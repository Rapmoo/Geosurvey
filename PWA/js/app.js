/* ============================================================
   FIREBASE SETUP
   ============================================================ */
import { initializeApp, deleteApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  disableNetwork, enableNetwork,
  doc, getDoc, getDocFromCache, getDocs, setDoc, updateDoc, deleteDoc, GeoPoint,
  collection, onSnapshot, addDoc, serverTimestamp, query, where, orderBy, limit, writeBatch, runTransaction,
  arrayUnion, arrayRemove
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import {
  getMessaging, getToken, onMessage, isSupported as isMessagingSupported, deleteToken
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-messaging.js";

// getToken is an ES-module binding, so it's invisible to the DevTools
// console (which runs in global/window scope, not this module's scope)
// unless we explicitly attach it to window. This doesn't change how the
// app itself calls getToken(...) below — it's purely for debugging.
window.getToken = getToken;

// ---- Authentication (persistent login, session restore, logout) ----
// Pulled out into a dedicated auth/ module: firebaseAuth.js owns the Auth
// instance + browserLocalPersistence (what makes a session survive closed
// tabs/browsers/restarts), session.js is the single onAuthStateChanged
// wiring point, logout.js is the only sanctioned way to end a session.
// See those files for the reasoning behind each piece.
import {
  firebaseApp, firebaseConfig, auth, getAuth,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword, updatePassword, updateEmail,
  EmailAuthProvider, reauthenticateWithCredential,
  signOut // still used directly for the app's own forced-signout cases
          // (disabled/removed account) — see subscribeOwnProfile() below;
          // those are security-driven, not the user-initiated Logout
          // button, which goes through logoutUser() instead.
} from './auth/firebaseAuth.js';
import { initializeAuth, getCurrentUser as getCurrentFirebaseUser } from './auth/session.js';
import { logoutUser } from './auth/logout.js';
// Media (photo/voice memo) now goes PWA -> our backend API -> company
// storage, instead of straight to Firebase Storage. fileStorageClient
// handles the authenticated HTTP calls + upload progress;
// uploadQueue persists failed/offline uploads to IndexedDB and retries
// them automatically once connectivity returns.
import {
  uploadPhoto as apiUploadPhoto, uploadAudio as apiUploadAudio,
  getMediaObjectUrl, deleteFile as apiDeleteFile
} from './auth/fileStorageClient.js';
import * as uploadQueue from './auth/uploadQueue.js';

// Generate this in the Firebase console: Project settings → Cloud Messaging
// → Web Push certificates → "Generate key pair". Push notifications can't
// request a token without it (getToken() below will just fail silently).
window.VAPID_KEY = "BAOBkQI6txG75GwxCQ9U8TG4hm__wgMfXzw5odbv-JxZv68rVoZF9eWwnfpS08pPugCMQzxuINM_eYAodj4gKL8";

// Get this from your MapTiler account: Cloud → your project → Keys.
// (Free tier: 100,000 tile requests/month, no card required.) The admin
// map's Satellite base layer (see initAdminMap below) can't load any
// imagery without it — every tile request will 401/403 until this is set.
/* ---------------- Service worker: real offline app-shell + push ----------------
   Registering sw.js is what actually turns this into an installable, offline-
   capable PWA — everything else (manifest, icons) just describes it, this is
   what does the work. The same registration is reused below for Firebase
   Cloud Messaging instead of letting it auto-register its own worker, so
   there's only ever one service worker controlling this origin. */
let swRegistration = null;
let swRegistrationReady = Promise.resolve(null);
if('serviceWorker' in navigator){
  // NOTE: this is '../sw.js', not './sw.js' — relative URLs in a module
  // script resolve against the *module's own* location, not the page's.
  // app.js lives in ./js/, but sw.js lives one level up at the PWA root
  // (it needs to control the whole app, not just /js/), so the path has
  // to walk back up to match.
  swRegistrationReady = navigator.serviceWorker.register('../sw.js').then((reg)=>{
    swRegistration = reg;
    // If a new version of sw.js is already waiting (installed while the
    // page was open), offer the reload prompt right away.
    if(reg.waiting) showUpdateToast(reg);
    reg.addEventListener('updatefound', ()=>{
      const installing = reg.installing;
      if(!installing) return;
      installing.addEventListener('statechange', ()=>{
        if(installing.state === 'installed' && navigator.serviceWorker.controller){
          showUpdateToast(reg);
        }
      });
    });
    return reg;
  }).catch((err)=>{
    console.warn('Service worker registration failed:', err);
    return null;
  });

  // The new SW takes control (after SKIP_WAITING) — reload once so every
  // open tab is actually running the new code instead of a stale copy.
  let refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', ()=>{
    if(refreshing) return;
    refreshing = true;
    window.location.reload();
  });

  // A background push was tapped while the app was already open — route to
  // the relevant form/submission instead of just focusing a blank view.
  navigator.serviceWorker.addEventListener('message', (event)=>{
    if(event.data && event.data.type === 'NOTIFICATION_CLICK'){
      handleNotificationNavigation(event.data.data || {});
    }
  });
}
function showUpdateToast(reg){
  const el = document.getElementById('update-toast');
  el.style.display = 'flex';
  document.getElementById('update-reload-btn').onclick = ()=>{
    if(reg.waiting) reg.waiting.postMessage('SKIP_WAITING');
    el.style.display = 'none';
  };
}

/* ---------------- Real installability (beforeinstallprompt) ----------------
   Chromium/Edge/Samsung Internet only ever fire this event once, for an
   origin that isn't already installed — so its absence is itself useful
   information: if enough time has passed for the browser to have decided
   and it still hasn't fired, the overwhelmingly likely reason is that this
   browser already has the app installed (that's exactly what happened when
   you installed it as admin and then logged in as a worker in the same
   browser — Chrome doesn't re-offer an install it already granted). Rather
   than hide the button and leave that unexplained, we keep it visible all
   the time and have the click itself explain what's going on. */
let deferredInstallPrompt = null;
let installPromptDecided = false; // flips true once the browser fires the event OR the grace period below elapses
const supportsInstallPrompt = 'onbeforeinstallprompt' in window; // rough Chromium-family detection
// NOTE: absence of beforeinstallprompt is NOT reliable proof the app is
// already installed — Chrome on Android in particular can withhold it on
// a first visit until its own engagement heuristics are satisfied (repeat
// visits, time on page, interaction), which has nothing to do with
// install state. Earlier this code treated "never fired" as "must already
// be installed," which was wrong and told genuinely-not-installed workers
// the opposite of the truth. Give it a generous window, and when it still
// hasn't fired, say so honestly instead of guessing a specific reason.
setTimeout(()=>{ installPromptDecided = true; }, 8000);

window.addEventListener('beforeinstallprompt', (e)=>{
  e.preventDefault();
  deferredInstallPrompt = e;
  installPromptDecided = true;
  refreshInstallButtonVisibility();
});

function isRunningStandalone(){
  return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}
function isIosDevice(){
  return /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;
}
function refreshInstallButtonVisibility(){
  const btn = document.getElementById('install-app-btn');
  // Never show while already running as the installed app.
  if(isRunningStandalone()){ btn.style.display = 'none'; return; }
  // Browser doesn't support the install prompt API at all (e.g. Firefox
  // desktop) — hide the button entirely rather than show it and error
  // out on click.
  if(!supportsInstallPrompt){ btn.style.display = 'none'; return; }
  // Only show once the browser has actually handed us a captured
  // beforeinstallprompt event — that's the one reliable signal that the
  // app is installable right now.
  btn.style.display = deferredInstallPrompt ? 'flex' : 'none';
}
refreshInstallButtonVisibility();
window.addEventListener('DOMContentLoaded', refreshInstallButtonVisibility);

document.getElementById('install-app-btn').onclick = async ()=>{
  if(isRunningStandalone()) return; // button is hidden in this case anyway
  if(isIosDevice()){
    document.getElementById('ios-install-hint').style.display = 'block';
    return;
  }
  if(!deferredInstallPrompt) return; // button shouldn't be visible without it, but guard anyway
  deferredInstallPrompt.prompt();
  const { outcome } = await deferredInstallPrompt.userChoice;
  console.log(`User response to the install prompt: ${outcome}`);
  deferredInstallPrompt = null; // a captured prompt can only ever be used once
  refreshInstallButtonVisibility();
  if(outcome === 'accepted') return; // appinstalled listener below shows the confirmation toast
  showToast(pushNotifText('install_dismissed', "No problem — you can install it anytime from this button."));
};
window.addEventListener('appinstalled', ()=>{
  deferredInstallPrompt = null;
  document.getElementById('ios-install-hint').style.display = 'none';
  refreshInstallButtonVisibility();
  showToast(I18N[currentLang] ? I18N[currentLang].app_installed || 'App installed' : 'App installed');
});
// iOS Safari never fires beforeinstallprompt — it's the one major browser
// with no install API, so the only honest option is a manual instruction,
// shown once per browser (not a recurring nag) and only when not already
// running as an installed app.
(function iosInstallHint(){
  if(isIosDevice() && !isRunningStandalone() && !localStorage.getItem('geosurvey_ios_hint_dismissed')){
    setTimeout(()=>{ document.getElementById('ios-install-hint').style.display = 'block'; }, 1500);
  }
})();
document.getElementById('ios-install-close').onclick = ()=>{
  document.getElementById('ios-install-hint').style.display = 'none';
  localStorage.setItem('geosurvey_ios_hint_dismissed', '1');
};
// Submission media (photos, voice memos) previously went straight to a
// Firebase Storage bucket declared in firebaseConfig above. It now goes
// through our own backend API (auth/fileStorageClient.js), which stores
// bytes on company-owned infrastructure instead — see
// uploadSubmissionPhoto/uploadSubmissionVoice below. Submission docs
// still store a single string identifier per media field, but it's now
// a backend `fileId`, not a public https:// download URL — see the
// note on displaying media further down (getMediaObjectUrl).

// Firestore's built-in offline cache, configured via FirestoreSettings.cache
// (the current API — replaces the now-deprecated enableIndexedDbPersistence()
// call, though the behavior is the same: writes made while offline succeed
// instantly against the local cache and sync automatically once connectivity
// returns). persistentMultipleTabManager() (rather than the single-tab
// variant) is required here specifically because this app is installable —
// a worker very plausibly has both the installed standalone app AND a
// regular browser tab open on the same origin at once (or several tabs left
// open across sessions). With single-tab persistence, only the first
// context to open wins the IndexedDB lock; every other one silently falls
// back to a memory-only cache with NO offline data at all — which looks
// exactly like "the app hangs forever loading" the moment that context
// goes offline, since it has nothing cached to fall back to. Multi-tab
// persistence lets every open tab/window share the same underlying cache
// instead of only one of them actually having one.
// experimentalAutoDetectLongPolling: Chrome's default WebChannel transport
// for Firestore's realtime Listen connection prefers QUIC, which some
// mobile networks, ISPs, corporate firewalls, and VPNs silently mangle
// (surfaces in devtools as net::ERR_QUIC_PROTOCOL_ERROR on the
// Listen/channel request, with the listener endlessly retrying instead of
// delivering updates). This makes the SDK detect that case itself and fall
// back to plain long-polling — cheap to set, and a no-op on networks where
// QUIC already works fine.
let db;
try{
  db = initializeFirestore(firebaseApp, {
    cache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
    experimentalAutoDetectLongPolling: true
  });
}catch(err){
  console.warn("Firestore offline persistence unavailable, falling back to in-memory cache:", err.code);
  db = initializeFirestore(firebaseApp, { experimentalAutoDetectLongPolling: true });
}

/* ---------------- Friendly Firestore error messages ----------------
   Every onSnapshot() error callback and every write's catch block routes
   through here so the person always sees one consistent, plain-language
   explanation instead of a raw Firestore error code — while the original
   error still goes to the console for debugging. */
function friendlyFirestoreError(err, fallback){
  if(!err) return fallback || 'Something went wrong.';
  if(!isOnline()){
    return "You're offline — this will retry automatically once you're back online.";
  }
  switch(err.code){
    case 'permission-denied':
      return "You don't have permission to do that.";
    case 'unavailable':
    case 'deadline-exceeded':
      return "Couldn't reach the server — check your connection and try again.";
    case 'unauthenticated':
      return 'Your session has expired — please sign in again.';
    case 'not-found':
      return "That item no longer exists — it may have been deleted.";
    case 'failed-precondition':
      return "This filter or sort combination needs a Firestore index — see the browser console for a link to create it.";
    case 'resource-exhausted':
      return "Too many requests right now — please wait a moment and try again.";
    case 'cancelled':
      return null; // request was intentionally aborted (e.g. a newer query superseded it) — nothing to show
    case 'already-exists':
      return 'That already exists.';
    default:
      return fallback || (err.message ? `Something went wrong — ${err.message}` : 'Something went wrong.');
  }
}

// Logs the real error for debugging and, unless it's a silent/cancelled
// case, shows the friendly translation as a toast.
function notifyError(err, fallback, ms){
  console.error(err);
  const msg = friendlyFirestoreError(err, fallback);
  if(msg) showToast(msg, ms || 5000);
}

/* ---------------- Connectivity banner ----------------
   A single global indicator (not just the worker view's demo toggle) so
   every role sees at a glance whether they're looking at live data or a
   local cache that hasn't synced yet. */
function updateConnectivityBanner(){
  const banner = document.getElementById('connectivity-banner');
  if(!banner) return;
  banner.style.display = isOnline() ? 'none' : 'flex';
}

/* ============================================================
   MOCK / DEMO DATA LAYER
   Users, Submissions (including their photo/voice-memo attachments,
   which live in Firebase Storage — see uploadSubmissionPhoto/Voice
   below), and Form Templates are wired to Firebase. Kobo import now
   goes through the backend's real KoboToolbox integration too — see
   the "Kobo import" section further down and services/koboService.js
   on the backend.
   ============================================================ */

const I18N = {
  en: {
    login_sub:"Sign in to continue", login_error:"Invalid email or password for this role.",
    signing_in:"Signing in…",
    role_admin:"Administrator", role_supervisor:"Supervisor", role_worker:"Field Worker",
    email:"Email", password:"Password", sign_in:"Sign in", logout:"Log out",
    stat_total:"Approved Submissions", stat_pending:"Pending", stat_approved:"Approved", stat_rejected:"Rejected",
    base_layer:"Base Layer", street:"Street", satellite:"Satellite", overlay:"Overlay", heatmap:"Heatmap", layers:"Layers",
    legend:"Legend", l_pending:"Pending", l_approved:"Approved", l_rejected:"Rejected",
    all_submissions:"All Submissions", all_status:"All statuses", all_workers:"All workers", sort_newest:"Newest first", sort_oldest:"Oldest first", export:"⬇ Export",
    conn_banner_text:"You're offline — showing cached data. Changes will sync automatically once you're back online.",
    install_app:"Install app", ios_install_title:"Install GeoSurvey", ios_install_body:"Tap the Share icon, then \"Add to Home Screen\" to install this app.",
    install_dismissed:"No problem — you can install it anytime from this button.",
    install_unsupported:"This browser can't install apps like this — try Chrome or Edge.",
    install_checking:"Still checking — give it a few seconds and try again.",
    install_already:"Install isn't available right now. If you've already installed GeoSurvey, check your Home Screen/App drawer/Start Menu. Otherwise, browse around a bit and try this button again shortly.",
    update_available:"A new version is ready.", update_reload:"Reload", app_installed:"App installed",
    push_notif_title:"Push notifications", push_notif_sub:"Get notified on this device, even when the app is closed.",
    enable:"Enable", disable:"Disable", blocked:"Blocked",
    push_not_supported:"Not supported", push_not_supported_sub:"This browser doesn't support push notifications.",
    push_notif_on:"You'll get notified on this device, even when the app is closed.",
    push_notif_blocked:"Notifications are blocked for this site in your browser settings.",
    push_enabled:"Push notifications enabled on this device", push_enable_failed:"Could not enable push notifications — check your connection and try again",
    push_disabled:"Push notifications disabled on this device",
    swipe_to_clear_hint:"← Swipe a notification to clear it", clear:"Clear",
    clear_all_notifs:"Clear all", clear_all_notifs_confirm:"Tap again to clear all",
    th_id:"ID", th_form:"Form", th_worker:"Worker", th_lng:"Longitude", th_lat:"Latitude", th_status:"Status", th_date:"Collected",
    worker_activity:"Worker Activity", th_total:"Approved Submissions", th_last_active:"Last Active", never_active:"No submissions yet",
    manage_users:"Manage Users", th_name:"Name", th_email:"Email", th_role:"Role", th_supervisor:"Supervisor", th_status_col:"Status",
    version_history:"Version History", version_sub:"Edits to reviewed submissions will be tracked here, old vs. new, side by side.",
    no_version_history:"No edits have been tracked yet.",
    system_settings:"System Settings", interface_lang:"Interface language", default_export:"Default export format",
    select_submission:"Select a submission", select_submission_sub:"Choose an item from the pending queue to review its data and voice memo.",
    online:"Online", new_submission:"New Submission", form_name:"Household Survey — v3",
    submitted:"Submitted", pending_sync:"Pending Sync", alerts:"Alerts",
    no_submitted_yet:"No submitted data yet", nothing_pending:"Nothing pending", no_alerts_yet:"No alerts yet",
    system_alerts:"System Alerts", refresh:"Refresh", refreshed_toast:"Refreshed", no_system_alerts:"No system alerts.", acknowledge:"Acknowledge",
    no_form_assigned:"No form has been sent to you yet", no_form_assigned_sub:"Ask your admin to send you a form from the Form Builder.",
    no_submissions_table:"No submitted data yet.",
    household_name:"Household name", region:"Coordinates", answers_section:"Answers",
    gps_location:"GPS location", gps_prompt:"Capture your current location before submitting.", capture_gps:"📍 Capture GPS",
    voice_memo:"Voice memo (up to 10 sec)", mic_prompt:"Record a short memo describing this visit (up to 10 seconds — tap Stop to finish early).", start_recording:"🎙 Start Recording", remove_voice:"🗑 Remove",
    photo:"Photo (optional)", photo_prompt:"Attach a photo of the household or site.", add_photo:"📷 Add Photo", retake_photo:"📷 Retake Photo", remove_photo:"🗑 Remove",
    take_photo:"📷 Take Photo", choose_photo:"🖼 Choose from Library", retake_camera:"📷 Retake Photo", rechoose_library:"🖼 Choose Different Photo",
    submit_data:"Submit Data", reject_title:"Reject submission", reject_sub:"Explain what needs to be corrected. The worker will see this note.",
    cancel:"Cancel", reject_confirm:"Reject & notify",
    retry:"Retry", save_anyway:"Save Anyway", gps_timeout_title:"Unable to obtain high accuracy",
    allow_poor_gps:"Allow workers to submit with poor GPS accuracy (>20m)",
    allow_poor_gps_sub:"When off, workers must Retry or Cancel instead of Save Anyway if the required GPS accuracy can't be reached.",
    nav_overview:"Overview & Map", nav_builder:"Form Builder", nav_templates:"Survey Templates", nav_import:"Import Data", nav_users:"Users", nav_versions:"Version History", nav_settings:"Settings",
    nav_queue:"Validation Queue", nav_worker:"Collect Data", nav_downloads:"Downloaded Forms",
    approve:"✓ Approve", reject:"✕ Reject", listen:"▶ Play memo", playing:"⏸ Playing…",
    view_details:"Review",
    kobo_connect_title:"Connect to KoboToolbox", kobo_not_connected:"Not connected", kobo_connected:"Connected",
    kobo_connect_sub:"Connect your KoboToolbox account to pull in existing forms and submissions.",
    kobo_server:"Server", kobo_token:"API Token", kobo_custom_url:"Custom server URL",
    kobo_token_help:"Find your token in Kobo under Account Settings → Security. It's never stored on our servers.",
    kobo_connect_btn:"Connect account", kobo_connecting:"Connecting…", kobo_disconnecting:"Disconnecting…",
    kobo_forms_title:"Available Forms", kobo_disconnect:"Disconnect",
    kobo_forms_sub:"Select one or more forms to import, or view a form to see its questions before importing. Duplicate submissions are skipped automatically.",
    kobo_mapping_title:"Field Mapping", kobo_mapping_sub:"GeoSurvey matched these fields automatically. Adjust if anything looks off.",
    kobo_field_col:"Kobo field", geosurvey_field_col:"GeoSurvey field",
    kobo_import_btn:"Import selected forms", kobo_importing_title:"Importing…",
    kobo_done_title:"Import complete", kobo_imported:"Imported", kobo_skipped:"Duplicates skipped", kobo_failed:"Failed",
    kobo_import_more:"← Import more forms", kobo_submissions:"submissions", kobo_last_modified:"Last modified",
    kobo_result_forms_title:"Imported forms", kobo_edit_form:"Edit form →",
    kobo_result_row_meta:"{imported} imported, {skipped} skipped, {failed} failed",
    kobo_vf_questions_heading:"Questions",
    kobo_field_count:"{n} question(s)",
    kobo_loading_form:"Loading form…", kobo_no_fields:"No questions found for this form.",
    kobo_view_forms_btn:"View Forms", kobo_view_forms_title:"Kobo Forms", kobo_view_forms_close:"Close",
    kobo_vf_search_placeholder:"Search forms by name…", kobo_vf_refresh:"⟳ Refresh",
    kobo_vf_loading:"Loading forms from KoboToolbox…", kobo_vf_empty:"No forms match your search.",
    kobo_vf_col_name:"Form Name", kobo_vf_col_id:"Form ID", kobo_vf_col_owner:"Owner",
    kobo_vf_col_created:"Date Created", kobo_vf_col_count:"Submissions", kobo_vf_col_status:"Status",
    kobo_vf_col_actions:"Actions", kobo_vf_status_deployed:"Deployed", kobo_vf_status_draft:"Draft",
    kobo_vf_status_archived:"Archived", kobo_vf_view_questions:"View questions",
    kobo_vf_hide_questions:"Hide questions",
    kobo_vf_import:"Import", kobo_vf_load_error:"Could not load forms from KoboToolbox.",
    kobo_vf_export:"Export to Excel", kobo_vf_exporting:"Exporting…",
    kobo_vf_export_error:"Could not export this form from KoboToolbox.",
    kobo_vf_export_saved_template:"Exported — also saved to Survey Templates.",
    kobo_vf_export_template_exists:"Exported — already saved in Survey Templates.",
    your_forms:"Your Forms", new_form:"+ New form", set_active:"Set as active form", save_form:"Save form",
    form_description_placeholder:"Describe what this form is for…",
    import_form:"📁 Import form…", export_form_json:"⬇ JSON", export_form_xlsx:"⬇ Excel", form_imported:"Form imported",
    form_exported:"Form exported", err_invalid_form_file:"That file isn't a valid form — check its format and try again.",
    builder_sub:"Drag questions to reorder. This defines what field workers see in the PWA.",
    save_as_template:"📚 Save Template",
    save_as_template_hint:"\"Save form\" updates the live working copy. \"Save Template\" snapshots the current questions as a new, reusable version in Survey Templates — it never overwrites an earlier version.",
    template_saved:"Saved as a new template version",
    survey_templates_title:"Survey Templates",
    survey_templates_sub:"Every \"Save Template\" click in the Form Builder adds a new version here — earlier versions are kept, never overwritten. Use any of them to start a new survey.",
    no_templates_yet:"No templates saved yet. Open a form in the Form Builder and click \"Save Template\".",
    th_tpl_name:"Template Name", th_tpl_description:"Description", th_tpl_kobo_id:"Original Kobo Form ID",
    th_tpl_version:"Version", th_tpl_imported:"Date Imported", th_tpl_modified:"Date Modified", th_tpl_created_by:"Created By",
    tpl_use_btn:"Use for new survey", tpl_versions_btn:"{n} version(s)", tpl_no_kobo_id:"—",
    tpl_use_confirm_title:"Start a new survey from this template?", tpl_use_confirm_body:"This creates a new, independent draft form in the Form Builder using this template's questions (version {v}). The template itself stays unchanged.",
    tpl_use_confirm_btn:"Create draft form", tpl_new_form_created:"New draft form created from template",
    tpl_remove_btn:"🗑 Remove", tpl_remove_confirm_title:"Remove this template version?",
    tpl_remove_confirm_body:"This permanently deletes version {v} of \"{name}\" from Survey Templates. This can't be undone.",
    tpl_remove_confirm_btn:"Remove version", tpl_removed:"Template version removed",
    unknown_user:"Unknown user",
    add_question:"Add a question", untitled_question:"Untitled question", required:"Required",
    q_short_text:"Short text", q_number:"Number", q_single_choice:"Single choice", q_multi_choice:"Multiple choice",
    q_date:"Date", q_gps:"GPS point", q_photo:"Photo", q_audio:"Voice memo",
    add_option:"+ Add option", add_suboption:"+ Add sub-choice", hint_label:"Hint shown to worker", option_placeholder:"Option label", no_questions:"No questions yet — add one below.",
    form_saved:"Form saved", form_set_active:"is now the active form",
    confirm_delete_q:"Delete this question?", untitled_form:"Untitled form",
    delete_form:"Delete form", confirm_delete_form:"Delete this form permanently? This can't be undone.",
    confirm_delete_form_has_submissions:"This form has {n} submission(s) already collected against it. Deleting it will permanently orphan those submissions \u2014 they will never be archived. Type DELETE to confirm anyway.",
    form_deleted:"Form deleted",
    send_to_worker:"Send to worker", send_form_title:"Send form to worker",
    send_form_sub:"The worker will get a notification and can start collecting with this form.",
    select_worker:"Worker(s)", select_all:"Select all", send_confirm:"Send form", no_workers_to_send:"No active field workers to send to yet.",
    err_pick_worker:"Pick at least one worker first.", form_sent:"sent to", form_sent_count:"Form sent to {n} workers.", form_sent_partial:"Sent to {ok} workers \u2014 {fail} failed. Check your connection and try those again.",
    open_form:"👁 Open", view_submission:"👁 View", preview_form_title:"Form preview", preview_form_sub:"This is what the admin sent you to fill out.", fill_out_form:"Continue → GPS, photo & submit",
    close:"Close", fp_no_questions:"This form doesn't have any questions yet.",
    fp_media_note:"Captured on the next screen:", fp_media_only:"This form only asks for GPS, a photo, or a voice memo — continue to capture them.",
    nav_account:"Account", account_settings:"Account Settings", account_sub:"Update the email and password you use to sign in.",
    notify_email_label:"Also email me at (optional)", notify_email_hint:"When a form is sent to you, we'll also email a copy here — handy if you check Gmail more often than this account's inbox.",
    current_password:"Current password", new_password:"New password", optional_hint:"(leave blank to keep current password)",
    confirm_password:"Confirm new password", save_changes:"Save changes",
    err_current_pass_required:"Enter your current password to make changes.",
    err_wrong_pass:"Current password is incorrect.",
    err_pass_mismatch:"New password and confirmation don't match.",
    err_email_taken:"That email is already in use by another account.",
    err_supervisor_unresolved:"Couldn't match \"{supervisor}\" to an active supervisor account. Pick a supervisor from the list, or create their account first.",
    err_email_invalid:"Enter a valid email address.",
    acct_saved:"Account updated.",
    err_account_disabled:"This account has been disabled by an administrator.",
    new_user_btn:"+ New user", new_user_title:"Create new user", new_user_sub:"They'll sign in with this email and temporary password.",
    full_name:"Full name", role:"Role", assign_supervisor:"Assign supervisor", temp_password:"Temporary password",
    create_user:"Create user", err_fill_required:"Fill in a name, valid email, and password.",
    user_created:"created successfully", disable_user:"Disable", enable_user:"Enable",
    user_enabled:"enabled", user_disabled:"disabled",
    delete_user:"Delete", confirm_delete_user:"Delete this user? This removes their profile and access permanently — this can't be undone.",
    user_deleted:"deleted",
    offline:"Offline", sim_offline:"Simulate offline (demo)",
    tab_new:"New Submission", tab_history:"My Submissions",
    no_history:"You haven't submitted anything yet.",
    view_map:"🗺 View Map", my_submissions_map:"My Submissions Map",
    map_no_location:"None of your submissions have a captured location yet.",
    resubmit:"↻ Resubmit", resubmit_btn:"Resubmit corrected data",
    delete_submission:"Delete submission", confirm_delete_submission:"Delete this submission? This can't be undone.",
    submission_deleted:"Submission deleted", err_delete_submission:"Could not delete — check your connection.",
    submission_deleted_offline:"Removed — will finish deleting once you're back online",
    no_alerts:"No alerts",
    offline_saved:"Saved offline — will sync when you're back online",
    synced_toast:"submission(s) synced",
    tab_drafts:"Drafts",
    draft_saved:"Saved as a draft. Edit or submit it anytime from the Drafts tab.",
    draft_updated:"Draft updated",
    no_drafts:"No saved drafts. Use \"Save as Draft\" on any form to keep it here for later — nothing needs to be filled in first.",
    edit_draft:"✎ Edit", submit_draft:"↑ Submit now", delete_draft:"🗑 Delete",
    confirm_delete_draft:"Delete this draft? This can't be undone.",
    draft_deleted:"Draft deleted",
    l_draft:"Draft",
    needs_gps_badge:"⚠ GPS needed",
    draft_gps_needed_status:"⚠ GPS needed before you can submit — tap Capture GPS below.",
    draft_gps_missing_toast:"This draft has no GPS location saved yet. Capture it before submitting.",
    editing_draft_banner:"Editing a saved draft — submitting will send it and remove the draft.",
    draft_needs_connection:"Still offline — this draft will submit once you're back online.",
    drafts_ready_toast:"Back online — you have saved drafts ready to submit.",
    untitled_draft:"Untitled draft",
    save_draft_btn:"💾 Save as Draft",
    save_draft_hint:"Saves whatever you've filled in so far. Nothing is required — finish it later from the Drafts tab.",
    download_form:"⬇ Download for offline", form_downloaded:"Downloaded",
    form_downloaded_toast:"Form saved to this device — you can open it offline anytime.",
    download_form_failed:"Could not save this form on your device — storage may be full.",
    downloaded_forms:"Downloaded Forms", no_downloaded_forms:"No forms downloaded yet.",
    downloaded_forms_page_sub:"Forms you've saved for offline use. Open one to fill it in even without a connection.",
    remove_download:"Remove download", confirm_remove_download:"Remove this downloaded form from your device?",
    download_removed:"Downloaded form removed",
  },
  am: {
    login_sub:"ለመቀጠል ይግቡ", login_error:"ኢሜይል ወይም የይለፍ ቃል ልክ አይደለም።",
    signing_in:"በመግባት ላይ…",
    role_admin:"አስተዳዳሪ", role_supervisor:"ተቆጣጣሪ", role_worker:"የመስክ ሰራተኛ",
    email:"ኢሜይል", password:"የይለፍ ቃል", sign_in:"ግባ", logout:"ውጣ",
    stat_total:"የጸደቁ ማስገቢያዎች", stat_pending:"በመጠባበቅ ላይ", stat_approved:"የጸደቀ", stat_rejected:"ውድቅ የተደረገ",
    base_layer:"መሰረታዊ ንብርብር", street:"የመንገድ ካርታ", satellite:"ሳተላይት", overlay:"ተደራቢ", heatmap:"ሙቀት ካርታ", layers:"ንብርብሮች",
    legend:"ምልክት", l_pending:"በመጠባበቅ ላይ", l_approved:"የጸደቀ", l_rejected:"ውድቅ",
    all_submissions:"ሁሉም ማስገቢያዎች", all_status:"ሁሉም ሁኔታዎች", all_workers:"ሁሉም ሰራተኞች", sort_newest:"አዲስ መጀመሪያ", sort_oldest:"ብሉይ መጀመሪያ", export:"⬇ ላክ",
    conn_banner_text:"ከመስመር ውጪ ነዎት — የተቀመጠ መረጃ እያሳየ ነው። መስመር ላይ ሲሆኑ በራስ-ሰር ይመሳሰላል።",
    install_app:"መተግበሪያ ጫን", ios_install_title:"GeoSurvey ጫን", ios_install_body:"የማጋሪያ አዶውን ይንኩ፣ ከዚያ ይህን መተግበሪያ ለመጫን \"ወደ መነሻ ገጽ አክል\" ይምረጡ።",
    install_dismissed:"ምንም ችግር የለም — በማንኛውም ጊዜ ከዚህ አዝራር መጫን ይችላሉ።",
    install_unsupported:"ይህ አሳሽ እንደዚህ አይነት መተግበሪያዎችን መጫን አይችልም — Chrome ወይም Edge ይሞክሩ።",
    install_checking:"እየተመረመረ ነው — ጥቂት ሰከንዶች ይጠብቁ እና እንደገና ይሞክሩ።",
    install_already:"መጫን በአሁኑ ጊዜ አይገኝም። GeoSurvey ን አስቀድመው ከጫኑ፣ በመነሻ ገጽዎ/መተግበሪያ መሳቢያ/ጀምር ምናሌ ውስጥ ይመልከቱ። ካልሆነ፣ ትንሽ ይዘዋወሩ እና ይህን አዝራር በቅርቡ እንደገና ይሞክሩ።",
    update_available:"አዲስ ስሪት ዝግጁ ነው።", update_reload:"እንደገና ጫን", app_installed:"መተግበሪያ ተጭኗል",
    push_notif_title:"የግፋ ማሳወቂያዎች", push_notif_sub:"መተግበሪያው ዝግ ቢሆንም እንኳ በዚህ መሳሪያ ላይ ማሳወቂያ ያገኛሉ።",
    enable:"አንቃ", disable:"አሰናክል", blocked:"ታግዷል",
    push_not_supported:"አይደገፍም", push_not_supported_sub:"ይህ አሳሽ የግፋ ማሳወቂያዎችን አይደግፍም።",
    push_notif_on:"መተግበሪያው ዝግ ቢሆንም እንኳ በዚህ መሳሪያ ላይ ማሳወቂያ ያገኛሉ።",
    push_notif_blocked:"ማሳወቂያዎች በአሳሽዎ ቅንብሮች ውስጥ ለዚህ ጣቢያ ታግደዋል።",
    push_enabled:"የግፋ ማሳወቂያዎች በዚህ መሳሪያ ላይ ነቅተዋል", push_enable_failed:"የግፋ ማሳወቂያዎችን ማንቃት አልተቻለም — ግንኙነትዎን ያረጋግጡ እና እንደገና ይሞክሩ",
    push_disabled:"የግፋ ማሳወቂያዎች በዚህ መሳሪያ ላይ ተሰናክለዋል",
    swipe_to_clear_hint:"← ማሳወቂያን ለማጽዳት ወደ ግራ ይጎትቱ", clear:"አጽዳ",
    clear_all_notifs:"ሁሉንም አጽዳ", clear_all_notifs_confirm:"ሁሉንም ለማጽዳት ደግመው ይንኩ",
    th_id:"መለያ", th_form:"ቅጽ", th_worker:"ሰራተኛ", th_lng:"ኬንትሮስ", th_lat:"ኬክሮስ", th_status:"ሁኔታ", th_date:"የተሰበሰበበት",
    worker_activity:"የሰራተኛ እንቅስቃሴ", th_total:"የጸደቁ ማስገቢያዎች", th_last_active:"የመጨረሻ እንቅስቃሴ", never_active:"እስካሁን ምንም ማስገቢያ የለም",
    manage_users:"ተጠቃሚዎችን ያስተዳድሩ", th_name:"ስም", th_email:"ኢሜይል", th_role:"ሚና", th_supervisor:"ተቆጣጣሪ", th_status_col:"ሁኔታ",
    version_history:"የስሪት ታሪክ", version_sub:"የተገመገሙ ማስገቢያዎች ላይ የሚደረጉ ለውጦች እዚህ ይመዘገባሉ፣ አሮጌ እና አዲስ በጎን ለጎን።",
    no_version_history:"እስካሁን የተመዘገበ ለውጥ የለም።",
    system_settings:"የስርዓት ቅንብሮች", interface_lang:"የበይነገጽ ቋንቋ", default_export:"ነባሪ የመላኪያ ቅርጸት",
    select_submission:"ማስገቢያ ይምረጡ", select_submission_sub:"መረጃውን እና የድምጽ መልእክቱን ለመገምገም ከተጠባባቂ ዝርዝሩ ይምረጡ።",
    online:"መስመር ላይ", new_submission:"አዲስ ማስገቢያ", form_name:"የቤተሰብ ዳሰሳ — v3",
    submitted:"የገባ", pending_sync:"በመጠባበቅ ላይ", alerts:"ማንቂያዎች",
    no_submitted_yet:"እስካሁን የገባ ውሂብ የለም", nothing_pending:"የሚጠበቅ ነገር የለም", no_alerts_yet:"እስካሁን ማንቂያ የለም",
    system_alerts:"የስርዓት ማንቂያዎች", refresh:"አድስ", refreshed_toast:"ታድሷል", no_system_alerts:"ምንም የስርዓት ማንቂያ የለም።", acknowledge:"ተቀብያለሁ",
    no_form_assigned:"እስካሁን ምንም ቅጽ አልተላከልዎትም", no_form_assigned_sub:"አስተዳዳሪዎ ከቅጽ ገንቢው ቅጽ እንዲልክልዎት ይጠይቁ።",
    no_submissions_table:"እስካሁን የገባ ውሂብ የለም።",
    household_name:"የቤተሰብ ስም", region:"መጋጠሚያ", answers_section:"መልሶች",
    gps_location:"የጂፒኤስ አካባቢ", gps_prompt:"ከማስገባትዎ በፊት የአሁኑን አካባቢዎን ይያዙ።", capture_gps:"📍 ጂፒኤስ ያዝ",
    voice_memo:"የድምጽ መልእክት (እስከ 10 ሰከንድ)", mic_prompt:"ስለዚህ ጉብኝት አጭር መልእክት ይቅዱ (እስከ 10 ሰከንድ — ቀድመው ለማቆም 'አቁም' ይጫኑ)።", start_recording:"🎙 መቅዳት ጀምር", remove_voice:"🗑 አስወግድ",
    photo:"ፎቶ (አማራጭ)", photo_prompt:"የቤተሰቡን ወይም የቦታውን ፎቶ ያያይዙ።", add_photo:"📷 ፎቶ ጨምር", retake_photo:"📷 ፎቶ እንደገና አንሳ", remove_photo:"🗑 አስወግድ",
    take_photo:"📷 ፎቶ አንሳ", choose_photo:"🖼 ከቤተ-መጻሕፍት ምረጥ", retake_camera:"📷 ፎቶ እንደገና አንሳ", rechoose_library:"🖼 ሌላ ፎቶ ምረጥ",
    submit_data:"መረጃ አስገባ", reject_title:"ማስገቢያ ውድቅ አድርግ", reject_sub:"ምን መስተካከል እንዳለበት ያብራሩ። ሰራተኛው ይህን ማስታወሻ ያያል።",
    cancel:"ይቅር", reject_confirm:"ውድቅ አድርግ እና አሳውቅ",
    retry:"እንደገና ሞክር", save_anyway:"ቢሆንም አስቀምጥ", gps_timeout_title:"ከፍተኛ ትክክለኝነት ማግኘት አልተቻለም",
    allow_poor_gps:"ሰራተኞች ደካማ የጂፒኤስ ትክክለኝነት (>20ሜ) እንዲያስገቡ ፍቀድ",
    allow_poor_gps_sub:"ጠፍቶ ሲሆን፣ የሚያስፈልገው የጂፒኤስ ትክክለኝነት ማግኘት ካልተቻለ ሰራተኞች ከ«ቢሆንም አስቀምጥ» ይልቅ «እንደገና ሞክር» ወይም «ይቅር» ማድረግ አለባቸው።",
    nav_overview:"አጠቃላይ እይታ እና ካርታ", nav_builder:"ቅጽ ገንቢ", nav_templates:"የዳሰሳ ጥናት አብነቶች", nav_import:"ከKobo አስመጣ", nav_users:"ተጠቃሚዎች", nav_versions:"የስሪት ታሪክ", nav_settings:"ቅንብሮች",
    nav_queue:"የማረጋገጫ ወረፋ", nav_worker:"መረጃ ሰብስብ", nav_downloads:"የወረዱ ቅጾች",
    approve:"✓ አጽድቅ", reject:"✕ ውድቅ", listen:"▶ መልእክት ያጫውቱ", playing:"⏸ በማጫወት ላይ…",
    view_details:"ገምግም",
    kobo_connect_title:"ከKoboToolbox ጋር ይገናኙ", kobo_not_connected:"አልተገናኘም", kobo_connected:"ተገናኝቷል",
    kobo_connect_sub:"ነባር ቅጾችን እና ማስገቢያዎችን ለማምጣት የKoboToolbox መለያዎን ያገናኙ።",
    kobo_server:"አገልጋይ", kobo_token:"የኤፒአይ ቶከን", kobo_custom_url:"ብጁ የአገልጋይ አድራሻ",
    kobo_token_help:"ቶከንዎን በKobo ውስጥ Account Settings → Security ስር ያገኙታል። በአገልጋዮቻችን ላይ በጭራሽ አይቀመጥም።",
    kobo_connect_btn:"መለያ አገናኝ", kobo_connecting:"በማገናኘት ላይ…", kobo_disconnecting:"በማቋረጥ ላይ…",
    kobo_forms_title:"ያሉ ቅጾች", kobo_disconnect:"አቋርጥ",
    kobo_forms_sub:"ለማስመጣት አንድ ወይም ከዚያ በላይ ቅጾችን ይምረጡ፣ ወይም ከማስመጣትዎ በፊት ጥያቄዎቹን ለማየት ቅጹን ይመልከቱ። የተደጋገሙ ማስገቢያዎች በራስ-ሰር ይዘለላሉ።",
    kobo_mapping_title:"የመስክ ማዛመድ", kobo_mapping_sub:"GeoSurvey እነዚህን መስኮች በራስ-ሰር አዛምዷል። የሆነ ነገር ትክክል ካልመሰለ ያስተካክሉ።",
    kobo_field_col:"የKobo መስክ", geosurvey_field_col:"የGeoSurvey መስክ",
    kobo_import_btn:"የተመረጡ ቅጾችን አስመጣ", kobo_importing_title:"በማስመጣት ላይ…",
    kobo_done_title:"ማስመጣት ተጠናቅቋል", kobo_imported:"የገባ", kobo_skipped:"የተዘለሉ ድግግሞሾች", kobo_failed:"ያልተሳካ",
    kobo_import_more:"← ተጨማሪ ቅጾችን አስመጣ", kobo_submissions:"ማስገቢያዎች", kobo_last_modified:"መጨረሻ የተስተካከለው",
    kobo_result_forms_title:"የገቡ ቅጾች", kobo_edit_form:"ቅጹን አርትዕ →",
    kobo_result_row_meta:"{imported} ገብቷል፣ {skipped} ተዘልሏል፣ {failed} አልተሳካም",
    kobo_vf_questions_heading:"ጥያቄዎች",
    kobo_field_count:"{n} ጥያቄ(ዎች)",
    kobo_loading_form:"ቅጽ በመጫን ላይ…", kobo_no_fields:"ለዚህ ቅጽ ምንም ጥያቄ አልተገኘም።",
    kobo_view_forms_btn:"ቅጾችን ይመልከቱ", kobo_view_forms_title:"የKobo ቅጾች", kobo_view_forms_close:"ዝጋ",
    kobo_vf_search_placeholder:"ቅጾችን በስም ይፈልጉ…", kobo_vf_refresh:"⟳ አድስ",
    kobo_vf_loading:"ከKoboToolbox ቅጾችን በመጫን ላይ…", kobo_vf_empty:"ከፍለጋዎ ጋር የሚዛመድ ቅጽ አልተገኘም።",
    kobo_vf_col_name:"የቅጽ ስም", kobo_vf_col_id:"የቅጽ መታወቂያ", kobo_vf_col_owner:"ባለቤት",
    kobo_vf_col_created:"የተፈጠረበት ቀን", kobo_vf_col_count:"ማስገቢያዎች", kobo_vf_col_status:"ሁኔታ",
    kobo_vf_col_actions:"ተግባራት", kobo_vf_status_deployed:"ተሰማርቷል", kobo_vf_status_draft:"ረቂቅ",
    kobo_vf_status_archived:"ተቀምጧል", kobo_vf_view_questions:"ጥያቄዎችን ይመልከቱ",
    kobo_vf_hide_questions:"ጥያቄዎችን ደብቅ",
    kobo_vf_import:"አስመጣ", kobo_vf_load_error:"ከKoboToolbox ቅጾችን መጫን አልተቻለም።",
    kobo_vf_export:"ወደ ኤክሴል ላክ", kobo_vf_exporting:"በመላክ ላይ…",
    kobo_vf_export_error:"ይህን ቅጽ ከKoboToolbox መላክ አልተቻለም።",
    kobo_vf_export_saved_template:"ተልኳል — በዳሰሳ ጥናት አብነቶች ውስጥም ተቀምጧል።",
    kobo_vf_export_template_exists:"ተልኳል — በዳሰሳ ጥናት አብነቶች ውስጥ አስቀድሞ ተቀምጧል።",
    your_forms:"የእርስዎ ቅጾች", new_form:"+ አዲስ ቅጽ", set_active:"እንደ ንቁ ቅጽ አድርግ", save_form:"ቅጽ አስቀምጥ",
    form_description_placeholder:"ይህ ቅጽ ለምን እንደሆነ ይግለጹ…",
    import_form:"📁 ቅጽ አስመጣ…", export_form_json:"⬇ JSON", export_form_xlsx:"⬇ ኤክሴል", form_imported:"ቅጹ ገብቷል",
    form_exported:"ቅጹ ወጥቷል", err_invalid_form_file:"ይህ ፋይል ትክክለኛ ቅጽ አይደለም — ቅርጸቱን ያረጋግጡ እና እንደገና ይሞክሩ።",
    builder_sub:"ጥያቄዎችን ለማዘዋወር ይጎትቱ። ይህ የመስክ ሰራተኞች በPWA ውስጥ የሚያዩትን ይወስናል።",
    save_as_template:"📚 አብነት አስቀምጥ",
    save_as_template_hint:"«ቅጽ አስቀምጥ» የስራ ላይ ቅጂውን ያዘምናል። «አብነት አስቀምጥ» የአሁኑን ጥያቄዎች እንደ አዲስ፣ እንደገና ጥቅም ላይ የሚውል ስሪት በዳሰሳ ጥናት አብነቶች ውስጥ ያስቀምጣል — ቀደም ያለውን ስሪት በጭራሽ አይተካም።",
    template_saved:"እንደ አዲስ የአብነት ስሪት ተቀምጧል",
    survey_templates_title:"የዳሰሳ ጥናት አብነቶች",
    survey_templates_sub:"በቅጽ ገንቢ ውስጥ እያንዳንዱ «አብነት አስቀምጥ» ጠቅታ አዲስ ስሪት እዚህ ይጨምራል — ቀደምት ስሪቶች ይቀመጣሉ፣ አይተኩም። ማንኛውንም ከነሱ አዲስ የዳሰሳ ጥናት ለመጀመር ይጠቀሙ።",
    no_templates_yet:"እስካሁን ምንም አብነት አልተቀመጠም። በቅጽ ገንቢ ውስጥ ቅጽ ይክፈቱ እና «አብነት አስቀምጥ»ን ይጫኑ።",
    th_tpl_name:"የአብነት ስም", th_tpl_description:"መግለጫ", th_tpl_kobo_id:"የመጀመሪያው የKobo ቅጽ መታወቂያ",
    th_tpl_version:"ስሪት", th_tpl_imported:"የገባበት ቀን", th_tpl_modified:"የተስተካከለበት ቀን", th_tpl_created_by:"በማን ተፈጠረ",
    tpl_use_btn:"ለአዲስ ዳሰሳ ጥናት ተጠቀም", tpl_versions_btn:"{n} ስሪት(ዎች)", tpl_no_kobo_id:"—",
    tpl_use_confirm_title:"ከዚህ አብነት አዲስ ዳሰሳ ጥናት ይጀመር?", tpl_use_confirm_body:"ይህ የዚህን አብነት ጥያቄዎች (ስሪት {v}) በመጠቀም በቅጽ ገንቢ ውስጥ አዲስ፣ ራሱን የቻለ ረቂቅ ቅጽ ይፈጥራል። ራሱ አብነቱ ሳይለወጥ ይቆያል።",
    tpl_use_confirm_btn:"ረቂቅ ቅጽ ፍጠር", tpl_new_form_created:"ከአብነት አዲስ ረቂቅ ቅጽ ተፈጥሯል",
    tpl_remove_btn:"🗑 አስወግድ", tpl_remove_confirm_title:"ይህ የአብነት ስሪት ይወገድ?",
    tpl_remove_confirm_body:"ይህ የ«{name}» ስሪት {v}ን ከዳሰሳ ጥናት አብነቶች በቋሚነት ይሰርዛል። ይህን መተካት አይቻልም።",
    tpl_remove_confirm_btn:"ስሪት አስወግድ", tpl_removed:"የአብነት ስሪት ተወግዷል",
    unknown_user:"ያልታወቀ ተጠቃሚ",
    add_question:"ጥያቄ ጨምር", untitled_question:"ርዕስ የሌለው ጥያቄ", required:"ያስፈልጋል",
    q_short_text:"አጭር ጽሑፍ", q_number:"ቁጥር", q_single_choice:"ነጠላ ምርጫ", q_multi_choice:"ብዙ ምርጫ",
    q_date:"ቀን", q_gps:"የጂፒኤስ ነጥብ", q_photo:"ፎቶ", q_audio:"የድምጽ መልእክት",
    add_option:"+ ምርጫ ጨምር", add_suboption:"+ ንዑስ ምርጫ ጨምር", hint_label:"ለሰራተኛው የሚታይ ፍንጭ", option_placeholder:"የምርጫ ስም", no_questions:"እስካሁን ምንም ጥያቄ የለም — ከታች ይጨምሩ።",
    form_saved:"ቅጽ ተቀምጧል", form_set_active:"አሁን ንቁ ቅጽ ነው",
    confirm_delete_q:"ይህን ጥያቄ ይሰርዙ?", untitled_form:"ርዕስ የሌለው ቅጽ",
    delete_form:"ቅጽ ሰርዝ", confirm_delete_form:"ይህን ቅጽ በቋሚነት ይሰርዙ? ይህ ሊቀለበስ አይችልም።",
    confirm_delete_form_has_submissions:"ይህ ቅጽ {n} አስቀድሞ የተሰበሰቡ ማስረከቢያዎች አሉት። ቅጹን መሰረዝ እነዚያን ማስረከቢያዎች በቋሚነት ብቻቸውን ያስቀራቸዋል — ፈጽሞ አይመዘገቡም። ለማረጋገጥ DELETE ብለው ይተይቡ።",
    form_deleted:"ቅጹ ተሰርዟል",
    send_to_worker:"ለሰራተኛ ላክ", send_form_title:"ቅጽ ለሰራተኛ ላክ",
    send_form_sub:"ሰራተኛው ማሳወቂያ ይደርሰዋል እና በዚህ ቅጽ መሰብሰብ መጀመር ይችላል።",
    select_worker:"ሰራተኞች", select_all:"ሁሉንም ምረጥ", send_confirm:"ቅጽ ላክ", no_workers_to_send:"እስካሁን ንቁ የመስክ ሰራተኞች የሉም።",
    err_pick_worker:"መጀመሪያ ቢያንስ አንድ ሰራተኛ ይምረጡ።", form_sent:"ተልኳል ወደ", form_sent_count:"ቅጹ ለ{n} ሰራተኞች ተልኳል።", form_sent_partial:"ለ{ok} ሰራተኞች ተልኳል \u2014 {fail} አልተሳካም። ግንኙነትዎን ያረጋግጡና እንደገና ይሞክሩ።",
    open_form:"👁 ክፈት", view_submission:"👁 ይመልከቱ", preview_form_title:"የቅጽ ቅድመ እይታ", preview_form_sub:"አስተዳዳሪው ይህን ቅጽ እንዲሞሉ ልኮልዎታል።", fill_out_form:"ቀጥል → ጂፒኤስ፣ ፎቶ እና ላክ",
    close:"ዝጋ", fp_no_questions:"ይህ ቅጽ እስካሁን ምንም ጥያቄ የለውም።",
    fp_media_note:"በሚቀጥለው ገጽ ላይ ይያዛል:", fp_media_only:"ይህ ቅጽ የሚጠይቀው ጂፒኤስ፣ ፎቶ ወይም የድምጽ መልእክት ብቻ ነው — ለመቀጠል ይያዙዋቸው።",
    nav_account:"መለያ", account_settings:"የመለያ ቅንብሮች", account_sub:"ለመግቢያ የሚጠቀሙበትን ኢሜይል እና የይለፍ ቃል ያዘምኑ።",
    notify_email_label:"እዚህም ኢሜይል ላክልኝ (አማራጭ)", notify_email_hint:"ቅጽ ሲላክልዎ፣ ግልባጭ እዚህም ኢሜይል እናደርጋለን — ይህ መለያ ኢሜይል ካልተጠቀሙ ግን Gmail ብዙ ጊዜ የሚያዩ ከሆነ ይረዳል።",
    current_password:"የአሁኑ የይለፍ ቃል", new_password:"አዲስ የይለፍ ቃል", optional_hint:"(የይለፍ ቃልዎን ላለመቀየር ባዶ ይተውት)",
    confirm_password:"አዲሱን የይለፍ ቃል ያረጋግጡ", save_changes:"ለውጦችን አስቀምጥ",
    err_current_pass_required:"ለውጦችን ለማድረግ የአሁኑን የይለፍ ቃል ያስገቡ።",
    err_wrong_pass:"የአሁኑ የይለፍ ቃል ትክክል አይደለም።",
    err_pass_mismatch:"አዲሱ የይለፍ ቃል እና ማረጋገጫው አይዛመዱም።",
    err_email_taken:"ያ ኢሜይል በሌላ መለያ ጥቅም ላይ ውሏል።",
    err_supervisor_unresolved:"\"{supervisor}\" ከንቁ ተቆጣጣሪ መለያ ጋር ማዛመድ አልተቻለም። ከዝርዝሩ ውስጥ ተቆጣጣሪ ይምረጡ፣ ወይም መጀመሪያ የነሱን መለያ ይፍጠሩ።",
    err_email_invalid:"ትክክለኛ ኢሜይል አድራሻ ያስገቡ።",
    acct_saved:"መለያ ተዘምኗል።",
    err_account_disabled:"ይህ መለያ በአስተዳዳሪ ተሰናክሏል።",
    new_user_btn:"+ አዲስ ተጠቃሚ", new_user_title:"አዲስ ተጠቃሚ ፍጠር", new_user_sub:"በዚህ ኢሜይል እና ጊዜያዊ የይለፍ ቃል ይገባሉ።",
    full_name:"ሙሉ ስም", role:"ሚና", assign_supervisor:"ተቆጣጣሪ መድብ", temp_password:"ጊዜያዊ የይለፍ ቃል",
    create_user:"ተጠቃሚ ፍጠር", err_fill_required:"ስም፣ ትክክለኛ ኢሜይል እና የይለፍ ቃል ያስገቡ።",
    user_created:"በተሳካ ሁኔታ ተፈጥሯል", disable_user:"አሰናክል", enable_user:"አንቃ",
    user_enabled:"ነቅቷል", user_disabled:"ተሰናክሏል",
    delete_user:"ሰርዝ", confirm_delete_user:"ይህን ተጠቃሚ መሰረዝ ይፈልጋሉ? ይህ መገለጫቸውን እና መዳረሻቸውን በቋሚነት ያስወግዳል — ወደኋላ መመለስ አይቻልም።",
    user_deleted:"ተሰርዟል",
    offline:"ከመስመር ውጪ", sim_offline:"ከመስመር ውጪ ምሰል (ማሳያ)",
    tab_new:"አዲስ ማስገቢያ", tab_history:"የእኔ ማስገቢያዎች",
    no_history:"እስካሁን ምንም አላስገቡም።",
    view_map:"🗺 ካርታ ይመልከቱ", my_submissions_map:"የእኔ ማስገቢያዎች ካርታ",
    map_no_location:"እስካሁን ምንም የተያዘ አካባቢ ያለው ማስገቢያ የለዎትም።",
    resubmit:"↻ እንደገና አስገባ", resubmit_btn:"የተስተካከለ መረጃ እንደገና አስገባ",
    delete_submission:"ማስገቢያ ሰርዝ", confirm_delete_submission:"ይህን ማስገቢያ መሰረዝ ይፈልጋሉ? ይህ ሊቀለበስ አይችልም።",
    submission_deleted:"ማስገቢያው ተሰርዟል", err_delete_submission:"መሰረዝ አልተቻለም — ግንኙነትዎን ያረጋግጡ።",
    submission_deleted_offline:"ተወግዷል — መስመር ላይ ሲሆኑ መሰረዝ ይጠናቀቃል",
    no_alerts:"ምንም ማንቂያ የለም",
    offline_saved:"ከመስመር ውጪ ተቀምጧል — መስመር ላይ ሲሆኑ ይመሳሰላል",
    synced_toast:"ማስገቢያ(ዎች) ተመሳስለዋል",
    tab_drafts:"ረቂቆች",
    draft_saved:"እንደ ረቂቅ ተቀምጧል። በማንኛውም ጊዜ ከ«ረቂቆች» ትር ያርትዑት ወይም ያስገቡት።",
    draft_updated:"ረቂቁ ተዘምኗል",
    no_drafts:"የተቀመጠ ረቂቅ የለም። ማንኛውንም ቅጽ «እንደ ረቂቅ አስቀምጥ» በመጠቀም እዚህ ማቆየት ይችላሉ — መጀመሪያ ምንም መሞላት አያስፈልግም።",
    edit_draft:"✎ አርትዕ", submit_draft:"↑ አሁን አስገባ", delete_draft:"🗑 ሰርዝ",
    confirm_delete_draft:"ይህን ረቂቅ መሰረዝ ይፈልጋሉ? ይህ ሊቀለበስ አይችልም።",
    draft_deleted:"ረቂቁ ተሰርዟል",
    l_draft:"ረቂቅ",
    needs_gps_badge:"⚠ ጂፒኤስ ያስፈልጋል",
    draft_gps_needed_status:"⚠ ከማስገባትዎ በፊት ጂፒኤስ ያስፈልጋል — ከዚህ በታች ያለውን «ጂፒኤስ ያዝ»ን ይንኩ።",
    draft_gps_missing_toast:"ይህ ረቂቅ እስካሁን የተቀመጠ ጂፒኤስ የለውም። ከማስገባትዎ በፊት ይያዙት።",
    editing_draft_banner:"የተቀመጠ ረቂቅ በማርትዕ ላይ — ማስገባት ሲያደርጉ ይላካል እና ረቂቁ ይወገዳል።",
    draft_needs_connection:"አሁንም ከመስመር ውጪ ነዎት — ይህ ረቂቅ መስመር ላይ ሲሆኑ ይላካል።",
    drafts_ready_toast:"መስመር ላይ ተመልሰዋል — ለማስገባት ዝግጁ የሆኑ ረቂቆች አሉዎት።",
    untitled_draft:"ያልተሰየመ ረቂቅ",
    save_draft_btn:"💾 እንደ ረቂቅ አስቀምጥ",
    save_draft_hint:"እስካሁን የሞሉትን ያስቀምጣል። ምንም አስፈላጊ ነገር የለም — በኋላ ከ«ረቂቆች» ትር ይጨርሱት።",
    download_form:"⬇ ከመስመር ውጪ ለመጠቀም አውርድ", form_downloaded:"ወርዷል",
    form_downloaded_toast:"ቅጹ በዚህ መሳሪያ ላይ ተቀምጧል — በማንኛውም ጊዜ ከመስመር ውጪ ሆነው መክፈት ይችላሉ።",
    download_form_failed:"ይህን ቅጽ በመሳሪያዎ ላይ ማስቀመጥ አልተቻለም — ማከማቻ ሙሉ ሊሆን ይችላል።",
    downloaded_forms:"የወረዱ ቅጾች", no_downloaded_forms:"እስካሁን የወረደ ቅጽ የለም።",
    downloaded_forms_page_sub:"ከበይነ መረብ ውጭ ለመጠቀም ያስቀመጧቸው ቅጾች። ግንኙነት ባይኖርም ለመሙላት ይክፈቱት።",
    remove_download:"ውርዱን አስወግድ", confirm_remove_download:"ይህን የወረደ ቅጽ ከመሳሪያዎ ማስወገድ ይፈልጋሉ?",
    download_removed:"የወረደው ቅጽ ተወግዷል",
  }
};
let currentLang = 'en';
// Backed by the Firestore "settings" collection (settings/app doc) —
// see subscribeSettings(). Falls back to these values until the first
// snapshot arrives or if no settings doc exists yet.
let defaultExportFormat = 'GeoJSON';
let allowPoorGpsSubmission = true; // org-configurable — see "Anti-Poor GPS Validation"

// WORKERS_LIST now mirrors the Firestore "users" collection live (see subscribeUsers()).
// It starts empty and fills in the instant we get a snapshot.
let WORKERS_LIST = [];

// SUBMISSIONS now mirrors the Firestore "submissions" collection live (see subscribeSubmissions()).
let SUBMISSIONS = [];
// VERSIONS mirrors the "submissionVersions" collection — one entry per admin
// edit to a submission's answers, storing the full before/after snapshot so
// Version History can render old vs. new side by side.
let VERSIONS = [];

// SURVEY_TEMPLATES mirrors the "surveyTemplates" collection — every
// version an admin has ever saved via the Form Builder's "Save Template"
// button, newest first within each lineage (grouped by sourceFormId). See
// subscribeSurveyTemplates(). Immutable once written: a new save always
// adds a doc here rather than updating one.
let SURVEY_TEMPLATES = [];
// Which template lineages (sourceFormId) have their version-history row
// expanded in the Survey Templates table — purely local UI state.
let expandedTemplateLineages = new Set();

let currentUser = null;
let selectedQueueId = null;
// Cache for the supervisor review panel's fetched photo/voice memo blob:
// URLs, keyed by submission docId + the backend fileId(s) currently shown.
// renderReview() gets called on every live "submissions" snapshot update
// while a queue item is selected (see renderQueue()), so without this
// cache it would re-fetch (and flicker) the same media on every update
// instead of only when the underlying fileId actually changes.
let reviewMediaCache = { docId: null, photoUrl: null, photoObjectUrl: null, audioUrl: null, audioObjectUrl: null };
let adminMap = null, heatLayer = null, streetLayer = null, satLayer = null;
let baseLayers = {}, activeBaseLayerKey = 'street';
let markersLayer = null;
// Worker-facing "My Submissions" map (see openWorkerMap below) — a
// lightweight sibling of the admin overview map above: its own Leaflet
// instance/base layers/marker layer, scoped to just the signed-in
// worker's own submissions instead of every submission in the system.
let workerMap = null, workerStreetLayer = null, workerSatLayer = null;
let workerBaseLayers = {}, workerActiveBaseLayerKey = 'street';
let workerMarkersLayer = null;
// Satellite-only overlay of photo thumbnails (see initAdminMap/
// renderPhotoThumbnails) — a Leaflet.markercluster group so thumbnails
// collected close together cluster instead of piling on top of each other.
// Kept off the map entirely while Street is active; toggled on/off by
// switchBaseLayer() inside initAdminMap.
let photoThumbLayer = null;
let photoMarkerRegistry = new Map();
// Shared, LRU-bounded cache of fetched photo blob: URLs, keyed by backend
// fileId. Both the satellite thumbnails AND the full-resolution admin-detail
// viewer (openAdminDetail/renderAdPhotoAt) read/write through this SAME
// cache -- they're fetching the same bytes for the same fileId, so a photo
// already loaded as a thumbnail displays instantly full-res on click
// instead of hitting the network again, and vice versa. Capped so a large
// dataset (thousands of submissions) can't pin thousands of full-size blobs
// in memory forever; oldest-unused entries are evicted first. Persists
// across Street/Satellite toggles and map pans/zooms -- those never touch
// this cache, only which markers currently reference it.
const PHOTO_BLOB_CACHE_LIMIT = 150;
let photoBlobCache = new Map(); // fileId -> objectUrl, insertion-order = recency
// Any in-flight fetch for a fileId is shared rather than duplicated, so a
// thumbnail fetch and a simultaneous full-res click on the same photo only
// hit the network once.
let photoBlobInflight = new Map(); // fileId -> Promise<objectUrl>
function getCachedPhotoUrl(fileId){
  if(photoBlobCache.has(fileId)){
    // Bump recency: delete+re-set moves it to the end of Map's iteration
    // order, which the eviction loop below treats as "most recently used".
    const url = photoBlobCache.get(fileId);
    photoBlobCache.delete(fileId);
    photoBlobCache.set(fileId, url);
    return Promise.resolve(url);
  }
  if(photoBlobInflight.has(fileId)) return photoBlobInflight.get(fileId);
  const p = getMediaObjectUrl(fileId).then(url=>{
    photoBlobInflight.delete(fileId);
    photoBlobCache.set(fileId, url);
    while(photoBlobCache.size > PHOTO_BLOB_CACHE_LIMIT){
      // Evict the least-recently-used entry -- but never evict a fileId a
      // currently-visible marker or the open admin-detail modal still
      // points at, or a live <img> would go blank out from under the admin.
      const oldestKey = photoBlobCache.keys().next().value;
      if(photoUrlInUse(oldestKey)) break; // nothing safe left to evict
      const oldestUrl = photoBlobCache.get(oldestKey);
      photoBlobCache.delete(oldestKey);
      URL.revokeObjectURL(oldestUrl);
    }
    return url;
  }).catch(err=>{ photoBlobInflight.delete(fileId); throw err; });
  photoBlobInflight.set(fileId, p);
  return p;
}
// True if some currently-rendered marker or the open admin-detail modal is
// still relying on this cached fileId, i.e. it's unsafe to revoke.
function photoUrlInUse(fileId){
  if(typeof adPhotoIds !== 'undefined' && adPhotoIds.includes(fileId)) return true;
  for(const entry of photoMarkerRegistry.values()){
    if(entry.photoId === fileId) return true;
  }
  return false;
}
// Tracks which photo index is currently displayed for whichever admin-map
// marker popup is open right now, keyed by submission id. This is purely
// transient (which photo the carousel is on) -- the actual fetched blob:
// URLs are cached on markerRegistry's per-submission entries (see below) so
// they survive across popup closes/reopens instead of being re-fetched.
let popupPhotoState = {};
// Shared "No image available" placeholder for any submission photo slot —
// used both when there's no photoUrl to begin with and when a fetch/render
// of an existing photoUrl fails, so a broken photo never falls through to
// the browser's default broken-image icon. `compact` trims the padding for
// tighter spots (map popup carousel) vs. the roomier admin/review panels.
function photoUnavailableHTML(compact){
  return `<div class="photo-unavailable" style="display:flex;flex-direction:column;align-items:center;justify-content:center;gap:5px;padding:${compact?'18px 10px':'26px 12px'};color:#9a958a;background:#f1efe8;border-radius:8px;">
    <span style="font-size:${compact?'20px':'24px'};line-height:1;opacity:0.6;">🖼️</span>
    <span style="font-size:11.5px;font-style:italic;">No image available</span>
  </div>`;
}
// Formats a single answers[k] value for display in a field grid. Most
// answers are plain strings/numbers and just render as-is. Kobo-imported
// media questions (image/audio/video/file), though, get their raw filename
// string REPLACED at import time with an object — either
// { filename, url, mimeType } on success or { filename, failed: true,
// reason } when the attachment couldn't be downloaded/saved (see
// koboService.importAttachmentsForRecord's answerReplacements) — so that a
// failed import is never confused with a field nothing went wrong with.
// Naively interpolating that object into a template literal (the previous
// behavior here) stringifies it to the literal text "[object Object]",
// which is exactly what an admin would see for TAKE_A_PHOTO/RECORD_A_SOUND
// on an import whose attachment failed. This renders each case
// meaningfully instead: a clear failure reason for `failed`, and a
// filename readout (not just a bare fileId) for a successful import.
function formatAnswerValue(value){
  if(value && typeof value === 'object'){
    if(value.failed){
      return `<span style="color:var(--red,#b4432f);">⚠️ Import failed — ${escapeHtml(value.filename || 'file')}${value.reason ? ` (${escapeHtml(value.reason)})` : ''}</span>`;
    }
    if(value.url){
      return `<span>📎 ${escapeHtml(value.filename || 'Attached file')}</span>`;
    }
    return '—';
  }
  return value;
}
// Wires an <img> element so that if the image it's already pointed at
// (e.g. a resolved blob: URL) turns out to be corrupt/unrenderable, the
// element is swapped for the same placeholder used for fetch failures,
// instead of showing the browser's broken-image icon. Safe to call
// multiple times on the same element.
function wireImgFallback(imgEl, compact){
  if(!imgEl) return;
  imgEl.onerror = ()=>{
    console.warn('Submission photo failed to render:', imgEl.src);
    const holder = document.createElement('div');
    holder.innerHTML = photoUnavailableHTML(compact);
    imgEl.replaceWith(holder.firstElementChild);
  };
}
let workerNotifs = [];
let gpsCaptured = null, micCaptured = false, mediaRecorder = null, recordedChunks = [], recordedBlob = null, recordedSeconds = 0, micTimerInterval = null;
let gpsWatchId = null, gpsTimeoutHandle = null;
let gpsReadings = [];       // rolling buffer of the last GPS_READING_BUFFER_SIZE raw readings, best-first is NOT assumed — filtered/sorted on demand
let gpsCaptureStartedAt = 0; // Date.now() when the current capture attempt began, for captureDurationMs
const GPS_REQUIRED_ACCURACY_ONLINE = 5;   // meters — required accuracy before a fix is accepted while online (see "GPS Lock")
const GPS_REQUIRED_ACCURACY_OFFLINE = 20; // meters — relaxed threshold while offline: a field worker with no signal
                                           // can't wait indefinitely for a 5m fix, and an offline draft's location
                                           // is already inherently provisional until it syncs. 20m matches the
                                           // existing "Fair" GPS quality tier (see gpsQualityTier()) and the
                                           // pre-existing >20m "poor GPS" admin warning threshold, so a fix
                                           // accepted here is exactly the same one the UI already calls
                                           // acceptable, not a newly-invented cutoff.
// Resolved once per capture attempt (in startGpsCapture, below) rather than
// read live on every watchPosition callback — if connectivity flips midway
// through a single capture, the target it's converging toward shouldn't
// silently change out from under the worker.
let GPS_REQUIRED_ACCURACY = GPS_REQUIRED_ACCURACY_ONLINE;
const GPS_TIMEOUT_MS = 30000;       // 30s — if not locked by then, offer Retry / Save Anyway / Cancel
const GPS_WARMUP_TIMEOUT_MS = 8000; // low-accuracy (network/Wi-Fi) fix used as a fast, reliable safety
                                     // net before the high-accuracy GNSS watch — see startGpsCapture().
                                     // Counts against, not on top of, GPS_TIMEOUT_MS.
const GPS_READING_BUFFER_SIZE = 10; // "Store the latest 10 GPS readings"
const GPS_SANITY_CEILING_M = 200;   // readings worse than this are treated as noise and ignored entirely
const GPS_WARN_ACCURACY_M = 20;     // "Warn the worker if Accuracy > 20m"
// Dynamic answer-section state: answerValues holds one entry per non-media
// question in the worker's assigned form, keyed by question id.
// currentGpsQ/currentPhotoQ/currentAudioQ point at whichever question (if
// any) in that form is of type gps/photo/audio, so the capture boxes below
// can show that question's own label and file the captured value under it —
// this is what "links" GPS/photo/voice capture to the assigned form instead
// of them being fixed, form-independent fields.
let answerValues = {};
let currentGpsQ = null, currentPhotoQ = null, currentAudioQ = null;
let lastRenderedAnswerFormId = undefined;

function assignedTemplate(){
  // A worker who explicitly opened a form from the Downloaded Forms list
  // (see offlineFormOverrideId above) is filling THAT form, full stop —
  // this takes priority over every other resolution below, since those
  // all depend on currentUser.assignedFormId / FORM_TEMPLATES, which is
  // exactly the data that may not be available offline.
  if(offlineFormOverrideId){
    const overridden = FORM_TEMPLATES.find(t=>t.id===offlineFormOverrideId) || downloadedFormById(offlineFormOverrideId);
    if(overridden) return overridden;
  }
  // Prefer a form an admin explicitly sent this worker; fall back to
  // whichever form is currently marked active in Firestore so workers
  // always have something to collect against even if nothing was sent
  // to them directly. As a last resort, fall back to a copy the worker
  // explicitly downloaded — this is what keeps the assigned form openable
  // offline even if Firestore's own cache hasn't hydrated yet (or was
  // cleared) on this device.
  return FORM_TEMPLATES.find(t=>t.id===currentUser.assignedFormId)
      || FORM_TEMPLATES.find(t=>t.active)
      || (currentUser.assignedFormId && downloadedFormById(currentUser.assignedFormId))
      || null;
}

// A single_choice answer is stored as one string, but can represent BOTH a
// parent option and one of its sub-choices at once ("Parent — Sub"). These
// two helpers are the single source of truth for combining/splitting that
// string, so every place that reads or writes a single_choice value agrees
// on the format. (Assumes an option's own label never contains " — ".)
const CHOICE_SEP = '\u001F'; // ASCII Unit Separator — cannot appear in typed/typeable text, so it can no longer collide with a parent value that legitimately contains ' — ' (e.g. a place name typed with an em dash)
function parseChoiceValue(val){
  if(!val) return {parent:'', sub:''};
  const idx = String(val).indexOf(CHOICE_SEP);
  if(idx===-1) return {parent:val, sub:''};
  return {parent:val.slice(0, idx), sub:val.slice(idx+CHOICE_SEP.length)};
}
function composeChoiceValue(parent, sub){
  if(!parent) return '';
  return sub ? `${parent}${CHOICE_SEP}${sub}` : parent;
}

// Builds the HTML for one question's answer field (label + input(s)),
// reading its current value out of the shared answerValues state.
function questionFieldHTML(q){
  const val = answerValues[q.id];
  const esc = (s)=> String(s==null?'':s).replace(/"/g,'&quot;');
  const reqMark = q.required ? ` <span style="color:var(--red);">*</span>` : '';
  let inner = '';
  if(q.type==='short_text'){
    inner = `<input class="input" style="margin-bottom:0;" data-qid="${q.id}" data-qtype="short_text" value="${esc(val)}" />`;
  } else if(q.type==='number'){
    inner = `<input type="number" class="input" style="margin-bottom:0;" data-qid="${q.id}" data-qtype="number" value="${esc(val)}" />`;
  } else if(q.type==='date'){
    inner = `<input type="date" class="input" style="margin-bottom:0;" data-qid="${q.id}" data-qtype="date" value="${esc(val)}" />`;
  } else if(q.type==='single_choice'){
    // A single-choice answer can now carry BOTH a top-level pick and one of
    // its sub-choices at once — stored together as "Parent — Sub" (see
    // parseChoiceValue/composeChoiceValue below) — rather than the sub-
    // choice silently replacing the parent as the answer. Parent options
    // and sub-choices are therefore two separate radio groups (own name=
    // per group) so checking one doesn't uncheck the other natively; we
    // keep them each individually exclusive (one parent, one sub) and let
    // JS keep both visible states + the combined value in sync.
    const parsed = parseChoiceValue(val);
    inner = (q.options||[]).map(o=>{
      const lbl = optLabel(o);
      const subOpts = (typeof o!=='string' && o.subOptions) ? o.subOptions : [];
      const isParentSelected = parsed.parent===lbl;
      const isGroupActive = isParentSelected;
      const subs = subOpts.length ? `<div class="choice-subwrap${isGroupActive?' show':''}" data-parent-qid="${q.id}">${
        subOpts.map(s=>{
          const slbl = optLabel(s);
          const isSubSelected = isParentSelected && parsed.sub===slbl;
          return `<label class="choice-opt choice-suboption${isSubSelected?' selected':''}" style="display:flex;align-items:center;gap:8px;font-size:12.5px;font-weight:400;margin-bottom:6px;color:var(--ink);"><input type="radio" name="ans-${q.id}-sub" value="${esc(slbl)}" data-qid="${q.id}" data-qtype="single_choice" data-role="sub" data-parent-label="${esc(lbl)}" ${isSubSelected?'checked':''} /> ↳ ${slbl}</label>`;
        }).join('')
      }</div>` : '';
      return `<label class="choice-opt${isParentSelected?' selected':''}" style="display:flex;align-items:center;gap:8px;font-size:13px;font-weight:400;margin-bottom:6px;color:var(--ink);"><input type="radio" name="ans-${q.id}" value="${esc(lbl)}" data-qid="${q.id}" data-qtype="single_choice" data-role="parent" ${isParentSelected?'checked':''} /> ${lbl}</label>${subs}`;
    }).join('');
  } else if(q.type==='multi_choice'){
    const arr = Array.isArray(val) ? val : [];
    inner = (q.options||[]).map(o=>{
      const lbl = optLabel(o);
      const subOpts = (typeof o!=='string' && o.subOptions) ? o.subOptions : [];
      const isParentChecked = arr.includes(lbl);
      const isGroupActive = isParentChecked || subOpts.some(s=>arr.includes(optLabel(s)));
      const subs = subOpts.length ? `<div class="choice-subwrap${isGroupActive?' show':''}" data-parent-qid="${q.id}">${
        subOpts.map(s=>{
          const slbl = optLabel(s);
          return `<label class="choice-opt choice-suboption${arr.includes(slbl)?' selected':''}" style="display:flex;align-items:center;gap:8px;font-size:12.5px;font-weight:400;margin-bottom:6px;color:var(--ink);"><input type="checkbox" value="${esc(slbl)}" data-qid="${q.id}" data-qtype="multi_choice" ${arr.includes(slbl)?'checked':''} /> ↳ ${slbl}</label>`;
        }).join('')
      }</div>` : '';
      return `<label class="choice-opt${isParentChecked?' selected':''}" style="display:flex;align-items:center;gap:8px;font-size:13px;font-weight:400;margin-bottom:6px;color:var(--ink);"><input type="checkbox" value="${esc(lbl)}" data-qid="${q.id}" data-qtype="multi_choice" ${isParentChecked?'checked':''} /> ${lbl}</label>${subs}`;
    }).join('');
  }
  return `<div class="pwa-field"><label>${q.label || I18N[currentLang].untitled_question}${reqMark}</label>${inner}</div>`;
}

// Renders a list of (non-media) questions as writable fields into any
// container — used for both the New Submission tab's Answers section and
// the form-preview modal, so a worker can write responses from either
// place. Both copies read/write the same answerValues state, so typing in
// one keeps the other in sync.
function renderQuestionsInto(container, questions){
  container.innerHTML = questions.map(q=>questionFieldHTML(q)).join('');
  container.querySelectorAll('[data-qid]').forEach(inp=>{
    inp.addEventListener('input', onAnswerFieldChange);
    inp.addEventListener('change', onAnswerFieldChange);
  });
}

// Pushes a just-changed answer back into any other rendered copy of that
// same question (e.g. keeps the modal and the New Submission tab in sync
// with each other) without disturbing whichever field the worker is
// actively typing in. Not used for single_choice — see syncSingleChoiceUI,
// since a single_choice value can represent a parent+sub pair rather than
// one plain value a radio's own .value can be compared against.
function syncAnswerFieldsUI(qid, sourceEl){
  const val = answerValues[qid];
  document.querySelectorAll(`[data-qid="${qid}"]`).forEach(el=>{
    if(el === sourceEl) return;
    if(el.type==='checkbox') el.checked = Array.isArray(val) && val.includes(el.value);
    else if(el.type==='radio') el.checked = (el.value === val);
    else el.value = val || '';
    const label = el.closest('.choice-opt');
    if(label) label.classList.toggle('selected', el.checked);
  });
}

// Re-applies a single_choice question's current answerValues[qid] (a plain
// label, or a "Parent — Sub" combo — see parseChoiceValue) to every rendered
// copy of that question: checks the matching parent radio AND, separately,
// the matching sub radio (they're independent radio groups so both can be
// checked together), toggles each .choice-opt's .selected class, and shows/
// hides each option's sub-choice list based on whether its own parent is
// the one currently selected.
function syncSingleChoiceUI(qid){
  const parsed = parseChoiceValue(answerValues[qid]);
  document.querySelectorAll(`[data-qid="${qid}"][data-qtype="single_choice"]`).forEach(el=>{
    const checked = el.dataset.role==='sub'
      ? (parsed.parent===el.dataset.parentLabel && parsed.sub===el.value)
      : (parsed.parent===el.value);
    el.checked = checked;
    const label = el.closest('.choice-opt');
    if(label) label.classList.toggle('selected', checked);
  });
  document.querySelectorAll(`.choice-subwrap[data-parent-qid="${qid}"]`).forEach(wrap=>{
    const parentInput = wrap.previousElementSibling ? wrap.previousElementSibling.querySelector('input[data-role="parent"]') : null;
    wrap.classList.toggle('show', !!(parentInput && parsed.parent===parentInput.value));
  });
}

// Builds/refreshes the "Answers" section from the worker's currently
// assigned form template, and points the GPS/Photo/Voice capture boxes at
// whichever question in that form they correspond to. Pass `prefill` (an
// answers object keyed by question label, as stored on a submission) to
// repopulate values — used when starting a resubmit/correction.
function renderAnswerFields(prefill){
  const t = assignedTemplate();
  const questions = (t && t.questions) || [];
  const regular = questions.filter(q=>!['gps','photo','audio'].includes(q.type));

  answerValues = {};
  regular.forEach(q=>{
    const existing = prefill && prefill[q.label] !== undefined ? prefill[q.label] : undefined;
    answerValues[q.id] = q.type==='multi_choice'
      ? (existing ? String(existing).split(',').map(x=>x.trim()).filter(Boolean) : [])
      : (existing || '');
  });

  document.getElementById('pwa-answers-field').style.display = regular.length ? 'block' : 'none';
  renderQuestionsInto(document.getElementById('pwa-answers'), regular);

  // Link the GPS / photo / voice capture boxes to whichever question of
  // that type exists on the assigned form, so their labels — and later the
  // captured values — come from the form itself rather than being fixed.
  currentGpsQ = questions.find(q=>q.type==='gps') || null;
  currentPhotoQ = questions.find(q=>q.type==='photo') || null;
  currentAudioQ = questions.find(q=>q.type==='audio') || null;
  updateCaptureLabels();
}

// Refreshes the GPS/photo/voice capture box labels and hint text from
// whichever question of that type is on the assigned form — including any
// custom hint the admin set in the Form Builder — falling back to the
// generic i18n copy when there's no form or no custom hint. Re-run on every
// language switch too, since applyI18n() blindly resets data-i18n elements.
function updateCaptureLabels(){
  document.getElementById('gps-label').textContent = currentGpsQ ? currentGpsQ.label : I18N[currentLang].gps_location;
  const photoOptional = !(currentPhotoQ && currentPhotoQ.required);
  const voiceOptional = !(currentAudioQ && currentAudioQ.required);
  document.getElementById('photo-label').textContent = (currentPhotoQ ? currentPhotoQ.label : I18N[currentLang].photo) + (photoOptional ? ' (optional)' : '');
  document.getElementById('voice-label').textContent = (currentAudioQ ? currentAudioQ.label : I18N[currentLang].voice_memo) + (voiceOptional ? ' (optional)' : '');
  document.getElementById('photo-prompt').textContent = (currentPhotoQ && currentPhotoQ.hint) ? currentPhotoQ.hint : I18N[currentLang].photo_prompt;
  document.getElementById('mic-prompt').textContent = (currentAudioQ && currentAudioQ.hint) ? currentAudioQ.hint : I18N[currentLang].mic_prompt;
}

function onAnswerFieldChange(e){
  const qid = e.target.dataset.qid, qtype = e.target.dataset.qtype;
  if(qtype==='multi_choice'){
    // Scope the "checked" lookup to whichever copy of this question the
    // worker is actually editing (modal vs. the New Submission tab), so the
    // other, currently-hidden copy doesn't leak its own checked state in.
    const scope = e.target.closest('#pwa-answers, #fp-questions') || document;
    // Unchecking a parent option hides its sub-choices again — clear them
    // too, rather than leaving a hidden sub-choice silently still selected.
    if(e.target.type==='checkbox' && !e.target.checked){
      const subwrap = e.target.closest('.choice-opt').nextElementSibling;
      if(subwrap && subwrap.classList.contains('choice-subwrap')){
        subwrap.querySelectorAll('input[type="checkbox"]').forEach(childInput=>{ childInput.checked = false; });
      }
    }
    answerValues[qid] = Array.from(scope.querySelectorAll(`[data-qid="${qid}"]:checked`)).map(el=>el.value);
    // Belt-and-braces visual feedback: toggle the .selected class directly
    // rather than relying solely on the :has() CSS selector, so a tap always
    // visibly highlights the chosen option even on older mobile browsers/
    // webviews that don't support :has().
    document.querySelectorAll(`[data-qid="${qid}"]`).forEach(el=>{
      const label = el.closest('.choice-opt');
      if(label) label.classList.toggle('selected', el.checked);
    });
    syncAnswerFieldsUI(qid, e.target);
    updateSubchoiceVisibility(qid);
  } else if(qtype==='single_choice'){
    const role = e.target.dataset.role;
    if(role==='sub'){
      // Picking a sub-choice keeps its parent selected too — the answer
      // becomes the "Parent — Sub" combo, not just the sub-choice alone.
      answerValues[qid] = composeChoiceValue(e.target.dataset.parentLabel, e.target.value);
    } else {
      // Picking a parent option: if it already had a sub-choice selected,
      // keep it (re-picking the same parent shouldn't lose that). Switching
      // to a *different* parent drops the old parent's sub-choice, since it
      // no longer applies.
      const prev = parseChoiceValue(answerValues[qid]);
      answerValues[qid] = (prev.parent===e.target.value) ? composeChoiceValue(prev.parent, prev.sub) : e.target.value;
    }
    syncSingleChoiceUI(qid);
  } else {
    answerValues[qid] = e.target.value;
    syncAnswerFieldsUI(qid, e.target);
  }
  updateSubmitState();
}

// Same belt-and-braces reasoning as the .selected toggle above: reveals or
// hides each option's .choice-subwrap based on whether its parent option
// (or, for a single-choice question, one of its own sub-choices directly)
// is currently selected — without relying solely on the CSS :has() rules.
function updateSubchoiceVisibility(qid){
  document.querySelectorAll(`.choice-subwrap[data-parent-qid="${qid}"]`).forEach(wrap=>{
    const parentLabel = wrap.previousElementSibling;
    const parentInput = parentLabel ? parentLabel.querySelector('input') : null;
    const parentChecked = !!(parentInput && parentInput.checked);
    const childChecked = !!wrap.querySelector('input:checked');
    wrap.classList.toggle('show', parentChecked || childChecked);
  });
}

// Escapes text before it's interpolated into an innerHTML template
// literal. Every innerHTML site in this file that inserts user-typed
// content (review comments, notification titles/comments, names, etc.
// — anything that ultimately came from someone filling in a text field,
// as opposed to a string this file itself constructed) MUST pass that
// value through this first, or a comment like
// `<img src=x onerror=alert(1)>` typed into a review/rejection note
// would execute as real HTML for the next person who views it. Plain
// UI chrome/labels built entirely by this code don't need it.
function escapeHtml(str){
  if(str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Every question needs a non-empty key when written into an answers{}
// object — Firestore's setDoc()/update() reject a document outright if
// any field name is "". A template question can still have a blank
// label (e.g. an admin-created question never given a title), so ANY
// place that does answers[q.label] = ... must go through this helper
// instead of using q.label directly.
function safeAnswerKey(q){
  return (q && q.label && q.label.trim()) || `Untitled question (${q && q.id})`;
}

// Turns the live answerValues state into a plain {label: value} object for
// saving — this is what actually gets stored as the submission's `answers`.
function buildAnswersObject(){
  const t = assignedTemplate();
  const questions = (t && t.questions) || [];
  const answers = {};
  questions.filter(q=>!['gps','photo','audio'].includes(q.type)).forEach(q=>{
    const v = answerValues[q.id];
    answers[safeAnswerKey(q)] = Array.isArray(v) ? v.join(', ') : (v || '');
  });
  return answers;
}

// The submission's location field always stores the captured GPS point as
// a "lat, lng" string now, rather than trying to guess a region/kebele name
// out of the worker's answers — coordinates are unambiguous and always
// available, where an answer-derived label wasn't.
function formatCoords(gps){
  if(!gps) return '';
  return `${gps.lat.toFixed(5)}, ${gps.lng.toFixed(5)}`;
}
// photoBlob is the actual (compressed) file that gets uploaded to Storage;
// photoPreviewUrl is a local, temporary blob: URL just for the <img> tag —
// never sent anywhere, and always revoked when replaced/cleared so we don't
// leak object URLs over the life of a long-running session.
// photoExifGps holds { lat, lng, altitude } read out of the ORIGINAL file's
// EXIF metadata (before readAndCompressImage's canvas re-encode strips it),
// or null if the photo had no usable GPS EXIF tag — see extractExifGps() /
// computePhotoGps(). Null means "fall back to the submission's own GPS fix".
let photoCaptured = false, photoBlob = null, photoPreviewUrl = null, photoRemoved = false, photoExifGps = null;
let usersUnsub = null, submissionsUnsub = null, notifsUnsub = null, templatesUnsub = null, ownProfileUnsub = null, versionsUnsub = null, settingsUnsub = null, koboFormsUnsub = null, reviewHistoryUnsub = null, surveyTemplatesUnsub = null;

/* ---------------- i18n apply ---------------- */
function applyI18n(){
  document.querySelectorAll('[data-i18n]').forEach(el=>{
    const key = el.getAttribute('data-i18n');
    if(I18N[currentLang][key]) el.textContent = I18N[currentLang][key];
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el=>{
    const key = el.getAttribute('data-i18n-placeholder');
    if(I18N[currentLang][key]) el.placeholder = I18N[currentLang][key];
  });
  document.getElementById('lang-en').classList.toggle('active', currentLang==='en');
  document.getElementById('lang-am').classList.toggle('active', currentLang==='am');
  document.documentElement.lang = currentLang;
  if(currentUser) renderNav();
  if(currentUser && currentUser.role==='worker') renderDownloadedFormsSidebar();
  if(typeof updateCaptureLabels==='function') updateCaptureLabels();
}
document.getElementById('lang-en').onclick = ()=>{ currentLang='en'; applyI18n(); refreshCurrentView(); };
document.getElementById('lang-am').onclick = ()=>{ currentLang='am'; applyI18n(); refreshCurrentView(); };

/* ---------------- Login ---------------- */

document.getElementById('login-btn').onclick = doLogin;
document.getElementById('login-email').addEventListener('keydown', e=>{ if(e.key==='Enter') doLogin(); });
document.getElementById('login-password').addEventListener('keydown', e=>{ if(e.key==='Enter') doLogin(); });

async function doLogin(){
  const email = document.getElementById('login-email').value.trim().toLowerCase();
  const pass = document.getElementById('login-password').value;
  const errEl = document.getElementById('login-error');
  const okEl = document.getElementById('login-success');
  const btn = document.getElementById('login-btn');
  errEl.style.display = 'none';
  okEl.style.display = 'none';

  if(!email || !pass){
    errEl.textContent = I18N[currentLang].login_error;
    errEl.style.display = 'block';
    return;
  }

  btn.disabled = true;
  const originalLabel = btn.textContent;
  btn.textContent = I18N[currentLang].signing_in;

  try{
    await signInWithEmailAndPassword(auth, email, pass);
    // enterApp() runs automatically via onAuthStateChanged below
  }catch(err){
    let msg = I18N[currentLang].login_error;
    if(err.code === 'auth/too-many-requests') msg = 'Too many attempts — try again in a moment.';
    else if(err.code === 'auth/network-request-failed') msg = 'Network error — check your connection and try again.';
    errEl.textContent = msg;
    errEl.style.display = 'block';
    btn.disabled = false;
    btn.textContent = originalLabel;
  }
  // On success we deliberately leave the button disabled/labeled "Signing in…" —
  // onAuthStateChanged will swap to the app screen momentarily, so re-enabling
  // it here would just let someone double-submit while that's in flight.
}

/* ---------------- First-admin bootstrap ----------------
   Problem: there's no self-signup, and new users can only be created by an
   existing admin (via the secondary-app trick above) — so on a brand new
   deployment, with zero users, nobody can ever get in. Something has to
   create the very first admin.

   Rather than requiring someone to reach into the Firebase console by hand,
   we offer a "set up the first admin" link on the login screen, but it only
   works while no admin has been created yet. That "has an admin been
   created yet?" flag lives in a small public doc — meta/bootstrap — instead
   of being inferred by counting the users collection, because unauth'd
   visitors can't (and shouldn't be able to) list/query `users` at all.

   THIS CLIENT-SIDE CHECK IS A UX CONVENIENCE ONLY. The real enforcement has
   to live in Firestore Security Rules, e.g.:

     match /meta/bootstrap {
       allow read: if true;
       // Only flips false -> true, once, by whoever is creating themselves
       // as the first admin doc in the same request.
       allow update: if request.auth != null
         && resource.data.done == false
         && request.resource.data.done == true;
     }
     match /users/{uid} {
       allow create: if request.auth != null && request.auth.uid == uid
         && request.resource.data.role == 'admin'
         && get(/databases/$(database)/documents/meta/bootstrap).data.done == false;
       // ...existing admin-only create/update rules for every other case...
     }

   Without those rules, this UI is decorative, not a security boundary.
   Also note: anyone who reaches the app before the real admin runs this
   flow could claim the first-admin slot themselves — so run it immediately
   after deploying, before sharing the link with anyone. */
async function checkBootstrapNeeded(){
  try{
    const snap = await getDoc(doc(db, 'meta', 'bootstrap'));
    const done = snap.exists() && snap.data().done === true;
    document.getElementById('bootstrap-prompt').style.display = done ? 'none' : 'block';
    return !done;
  }catch(err){
    // If the meta doc can't be read (rules not deployed yet, offline, etc.)
    // fail closed on the UI hint — don't advertise a flow we can't verify —
    // but don't block normal sign-in either.
    console.error('Bootstrap check failed:', err);
    document.getElementById('bootstrap-prompt').style.display = 'none';
    return false;
  }
}

function showBootstrapCard(show){
  document.querySelector('#login-screen .login-card').style.display = show ? 'none' : 'block';
  document.getElementById('bootstrap-card').style.display = show ? 'block' : 'none';
  document.getElementById('bootstrap-error').style.display = 'none';
  if(show){
    document.getElementById('bootstrap-name').value = '';
    document.getElementById('bootstrap-email').value = '';
    document.getElementById('bootstrap-password').value = '';
    document.getElementById('bootstrap-confirm').value = '';
  }
}
document.getElementById('bootstrap-link').onclick = (e)=>{ e.preventDefault(); showBootstrapCard(true); };
document.getElementById('bootstrap-back-link').onclick = (e)=>{ e.preventDefault(); showBootstrapCard(false); };

function showBootstrapError(msg){
  const el = document.getElementById('bootstrap-error');
  el.textContent = msg;
  el.style.display = 'block';
}

document.getElementById('bootstrap-confirm-btn').onclick = async ()=>{
  const name = document.getElementById('bootstrap-name').value.trim();
  const email = document.getElementById('bootstrap-email').value.trim().toLowerCase();
  const password = document.getElementById('bootstrap-password').value;
  const confirm = document.getElementById('bootstrap-confirm').value;
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const btn = document.getElementById('bootstrap-confirm-btn');

  if(!name || !emailPattern.test(email) || password.length < 6){
    showBootstrapError('Fill in every field — password needs 6+ characters.');
    return;
  }
  if(password !== confirm){
    showBootstrapError('Passwords do not match.');
    return;
  }

  btn.disabled = true;
  const originalLabel = btn.textContent;
  btn.textContent = 'Creating…';

  // Re-check right before writing, to shrink (not eliminate — only Security
  // Rules can truly eliminate) the race where two people click the link at
  // the same time. Whichever request the backend accepts second will fail
  // the Firestore rule above and land in the catch block below.
  const stillNeeded = await checkBootstrapNeeded();
  if(!stillNeeded){
    showBootstrapError('An admin account already exists — please sign in instead.');
    btn.disabled = false;
    btn.textContent = originalLabel;
    showBootstrapCard(false);
    return;
  }

  try{
    // Signs the browser in as this brand-new account directly on the
    // primary `auth` instance — unlike the admin "add user" flow, there is
    // no existing session here to protect, so no secondary-app dance is
    // needed. onAuthStateChanged will pick this up once the profile doc
    // below exists and take them straight into the app as admin.
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    await setDoc(doc(db, 'users', cred.user.uid), {
      uid: cred.user.uid,
      name, email, role: 'admin',
      supervisor: '—',
      supervisorId: null,
      active: true,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
    await setDoc(doc(db, 'meta', 'bootstrap'), {
      done: true,
      createdBy: cred.user.uid,
      createdAt: serverTimestamp()
    }, { merge: true });
    // enterApp() runs automatically via onAuthStateChanged below.
  }catch(err){
    console.error('First-admin bootstrap failed:', err);
    if(err.code === 'auth/email-already-in-use'){
      showBootstrapError('That email is already registered. Try signing in, or ask an admin to reset it.');
    } else if(err.code === 'permission-denied'){
      showBootstrapError('An admin account already exists — please sign in instead.');
    } else {
      showBootstrapError(err.message || 'Could not create the admin account.');
    }
    btn.disabled = false;
    btn.textContent = originalLabel;
  }
};

// Fires on every page load (restoring a previous session) and right after
// a successful sign-in. This is the single entry point into the app.
// ---------------------------------------------------------------------
// Second, independent local copy of "who am I / what's my role", kept in
// plain localStorage — separate from Firestore's own IndexedDB-based
// persistentLocalCache used elsewhere in this file. The two are
// deliberately redundant: Firestore's cache is the primary source (it's
// also what keeps the rest of the app's data offline-capable), but it's
// one specific storage layer, and specific browsers/modes are known to
// evict or refuse to persist IndexedDB more aggressively than plain
// localStorage (Safari's ITP, some incognito/private-browsing configs,
// storage-pressure eviction). A worker who has successfully gotten into
// the app even once on a device should never be locked out again just
// because that one layer had a bad day — "stay logged in until Logout or
// an admin disables the account" shouldn't depend on which cache API
// happened to survive. Only the fields the UI actually needs are stored;
// nothing sensitive beyond what's already visible in the signed-in app.
function profileSnapshotKey(uid){ return `geosurvey_profile_snapshot_${uid}`; }
function saveProfileSnapshot(profile){
  try{
    localStorage.setItem(profileSnapshotKey(profile.uid), JSON.stringify(profile));
  }catch(e){
    // Storage full/disabled — nothing to do; Firestore's own cache is
    // still the primary path and this is only ever a fallback.
    console.warn('Could not save local profile snapshot:', e);
  }
}
function loadProfileSnapshot(uid){
  try{
    const raw = localStorage.getItem(profileSnapshotKey(uid));
    return raw ? JSON.parse(raw) : null;
  }catch(e){
    console.warn('Could not read local profile snapshot:', e);
    return null;
  }
}
function clearProfileSnapshot(uid){
  try{
    localStorage.removeItem(profileSnapshotKey(uid));
  }catch(e){
    console.warn('Could not clear local profile snapshot:', e);
  }
}

initializeAuth(async (user)=>{
  // The very first call resolves whatever session Firebase restored from
  // local storage (or confirms there isn't one) — only then do we know
  // whether to show the login form or the app, so the spinner covers
  // everything until this fires once, instead of flashing the login screen.
  document.getElementById('auth-checking').style.display = 'none';

  if(!user){
    exitApp();
    checkBootstrapNeeded();
    return;
  }
  // DEBUG [auth]: confirm resume-hook fires on both a restored session
  // and a fresh interactive login (this callback runs on every
  // subsequent sign-in, not just the first restore — see session.js).
  console.log('[auth] initializeAuth callback: signed-in user confirmed, uid =', user.uid, '— resuming upload queue');
  // Any uploads queued while unauthenticated (or that gave up before
  // this sign-in completed) get a chance to run now, instead of
  // waiting up to PERIODIC_FLUSH_MS for the queue's own timer to
  // notice. See resumeAfterAuthChange() in auth/uploadQueue.js.
  uploadQueue.resumeAfterAuthChange();
  const errEl = document.getElementById('login-error');

  // SECURITY: role/active/supervisorId are never trusted from anywhere
  // client-side (not from a cached variable, not from the login form, not
  // from Firebase Auth custom claims in this app). Firestore security rules
  // must independently enforce the same read/write restrictions
  // server-side; this client-side read only drives the UI. Revocation is
  // still fully enforced even on a cache hit below, because enterApp()
  // immediately starts subscribeOwnProfile() — a *live* listener on this
  // same document — which re-confirms active/role the instant a real
  // connection exists and signs the worker out then if it's been disabled.
  async function applyProfileAndEnter(profile){
    if(profile.active === false){
      errEl.textContent = I18N[currentLang].err_account_disabled;
      errEl.style.display = 'block';
      await signOut(auth);
      return;
    }
    currentUser = {
      uid: profile.uid || user.uid,
      email: profile.email || user.email,
      name: profile.name,
      role: profile.role,
      supervisorId: profile.supervisorId || null,
      active: profile.active !== false,
      assignedFormId: profile.assignedFormId || null,
      assignedFormName: profile.assignedFormName || null,
      assignedFormVersion: profile.assignedFormVersion || null,
      personalEmail: profile.personalEmail || null,
      fcmTokens: Array.isArray(profile.fcmTokens) ? profile.fcmTokens : []
    };
    saveProfileSnapshot(currentUser);
    enterApp();
  }

  // CACHE FIRST, always — not just as a fallback after a failed network
  // read. A worker who has ever signed in successfully on this device
  // already has their profile sitting in Firestore's local IndexedDb cache
  // (persistentLocalCache, configured above), and reading it needs no
  // network at all. Checking it first — rather than trying the server and
  // only falling back to cache once that throws — is what actually fixes
  // "opens the app offline, sees a scary error": the old order raced a
  // live network call every time, gated by navigator.onLine, which is
  // notoriously unreliable (it reports "online" for a WiFi network with no
  // working internet, a captive portal, or a signal too weak to actually
  // reach Firestore — exactly the conditions a field worker hits). None of
  // that matters if we never need the network in the first place.
  try{
    const cachedSnap = await getDocFromCache(doc(db, 'users', user.uid));
    if(cachedSnap.exists()){
      await applyProfileAndEnter(cachedSnap.data());
      return;
    }
  }catch(cacheErr){
    // Nothing cached yet on this device (e.g. first-ever login) — fall
    // through to the network read below, which is the only way in this
    // case.
  }

  try{
    const profileSnap = await getDoc(doc(db, 'users', user.uid));
    if(!profileSnap.exists()){
      errEl.textContent = 'No profile found for this account. Ask an admin to set one up in Firestore.';
      errEl.style.display = 'block';
      await signOut(auth);
      return;
    }
    await applyProfileAndEnter(profileSnap.data());
  }catch(err){
    console.error('Failed to load user profile:', err);
    // Distinguish "we're offline / this read failed" from "this account is
    // actually invalid." Firebase Auth's own session is stored locally and
    // survives being offline (or any other read failure) just fine — the
    // thing that can fail here is only the Firestore profile read. Signing
    // out on every kind of read failure (as this used to, for anything that
    // wasn't literally 'unavailable'/'failed-precondition') meant a worker
    // could get logged out on reopen just from a transient error — a
    // permission hiccup, a blocked/CORS-like request, a timeout — which
    // directly defeats "stay logged in until I explicitly log out." So:
    // this branch now NEVER signs the worker out. The only things that end
    // a session are the Logout button (logoutUser()) and the *live*
    // subscribeOwnProfile() listener confirming — while actually connected —
    // that the account is genuinely disabled or removed. That still fully
    // enforces account revocation; it just doesn't punish a worker for a
    // network/read error on reopen.
    //
    // We only land here at all when there was NO cached profile for this
    // device to fall back on (see the cache-first check above) — so there
    // really is nothing to show the worker yet. Leave the Auth session
    // alone; the app will retry automatically once this read can succeed
    // (e.g. connectivity returns, or whatever blocked the request clears) —
    // see the window 'online' handler below, which reloads to pick the
    // restore flow back up the moment the browser sees a connection again.
    //
    // LAST RESORT before giving up: Firestore's own IndexedDB cache had
    // nothing usable for this uid (or errored reading it), but this device
    // may still have the plain-localStorage snapshot saved on this worker's
    // last successful sign-in (see saveProfileSnapshot() above). Two
    // independent local copies means one specific storage layer having a
    // bad day (IndexedDB eviction, a locked-tab-manager edge case, etc.)
    // doesn't strand a worker who has already proven they can get in on
    // this device. It's necessarily a little stale — role/active could have
    // changed since it was saved — but subscribeOwnProfile() (started by
    // enterApp() below) reconciles that live the instant a real connection
    // exists, exactly like the fresher paths above.
    const snapshot = loadProfileSnapshot(user.uid);
    if(snapshot){
      if(snapshot.active === false){
        // Even a stale snapshot saying "disabled" is still worth respecting
        // — don't let a locally-remembered disabled account back in.
        errEl.textContent = I18N[currentLang].err_account_disabled;
        errEl.style.display = 'block';
        await signOut(auth);
        return;
      }
      currentUser = snapshot;
      enterApp();
      return;
    }

    // Which message to show is decided from Firestore's OWN error code, not
    // navigator.onLine. navigator.onLine only reports whether a network
    // interface is up, not whether it can reach anything — it reads `true`
    // on a WiFi network with no working internet, a captive portal, or (as
    // seen in the field) a connection where DNS itself can't resolve
    // firestore.googleapis.com. Firestore's own SDK already does the real
    // connectivity check for us: it fails fast with code 'unavailable' (and
    // the message "...because the client is offline") the moment it knows
    // it can't reach the backend, or 'deadline-exceeded' if a request timed
    // out trying. Either of those means "this is a connectivity problem,"
    // regardless of what navigator.onLine claims.
    const looksOffline = !navigator.onLine || err.code === 'unavailable' || err.code === 'deadline-exceeded';
    errEl.textContent = looksOffline
      ? 'You appear to be offline and no cached profile is available yet. Connect to the internet once to finish signing in — after that this app will work offline.'
      : 'Could not load your account right now. This will retry automatically — check your connection if it persists.';
    errEl.style.display = 'block';
    document.getElementById('login-screen').style.display = 'flex';
  }
});

function enterApp(){
  document.getElementById('login-screen').style.display='none';
  document.getElementById('app-screen').style.display='flex';
  document.getElementById('user-name').textContent = currentUser.name;
  document.getElementById('user-role').textContent = I18N[currentLang]['role_'+currentUser.role];
  document.getElementById('user-av').textContent = currentUser.name.charAt(0);
  renderNav();
  // The full "users" collection (every account's name, email, active
  // status, supervisor assignments, etc.) is only ever rendered on admin
  // screens — see subscribeUsers()'s own guard below, which is the real
  // enforcement point. This role check is just to avoid opening a listener
  // (and a read cost) that a non-admin session has no use for; Firestore
  // Security Rules are what actually stop a worker or supervisor client
  // from listing this collection even if this check were removed.
  if(currentUser.role === 'admin') subscribeUsers();
  if(currentUser.role === 'worker'){ loadDrafts(); renderDraftsBadge(); loadDownloadedForms(); renderDownloadedFormsSidebar(); }
  subscribeSubmissions();
  subscribeNotifications();
  subscribeFormTemplates();
  subscribeOwnProfile();
  subscribeSettings();
  initPushOnLogin();
  document.dispatchEvent(new Event('geosurvey:entered-app'));
  // versionsUnsub and koboFormsUnsub are intentionally NOT started here —
  // "submissionVersions" and the Kobo form catalog are only ever read on
  // their own dedicated admin views, so they're subscribed lazily on
  // entering those views (see switchView()) and detached on leaving them,
  // instead of downloading data most sessions never look at.
  const firstView = currentUser.role==='admin' ? 'admin-overview' : currentUser.role==='supervisor' ? 'supervisor-queue' : 'worker';
  switchView(firstView);
}

function exitApp(){
  // Clear this device's local fallback snapshot (see initializeAuth() and
  // subscribeOwnProfile() above) whenever a session actually ends — Logout,
  // or an admin disabling/removing the account. It only exists to let a
  // *currently valid* session back in when other caches fail; it should
  // never survive past the session it belonged to.
  if(currentUser) clearProfileSnapshot(currentUser.uid);
  currentUser = null;
  if(usersUnsub){ usersUnsub(); usersUnsub = null; }
  if(submissionsUnsub){ submissionsUnsub(); submissionsUnsub = null; }
  if(notifsUnsub){ notifsUnsub(); notifsUnsub = null; }
  if(templatesUnsub){ templatesUnsub(); templatesUnsub = null; }
  if(ownProfileUnsub){ ownProfileUnsub(); ownProfileUnsub = null; }
  if(versionsUnsub){ versionsUnsub(); versionsUnsub = null; }
  if(settingsUnsub){ settingsUnsub(); settingsUnsub = null; }
  if(koboFormsUnsub){ koboFormsUnsub(); koboFormsUnsub = null; }
  if(surveyTemplatesUnsub){ surveyTemplatesUnsub(); surveyTemplatesUnsub = null; }
  stopSystemAlertsPolling();
  if(reviewHistoryUnsub){ reviewHistoryUnsub(); reviewHistoryUnsub = null; }
  WORKERS_LIST = [];
  SUBMISSIONS = [];
  workerNotifs = [];
  FORM_TEMPLATES = [];
  currentTemplateId = null;
  pendingTemplateIds.clear();
  VERSIONS = [];
  SURVEY_TEMPLATES = [];
  expandedTemplateLineages.clear();
  KOBO_FORMS = [];
  KOBO_VF_FORMS = null;
  document.getElementById('app-screen').style.display='none';
  document.getElementById('login-screen').style.display='flex';
  showBootstrapCard(false);
  document.getElementById('login-email').value='';
  document.getElementById('login-password').value='';
  const loginBtn = document.getElementById('login-btn');
  loginBtn.disabled = false;
  loginBtn.textContent = I18N[currentLang].sign_in;
  document.getElementById('login-success').style.display = 'none';
  document.getElementById('sidebar-worker-stats').style.display='none';
  document.getElementById('sidebar-admin-stats').style.display='none';
  document.getElementById('topbar-right').style.display='none';
  document.getElementById('notif-dropdown').classList.remove('show');
  DOWNLOADED_FORMS = []; // saved copies stay in localStorage for next sign-in; just clear in-memory state
}

document.getElementById('logout-btn').onclick = ()=> logoutUser();

/* ---------------- Firestore live subscriptions ---------------- */
function subscribeUsers(){
  if(usersUnsub) usersUnsub();
  // Hard guard, independent of every call site: nothing that reads
  // WORKERS_LIST (renderUsersTable, renderWorkerActivity, the admin
  // "send form"/"new user" pickers) is ever shown outside admin views.
  // Firestore Security Rules deny this query for non-admins server-side
  // regardless of this check — this just avoids a doomed request.
  if(!currentUser || currentUser.role !== 'admin') return;
  usersUnsub = onSnapshot(collection(db, 'users'), (snap)=>{
    WORKERS_LIST = snap.docs.map(d=>({ uid:d.id, ...d.data() }));
    if(activeView==='admin-users') renderUsersTable();
    if(activeView==='admin-overview') renderWorkerActivity();
    populateWorkerFilterOptions();
  }, (err)=> notifyError(err, 'Could not load the users list.'));
}

// Keeps the "All Submissions" worker filter dropdown (f-worker) in sync
// with the live users list. Uses worker uid as the option value (not
// name) so the selected value can be dropped straight into a Firestore
// where('workerId', '==', ...) clause — no substring matching needed.
function populateWorkerFilterOptions(){
  const sel = document.getElementById('f-worker');
  if(!sel) return;
  const prev = sel.value;
  const escName = (s)=> String(s==null?'':s).replace(/"/g,'&quot;');
  const workers = WORKERS_LIST.filter(w=>w.role==='worker').sort((a,b)=> (a.name||'').localeCompare(b.name||''));
  sel.innerHTML = `<option value="" data-i18n="all_workers">${I18N[currentLang].all_workers}</option>` +
    workers.map(w=>`<option value="${w.uid}">${escName(w.name||w.email||w.uid)}</option>`).join('');
  if(workers.some(w=>w.uid===prev)) sel.value = prev;
}

// Maps a Firestore "submissions" doc — whose canonical fields are
// submissionId, workerId, workerName, formId, formVersion, answers, gps
// (a GeoPoint), photoUrl, voiceUrl, status, reviewComment, createdAt,
// updatedAt, reviewedBy, reviewedAt — onto the flatter shape the rest of
// the UI (map, tables, GeoJSON export, PWA history) already reads. The
// UI-facing names (worker, workerUid, lat, lng, region, collected,
// audioUrl, comment) are always *derived* here, never stored a second
// time in Firestore.
function submissionFromDoc(d){
  const data = d.data();
  const gps = data.gps || null; // Firestore GeoPoint
  const lat = gps ? gps.latitude : (typeof data.lat === 'number' ? data.lat : null);
  const lng = gps ? gps.longitude : (typeof data.lng === 'number' ? data.lng : null);
  const createdMillis = data.createdAt && data.createdAt.toMillis ? data.createdAt.toMillis() : null;
  const collected = createdMillis
    ? new Date(createdMillis).toISOString().slice(0,16).replace('T',' ')
    : (data.collected || '');
  return {
    docId: d.id,
    ...data,
    id: data.submissionId || d.id,
    worker: data.workerName,
    workerUid: data.workerId,
    lat, lng,
    region: (lat!=null && lng!=null) ? formatCoords({lat, lng}) : '',
    collected,
    audioUrl: data.voiceUrl || null,
    comment: data.reviewComment || null,
    pendingSync: d.metadata.hasPendingWrites,
    _createdMillis: createdMillis
  };
}

// Reads the current status/worker/sort controls (admin-overview panel) and
// turns them into Firestore where()/orderBy() constraints. Doing the
// filtering *in the query* — rather than pulling every submission down and
// filtering in JS — means a status or worker filter actually shrinks what
// gets read from Firestore instead of just hiding rows client-side.
function currentSubmissionFilters(){
  // f-worker / f-sort live inside the Admin Overview view's markup only —
  // but every view's HTML exists in the DOM simultaneously (just
  // hidden/shown), so getElementById finds them regardless of which role
  // is logged in. Only the admin role actually has UI to see/change these
  // controls, so only admin's query should ever be affected by them —
  // otherwise a supervisor's (or worker's) live queue can end up silently
  // scoped by a leftover value in a dropdown they can't even see, with no
  // indication anything was filtered at all.
  if(!currentUser || currentUser.role !== 'admin'){
    return { status: '', workerUid: '', sortDir: 'desc' };
  }
  const workerEl = document.getElementById('f-worker');
  const sortEl = document.getElementById('f-sort');
  return {
    // Admin only ever sees approved submissions — pending and rejected
    // ones are a supervisor's job to review, and rejected ones in
    // particular should stay invisible to admin entirely. This is fixed
    // rather than driven by a dropdown so it can't be widened client-side.
    status: 'approved',
    workerUid: workerEl ? workerEl.value : '',
    sortDir: (sortEl && sortEl.value === 'asc') ? 'asc' : 'desc'
  };
}

// Builds the live "submissions" query for the current user + current
// filter/sort controls. Role scoping (worker/supervisor) is a security
// requirement — it mirrors firestore.rules and must always be present, not
// just a UI nicety. Status/worker filters and date sort are layered on top
// as additional where()/orderBy() clauses so Firestore only ever returns
// the documents the current view actually needs. Note: status/workerUid
// only ever come back non-empty for admin (see currentSubmissionFilters
// above) — a supervisor's or worker's query is never affected by them.
function buildSubmissionsQuery(){
  const { status, workerUid, sortDir } = currentSubmissionFilters();
  const constraints = [];

  if(currentUser.role === 'worker'){
    // Workers only ever see their own docs — the worker filter dropdown
    // isn't shown to them, so no extra constraint is needed here.
    constraints.push(where('workerId', '==', currentUser.uid));
  } else if(currentUser.role === 'supervisor'){
    constraints.push(where('supervisorId', '==', currentUser.uid));
    if(workerUid) constraints.push(where('workerId', '==', workerUid));
  } else {
    // admin
    if(workerUid) constraints.push(where('workerId', '==', workerUid));
  }

  if(status) constraints.push(where('status', '==', status));

  // NOTE: sorting is intentionally done client-side in subscribeSubmissions()
  // rather than via orderBy('createdAt', ...) here. A Firestore orderBy
  // constraint excludes any document that doesn't yet have a value for that
  // field from the snapshot — including from the local cache. A submission
  // created while offline is written with createdAt: serverTimestamp(),
  // which stays unresolved (null) until the write reaches the server. With
  // an orderBy('createdAt') constraint, that doc would be silently dropped
  // from the worker's own query results until they're back online, even
  // though it's sitting right there in the local cache. Sorting in JS
  // avoids excluding it.

  return query(collection(db, 'submissions'), ...constraints);
}

function subscribeSubmissions(){
  if(submissionsUnsub){ submissionsUnsub(); submissionsUnsub = null; }
  const submissionsQuery = buildSubmissionsQuery();
  submissionsUnsub = onSnapshot(submissionsQuery, { includeMetadataChanges: true }, (snap)=>{
    SUBMISSIONS = snap.docs.map(d=> submissionFromDoc(d));
    // Sorted here in JS rather than via Firestore's orderBy (see the note
    // in buildSubmissionsQuery() above) so that a submission written while
    // offline — which has no createdAt yet — still shows up instead of
    // being excluded from the query entirely.
    const { sortDir } = currentSubmissionFilters();
    const dir = sortDir === 'asc' ? 1 : -1;
    SUBMISSIONS.sort((a,b)=> dir * ((a._createdMillis||0) - (b._createdMillis||0)));
    // A submission that was just written locally and hasn't round-tripped
    // to the server yet has no createdAt to sort by — pin those to the
    // top so an optimistic write doesn't appear to vanish mid-sync.
    const pending = SUBMISSIONS.filter(s=>s._createdMillis==null && s.pendingSync);
    if(pending.length){
      const rest = SUBMISSIONS.filter(s=>!(s._createdMillis==null && s.pendingSync));
      SUBMISSIONS = [...pending, ...rest];
    }
    updateSidebarWorkerStats();
    renderStats();
    refreshCurrentView();
    if(activeView==='admin-overview' && adminMap) renderMarkers(adminMap);
  }, (err)=>{
    // Compound where()+orderBy() combinations need a matching composite
    // index; friendlyFirestoreError() has a dedicated message for that
    // case (Firestore's own error includes a console link to create it).
    // permission-denied gets its own specific message too, naming the
    // exact rule this query needs, since "You don't have permission" alone
    // gives no lead on which collection/field/role to check.
    if(err.code === 'permission-denied'){
      const hint = currentUser && currentUser.role==='supervisor'
        ? 'the "submissions" collection needs a rule letting a supervisor read documents where supervisorId == their own uid'
        : currentUser && currentUser.role==='worker'
        ? 'the "submissions" collection needs a rule letting a worker read documents where workerId == their own uid'
        : 'the "submissions" collection needs a rule allowing this role to read';
      notifyError(err, `Blocked by Firestore security rules — ${hint}.`, 7000);
    } else {
      notifyError(err, 'Could not load submissions.', 6000);
    }
  });
}

// Rebuilds the query + re-subscribes whenever a filter/sort control
// changes, so the live listener always matches what's on screen.
function refreshSubmissionsSubscription(){
  if(!currentUser) return;
  subscribeSubmissions();
}

// True while the user is actively typing in one of the builder's free-text
// inputs. Used to suppress DOM rebuilds from Firestore snapshots — without
// this, an ack landing mid-keystroke would tear down and recreate the input,
// dropping focus and the caret position after every character typed.
function builderInputFocused(){
  const el = document.activeElement;
  if(!el || !el.classList) return false;
  return el.classList.contains('q-label-input') ||
         el.classList.contains('q-option-input') ||
         el.id === 'builder-form-name' ||
         el.id === 'builder-form-description';
}

function subscribeFormTemplates(){
  if(templatesUnsub) templatesUnsub();
  templatesUnsub = onSnapshot(collection(db, 'forms'), { includeMetadataChanges: true }, (snap)=>{
    // If this snapshot is just Firestore echoing back a write we made
    // locally (e.g. a keystroke in a question label), skip rebuilding the
    // builder DOM — otherwise every keystroke would blow away focus.
    const isLocalEcho = snap.docChanges().some(c=>c.doc.metadata.hasPendingWrites);
    const serverTemplates = snap.docs.map(d=>({ id:d.id, ...d.data() }))
      .sort((a,b)=> (a.createdAt?.toMillis?.()||0) - (b.createdAt?.toMillis?.()||0));
    // Any pending id that's now actually in the snapshot has arrived for
    // real — stop treating it as optimistic-only.
    serverTemplates.forEach(t=> pendingTemplateIds.delete(t.id));
    // Keep any still-pending optimistic entries (e.g. a Kobo import whose
    // write hasn't reached this snapshot yet) so they don't flicker away
    // and take the admin's selection with them.
    const stillPending = FORM_TEMPLATES.filter(t=> pendingTemplateIds.has(t.id) && !serverTemplates.some(s=>s.id===t.id));
    FORM_TEMPLATES = [...stillPending, ...serverTemplates];
    if(!FORM_TEMPLATES.find(t=>t.id===currentTemplateId)){
      currentTemplateId = FORM_TEMPLATES[0]?.id || null;
    }
    if(activeView==='admin-builder'){
      renderTemplateList();
      if(!isLocalEcho && !builderInputFocused()) renderBuilderMain();
    }
    // A worker sitting on the New Submission screen (or a form preview
    // modal) needs to pick up a newly-activated form — or edits to the one
    // they're currently on — the instant it changes in Firestore, not only
    // the next time they navigate. renderWorkerView() itself is guarded to
    // only rebuild the answer inputs when the *effective* form id actually
    // changes, so this won't wipe out mid-typing on unrelated form edits.
    if(currentUser && currentUser.role==='worker' && activeView==='worker') renderWorkerView();
  }, (err)=> notifyError(err, 'Could not load form templates.'));
}

function subscribeVersions(){
  if(versionsUnsub) versionsUnsub();
  const versionsQuery = query(collection(db, 'submissionVersions'), orderBy('editedAt', 'desc'));
  versionsUnsub = onSnapshot(versionsQuery, (snap)=>{
    VERSIONS = snap.docs.map(d=>({ id:d.id, ...d.data() }));
    if(activeView==='admin-versions') renderVersionsView();
  }, (err)=> notifyError(err, 'Could not load version history.'));
}

// Live listener on "surveyTemplates" — every version of every template an
// admin has ever saved via "Save Template" in the Form Builder. Sorted
// newest-version-first so renderSurveyTemplatesTable() can just take the
// first entry per sourceFormId as "the" row and treat the rest as that
// row's version history.
function subscribeSurveyTemplates(){
  if(surveyTemplatesUnsub) surveyTemplatesUnsub();
  const templatesQuery = query(collection(db, 'surveyTemplates'), orderBy('version', 'desc'));
  surveyTemplatesUnsub = onSnapshot(templatesQuery, (snap)=>{
    SURVEY_TEMPLATES = snap.docs.map(d=>({ id:d.id, ...d.data() }));
    if(activeView==='admin-templates') renderSurveyTemplatesTable();
  }, (err)=> notifyError(err, 'Could not load survey templates.'));
}

// Adds an immutable audit record to the top-level "reviews" collection to
// the given batch — existing review records are never updated or deleted,
// so the history for a submission only ever grows, never gets overwritten.
// Fields: submissionId, reviewerId, action, comment, createdAt.
// Takes a writeBatch (rather than writing on its own) so the review log,
// the submission's status change, and the worker's notification all
// commit together as a single atomic write — a partial failure can never
// leave a submission "approved" with no audit record, or vice versa.
function addReviewLogToBatch(batch, submissionDocId, action, comment){
  const reviewRef = doc(collection(db, 'reviews'));
  batch.set(reviewRef, {
    submissionId: submissionDocId,
    reviewerId: currentUser.uid,
    reviewerName: currentUser.name || currentUser.email, // denormalized for display only
    action,               // 'approved' | 'rejected'
    comment: comment || null,
    createdAt: serverTimestamp()
  });
}

// Live-reads the "reviews" collection, filtered to this submission via its
// submissionId, so the review panel shows real prior decisions instead of
// only whatever's cached on the submission doc itself.
function subscribeReviewHistory(submissionDocId){
  if(reviewHistoryUnsub) reviewHistoryUnsub();
  const histEl = document.getElementById('review-history');
  if(!histEl) return;
  const q = query(
    collection(db, 'reviews'),
    where('submissionId', '==', submissionDocId),
    orderBy('createdAt', 'desc')
  );
  reviewHistoryUnsub = onSnapshot(q, (snap)=>{
    const el = document.getElementById('review-history');
    if(!el) return;
    if(snap.empty){ el.innerHTML = ''; return; }
    const rows = snap.docs.map(d=>{
      const r = d.data();
      const when = r.createdAt && r.createdAt.toDate ? r.createdAt.toDate().toLocaleString() : '…';
      return `<div style="display:flex;justify-content:space-between;gap:10px;padding:8px 0;border-top:1px solid var(--line);font-size:12.5px;">
        <span><span class="badge ${r.action}">${r.action}</span> ${r.comment ? '— '+escapeHtml(r.comment) : ''}</span>
        <span class="mono" style="color:var(--ink-soft);opacity:0.7;">${escapeHtml(r.reviewerName || '')} · ${when}</span>
      </div>`;
    }).join('');
    el.innerHTML = `<div style="font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:0.05em;color:var(--ink-soft);opacity:0.65;">Review history</div>${rows}`;
  }, (err)=>{
    // This listener starts the instant a supervisor opens a submission —
    // right around when they'd go to hit play — so a permission-denied
    // here is easy to mistake for "can't hear the voice memo" when it's
    // actually the "reviews" collection rule, not audio playback at all
    // (the recording is an inline data URL and needs no Firestore read).
    if(err.code === 'permission-denied'){
      notifyError(err, 'Blocked by Firestore security rules — the "reviews" collection needs a rule allowing supervisors to read entries for their own submissions.', 7000);
    } else {
      notifyError(err, "Could not load this submission's review history.");
    }
  });
}

function subscribeNotifications(){
  if(notifsUnsub) notifsUnsub();
  if(!currentUser || currentUser.role !== 'worker') return;
  // Top-level "notifications" collection, scoped per-user via a userUid
  // field (rather than a users/{uid}/notifications subcollection) so
  // notifications are queryable/indexable independently of the user doc.
  const q = query(
    collection(db, 'notifications'),
    where('userUid', '==', currentUser.uid),
    orderBy('createdAt', 'desc')
  );
  notifsUnsub = onSnapshot(q, (snap)=>{
    workerNotifs = snap.docs.map(d=>({ id:d.id, ...d.data() }));
    if(activeView==='worker') renderWorkerView();
  }, (err)=> notifyError(err, 'Could not load notifications.'));
}

// Global, admin-editable app settings live in a single "settings/app"
// document in the top-level "settings" collection. Every signed-in user
// subscribes so changes (e.g. an admin changing the default export format)
// show up live everywhere, matching the live-Firestore pattern used for
// users/submissions/forms elsewhere in the app.
function subscribeSettings(){
  if(settingsUnsub) settingsUnsub();
  settingsUnsub = onSnapshot(doc(db, 'settings', 'app'), (snap)=>{
    if(snap.exists()){
      const data = snap.data();
      if(data.interfaceLang){ currentLang = data.interfaceLang; applyI18n(); }
      if(data.defaultExportFormat) defaultExportFormat = data.defaultExportFormat;
      allowPoorGpsSubmission = data.allowPoorGpsSubmission !== false; // default true if unset
      const langSel = document.getElementById('settings-lang-select');
      const exportSel = document.getElementById('settings-export-select');
      const poorGpsToggle = document.getElementById('settings-allow-poor-gps');
      if(langSel) langSel.value = currentLang;
      if(exportSel) exportSel.value = defaultExportFormat;
      if(poorGpsToggle) poorGpsToggle.checked = allowPoorGpsSubmission;
    } else if(currentUser && currentUser.role === 'admin'){
      // Seed a default settings doc the first time an admin loads the app
      // so the "settings" collection is real, database-driven state from
      // the start rather than only existing once someone edits a field.
      setDoc(doc(db, 'settings', 'app'), {
        interfaceLang: currentLang,
        defaultExportFormat,
        allowPoorGpsSubmission,
        updatedAt: serverTimestamp(),
        updatedByRef: doc(db, 'users', currentUser.uid)
      }, { merge: true }).catch(err=> console.error('Failed to seed settings/app:', err));
    }
  }, (err)=> notifyError(err, 'Could not load app settings — using defaults.'));
}

async function saveAppSetting(fields){
  if(!currentUser) return;
  await setDoc(doc(db, 'settings', 'app'), {
    ...fields,
    updatedAt: serverTimestamp(),
    updatedByRef: doc(db, 'users', currentUser.uid)
  }, { merge: true });
}

document.getElementById('settings-lang-select')?.addEventListener('change', (e)=>{
  currentLang = e.target.value;
  applyI18n(); refreshCurrentView();
  saveAppSetting({ interfaceLang: currentLang }).catch(err=> console.error('Failed to save language setting:', err));
});
document.getElementById('settings-export-select')?.addEventListener('change', (e)=>{
  defaultExportFormat = e.target.value;
  saveAppSetting({ defaultExportFormat }).catch(err=> console.error('Failed to save export setting:', err));
});
document.getElementById('settings-allow-poor-gps')?.addEventListener('change', (e)=>{
  allowPoorGpsSubmission = e.target.checked;
  saveAppSetting({ allowPoorGpsSubmission }).catch(err=> console.error('Failed to save GPS setting:', err));
});

// Listens to the signed-in user's own Firestore doc for as long as they're
// signed in — for every role, not just worker. This is what makes "never
// rely on a client-side role variable" actually hold over the life of a
// session: if an admin changes this user's role, supervisor, or disables
// the account while they're logged in, that change is reflected (or the
// session is force-ended) immediately, rather than only being picked up
// the next time they happen to sign in again.
function subscribeOwnProfile(){
  if(ownProfileUnsub) ownProfileUnsub();
  if(!currentUser) return;
  ownProfileUnsub = onSnapshot(doc(db, 'users', currentUser.uid), (snap)=>{
    if(!currentUser) return;
    if(!snap.exists()){
      // An empty result straight from Firestore's local cache (fromCache)
      // does NOT mean the account was deleted — it just means this device
      // has no cached copy of this document yet (exactly the situation the
      // localStorage fallback in initializeAuth() exists for: a worker
      // signing back in offline on a device whose Firestore cache doesn't
      // have their profile). Signing them out on that alone would undo the
      // whole point of that fallback the moment the live listener attaches.
      // Only trust "this account is gone" once it's server-confirmed.
      if(snap.metadata.fromCache) return;
      showToast('Your account was removed. Signing out…');
      signOut(auth);
      return;
    }
    const data = snap.data();
    if(data.active === false){
      showToast(I18N[currentLang].err_account_disabled);
      signOut(auth);
      return;
    }
    const roleChanged = currentUser.role !== data.role;
    currentUser.name = data.name;
    currentUser.email = data.email || currentUser.email;
    currentUser.role = data.role;
    currentUser.supervisorId = data.supervisorId || null;
    currentUser.active = data.active !== false;
    currentUser.assignedFormId = data.assignedFormId || null;
    currentUser.assignedFormName = data.assignedFormName || null;
    currentUser.assignedFormVersion = data.assignedFormVersion || null;
    currentUser.personalEmail = data.personalEmail || null;
    if(roleChanged){
      // Role changed under them (e.g. promoted/demoted by an admin) — the
      // nav, sidebar stats, and every role-gated view all key off
      // currentUser.role, so re-render the shell from Firestore's value.
      renderNav();
      // Demoted away from admin: drop the full-users listener immediately,
      // both because it's now pointless and because it would otherwise sit
      // there getting permission-denied errors once Security Rules (which
      // check the *current* role on every read, not just at session start)
      // reject the next snapshot. Promoted to admin: start it.
      if(currentUser.role === 'admin'){
        if(!usersUnsub) subscribeUsers();
      } else if(usersUnsub){
        usersUnsub(); usersUnsub = null;
        WORKERS_LIST = [];
      }
      const firstView = currentUser.role==='admin' ? 'admin-overview' : currentUser.role==='supervisor' ? 'supervisor-queue' : 'worker';
      switchView(firstView);
    } else if(activeView==='worker'){
      renderWorkerView();
    }
    // Keep the plain-localStorage fallback snapshot (see initializeAuth()
    // above) fresh with whatever this live listener just confirmed, so if
    // this device ever needs to fall back to it later, it's as recent as
    // this worker's last connected moment rather than only their very first
    // sign-in.
    saveProfileSnapshot(currentUser);
  }, (err)=> notifyError(err, 'Could not verify your account — some data may be out of date.'));
}

/* ---------------- Nav ---------------- */
const NAV_CONFIG = {
  admin: [
    {id:'admin-overview', icon:'🗺️', key:'nav_overview'},
    {id:'admin-builder', icon:'📝', key:'nav_builder'},
    {id:'admin-templates', icon:'📚', key:'nav_templates'},
    {id:'admin-import', icon:'📥', key:'nav_import'},
    {id:'admin-users', icon:'👥', key:'nav_users'},
    {id:'admin-versions', icon:'🕘', key:'nav_versions'},
    {id:'admin-settings', icon:'⚙️', key:'nav_settings'},
    {id:'account', icon:'👤', key:'nav_account'},
  ],
  supervisor: [
    {id:'supervisor-queue', icon:'✅', key:'nav_queue'},
    {id:'account', icon:'👤', key:'nav_account'},
  ],
  worker: [
    {id:'worker', tab:'new', icon:'📝', key:'tab_new'},
    {id:'worker', tab:'history', icon:'📋', key:'tab_history'},
    {id:'worker', tab:'drafts', icon:'💾', key:'tab_drafts'},
    {id:'worker-downloads', icon:'📥', key:'downloaded_forms'},
    {id:'account', icon:'👤', key:'nav_account'},
  ]
};
const VIEW_TITLES = {
  'admin-overview': ['Overview & Map', 'Live submissions across all regions'],
  'admin-builder': ['Form Builder', 'Design the questions field workers will answer'],
  'admin-templates': ['Survey Templates', 'Reusable, versioned templates saved from your forms'],
  'admin-import': ['Import from KoboToolbox', 'Bring in existing forms and submissions from Kobo'],
  'admin-users': ['Manage Users', 'Create and manage supervisor & worker accounts'],
  'admin-versions': ['Version History', 'Old vs. new data, tracked automatically'],
  'admin-settings': ['System Settings', 'Language, export defaults, and preferences'],
  'supervisor-queue': ['Validation Queue', 'Review voice memos and approve or reject'],
  'worker': ['Collect Data', 'Offline-capable field submission form'],
  'worker-downloads': ['Downloaded Forms', 'Forms saved to this device for offline use'],
  'account': ['Account Settings', 'Update the email and password you use to sign in'],
};

function renderNav(){
  const wrap = document.getElementById('nav-items');
  wrap.innerHTML = '';
  NAV_CONFIG[currentUser.role].forEach(item=>{
    const btn = document.createElement('button');
    // The worker's New/My Submissions/Drafts items all share the same
    // underlying 'worker' view, so their active state is driven by the
    // in-view tab (workerActiveTab) rather than the top-level activeView.
    const isActive = item.tab ? (activeView==='worker' && workerActiveTab===item.tab) : (activeView===item.id);
    btn.className = 'nav-item' + (isActive ? ' active' : '');
    const badge = item.tab==='drafts' ? '<span id="pwa-drafts-badge" class="nav-badge"></span>'
      : item.id==='worker-downloads' ? '<span id="downloaded-forms-nav-badge" class="nav-badge"></span>'
      : '';
    btn.innerHTML = `<span class="dot"></span><span>${item.icon}</span><span class="lbl">${I18N[currentLang][item.key]}</span>${badge}`;
    btn.onclick = item.tab
      ? ()=>{ goToWorkerTab(item.tab); closeSidebar(); }
      : ()=>{ switchView(item.id); closeSidebar(); };
    wrap.appendChild(btn);
  });
  if(currentUser.role==='worker' && typeof renderDraftsBadge==='function') renderDraftsBadge();
}

/* ---------------- Mobile sidebar drawer ---------------- */
function openSidebar(){
  document.getElementById('sidebar').classList.add('open');
  document.getElementById('sidebar-overlay').classList.add('show');
}
function closeSidebar(){
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebar-overlay').classList.remove('show');
}
function toggleSidebar(){
  document.getElementById('sidebar').classList.contains('open') ? closeSidebar() : openSidebar();
}
document.getElementById('hamburger-btn').onclick = toggleSidebar;
document.getElementById('sidebar-overlay').onclick = closeSidebar;

let activeView = null;
function switchView(id){
  // Defense-in-depth: only allow navigating to a view that's actually in
  // this role's nav config (real access control still lives in Firestore
  // security rules — this just stops a stale/forged view id from rendering
  // a screen the UI never intended this role to reach).
  if(!currentUser || !NAV_CONFIG[currentUser.role].some(item=>item.id===id)){
    console.warn('Blocked navigation to view not available for this role:', id);
    return;
  }
  const previousView = activeView;
  activeView = id;

  // View-scoped listeners: only live while their view is on screen, so
  // navigating away always detaches them instead of leaving a stale
  // subscription (and its Firestore reads) running in the background.
  if(previousView === 'admin-versions' && id !== 'admin-versions' && versionsUnsub){
    versionsUnsub(); versionsUnsub = null;
  }
  if(id === 'admin-versions' && !versionsUnsub){
    subscribeVersions();
  }
  if(previousView === 'admin-import' && id !== 'admin-import' && koboFormsUnsub){
    koboFormsUnsub(); koboFormsUnsub = null;
  }
  if(id === 'admin-import' && !koboFormsUnsub){
    subscribeKoboForms();
  }
  if(previousView === 'admin-templates' && id !== 'admin-templates' && surveyTemplatesUnsub){
    surveyTemplatesUnsub(); surveyTemplatesUnsub = null;
  }
  if(id === 'admin-templates' && !surveyTemplatesUnsub){
    subscribeSurveyTemplates();
  }
  // The supervisor's review panel is the only place that subscribes to a
  // submission's review history — detach it as soon as that view isn't
  // showing so a leftover listener doesn't keep reading after navigating away.
  if(previousView === 'supervisor-queue' && id !== 'supervisor-queue' && reviewHistoryUnsub){
    reviewHistoryUnsub(); reviewHistoryUnsub = null;
  }
  if(previousView === 'admin-overview' && id !== 'admin-overview'){
    stopSystemAlertsPolling();
  }
  if(id === 'admin-overview' && currentUser && currentUser.role === 'admin'){
    startSystemAlertsPolling();
  }

  document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
  document.getElementById('view-'+id).classList.add('active');
  const t = VIEW_TITLES[id];
  document.getElementById('view-title').textContent = I18N[currentLang]['nav_'+id.split('-').pop()] || t[0];
  document.getElementById('view-sub').textContent = t[1];
  document.getElementById('topbar-right').style.display = (id==='worker' && currentUser && currentUser.role==='worker') ? 'flex' : 'none';
  document.getElementById('notif-dropdown').classList.remove('show');
  renderNav();
  refreshCurrentView();
}

function refreshCurrentView(){
  if(!activeView) return;
  if(activeView==='admin-overview'){ renderStats(); renderAdminTable(); renderWorkerActivity(); initAdminMap(); }
  if(activeView==='admin-builder'){ renderTemplateList(); renderBuilderMain(); }
  if(activeView==='admin-settings'){ loadClearSubsList(); }
  if(activeView==='admin-import'){ /* state is preserved between visits, nothing to re-render on entry */ }
  if(activeView==='admin-users'){ renderUsersTable(); }
  if(activeView==='admin-versions'){ renderVersionsView(); }
  if(activeView==='supervisor-queue'){ renderQueue(); }
  if(activeView==='worker'){ renderWorkerView(); }
  if(activeView==='worker-downloads'){ renderDownloadedFormsSidebar(); }
  if(activeView==='account'){ renderAccountView(); }
}

/* ---------------- Admin: stats + table ---------------- */
function renderStats(){
  const wrap = document.getElementById('sidebar-admin-stats');
  if(!currentUser || currentUser.role!=='admin'){
    wrap.style.display = 'none';
    return;
  }
  wrap.style.display = 'grid';
  // SUBMISSIONS only ever contains approved docs for the admin role (see
  // buildSubmissionsQuery) — pending/rejected review status stays visible
  // to supervisors only, so there's nothing else to break out here.
  document.getElementById('side-stat-total').textContent = SUBMISSIONS.length;
}

function renderAdminTable(){
  const tbody = document.getElementById('admin-table-body');
  tbody.innerHTML = '';
  // SUBMISSIONS already reflects the status/worker filters and date sort
  // applied at the Firestore query level (see buildSubmissionsQuery) —
  // no further filtering needed here.
  const rows = SUBMISSIONS;
  if(rows.length===0){
    tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;padding:30px 10px;color:var(--ink-soft);opacity:0.6;">${I18N[currentLang].no_submissions_table}</td></tr>`;
    return;
  }
  rows.forEach(s=>{
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="mono">${s.formName || s.id}</td>
        <td>${s.worker}</td>
        <td class="mono">${typeof s.lng==='number' ? s.lng.toFixed(5) : ''}</td>
        <td class="mono">${typeof s.lat==='number' ? s.lat.toFixed(5) : ''}</td>
        <td><span class="badge ${s.status}">${I18N[currentLang]['l_'+s.status]}</span></td>
        <td class="mono" style="font-size:11.5px;">${s.collected}</td>
        <td><button class="row-link" onclick="focusOnMap(${s.lat},${s.lng})">📍</button></td>
        <td><button class="row-link" data-view-id="${s.id}">👁</button></td>
        <td><button class="row-link" data-export-id="${s.id}" title="Export this submission">⬇</button></td>
      `;
      tr.querySelector('[data-view-id]').onclick = ()=> openAdminDetail(s);
      tr.querySelector('[data-export-id]').onclick = ()=> exportSubmission(s);
      tbody.appendChild(tr);
    });
}

// Per-worker submission counts/status breakdown/last-activity timestamp,
// derived live from the same SUBMISSIONS + WORKERS_LIST state the rest of
// the dashboard uses — so it refreshes automatically whenever either the
// "submissions" or "users" Firestore listener fires, with no separate
// query and no page reload needed.
function renderWorkerActivity(){
  const tbody = document.getElementById('worker-activity-body');
  if(!tbody) return;
  const fieldWorkers = WORKERS_LIST.filter(w=>w.role==='worker');
  if(fieldWorkers.length===0){
    tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;padding:30px 10px;color:var(--ink-soft);opacity:0.6;">${I18N[currentLang].no_submissions_table}</td></tr>`;
    return;
  }
  // SUBMISSIONS only ever contains approved docs for the admin role (see
  // buildSubmissionsQuery) — pending/rejected submissions stay visible to
  // supervisors only, so there's nothing to break out by status here.
  const rows = fieldWorkers.map(w=>{
    const mine = SUBMISSIONS.filter(s=>s.workerUid===w.uid);
    const lastMillis = mine.reduce((max,s)=> Math.max(max, s._createdMillis || 0), 0);
    const lastActive = lastMillis ? new Date(lastMillis).toLocaleString() : I18N[currentLang].never_active;
    return { w, total: mine.length, lastMillis, lastActive };
  }).sort((a,b)=> b.lastMillis - a.lastMillis);

  tbody.innerHTML = rows.map(r=>`
    <tr>
      <td>${r.w.name}</td>
      <td><span class="badge ${r.w.active?'approved':'rejected'}">${r.w.active ? I18N[currentLang].l_approved : I18N[currentLang].l_rejected}</span></td>
      <td class="mono">${r.total}</td>
      <td class="mono" style="font-size:11.5px;">${r.lastActive}</td>
    </tr>
  `).join('');
}

/* ---------------- Admin: submission detail modal (photo + voice memo) ---------------- */
let adCurrentSubmission = null;
// photoUrl/audioUrl on a submission are now backend fileIds (see the
// "Submission media: company-owned backend API" section below), not
// directly-usable URLs — GET /api/files/:id needs an Authorization header,
// so each one has to be fetched into a local blob: URL via
// getMediaObjectUrl() before it can go in an <img>/<audio> src. adPhotoIds/
// adPhotoObjectUrls/adPhotoIndex track a whole CAROUSEL of photos (today
// that's usually just one, but getSubmissionPhotoIds() already supports a
// hypothetical multi-photo field) so browsing back and forth reuses
// already-fetched blob: URLs instead of re-fetching, and everything gets
// revoked (freeing memory) the moment it's replaced or the modal closes.
let adPhotoIds = [];
let adPhotoIndex = 0;
let adPhotoObjectUrls = [];
let adAudioObjectUrl = null;
// Shared by the supervisor review panel and admin submission detail —
// renders GPS accuracy/quality/capture info as a field-block if gpsMeta
// exists on the submission, so both views understand how reliable that
// location fix actually was, not just its bare coordinates.
// Small caption shown under a submission photo, making explicit whether
// its coordinates came from the photo's own EXIF data or were carried over
// from the submission's GPS capture — see computePhotoGps().
function photoGpsCaptionHTML(photoGps){
  if(!photoGps || typeof photoGps.lat !== 'number' || typeof photoGps.lng !== 'number') return '';
  const label = photoGps.source === 'exif' ? 'From photo EXIF' : 'From submission GPS';
  return `<div style="font-size:11px;color:var(--ink-soft);margin-top:4px;">📍 ${photoGps.lat.toFixed(5)}, ${photoGps.lng.toFixed(5)} · ${label}</div>`;
}
function gpsMetaFieldBlockHTML(gpsMeta){
  if(!gpsMeta) return '';
  const qualityColors = {excellent:'var(--olive)', good:'var(--teal)', fair:'var(--gold)', poor:'var(--clay)', verypoor:'var(--red)'};
  const qualityLabels = {excellent:'Excellent', good:'Good', fair:'Fair', poor:'Poor', verypoor:'Very Poor'};
  const color = qualityColors[gpsMeta.quality] || 'var(--ink-soft)';
  const label = qualityLabels[gpsMeta.quality] || '—';
  const parts = [];
  if(typeof gpsMeta.accuracy === 'number') parts.push(`Accuracy: ${gpsMeta.accuracy.toFixed(1)} m`);
  parts.push(`GPS Quality: <span style="color:${color};font-weight:700;">${label}</span>`);
  if(gpsMeta.captureDurationMs) parts.push(`Capture Duration: ${(gpsMeta.captureDurationMs/1000).toFixed(1)}s`);
  if(typeof gpsMeta.altitude === 'number') parts.push(`Altitude: ${Math.round(gpsMeta.altitude)} m`);
  return `<div class="field-block"><div class="fl">GPS Quality</div><div class="fv">${parts.join(' · ')}</div></div>`;
}

function renderAdFieldsReadOnly(s){
  const answers = s.answers || {};
  const answerKeys = Object.keys(answers);
  const gpsQualityHTML = gpsMetaFieldBlockHTML(s.gpsMeta);
  document.getElementById('ad-fields').innerHTML = answerKeys.length
    ? answerKeys.map(k=>`<div class="field-block"><div class="fl">${k}</div><div class="fv">${formatAnswerValue(answers[k])}</div></div>`).join('')
      + `<div class="field-block"><div class="fl">Region</div><div class="fv">${s.region}</div></div>`
      + gpsQualityHTML
    : `<div class="field-block"><div class="fl">Region</div><div class="fv">${s.region}</div></div>` + gpsQualityHTML;
}
function renderAdFieldsEditable(s){
  const answers = s.answers || {};
  const answerKeys = Object.keys(answers);
  const fields = document.getElementById('ad-fields');
  if(!answerKeys.length){
    fields.innerHTML = `<div style="grid-column:1/-1;font-size:12px;color:#999;font-style:italic;">No survey answers to edit on this submission.</div>`;
    return;
  }
  fields.innerHTML = answerKeys.map((k,i)=>{
    // Media-question answers (Kobo imports whose value is an object — see
    // formatAnswerValue above) aren't safe to edit as free text: saving
    // would overwrite the stored fileId reference (or failure marker) with
    // an arbitrary string, breaking the photo/audio for good. Render those
    // read-only instead of as an input, same as the field grid does.
    if(answers[k] && typeof answers[k] === 'object'){
      return `<div class="field-block">
      <div class="fl">${k}</div>
      <div class="fv">${formatAnswerValue(answers[k])}</div>
    </div>`;
    }
    return `
    <div class="field-block">
      <div class="fl">${k}</div>
      <input class="input" style="margin-bottom:0;" data-ad-edit-key="${i}" value="${String(answers[k]).replace(/"/g,'&quot;')}" />
    </div>`;
  }).join('')
    + `<div class="field-block"><div class="fl">Region</div><div class="fv">${s.region}</div></div>`;
}
// Releases every cached blob: URL in the current photo carousel and resets
// carousel state — called both before opening a (possibly different)
// submission and when the modal closes.
function revokeAdPhotoUrls(){
  // adPhotoObjectUrls now holds URLs from the SAME shared photoBlobCache the
  // satellite thumbnails use (see getCachedPhotoUrl) -- they're not owned
  // exclusively by this modal, so closing/switching submissions here must
  // NOT revoke them; the cache's own LRU eviction (in getCachedPhotoUrl)
  // handles that once nothing -- marker or modal -- still points at them.
  adPhotoObjectUrls = [];
  adPhotoIds = [];
  adPhotoIndex = 0;
}
function adPhotoNavHTML(){
  if(adPhotoIds.length <= 1) return '';
  return `
        <button type="button" id="ad-photo-prev" aria-label="Previous photo" style="position:absolute;left:8px;top:50%;transform:translateY(-50%);background:rgba(0,0,0,0.5);color:#fff;border:none;border-radius:50%;width:32px;height:32px;cursor:pointer;font-size:18px;line-height:1;">‹</button>
        <button type="button" id="ad-photo-next" aria-label="Next photo" style="position:absolute;right:8px;top:50%;transform:translateY(-50%);background:rgba(0,0,0,0.5);color:#fff;border:none;border-radius:50%;width:32px;height:32px;cursor:pointer;font-size:18px;line-height:1;">›</button>`;
}
function wireAdPhotoNav(s){
  const prevBtn = document.getElementById('ad-photo-prev');
  const nextBtn = document.getElementById('ad-photo-next');
  if(prevBtn) prevBtn.onclick = ()=> renderAdPhotoAt(s, (adPhotoIndex - 1 + adPhotoIds.length) % adPhotoIds.length);
  if(nextBtn) nextBtn.onclick = ()=> renderAdPhotoAt(s, (adPhotoIndex + 1) % adPhotoIds.length);
}
// Renders (and, if not already cached, fetches) the photo at `index` of the
// current submission's carousel into #ad-photo-wrap — full-resolution
// (object-fit:contain, no cropping, up to 70vh tall) rather than the
// cropped preview used in the map popups/thumbnails, since this is the
// "view it properly" destination.
async function renderAdPhotoAt(s, index){
  const photoWrap = document.getElementById('ad-photo-wrap');
  if(!photoWrap) return;
  if(!adPhotoIds.length){
    photoWrap.innerHTML = `<div class="field-block" style="margin-bottom:16px;"><div class="fl">Photo</div>${photoUnavailableHTML()}</div>`;
    return;
  }
  adPhotoIndex = index;
  const countHTML = adPhotoIds.length > 1
    ? `<div style="text-align:center;font-size:11px;color:var(--ink-soft);margin-top:4px;">${index+1} / ${adPhotoIds.length}</div>` : '';
  const cached = adPhotoObjectUrls[index];
  photoWrap.innerHTML = `<div class="field-block" style="margin-bottom:16px;">
      <div class="fl">Photo</div>
      <div style="position:relative;border-radius:8px;overflow:hidden;background:#f1efe8;min-height:160px;display:flex;align-items:center;justify-content:center;margin-top:6px;">
        ${cached
          ? `<img id="ad-photo-img" src="${cached}" style="max-width:100%;max-height:70vh;display:block;object-fit:contain;" />`
          : `<span style="font-size:11.5px;color:#999;font-style:italic;">Loading photo…</span>`}
        ${adPhotoNavHTML()}
      </div>
      ${index===0 ? photoGpsCaptionHTML(s.photoGps) : ''}
      ${countHTML}
    </div>`;
  wireAdPhotoNav(s);
  if(cached){
    wireImgFallback(document.getElementById('ad-photo-img'));
    return;
  }
  try{
    // getCachedPhotoUrl (shared with the satellite thumbnails, see its
    // definition above) returns instantly, with no network fetch, if this
    // exact photo was already loaded as a thumbnail -- clicking a thumbnail
    // is the normal path into this modal, so that's the common case, not an
    // edge case.
    const objectUrl = await getCachedPhotoUrl(adPhotoIds[index]);
    if(adCurrentSubmission !== s || adPhotoIndex !== index) return; // moved on while this was loading -- url stays cached for whoever's next
    adPhotoObjectUrls[index] = objectUrl;
    renderAdPhotoAt(s, index); // re-render, now hitting the cached branch above
  }catch(err){
    console.error('Could not load submission photo:', err);
    if(adCurrentSubmission === s && adPhotoIndex === index){
      photoWrap.innerHTML = `<div class="field-block" style="margin-bottom:16px;"><div class="fl">Photo</div>${photoUnavailableHTML()}</div>`;
    }
  }
}
async function openAdminDetail(s){
  adCurrentSubmission = s;
  document.getElementById('ad-title').textContent = `${s.id} — ${s.worker}`;
  const badge = document.getElementById('ad-status-badge');
  badge.className = `badge ${s.status}`;
  badge.textContent = I18N[currentLang]['l_'+s.status] || s.status;
  document.getElementById('ad-meta').textContent =
    `📍 ${s.lat.toFixed(5)}, ${s.lng.toFixed(5)} · 🕐 ${s.collected}${s.formName ? ' · 📋 '+s.formName : ''}`;

  renderAdFieldsReadOnly(s);
  document.getElementById('ad-edit-actions').style.display = 'none';
  document.getElementById('ad-edit-btn').style.display = (s.answers && Object.keys(s.answers).length) ? 'inline-block' : 'none';

  // Release whatever the previously-open submission's photo/audio object:
  // URLs were pointing at before requesting this submission's media.
  revokeAdPhotoUrls();
  if(adAudioObjectUrl){ URL.revokeObjectURL(adAudioObjectUrl); adAudioObjectUrl = null; }

  adPhotoIds = getSubmissionPhotoIds(s);
  adPhotoObjectUrls = new Array(adPhotoIds.length).fill(null);

  const photoWrap = document.getElementById('ad-photo-wrap');
  photoWrap.innerHTML = adPhotoIds.length
    ? `<div class="field-block" style="margin-bottom:16px;"><div class="fl">Photo</div><div style="font-size:11.5px;color:#999;font-style:italic;margin-top:4px;">Loading photo…</div></div>`
    : `<div class="field-block" style="margin-bottom:16px;"><div class="fl">Photo</div>${photoUnavailableHTML()}</div>`;

  const toggleBtn = document.getElementById('ad-play-toggle');
  const label = document.getElementById('ad-play-label');
  const lenEl = document.getElementById('ad-memo-len');
  const voiceWrap = document.getElementById('ad-voice-wrap');
  voiceWrap.querySelectorAll('audio').forEach(a=>a.remove());
  if(s.audioUrl){
    toggleBtn.disabled = true;
    toggleBtn.style.opacity = '0.4';
    toggleBtn.style.cursor = 'not-allowed';
    toggleBtn.textContent = '▶';
    toggleBtn.onclick = null;
    label.textContent = 'Loading…';
    lenEl.textContent = s.memoLen ? ` · ${s.memoLen}-second field memo` : '';
  } else {
    toggleBtn.disabled = true;
    toggleBtn.style.opacity = '0.4';
    toggleBtn.style.cursor = 'not-allowed';
    toggleBtn.textContent = '▶';
    toggleBtn.onclick = null;
    label.textContent = 'No recording on file';
    lenEl.textContent = '';
  }

  document.getElementById('ad-reject-note').innerHTML = (s.status==='rejected' && s.comment)
    ? `<div style="margin-top:4px;padding:9px 11px;background:rgba(180,67,47,0.08);border-left:2px solid var(--red);font-size:12px;color:#8a3a2c;border-radius:4px;">${escapeHtml(s.comment)}</div>`
    : '';

  // Show the modal right away with fields populated and photo/voice in a
  // loading state — no need to block on the media fetches below.
  document.getElementById('admin-detail-modal').classList.add('show');

  if(adPhotoIds.length){
    await renderAdPhotoAt(s, 0);
  }
  if(s.audioUrl){
    try{
      const objectUrl = await getMediaObjectUrl(s.audioUrl);
      if(adCurrentSubmission !== s) { URL.revokeObjectURL(objectUrl); return; } // modal moved on while this was loading
      adAudioObjectUrl = objectUrl;
      const audioEl = document.createElement('audio');
      audioEl.id = 'ad-memo-audio';
      audioEl.preload = 'none';
      audioEl.src = adAudioObjectUrl;
      audioEl.style.display = 'none';
      voiceWrap.appendChild(audioEl);
      toggleBtn.disabled = false;
      toggleBtn.style.opacity = '';
      toggleBtn.style.cursor = '';
      toggleBtn.textContent = '▶';
      label.textContent = I18N[currentLang].listen;
      toggleBtn.onclick = ()=>{ audioEl.paused ? audioEl.play() : audioEl.pause(); };
      audioEl.onplay = ()=>{ toggleBtn.textContent = '⏸'; label.textContent = I18N[currentLang].playing; };
      audioEl.onpause = ()=>{ toggleBtn.textContent = '▶'; label.textContent = I18N[currentLang].listen; };
      audioEl.onended = ()=>{ toggleBtn.textContent = '▶'; label.textContent = I18N[currentLang].listen; };
      audioEl.onerror = ()=>{ label.textContent = 'Could not load the recording.'; toggleBtn.disabled = true; };
    }catch(err){
      console.error('Could not load submission voice memo:', err);
      if(adCurrentSubmission === s){ label.textContent = 'Could not load the recording.'; }
    }
  }
}
document.getElementById('ad-edit-btn').onclick = ()=>{
  if(!adCurrentSubmission) return;
  renderAdFieldsEditable(adCurrentSubmission);
  document.getElementById('ad-edit-btn').style.display = 'none';
  document.getElementById('ad-edit-actions').style.display = 'flex';
};
document.getElementById('ad-edit-cancel').onclick = ()=>{
  if(!adCurrentSubmission) return;
  renderAdFieldsReadOnly(adCurrentSubmission);
  document.getElementById('ad-edit-actions').style.display = 'none';
  document.getElementById('ad-edit-btn').style.display = 'inline-block';
};
document.getElementById('ad-edit-save').onclick = async ()=>{
  const s = adCurrentSubmission;
  if(!s) return;
  const answers = s.answers || {};
  const answerKeys = Object.keys(answers);
  const newAnswers = {};
  answerKeys.forEach((k,i)=>{
    const input = document.querySelector(`[data-ad-edit-key="${i}"]`);
    newAnswers[k] = input ? input.value : answers[k];
  });
  const changed = answerKeys.some(k=> String(answers[k]) !== String(newAnswers[k]));
  if(!changed){
    document.getElementById('ad-edit-actions').style.display = 'none';
    document.getElementById('ad-edit-btn').style.display = 'inline-block';
    renderAdFieldsReadOnly(s);
    return;
  }
  const saveBtn = document.getElementById('ad-edit-save');
  saveBtn.disabled = true;
  try{
    const batch = writeBatch(db);
    batch.update(doc(db, 'submissions', s.docId), {
      answers: newAnswers,
      updatedAt: serverTimestamp(),
      lastEditedBy: currentUser.email
    });
    const versionRef = doc(collection(db, 'submissionVersions'));
    batch.set(versionRef, {
      submissionDocId: s.docId,
      submissionId: s.id,
      worker: s.worker,
      editedBy: currentUser.email,
      editedByName: currentUser.name,
      editedAt: serverTimestamp(),
      oldAnswers: answers,
      newAnswers: newAnswers
    });
    await batch.commit();
    showToast(`${s.id} updated — change recorded in Version History`);
    adCurrentSubmission = { ...s, answers: newAnswers };
    renderAdFieldsReadOnly(adCurrentSubmission);
    document.getElementById('ad-edit-actions').style.display = 'none';
    document.getElementById('ad-edit-btn').style.display = 'inline-block';
  }catch(err){
    console.error('Failed to save submission edit:', err);
    let msg = 'Could not save this edit — check your connection';
    if(err.code === 'permission-denied'){
      msg = 'Save blocked by Firestore security rules — the "submissions" or "submissionVersions" collection needs a rule allowing admins to write these fields.';
    } else if(!isOnline()){
      msg = friendlyFirestoreError(err);
    } else if(err.message){
      msg = `Could not save this edit — ${err.message}`;
    }
    showToast(msg, 7000);
  }
  saveBtn.disabled = false;
};
document.getElementById('ad-close').onclick = ()=>{
  const a = document.getElementById('ad-memo-audio');
  if(a) a.pause();
  document.getElementById('ad-edit-actions').style.display = 'none';
  document.getElementById('ad-edit-btn').style.display = 'inline-block';
  document.getElementById('admin-detail-modal').classList.remove('show');
  // Free the fetched photo/voice memo blob: URLs now that they're no
  // longer displayed — openAdminDetail() will re-fetch fresh ones next open.
  revokeAdPhotoUrls();
  if(adAudioObjectUrl){ URL.revokeObjectURL(adAudioObjectUrl); adAudioObjectUrl = null; }
  adCurrentSubmission = null;
};
document.getElementById('f-worker').addEventListener('change', refreshSubmissionsSubscription);
document.getElementById('f-sort').addEventListener('change', refreshSubmissionsSubscription);
// Shared row-shaping for every export format — one place that decides what
// a "submission" looks like as flat, exported data, so GeoJSON/Shapefile/
// Excel can never quietly drift out of sync with each other. answers{} is
// flattened into individual columns (q_<label>) rather than one big JSON
// blob, since that's what actually makes the Excel/Shapefile output useful
// to open directly in Excel/QGIS/ArcGIS instead of needing to be
// re-parsed.
function buildExportRows(list){
  return (list || SUBMISSIONS).map(s=>{
    const gm = s.gpsMeta || {};
    const row = {
      id: s.id,
      worker: s.worker || '',
      status: s.status || '',
      form: s.formName || '',
      collected: s.collected || '',
      lat: typeof s.lat === 'number' ? s.lat : '',
      lng: typeof s.lng === 'number' ? s.lng : '',
      gps_accuracy_m: typeof gm.accuracy === 'number' ? gm.accuracy : '',
      gps_quality: gm.quality || '',
      gps_altitude_m: typeof gm.altitude === 'number' ? gm.altitude : '',
      gps_capture_duration_s: gm.captureDurationMs ? +(gm.captureDurationMs/1000).toFixed(1) : '',
      reviewer: s.reviewedBy || '',
      comment: s.comment || ''
    };
    if(s.answers && typeof s.answers === 'object'){
      Object.entries(s.answers).forEach(([label, value])=>{
        row[`q_${label}`] = (value===null || value===undefined) ? '' : String(value);
      });
    }
    return row;
  });
}

function exportAsGeoJSON(list, filename){
  const source = list || SUBMISSIONS;
  const geo = {
    type:"FeatureCollection",
    features: source
      .filter(s=> typeof s.lat === 'number' && typeof s.lng === 'number')
      .map(s=>({
        type:"Feature",
        geometry:{type:"Point", coordinates:[s.lng, s.lat]},
        properties:{id:s.id, worker:s.worker, status:s.status, form:s.formName, collected:s.collected, reviewer:s.reviewedBy||'', comment:s.comment||'',
          gps_accuracy_m: (s.gpsMeta && typeof s.gpsMeta.accuracy === 'number') ? s.gpsMeta.accuracy : null,
          gps_quality: (s.gpsMeta && s.gpsMeta.quality) || null,
          gps_altitude_m: (s.gpsMeta && typeof s.gpsMeta.altitude === 'number') ? s.gpsMeta.altitude : null}
      }))
  };
  const name = filename || 'geosurvey-submissions.geojson';
  const blob = new Blob([JSON.stringify(geo, null, 2)], {type:'application/geo+json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  showToast(`Exported ${name}`);
}

function exportAsExcel(list, filename){
  if(typeof XLSX === 'undefined'){
    showToast('Excel export library failed to load — check your connection and try again.');
    return;
  }
  const name = filename || 'geosurvey-submissions.xlsx';
  const rows = buildExportRows(list);
  const sheet = XLSX.utils.json_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, 'Submissions');
  XLSX.writeFile(workbook, name);
  showToast(`Exported ${name}`);
}

function exportAsShapefile(list, filename){
  if(typeof shpwrite === 'undefined'){
    showToast('Shapefile export library failed to load — check your connection and try again.');
    return;
  }
  // DBF field names are hard-capped at 10 characters (a real Shapefile
  // format limit, not a shp-write quirk) — using short, explicit keys here
  // avoids relying on automatic truncation, which can silently collide two
  // longer field names into the same 10-character name.
  const source = list || SUBMISSIONS;
  const geo = {
    type:"FeatureCollection",
    features: source
      .filter(s=> typeof s.lat === 'number' && typeof s.lng === 'number')
      .map(s=>({
        type:"Feature",
        geometry:{type:"Point", coordinates:[s.lng, s.lat]},
        properties:{
          sub_id: s.id,
          worker: (s.worker||'').slice(0,254),
          status: s.status || '',
          form: (s.formName||'').slice(0,254),
          collected: s.collected || '',
          gps_acc_m: (s.gpsMeta && typeof s.gpsMeta.accuracy === 'number') ? s.gpsMeta.accuracy : null,
          gps_qual: (s.gpsMeta && s.gpsMeta.quality) || '',
          reviewer: (s.reviewedBy||'').slice(0,254),
          comment: (s.comment||'').slice(0,254)
        }
      }))
  };
  const base = filename || 'geosurvey-submissions';
  shpwrite.download(geo, { outputType: 'blob', filename: base, folder: base });
  showToast(`Exported ${base}.zip (Shapefile)`);
}

// Exports a single admin submission (row-level export) using whatever
// format the admin has set as their default in System Settings, so the
// per-row ⬇ button in the submissions table always matches their
// GeoJSON/Excel/Shapefile preference without needing its own selector.
function exportSubmission(s){
  const list = [s];
  // Name the download after the form itself (e.g. "Water Point Survey.xlsx")
  // rather than a generic filename — only strip characters that are
  // actually invalid in filenames (/ \ : * ? " < > |), so spacing and
  // capitalization from the form name are preserved.
  const safeName = (s.formName || s.id || 'submission').toString().replace(/[\/\\:*?"<>|]+/g, '-').trim().slice(0,80);
  if(defaultExportFormat === 'Excel') exportAsExcel(list, `${safeName}.xlsx`);
  else if(defaultExportFormat === 'Shapefile') exportAsShapefile(list, safeName);
  else exportAsGeoJSON(list, `${safeName}.geojson`);
}

function renderUsersTable(){
  const tbody = document.getElementById('users-table-body');
  tbody.innerHTML = '';
  const escName = (s)=> String(s==null?'':s).replace(/"/g,'&quot;');
  // The signed-in admin manages other accounts here, not their own — showing
  // their own row would let them accidentally disable themselves (locking
  // themselves out) or reassign their own supervisor. Account changes for
  // the logged-in user (email/password) already live in Account Settings.
  const rows = WORKERS_LIST.filter(u=> u.uid !== currentUser.uid);
  rows.forEach(u=>{
    const tr = document.createElement('tr');
    const isDisabled = !u.active;
    const statusLabel = u.active ? 'active' : 'disabled';

    // Workers get an editable supervisor cell — this is the only place a
    // wrong/stale supervisor assignment (set once at account creation, see
    // nu-confirm's onclick) can ever be corrected. Without this, a worker
    // pointed at the wrong supervisor uid silently never shows up in any
    // supervisor's queue, with no error anywhere, since the query is a
    // simple where('supervisorId','==', uid) that just returns zero results.
    let supervisorCellHTML;
    if(u.role==='worker'){
      const activeSupervisors = WORKERS_LIST.filter(w=>w.role==='supervisor' && w.active);
      const options = activeSupervisors.map(s=>
        `<option value="${s.uid}" ${s.uid===u.supervisorId ? 'selected' : ''}>${escName(s.name)}</option>`
      ).join('');
      // If this worker's current supervisorId doesn't resolve to any active
      // supervisor (deleted, renamed, disabled, or was never set), surface
      // that clearly instead of silently defaulting to the first option in
      // the list — defaulting there would look like a valid assignment.
      const isUnresolved = !activeSupervisors.some(s=>s.uid===u.supervisorId);
      supervisorCellHTML = `
        <select class="input reassign-supervisor-select" data-uid="${u.uid}" data-name="${escName(u.name)}" style="padding:6px 8px;font-size:12.5px;margin:0;${isUnresolved ? 'border-color:var(--red);' : ''}">
          ${isUnresolved ? `<option value="" selected>⚠️ Unassigned</option>` : ''}
          ${options}
        </select>`;
    } else {
      supervisorCellHTML = '—';
    }

    tr.innerHTML = `
      <td>${u.name}</td><td class="mono" style="font-size:12px;">${u.email}</td>
      <td style="text-transform:capitalize;">${u.role}</td>
      <td>${supervisorCellHTML}</td>
      <td><span class="badge ${u.active?'approved':'rejected'}">${statusLabel}</span></td>
      <td style="display:flex;gap:6px;flex-wrap:wrap;">
        <button class="row-link" data-act="toggle">${isDisabled ? I18N[currentLang].enable_user : I18N[currentLang].disable_user}</button>
        <button class="row-link" data-act="delete" style="color:var(--red);">${I18N[currentLang].delete_user}</button>
      </td>
    `;
    tr.querySelector('[data-act="toggle"]').onclick = async ()=>{
      const newActive = isDisabled; // toggling: currently disabled -> becomes active
      try{
        await updateDoc(doc(db, 'users', u.uid), { active: newActive, updatedAt: serverTimestamp() });
        showToast(`${u.name} ${newActive ? I18N[currentLang].user_enabled : I18N[currentLang].user_disabled}`);
      }catch(err){
        notifyError(err, 'Could not update this user — check your connection');
      }
    };
    tr.querySelector('[data-act="delete"]').onclick = async ()=>{
      const confirmed = await confirmDialog(I18N[currentLang].confirm_delete_user, I18N[currentLang].delete_label || 'Delete');
      if(!confirmed) return;
      // This deletes the user's Firestore profile only. Their Firebase Auth
      // login record can't be removed from the client SDK (that requires
      // admin privileges via Cloud Functions / Admin SDK), so disabling
      // (above) is what actually blocks them from doing anything once
      // deleted — the disabled Auth account will simply fail the
      // app's active-check on next sign-in. Deleting here mainly clears
      // them out of lists, assignments, and the workers dropdown.
      try{
        await deleteDoc(doc(db, 'users', u.uid));
        showToast(`${u.name} ${I18N[currentLang].user_deleted}`);
      }catch(err){
        notifyError(err, 'Could not delete this user — check your connection');
      }
    };
    const reassignSel = tr.querySelector('.reassign-supervisor-select');
    if(reassignSel){
      reassignSel.onchange = async (e)=>{
        const newSupervisorId = e.target.value;
        const newSupervisor = WORKERS_LIST.find(w=>w.uid===newSupervisorId);
        if(!newSupervisorId || !newSupervisor){
          showToast('Pick a supervisor to assign.');
          e.target.value = u.supervisorId || '';
          return;
        }
        reassignSel.disabled = true;
        try{
          const batch = writeBatch(db);
          // The worker's profile is what every *future* submission reads
          // supervisorId from (see the submit handler's addDoc call).
          batch.update(doc(db, 'users', u.uid), {
            supervisor: newSupervisor.name,
            supervisorId: newSupervisorId,
            updatedAt: serverTimestamp()
          });
          // Past submissions already have the old (wrong/missing)
          // supervisorId baked in and won't pick up the profile change on
          // their own — repair any of this worker's still-pending ones so
          // they immediately appear in the newly-assigned supervisor's
          // queue instead of staying orphaned. Reviewed submissions are
          // left alone since they're historical record, not awaiting review.
          const pendingSnap = await getDocs(query(
            collection(db, 'submissions'),
            where('workerId', '==', u.uid),
            where('status', '==', 'pending')
          ));
          pendingSnap.docs.forEach(d=>{
            batch.update(doc(db, 'submissions', d.id), { supervisorId: newSupervisorId, updatedAt: serverTimestamp() });
          });
          await batch.commit();
          showToast(`${u.name} reassigned to ${newSupervisor.name}${pendingSnap.size ? ` — ${pendingSnap.size} pending submission${pendingSnap.size===1?'':'s'} moved` : ''}`);
        }catch(err){
          notifyError(err, 'Could not reassign this worker — check your connection');
          e.target.value = u.supervisorId || '';
        }
        reassignSel.disabled = false;
      };
    }
    tbody.appendChild(tr);
  });
}

/* ---------------- Admin: Version History ---------------- */
function fmtVersionValue(v){
  if(v === undefined || v === null || v === '') return '<span style="opacity:0.4;font-style:italic;">(empty)</span>';
  return String(v);
}
function renderVersionsView(){
  const list = document.getElementById('versions-list');
  if(!list) return;
  if(VERSIONS.length === 0){
    list.innerHTML = `<div class="q-empty" style="padding:40px 12px;text-align:center;">${I18N[currentLang].no_version_history}</div>`;
    updateVersionsDeleteBtn();
    return;
  }
  list.innerHTML = VERSIONS.map(v=>{
    const oldA = v.oldAnswers || {};
    const newA = v.newAnswers || {};
    const keys = [...new Set([...Object.keys(oldA), ...Object.keys(newA)])];
    const rowsHTML = keys.map(k=>{
      const changed = oldA[k] !== newA[k];
      return `
        <div class="field-block" style="${changed ? 'background:rgba(217,164,65,0.12);border-radius:6px;padding:6px 8px;' : ''}">
          <div class="fl">${k}</div>
          <div class="fv">${fmtVersionValue(oldA[k])}</div>
        </div>`;
    }).join('');
    const rowsHTMLNew = keys.map(k=>{
      const changed = oldA[k] !== newA[k];
      return `
        <div class="field-block" style="${changed ? 'background:rgba(107,122,63,0.12);border-radius:6px;padding:6px 8px;' : ''}">
          <div class="fl">${k}</div>
          <div class="fv">${fmtVersionValue(newA[k])}</div>
        </div>`;
    }).join('');
    const when = v.editedAt?.toDate ? v.editedAt.toDate().toLocaleString() : '';
    return `
      <div class="panel" style="margin-bottom:16px;">
        <div class="panel-head" style="align-items:flex-start;">
          <div style="display:flex;align-items:flex-start;gap:10px;">
            <input type="checkbox" class="version-cb" value="${v.id}" style="width:16px;height:16px;margin-top:3px;accent-color:var(--clay);flex-shrink:0;" />
            <div>
              <h3 style="font-size:15px;margin:0;">${v.submissionId || v.submissionDocId} — ${v.worker || ''}</h3>
              <div style="font-size:11.5px;color:var(--ink-soft);opacity:0.7;margin-top:2px;">Edited by ${v.editedByName || v.editedBy || 'admin'}${when ? ' · '+when : ''}</div>
            </div>
          </div>
        </div>
        <div class="version-pair">
          <div class="version-col old">
            <div class="vt">Before</div>
            ${rowsHTML || '<div style="font-size:11.5px;color:#999;font-style:italic;">No survey answers recorded</div>'}
          </div>
          <div class="version-col new">
            <div class="vt">After</div>
            ${rowsHTMLNew || '<div style="font-size:11.5px;color:#999;font-style:italic;">No survey answers recorded</div>'}
          </div>
        </div>
      </div>`;
  }).join('');
  list.querySelectorAll('.version-cb').forEach(cb=> cb.addEventListener('change', updateVersionsDeleteBtn));
  updateVersionsDeleteBtn();
}

// Keeps "Select all" and the delete button's enabled state/count in sync
// with the individual version checkboxes — same pattern as the submissions
// bulk-delete tool in System Settings.
function updateVersionsDeleteBtn(){
  const checked = document.querySelectorAll('.version-cb:checked').length;
  const total = document.querySelectorAll('.version-cb').length;
  const btn = document.getElementById('delete-versions-btn');
  if(btn){
    btn.textContent = `🗑 Delete selected (${checked})`;
    btn.disabled = checked === 0;
  }
  const selectAllCb = document.getElementById('versions-select-all');
  if(selectAllCb) selectAllCb.checked = total > 0 && checked === total;
}
document.getElementById('versions-select-all').onclick = (e)=>{
  const on = e.target.checked;
  document.querySelectorAll('.version-cb').forEach(cb=> cb.checked = on);
  updateVersionsDeleteBtn();
};
document.getElementById('delete-versions-btn').onclick = async ()=>{
  if(currentUser.role !== 'admin') return;
  const checkedIds = Array.from(document.querySelectorAll('.version-cb:checked')).map(cb=>cb.value);
  const count = checkedIds.length;
  if(count === 0) return;
  const typed = await confirmDialog(
    `This permanently deletes the ${count} selected version record${count===1?'':'s'} from Firestore. This can't be undone.\n\nType DELETE to confirm.`,
    'Delete permanently',
    'DELETE'
  );
  if(!typed) return;

  const btn = document.getElementById('delete-versions-btn');
  btn.disabled = true;
  let deleted = 0, failed = 0;
  // Firestore batches are capped at 500 writes, so delete in chunks — each
  // chunk still commits atomically, just far fewer round trips than one
  // deleteDoc() per version record. Mirrors the submissions bulk-delete tool.
  const CHUNK = 400;
  for(let i=0; i<checkedIds.length; i+=CHUNK){
    const chunk = checkedIds.slice(i, i+CHUNK);
    const batch = writeBatch(db);
    chunk.forEach(vid=> batch.delete(doc(db, 'submissionVersions', vid)));
    try{
      await batch.commit();
      deleted += chunk.length;
    }catch(err){
      console.error('Failed to delete a batch of version records', err);
      failed += chunk.length;
    }
  }
  showToast(failed ? `Deleted ${deleted}, ${failed} failed — see console.` : `Deleted ${deleted} version record${deleted===1?'':'s'}.`);
  // VERSIONS/renderVersionsView() will refresh on their own via the live
  // subscribeVersions() onSnapshot listener once the deletes land — no
  // manual reload needed here.
};

document.getElementById('nu-role').addEventListener('change', (e)=>{
  document.getElementById('nu-supervisor-wrap').style.display = e.target.value==='worker' ? 'block' : 'none';
});

document.getElementById('new-user-btn').onclick = ()=>{
  document.getElementById('nu-name').value = '';
  document.getElementById('nu-email').value = '';
  document.getElementById('nu-role').value = 'worker';
  document.getElementById('nu-password').value = 'changeme123';
  document.getElementById('nu-error').style.display = 'none';
  document.getElementById('nu-supervisor-wrap').style.display = 'block';
  const supSelect = document.getElementById('nu-supervisor');
  supSelect.innerHTML = WORKERS_LIST.filter(w=>w.role==='supervisor' && w.active)
    .map(w=>`<option value="${w.name}">${w.name}</option>`).join('');
  document.getElementById('user-modal').classList.add('show');
};
document.getElementById('nu-cancel').onclick = ()=> document.getElementById('user-modal').classList.remove('show');
document.getElementById('nu-confirm').onclick = async ()=>{
  const name = document.getElementById('nu-name').value.trim();
  const email = document.getElementById('nu-email').value.trim().toLowerCase();
  const role = document.getElementById('nu-role').value;
  const password = document.getElementById('nu-password').value.trim();
  const supervisor = document.getElementById('nu-supervisor').value;
  const errEl = document.getElementById('nu-error');
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const btn = document.getElementById('nu-confirm');

  if(!name || !emailPattern.test(email) || password.length < 6){
    errEl.textContent = I18N[currentLang].err_fill_required + ' (password needs 6+ characters)';
    errEl.style.display = 'block';
    return;
  }
  if(WORKERS_LIST.some(w=>w.email===email)){
    errEl.textContent = I18N[currentLang].err_email_taken;
    errEl.style.display = 'block';
    return;
  }

  // Resolve the supervisor's uid up front, before touching Firebase Auth.
  // A worker profile with a null supervisorId is a silent failure — their
  // submissions still save, but never appear in any supervisor's queue
  // (queries filter on submissions.supervisorUid == the logged-in
  // supervisor's uid, sourced from this worker's supervisorId).
  // Blocking here, instead of after the Auth account already exists, means
  // we never create an orphaned worker in the first place.
  let supervisorId = null;
  if(role==='worker'){
    if(!supervisor){
      errEl.textContent = I18N[currentLang].err_supervisor_unresolved.replace('{supervisor}', '(none selected)');
      errEl.style.display = 'block';
      return;
    }
    const match = WORKERS_LIST.find(w=>w.name===supervisor && w.role==='supervisor' && w.active);
    if(!match){
      errEl.textContent = I18N[currentLang].err_supervisor_unresolved.replace('{supervisor}', supervisor);
      errEl.style.display = 'block';
      return;
    }
    supervisorId = match.uid;
  }

  errEl.style.display = 'none';
  btn.disabled = true;

  // Creating a Firebase Auth user via createUserWithEmailAndPassword signs
  // the *caller* in as that new user, which would kick the admin out of
  // their own session. The standard client-side workaround: spin up a second,
  // throwaway Firebase App instance, create the account there, then tear it
  // down — the admin's primary session in `auth` is never touched.
  const secondaryApp = initializeApp(firebaseConfig, 'UserCreation-' + Date.now());
  const secondaryAuth = getAuth(secondaryApp);
  try{
    const cred = await createUserWithEmailAndPassword(secondaryAuth, email, password);
    // supervisorId was already resolved and validated above — denormalized
    // onto the worker's profile since security rules need a plain uid to
    // compare against request.auth.uid, they can't resolve it from a name.
    await setDoc(doc(db, 'users', cred.user.uid), {
      uid: cred.user.uid,
      name, email, role,
      supervisor: role==='worker' ? supervisor : '—',
      supervisorId,
      active: true,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
    document.getElementById('user-modal').classList.remove('show');
    showToast(`${name} ${I18N[currentLang].user_created}`);
  }catch(err){
    console.error(err);
    errEl.textContent = err.code === 'auth/email-already-in-use'
      ? I18N[currentLang].err_email_taken
      : (err.message || 'Could not create this user.');
    errEl.style.display = 'block';
  }
  await signOut(secondaryAuth).catch(()=>{});
  await deleteApp(secondaryApp).catch(()=>{});
  btn.disabled = false;
};

/* ---------------- Admin: manage/delete individual submissions ---------------- */
let clearSubsDocs = []; // full snapshot of every submission, independent of the overview table's filters
let clearSubsLoaded = false;

async function loadClearSubsList(){
  const listEl = document.getElementById('clear-subs-list');
  const statusEl = document.getElementById('clear-submissions-status');
  const selectAllCb = document.getElementById('clear-subs-select-all');
  if(!listEl) return;
  listEl.innerHTML = `<div style="text-align:center;padding:16px 8px;color:var(--ink-soft);opacity:0.6;font-size:12.5px;">Loading submissions…</div>`;
  selectAllCb.checked = false;
  statusEl.textContent = '';
  try{
    // Deliberately re-fetches the full "submissions" collection here rather
    // than reusing the SUBMISSIONS array — SUBMISSIONS may currently be
    // scoped by an active worker filter on the Overview table, and this
    // list must show all approved submissions regardless of that filter.
    // Filtered to status 'approved' only: admin never sees pending or
    // rejected submissions anywhere in this dashboard — those stay a
    // supervisor's job to review — so this delete tool can't surface them
    // either.
    const snap = await getDocs(query(collection(db, 'submissions'), where('status', '==', 'approved')));
    clearSubsDocs = snap.docs.map(d=> submissionFromDoc(d))
      .sort((a,b)=> (b._createdMillis||0) - (a._createdMillis||0));
    clearSubsLoaded = true;
  }catch(err){
    notifyError(err, 'Could not load submissions — check your connection');
    listEl.innerHTML = `<div style="text-align:center;padding:16px 8px;color:var(--ink-soft);opacity:0.6;font-size:12.5px;">Could not load submissions.</div>`;
    return;
  }
  renderClearSubsList();
}

function renderClearSubsList(){
  const listEl = document.getElementById('clear-subs-list');
  if(clearSubsDocs.length === 0){
    listEl.innerHTML = `<div style="text-align:center;padding:16px 8px;color:var(--ink-soft);opacity:0.6;font-size:12.5px;">There are no submissions.</div>`;
    updateClearSubsBtn();
    return;
  }
  listEl.innerHTML = clearSubsDocs.map(s=>`
    <label class="clear-sub-row">
      <input type="checkbox" class="clear-sub-cb" value="${s.docId}" />
      <div class="clear-sub-info">
        <div class="clear-sub-name">${(s.formName || s.id || s.docId).replace(/</g,'&lt;')}</div>
        <div class="clear-sub-meta">${(s.worker||'').replace(/</g,'&lt;')} · ${s.collected}</div>
      </div>
      <span class="badge ${s.status}">${I18N[currentLang]['l_'+s.status] || s.status}</span>
    </label>
  `).join('');
  listEl.querySelectorAll('.clear-sub-cb').forEach(cb=> cb.addEventListener('change', updateClearSubsBtn));
  updateClearSubsBtn();
}

function updateClearSubsBtn(){
  const checked = document.querySelectorAll('.clear-sub-cb:checked').length;
  const total = document.querySelectorAll('.clear-sub-cb').length;
  const btn = document.getElementById('clear-submissions-btn');
  btn.textContent = `🗑 Delete selected (${checked})`;
  btn.disabled = checked === 0;
  const selectAllCb = document.getElementById('clear-subs-select-all');
  selectAllCb.checked = total > 0 && checked === total;
}

document.getElementById('clear-subs-select-all').onclick = (e)=>{
  const on = e.target.checked;
  document.querySelectorAll('.clear-sub-cb').forEach(cb=> cb.checked = on);
  updateClearSubsBtn();
};
document.getElementById('clear-subs-refresh').onclick = ()=> loadClearSubsList();

const clearSubsBtn = document.getElementById('clear-submissions-btn');
if(clearSubsBtn) clearSubsBtn.onclick = async ()=>{
  if(currentUser.role !== 'admin') return;
  const checkedIds = Array.from(document.querySelectorAll('.clear-sub-cb:checked')).map(cb=>cb.value);
  const count = checkedIds.length;
  if(count === 0) return;
  const typed = await confirmDialog(
    `This permanently deletes the ${count} selected submission${count===1?'':'s'} from Firestore. This can't be undone.\n\nType DELETE to confirm.`,
    'Delete permanently',
    'DELETE'
  );
  if(!typed) return;

  clearSubsBtn.disabled = true;
  const statusEl = document.getElementById('clear-submissions-status');
  statusEl.textContent = `Deleting ${count} submission${count===1?'':'s'}…`;
  let deleted = 0, failed = 0;
  // Firestore batches are capped at 500 writes, so delete in chunks —
  // each chunk still commits atomically (all-or-nothing), just far fewer
  // round trips than one deleteDoc() per submission.
  const CHUNK = 400;
  for(let i=0; i<checkedIds.length; i+=CHUNK){
    const chunk = checkedIds.slice(i, i+CHUNK);
    const batch = writeBatch(db);
    chunk.forEach(docId=> batch.delete(doc(db, 'submissions', docId)));
    // Media is deleted from the backend before the batch commits (not
    // after): an admin bypasses the ownership check either way, but
    // doing it in this order keeps both delete paths (this one and the
    // worker's own, below) consistent, and means a mid-batch failure
    // never leaves files whose owning doc is already gone and
    // un-lookup-able. photoUrl/audioUrl are now backend fileIds, not
    // Storage paths — look each submission up locally to find them.
    await Promise.allSettled(chunk.map(docId=>{
      const s = clearSubsDocs.find(x=> x.docId === docId);
      return deleteSubmissionMedia([s && s.photoUrl, s && s.audioUrl]);
    }));
    try{
      await batch.commit();
      deleted += chunk.length;
    }catch(err){
      console.error('Failed to delete a batch of submissions', err);
      failed += chunk.length;
    }
    statusEl.textContent = `Deleting… ${deleted + failed}/${count}`;
  }
  statusEl.textContent = failed
    ? `Deleted ${deleted} submission${deleted===1?'':'s'} — ${failed} failed (check console).`
    : `Deleted ${deleted} submission${deleted===1?'':'s'}.`;
  showToast(failed ? 'Some submissions could not be deleted — see the status message below the button.' : 'Selected submissions deleted');
  // Remove the deleted ones from the in-memory list and re-render rather
  // than a full refetch, so the list doesn't jump/flicker after a delete.
  const deletedIds = new Set(checkedIds.slice(0, deleted));
  clearSubsDocs = clearSubsDocs.filter(s=> !deletedIds.has(s.docId));
  renderClearSubsList();
};

/* ---------------- Maps ---------------- */
function statusColor(s){ return s==='pending' ? '#D9A441' : s==='approved' ? '#6B7A3F' : '#B4432F'; }
window.addEventListener('resize', ()=>{
  if(adminMap) adminMap.invalidateSize();
});

/* ---------------- Map controls collapse (mobile) ---------------- */
const mapControlsToggle = document.getElementById('map-controls-toggle');
if(mapControlsToggle){
  mapControlsToggle.onclick = ()=>{
    const panel = document.getElementById('map-controls');
    panel.classList.toggle('open');
    document.getElementById('map-controls-chevron').textContent = panel.classList.contains('open') ? '▴' : '▾';
    setTimeout(()=>{ if(adminMap) adminMap.invalidateSize(); }, 260);
  };
}

function initAdminMap(){
  if(adminMap){ setTimeout(()=>adminMap.invalidateSize(),50); renderMarkers(adminMap); return; }
  adminMap = L.map('map', {
    zoomControl:false, minZoom:3, maxZoom:19, scrollWheelZoom:true,
    dragging:true, tap:true, touchZoom:true, inertia:true, boxZoom:true, keyboard:true
  }).setView([9.0192,38.7620], 12);
  L.control.zoom({position:'bottomright'}).addTo(adminMap);
  // Fallback tile: a 1x1 transparent PNG. Without this, individual failed
  // tiles (a transient host hiccup, a rate-limited request, etc.) render as
  // broken-image icons scattered across the map instead of just staying
  // blank, which reads as "totally broken" even when only a handful of
  // tiles actually failed.
  const TRANSPARENT_TILE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

  streetLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution:'&copy; OpenStreetMap contributors',
    maxZoom:19,
    errorTileUrl: TRANSPARENT_TILE
  });
  // Google Satellite — replaces the old MapTiler layer (which needed a
  // paid/free-tier API key) and the Esri World Imagery endpoint before
  // that (which now returns 403 for unauthenticated requests). Google's
  // "mt1.google.com/vt?lyrs=s" tiles need no key/auth at all. This is an
  // undocumented/unofficial endpoint (not the official Google Maps
  // Platform Tiles API), so it can change or start rate-limiting without
  // notice — if satellite tiles ever stop loading, that's the first
  // thing to check, and the MapTiler layer above is a documented,
  // key-authenticated fallback to switch back to.
  // Standard 256px tiles, so unlike the MapTiler layer this needs no
  // tileSize/zoomOffset/maxNativeZoom adjustment.
  satLayer = L.tileLayer('https://mt1.google.com/vt/lyrs=s&x={x}&y={y}&z={z}', {
    attribution:'&copy; Google',
    maxZoom:19,
    crossOrigin:true,
    errorTileUrl: TRANSPARENT_TILE
  });
  // Log real failures to the console (without surfacing anything in the UI)
  // so a future "satellite looks empty" report can be diagnosed from the
  // browser console instead of guessing again. On top of that, if enough
  // tiles fail in a row while satellite is the active layer to suggest the
  // whole basemap is down (not just a stray tile or two), automatically
  // fall back to Street so the map stays usable without the admin having
  // to notice and switch it manually.
  let satTileErrorStreak = 0;
  const SAT_FALLBACK_ERROR_THRESHOLD = 6;
  satLayer.on('tileerror', (e)=>{
    console.warn('Satellite tile failed to load:', e?.tile?.src);
    if(activeBaseLayerKey !== 'satellite') return;
    satTileErrorStreak++;
    if(satTileErrorStreak >= SAT_FALLBACK_ERROR_THRESHOLD){
      satTileErrorStreak = 0;
      console.warn('Satellite layer appears to be failing to load — falling back to Street layer.');
      switchBaseLayer('street');
      const streetRadio = document.getElementById('bl-street');
      if(streetRadio) streetRadio.checked = true;
      showToast('Satellite imagery is unavailable right now — switched to Street view.');
    }
  });
  // Any successful satellite tile means the layer is basically working, so
  // don't let stray earlier failures (that never hit the threshold) linger
  // and count toward a later, unrelated batch of failures.
  satLayer.on('tileload', ()=>{ satTileErrorStreak = 0; });

  // Single switching path for all base layers, used both by the radio
  // buttons below and by the automatic satellite-failure fallback above.
  // This guarantees exactly one base layer is ever attached to the map —
  // switching only swaps which tile layer is mounted; it never touches
  // markersLayer/heatLayer or calls setView/panTo, so markers and the
  // current map position are untouched.
  function switchBaseLayer(nextKey){
    const nextLayer = baseLayers[nextKey];
    if(!nextLayer || nextKey === activeBaseLayerKey) return;
    const currentLayer = baseLayers[activeBaseLayerKey];
    if(currentLayer && adminMap.hasLayer(currentLayer)) adminMap.removeLayer(currentLayer);
    nextLayer.addTo(adminMap);
    activeBaseLayerKey = nextKey;
    // Photo thumbnails are a Satellite-only affordance — high-resolution
    // imagery is what makes "does this line up with the right rooftop/
    // plot" a meaningful check in the first place. Toggle the whole
    // cluster layer on/off rather than hiding markers one at a time, and
    // refresh it on the way in so anything collected since it was last
    // shown (or never fetched because it was hidden) is brought current.
    if(photoThumbLayer){
      if(nextKey === 'satellite'){
        if(!adminMap.hasLayer(photoThumbLayer)) photoThumbLayer.addTo(adminMap);
        renderPhotoThumbnails();
      } else if(adminMap.hasLayer(photoThumbLayer)){
        adminMap.removeLayer(photoThumbLayer);
      }
    }
  }

  baseLayers = { street: streetLayer, satellite: satLayer };
  activeBaseLayerKey = 'street';
  streetLayer.addTo(adminMap);
  markersLayer = L.layerGroup().addTo(adminMap);
  // NOT added to the map here — only when Satellite becomes active (see
  // switchBaseLayer above). maxClusterRadius/disableClusteringAtZoom keep
  // thumbnails from overlapping when several submissions were collected
  // close together, while still splitting back out into individual,
  // correctly-anchored thumbnails once zoomed in far enough to tell them
  // apart on the imagery.
  photoThumbLayer = L.markerClusterGroup({
    maxClusterRadius: 60,
    spiderfyOnMaxZoom: true,
    showCoverageOnHover: false,
    disableClusteringAtZoom: 19
  });
  renderMarkers(adminMap);
  // Re-sync the visible photo-thumbnail set on every pan/zoom -- newly
  // in-view submissions get markers (and, if Satellite is active, their
  // photo fetched from the shared cache-first getCachedPhotoUrl()), while
  // submissions that scrolled out of the padded viewport get their marker
  // removed (not their cached blob: URL, which stays put for next time).
  // No-op while Street is active: there's nothing on-map to sync, and it'll
  // run once anyway the moment switchBaseLayer() flips to Satellite.
  adminMap.on('moveend zoomend', ()=>{
    if(activeBaseLayerKey === 'satellite') schedulePhotoThumbnailSync();
  });
  // Container can measure 0px on the very first paint in some browsers if the
  // view was still transitioning to display:block when the map was built —
  // that leaves drag pixel bounds stuck at the wrong size even though zoom
  // (which just redraws around the center) looks fine. Re-measuring a beat
  // later fixes panning without needing a manual resize to "unstick" it.
  requestAnimationFrame(()=> adminMap.invalidateSize());
  setTimeout(()=> adminMap.invalidateSize(), 200);

  // Radio buttons drive the same switchBaseLayer() used by the automatic
  // satellite-failure fallback above.
  document.querySelectorAll('input[name="baselayer"]').forEach(radio=>{
    radio.onchange = (e)=> switchBaseLayer(e.target.value);
  });
  document.getElementById('ov-heatmap').onchange = (e)=>{
    if(e.target.checked){
      refreshHeatLayer();
    } else if(heatLayer){ adminMap.removeLayer(heatLayer); heatLayer = null; }
  };
  setTimeout(()=>adminMap.invalidateSize(), 100);
}

// Same transparent-tile trick as initAdminMap() above, duplicated here so
// the worker map doesn't depend on the admin map ever having been built
// (a worker account never touches initAdminMap at all).
const WORKER_MAP_TRANSPARENT_TILE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

// Builds the "My Submissions Map" the first time it's opened, then just
// re-renders markers and re-measures the container on every later open —
// mirrors initAdminMap()'s own lazy-init-once pattern.
function initWorkerMap(){
  if(workerMap){ setTimeout(()=>workerMap.invalidateSize(),50); renderWorkerMapMarkers(); return; }
  workerMap = L.map('worker-map', {
    zoomControl:false, minZoom:3, maxZoom:19, scrollWheelZoom:true,
    dragging:true, tap:true, touchZoom:true, inertia:true, boxZoom:true, keyboard:true
  }).setView([9.0192,38.7620], 12);
  L.control.zoom({position:'bottomright'}).addTo(workerMap);

  workerStreetLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution:'&copy; OpenStreetMap contributors',
    maxZoom:19,
    errorTileUrl: WORKER_MAP_TRANSPARENT_TILE
  });
  // Same unauthenticated Google Satellite endpoint as the admin map (see
  // the long comment in initAdminMap) — no separate fallback-on-failure
  // logic here since this map is a much smaller, secondary surface.
  workerSatLayer = L.tileLayer('https://mt1.google.com/vt/lyrs=s&x={x}&y={y}&z={z}', {
    attribution:'&copy; Google',
    maxZoom:19,
    crossOrigin:true,
    errorTileUrl: WORKER_MAP_TRANSPARENT_TILE
  });

  workerBaseLayers = { street: workerStreetLayer, satellite: workerSatLayer };
  workerActiveBaseLayerKey = 'street';
  workerStreetLayer.addTo(workerMap);
  workerMarkersLayer = L.layerGroup().addTo(workerMap);

  document.querySelectorAll('input[name="worker-baselayer"]').forEach(radio=>{
    radio.onchange = (e)=>{
      const nextKey = e.target.value;
      const nextLayer = workerBaseLayers[nextKey];
      if(!nextLayer || nextKey === workerActiveBaseLayerKey) return;
      const currentLayer = workerBaseLayers[workerActiveBaseLayerKey];
      if(currentLayer && workerMap.hasLayer(currentLayer)) workerMap.removeLayer(currentLayer);
      nextLayer.addTo(workerMap);
      workerActiveBaseLayerKey = nextKey;
    };
  });

  renderWorkerMapMarkers();
  requestAnimationFrame(()=> workerMap.invalidateSize());
  setTimeout(()=> workerMap.invalidateSize(), 200);
}

// Plots a simple circle marker + popup (form name, status, region/date) for
// every one of the current worker's own submissions that has a captured
// GPS fix — no photo thumbnails, clustering, or heatmap, since this is a
// much lighter, secondary view of the same underlying data as the admin
// overview map. Fully rebuilt on each open, which is cheap at the scale of
// one worker's own submissions (unlike the full-system admin map).
function renderWorkerMapMarkers(){
  if(!workerMap || !workerMarkersLayer) return;
  workerMarkersLayer.clearLayers();
  const mine = SUBMISSIONS.filter(s=> s.workerUid===currentUser.uid && typeof s.lat==='number' && typeof s.lng==='number');
  const emptyState = document.getElementById('worker-map-empty');
  if(emptyState) emptyState.remove();
  if(mine.length===0){
    const empty = document.createElement('div');
    empty.id = 'worker-map-empty';
    empty.className = 'q-empty';
    empty.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;text-align:center;padding:20px;z-index:1100;background:rgba(255,253,248,0.85);';
    empty.textContent = I18N[currentLang].map_no_location;
    document.getElementById('worker-map').insertAdjacentElement('afterend', empty);
    return;
  }
  const bounds = [];
  mine.forEach(s=>{
    const marker = L.circleMarker([s.lat, s.lng], {
      radius:8, fillColor: statusColor(s.status), color:'#FFFDF8', weight:2, fillOpacity:0.9
    });
    const statusLabel = s.pendingSync ? I18N[currentLang].pending_sync : (I18N[currentLang]['l_'+s.status] || s.status);
    const badgeClass = s.pendingSync ? 'pending' : s.status;
    marker.bindPopup(`
      <div style="font-family:'Noto Sans',sans-serif;min-width:150px;">
        <div style="font-weight:700;margin-bottom:4px;">${escapeHtml(s.formName || s.id)}</div>
        <div style="font-size:12px;color:var(--ink-soft);margin-bottom:4px;">${escapeHtml(s.region||'')} · ${escapeHtml(s.collected||'')}</div>
        <span class="badge ${badgeClass}">${statusLabel}</span>
      </div>
    `);
    marker.addTo(workerMarkersLayer);
    bounds.push([s.lat, s.lng]);
  });
  if(bounds.length===1){
    workerMap.setView(bounds[0], 15);
  } else if(bounds.length>1){
    workerMap.fitBounds(bounds, { padding:[40,40], maxZoom:16 });
  }
}

// Opens the "My Submissions Map" modal and (re)builds the map inside it.
// The map is created lazily on first open, same reasoning as initAdminMap:
// Leaflet can't measure a container that's still display:none.
function openWorkerMap(){
  document.getElementById('worker-map-modal').classList.add('show');
  initWorkerMap();
}
function closeWorkerMap(){
  document.getElementById('worker-map-modal').classList.remove('show');
}
document.getElementById('wh-view-map-btn').onclick = openWorkerMap;
document.getElementById('worker-map-close').onclick = closeWorkerMap;
document.getElementById('worker-map-close-x').onclick = closeWorkerMap;
document.getElementById('worker-map-modal').addEventListener('click', (e)=>{
  if(e.target.id === 'worker-map-modal') closeWorkerMap();
});
const workerMapControlsToggle = document.getElementById('worker-map-controls-toggle');
if(workerMapControlsToggle){
  workerMapControlsToggle.onclick = ()=>{
    const panel = document.getElementById('worker-map-controls');
    panel.classList.toggle('open');
    document.getElementById('worker-map-controls-chevron').textContent = panel.classList.contains('open') ? '▴' : '▾';
    setTimeout(()=>{ if(workerMap) workerMap.invalidateSize(); }, 260);
  };
}

// Rebuilds the heat layer from the current SUBMISSIONS state. Called both
// when the heatmap checkbox is switched on and every time renderMarkers()
// runs (i.e. on every live submissions update), so the heatmap — not just
// the pin markers — stays current without a page refresh.
function refreshHeatLayer(){
  if(!adminMap) return;
  const cb = document.getElementById('ov-heatmap');
  if(!cb || !cb.checked) return;
  if(heatLayer) adminMap.removeLayer(heatLayer);
  heatLayer = L.heatLayer(SUBMISSIONS.map(s=>[s.lat,s.lng,0.7]), {radius:35, blur:25});
  heatLayer.addTo(adminMap);
}

// Registry of every marker currently on the map, keyed by submission id.
// This is what lets renderMarkers() update in place instead of tearing
// everything down: unchanged submissions are left completely untouched
// (marker, popup content, and any already-fetched photo blob: URLs all
// survive), changed ones are updated via setLatLng/setStyle/setPopupContent
// instead of being destroyed and recreated, and only submissions that no
// longer exist get removed. Switching Street/Satellite never calls this at
// all -- it only swaps the tile layer -- so this registry (and every marker
// and popup in it) is completely unaffected by a base-layer change.
let markerRegistry = new Map();

function renderMarkers(mapInstance){
  const seen = new Set();
  SUBMISSIONS.forEach(s=>{
    const uid = submissionUid(s);
    seen.add(uid);
    const sig = submissionSignature(s);
    const photoIds = getSubmissionPhotoIds(s);
    const existing = markerRegistry.get(uid);

    if(existing && existing.sig === sig){
      // Nothing about this submission changed since the last render --
      // leave the marker, its popup content, and its photo cache exactly
      // as they are. In particular this means an open popup stays open
      // (with its photo already loaded) across unrelated live-data updates
      // instead of being force-closed by a full rebuild.
      return;
    }

    if(existing){
      // Something did change: update the existing marker/popup in place.
      // setPopupContent() refreshes an open popup's content live instead
      // of closing it, which is what keeps this from disrupting whatever
      // the admin is currently looking at.
      existing.marker.setLatLng([s.lat, s.lng]);
      existing.marker.setStyle({ fillColor: statusColor(s.status) });
      existing.marker.setPopupContent(popupHTML(s));
      const photoIdsChanged = JSON.stringify(existing.photoIds) !== JSON.stringify(photoIds);
      if(photoIdsChanged){
        // The photo(s) attached to this submission actually changed (e.g. a
        // resubmission) -- the old cached blob: URLs no longer belong to
        // this submission, so release them rather than risk showing a
        // stale photo. They'll simply be re-fetched lazily next open.
        existing.photoCache.forEach(u=>{ if(u) URL.revokeObjectURL(u); });
        existing.photoCache = new Array(photoIds.length).fill(null);
        existing.photoIds = photoIds;
      }
      existing.sig = sig;
      return;
    }

    // Brand new submission: create its marker and popup once.
    const marker = L.circleMarker([s.lat,s.lng], {
      radius:8, fillColor: statusColor(s.status), color:'#FFFDF8', weight:2, fillOpacity:0.9
    });
    // maxWidth/minWidth are raised beyond the popup's own default size so
    // Leaflet doesn't clip it once the admin drags the resize handle added
    // in popupHTML() (.submission-popup-content has resize:both).
    marker.bindPopup(popupHTML(s), { maxWidth: 520, minWidth: 220, className: 'submission-popup' });
    const entry = { marker, sig, photoIds, photoCache: new Array(photoIds.length).fill(null) };
    if(photoIds.length){
      // Photos are fetched lazily -- only when the popup is actually opened,
      // not for every marker up front -- since each one is an authenticated
      // backend request, not a free static image load. Once fetched, the
      // blob: URL is kept in entry.photoCache and reused on every later
      // open of this same popup instead of being re-fetched from the network.
      marker.on('popupopen', ()=> loadPopupPhotos(uid));
      marker.on('popupclose', ()=> { delete popupPhotoState[uid]; });
    }
    marker.addTo(markersLayer);
    markerRegistry.set(uid, entry);
  });

  // Anything left in the registry that wasn't touched above no longer has a
  // matching submission (deleted, or filtered out) -- remove its marker and
  // release any photo blob: URLs it was holding.
  for(const [uid, entry] of markerRegistry){
    if(!seen.has(uid)){
      markersLayer.removeLayer(entry.marker);
      entry.photoCache.forEach(u=>{ if(u) URL.revokeObjectURL(u); });
      delete popupPhotoState[uid];
      markerRegistry.delete(uid);
    }
  }
  refreshHeatLayer();
  renderPhotoThumbnails();
}

function submissionUid(s){ return String(s.docId || s.id); }
// Cheap fingerprint of every field the marker or its popup actually
// displays. If this is identical to the last render, renderMarkers() above
// skips the submission entirely instead of touching its marker/popup.
function submissionSignature(s){
  return JSON.stringify({
    status:s.status, comment:s.comment, lat:s.lat, lng:s.lng, worker:s.worker,
    region:s.region, formName:s.formName, collected:s.collected,
    gpsMeta:s.gpsMeta, answers:s.answers, photoUrl:s.photoUrl, photoUrls:s.photoUrls
  });
}

// A submission currently only ever has a single photo (`photoUrl`, itself a
// backend fileId, not a public URL). This is written to also pick up a
// hypothetical future multi-photo field (`photoUrls`) so the carousel below
// doesn't need to change if that's ever added -- today it will just always
// resolve to zero or one photo.
function getSubmissionPhotoIds(s){
  const ids = [];
  if(s.photoUrl) ids.push(s.photoUrl);
  if(Array.isArray(s.photoUrls)) s.photoUrls.filter(Boolean).forEach(id=>ids.push(id));
  return [...new Set(ids)];
}

// Builds the L.divIcon for a photo-thumbnail marker in one of three states:
// loading (spinner, photo not fetched yet), loaded (objectUrl set), or
// error (fetch failed). iconAnchor points at the tip of the little tail so
// the anchor sits exactly on the submission's GPS coordinate, not the
// center of the thumbnail image above it.
function photoThumbIcon(objectUrl, state){
  const inner = state === 'error'
    ? `<span class="photo-thumb-error">⚠</span>`
    : objectUrl
      ? `<img src="${objectUrl}" alt="" />`
      : `<span class="photo-thumb-spinner"></span>`;
  return L.divIcon({
    className: '',
    html: `<div class="photo-thumb-marker"><div class="photo-thumb-frame">${inner}</div><div class="photo-thumb-tail"></div></div>`,
    iconSize: [50, 58],
    iconAnchor: [25, 58],
    popupAnchor: [0, -56]
  });
}

// Populates/refreshes the Satellite-only photo-thumbnail layer from the
// current SUBMISSIONS state. Only submissions that actually have a photo
// get a thumbnail marker (requirement: "every collected submission that
// contains a photo"); everything else is left to the regular status-color
// dot in markersLayer. Mirrors renderMarkers()'s add/update/remove-what's-
// no-longer-there pattern. Clicking a thumbnail opens the full admin
// detail modal (openAdminDetail) -- full-resolution image, every
// submission field, and photo-carousel browsing if there's more than one
// -- rather than the small map popup the status dots use.
// Actual photo bytes are only fetched once the layer is genuinely visible
// (Satellite active) — no point spending a request on a thumbnail nobody
// will see because the admin never switched off Street.
// Debounce handle for the pan/zoom-triggered viewport sync below -- panning
// fires many rapid moveend-adjacent events, and rebuilding the visible-photo
// set on every one of them would mean redundant work on every intermediate
// frame instead of once the admin actually stops moving the map.
let photoThumbSyncHandle = null;
function schedulePhotoThumbnailSync(){
  if(photoThumbSyncHandle) clearTimeout(photoThumbSyncHandle);
  photoThumbSyncHandle = setTimeout(()=>{ photoThumbSyncHandle = null; renderPhotoThumbnails(); }, 150);
}
// Rebuilds the Satellite-only photo-thumbnail layer against the current
// SUBMISSIONS state, but -- for large datasets -- only for submissions
// whose GPS point currently falls within the map's viewport (padded by 60%
// on every side, so a small pan doesn't cause a visible pop-in/out right at
// the screen edge). This keeps both the number of Leaflet markers alive and
// the number of photo fetches in flight bounded by "however much is roughly
// on screen" rather than "every photo submission that has ever existed".
//
// Only submissions with a photo get a thumbnail marker at all (requirement:
// "every collected submission that contains a photo"); everything else is
// left to the regular status-color dot in markersLayer, which is unaffected
// by any of this. Clicking a thumbnail opens the full admin detail modal
// (openAdminDetail) -- full-resolution image, every submission field, and
// photo-carousel browsing if there's more than one -- rather than the small
// map popup the status dots use.
//
// Photo bytes are fetched (via the shared, LRU-capped getCachedPhotoUrl())
// only once a thumbnail is genuinely both in-view AND Satellite is active --
// no point spending a request on a thumbnail nobody can see. Markers that
// scroll out of the padded viewport are removed from the map, but their
// blob: URL is left alone in the shared cache (not revoked) so panning back
// redisplays them instantly with no re-fetch, and so Street<->Satellite
// toggling never re-fetches anything either.
function renderPhotoThumbnails(){
  if(!photoThumbLayer || !adminMap) return;
  const bounds = adminMap.getBounds().pad(0.6);
  const seen = new Set();

  SUBMISSIONS.forEach(s=>{
    const photoIds = getSubmissionPhotoIds(s);
    if(!photoIds.length) return; // no photo on this submission -- no thumbnail
    if(typeof s.lat !== 'number' || typeof s.lng !== 'number') return; // no GPS to anchor to
    const uid = submissionUid(s);
    const primaryPhotoId = photoIds[0];
    const inView = bounds.contains([s.lat, s.lng]);
    let entry = photoMarkerRegistry.get(uid);

    if(entry && entry.photoId !== primaryPhotoId){
      // The attached photo itself changed (e.g. a resubmission swapped it
      // out) -- drop the stale marker/entry and rebuild against the new
      // fileId. (The old blob: URL, if cached, is left for the LRU cache to
      // evict naturally -- it's just not referenced by this fileId anymore.)
      photoThumbLayer.removeLayer(entry.marker);
      photoMarkerRegistry.delete(uid);
      entry = null;
    }

    if(!inView){
      // Off-screen: if a marker exists for it, remove it from the map --
      // its cached blob: URL (if any) stays in photoBlobCache untouched, so
      // panning back into view is instant rather than a re-fetch.
      if(entry){
        photoThumbLayer.removeLayer(entry.marker);
        photoMarkerRegistry.delete(uid);
      }
      return; // not "seen" -- nothing left in the registry to protect below
    }

    seen.add(uid);

    if(!entry){
      const cachedUrl = photoBlobCache.get(primaryPhotoId) || null;
      const marker = L.marker([s.lat, s.lng], { icon: photoThumbIcon(cachedUrl, cachedUrl ? 'loaded' : 'loading') });
      // Clicking a thumbnail opens the full submission detail modal (full-
      // resolution image, every field, submission ID, worker, collection
      // time, GPS, and photo-carousel browsing if there's more than one) --
      // looked up fresh from SUBMISSIONS by uid rather than closing over
      // `s`, since this marker/its click handler can outlive many later
      // live-data updates without being rebuilt (see the photoId-unchanged
      // branch below).
      marker.on('click', ()=>{
        const current = SUBMISSIONS.find(x=> submissionUid(x) === uid) || s;
        openAdminDetail(current);
      });
      // A short hover label -- submission ID + worker -- gives a quick
      // orientation cue without requiring a click, since there's no popup
      // anymore to glance at.
      marker.bindTooltip(`${s.id} — ${s.worker}`, { direction: 'top', offset: [0, -54], opacity: 0.92 });
      entry = { marker, photoId: primaryPhotoId, fetching: false, errored: false };
      photoMarkerRegistry.set(uid, entry);
      photoThumbLayer.addLayer(marker);
    } else {
      // Same photo, but the submission's own GPS point or worker/id label
      // may have changed (e.g. an admin edit) -- keep both current. The
      // click handler itself always re-looks-up SUBMISSIONS, so it never
      // needs rebinding here.
      entry.marker.setLatLng([s.lat, s.lng]);
      entry.marker.setTooltipContent(`${s.id} — ${s.worker}`);
    }

    const cachedNow = photoBlobCache.get(primaryPhotoId);
    if(cachedNow){
      entry.marker.setIcon(photoThumbIcon(cachedNow, 'loaded'));
    } else if(!entry.fetching && !entry.errored && activeBaseLayerKey === 'satellite'){
      entry.fetching = true;
      getCachedPhotoUrl(primaryPhotoId).then(objectUrl=>{
        entry.fetching = false;
        if(photoMarkerRegistry.get(uid) !== entry) return; // stale by the time it resolved (marker rebuilt/removed)
        entry.marker.setIcon(photoThumbIcon(objectUrl, 'loaded'));
      }).catch(err=>{
        entry.fetching = false;
        entry.errored = true;
        console.warn('Photo thumbnail could not be loaded:', err);
        if(photoMarkerRegistry.get(uid) === entry) entry.marker.setIcon(photoThumbIcon(null, 'error'));
      });
    }
  });

  // Anything left in the registry that wasn't touched above no longer has a
  // matching in-view, photo-bearing submission (deleted, filtered out, or
  // its GPS point moved off-screen and was already handled above) --
  // there's a small window where a stale entry could otherwise survive if a
  // submission was deleted while off-screen, so sweep those out too.
  for(const [uid, entry] of photoMarkerRegistry){
    if(!seen.has(uid)){
      photoThumbLayer.removeLayer(entry.marker);
      photoMarkerRegistry.delete(uid);
    }
  }
}

// Fetches and displays the photo at `index` for the given popup. Resolved
// blob: URLs are cached on the marker's registry entry (entry.photoCache),
// not just for the lifetime of one popup open -- so closing and reopening
// the same popup, or switching photos back and forth, reuses what's already
// been fetched instead of hitting the network again.
async function showPopupPhotoAt(uid, index){
  const entry = markerRegistry.get(uid);
  if(!entry) return;
  popupPhotoState[uid] = { index };
  const container = document.getElementById('pp-photo-'+uid);
  if(!container) return;
  const statusEl = container.querySelector('.pp-photo-status');
  const imgEl = container.querySelector('.pp-photo-img');
  const countEl = container.querySelector('.pp-photo-count');
  if(countEl) countEl.textContent = `${index+1} / ${entry.photoIds.length}`;

  const cached = entry.photoCache[index];
  if(cached){
    if(imgEl){ imgEl.src = cached; imgEl.style.display = ''; wireImgFallback(imgEl, true); }
    if(statusEl) statusEl.style.display = 'none';
    return;
  }

  if(imgEl) imgEl.style.display = 'none';
  if(statusEl){ statusEl.style.display = ''; statusEl.innerHTML = 'Loading photo…'; }
  let objectUrl;
  try{
    objectUrl = await getMediaObjectUrl(entry.photoIds[index]);
  } catch(e){
    console.warn('Submission photo could not be loaded:', e);
    if(!popupPhotoState[uid] || popupPhotoState[uid].index !== index) return; // stale by the time it failed
    const st = document.getElementById('pp-photo-'+uid)?.querySelector('.pp-photo-status');
    if(st) st.innerHTML = photoUnavailableHTML(true);
    return;
  }
  // If the marker was removed, or its photo set changed, while this fetch
  // was in flight, the result no longer belongs to anything -- don't cache
  // or display it.
  const stillValid = markerRegistry.get(uid) === entry && entry.photoIds[index];
  if(!stillValid){ URL.revokeObjectURL(objectUrl); return; }
  entry.photoCache[index] = objectUrl;
  if(!popupPhotoState[uid] || popupPhotoState[uid].index !== index) return; // navigated away before this resolved
  const freshContainer = document.getElementById('pp-photo-'+uid);
  if(!freshContainer) return; // popup closed while fetching
  const freshImg = freshContainer.querySelector('.pp-photo-img');
  const freshStatus = freshContainer.querySelector('.pp-photo-status');
  if(freshImg){ freshImg.src = objectUrl; freshImg.style.display = ''; wireImgFallback(freshImg, true); }
  if(freshStatus) freshStatus.style.display = 'none';
}
function loadPopupPhotos(uid){
  showPopupPhotoAt(uid, 0);
}
// Bound via inline onclick in the popup markup (see popupPhotoSectionHTML)
// -- module scripts don't auto-attach top-level functions to window, same
// reason focusOnMap is exposed this way below.
window.popupPhotoNav = function(uid, delta){
  const entry = markerRegistry.get(uid);
  if(!entry) return;
  const cur = popupPhotoState[uid] ? popupPhotoState[uid].index : 0;
  const next = (cur + delta + entry.photoIds.length) % entry.photoIds.length;
  showPopupPhotoAt(uid, next);
};

function popupPhotoSectionHTML(s){
  const photoIds = getSubmissionPhotoIds(s);
  if(!photoIds.length) return '';
  const uid = submissionUid(s);
  const navButtons = photoIds.length > 1 ? `
        <button type="button" onclick="window.popupPhotoNav('${uid}',-1)" aria-label="Previous photo" style="position:absolute;left:5px;top:50%;transform:translateY(-50%);background:rgba(0,0,0,0.45);color:#fff;border:none;border-radius:50%;width:22px;height:22px;cursor:pointer;font-size:13px;line-height:1;">‹</button>
        <button type="button" onclick="window.popupPhotoNav('${uid}',1)" aria-label="Next photo" style="position:absolute;right:5px;top:50%;transform:translateY(-50%);background:rgba(0,0,0,0.45);color:#fff;border:none;border-radius:50%;width:22px;height:22px;cursor:pointer;font-size:13px;line-height:1;">›</button>` : '';
  const countHTML = photoIds.length > 1 ? `<div class="pp-photo-count" style="text-align:center;font-size:10px;color:#8a8578;margin-top:3px;">1 / ${photoIds.length}</div>` : '';
  return `
      <div class="popup-photos" id="pp-photo-${uid}" style="margin-top:8px;">
        <div style="position:relative;border-radius:8px;overflow:hidden;background:#f1efe8;min-height:120px;display:flex;align-items:center;justify-content:center;">
          <span class="pp-photo-status" style="font-size:11px;color:#8a8578;">Loading photo…</span>
          <img class="pp-photo-img" style="display:none;width:100%;max-height:200px;object-fit:cover;" />
          ${navButtons}
        </div>
        ${countHTML}
      </div>`;
}
function popupHTML(s){
  const statusLabel = I18N[currentLang]['l_'+s.status] || s.status;
  const answers = s.answers || {};
  // meta/instanceID, start, and end are internal bookkeeping fields (raw
  // Kobo/ODK metadata) rather than something an admin scanning a submission
  // popup needs to see, so they're hidden here.
  const HIDDEN_POPUP_FIELDS = new Set(['meta/instanceID', 'start', 'end']);
  const answerKeys = Object.keys(answers).filter(k => !HIDDEN_POPUP_FIELDS.has(k));
  const answersHTML = answerKeys.length
    ? `<table style="width:100%;table-layout:fixed;border-collapse:collapse;margin-top:8px;">
        ${answerKeys.map(k=>`
          <tr>
            <td style="width:38%;padding:3px 8px 3px 0;font-size:10.5px;color:#8a8578;word-break:break-word;vertical-align:top;">${k}</td>
            <td style="width:62%;padding:3px 0;font-size:12px;font-weight:600;color:#1B2B24;word-break:break-word;overflow-wrap:break-word;">${formatAnswerValue(answers[k])}</td>
          </tr>
        `).join('')}
      </table>`
    : `<div style="font-size:11.5px;color:#999;margin-top:8px;font-style:italic;">No survey answers recorded</div>`;
  const rejectHTML = s.status==='rejected' && s.comment
    ? `<div style="margin-top:8px;padding:7px 9px;background:rgba(180,67,47,0.08);border-left:2px solid #B4432F;font-size:11px;color:#8a3a2c;">${s.comment}</div>`
    : '';
  return `
    <div class="submission-popup-content" style="font-family:'Noto Sans',sans-serif;width:280px;height:320px;min-width:220px;min-height:160px;max-width:520px;max-height:640px;overflow:auto;resize:both;">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:4px;">
        <div style="font-weight:700;font-size:13px;">${s.id} — ${s.worker}</div>
        <span style="font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:0.03em;padding:2px 7px;border-radius:20px;background:${statusColor(s.status)}26;color:${statusColor(s.status)};white-space:nowrap;">${statusLabel}</span>
      </div>
      <div style="font-size:12px;color:#555;margin-bottom:4px;">${s.region}</div>
      ${s.formName ? `<div style="font-size:10.5px;color:#8a8578;margin-bottom:4px;">📋 ${s.formName}</div>` : ''}
      ${popupPhotoSectionHTML(s)}
      <div style="font-size:11px;font-family:'JetBrains Mono',monospace;color:#777;line-height:1.6;">
        📍 Lat: ${s.lat.toFixed(6)}<br>📍 Lng: ${s.lng.toFixed(6)}
        ${s.gpsMeta && typeof s.gpsMeta.accuracy === 'number' ? `<br>🎯 Accuracy: ${s.gpsMeta.accuracy.toFixed(1)} m` : ''}
        ${s.gpsMeta && typeof s.gpsMeta.altitude === 'number' ? `<br>⛰ Altitude: ${Math.round(s.gpsMeta.altitude)} m` : ''}
        ${s.gpsMeta && s.gpsMeta.quality ? `<br>✦ GPS Quality: ${({excellent:'Excellent',good:'Good',fair:'Fair',poor:'Poor',verypoor:'Very Poor'})[s.gpsMeta.quality] || s.gpsMeta.quality}` : ''}
        <br>👤 Collector: ${s.worker}
        <br>🕐 Capture Time: ${s.collected}
      </div>
      ${answersHTML}
      ${rejectHTML}
    </div>
  `;
}
function focusOnMap(lat,lng){
  if(!adminMap) return;
  adminMap.setView([lat,lng], 17);
}
window.focusOnMap = focusOnMap; // module scripts don't auto-attach top-level functions to window; this one is called from an inline onclick=""

/* ---------------- Supervisor: queue + review ---------------- */
function renderQueue(){
  const list = document.getElementById('queue-list');
  list.innerHTML = '';
  const pending = SUBMISSIONS.filter(s=>s.status==='pending');
  if(pending.length===0){
    list.innerHTML = `<div style="padding:20px;text-align:center;color:var(--ink-soft);opacity:0.6;font-size:13px;">No pending submissions 🎉</div>`;
  }
  pending.forEach(s=>{
    const card = document.createElement('div');
    card.className = 'q-card' + (selectedQueueId===s.id ? ' selected' : '');
    card.innerHTML = `
      <div class="top"><span class="wname">${s.worker}</span><span class="badge pending">${I18N[currentLang].l_pending}</span></div>
      <div class="meta">${s.region}</div>
      <div class="meta mono">${s.collected}</div>
    `;
    card.onclick = ()=>{ selectedQueueId = s.id; renderQueue(); renderReview(s); };
    list.appendChild(card);
  });
  if(selectedQueueId){
    const s = SUBMISSIONS.find(x=>x.id===selectedQueueId);
    if(s && s.status==='pending') renderReview(s);
    else {
      selectedQueueId=null;
      if(reviewHistoryUnsub){ reviewHistoryUnsub(); reviewHistoryUnsub = null; }
      document.getElementById('review-panel').innerHTML = emptyStateHTML();
      // Nothing selected anymore — free the cached photo/voice memo blob:
      // URLs rather than leaving them held until some other submission
      // happens to reuse this same cache slot.
      if(reviewMediaCache.photoObjectUrl) URL.revokeObjectURL(reviewMediaCache.photoObjectUrl);
      if(reviewMediaCache.audioObjectUrl) URL.revokeObjectURL(reviewMediaCache.audioObjectUrl);
      reviewMediaCache = { docId: null, photoUrl: null, photoObjectUrl: null, audioUrl: null, audioObjectUrl: null };
    }
  }
}
function emptyStateHTML(){
  return `<div class="empty-state"><div class="display">${I18N[currentLang].select_submission}</div><div>${I18N[currentLang].select_submission_sub}</div></div>`;
}

function renderReview(s){
  const panel = document.getElementById('review-panel');
  const answers = s.answers || {};
  const answerKeys = Object.keys(answers);
  const gpsQualityHTML = gpsMetaFieldBlockHTML(s.gpsMeta);
  const fieldGridHTML = answerKeys.length
    ? answerKeys.map(k=>`<div class="field-block"><div class="fl">${k}</div><div class="fv">${formatAnswerValue(answers[k])}</div></div>`).join('')
      + `<div class="field-block"><div class="fl">Coordinates</div><div class="fv">${s.region}</div></div>`
      + gpsQualityHTML
    : `<div class="field-block"><div class="fl">Coordinates</div><div class="fv">${s.region}</div></div>` + gpsQualityHTML;

  // photoUrl/audioUrl are backend fileIds now (see "Submission media:
  // company-owned backend API" below), not directly-usable URLs — reuse
  // the cached blob: URL below if this is the same file we already fetched
  // for this submission, otherwise render a loading state and fetch it
  // further down. The cache exists because renderReview() re-runs on every
  // live "submissions" snapshot update while this item is selected (see
  // renderQueue()) — without it, every update would re-fetch and re-flash
  // the same photo/audio instead of only loading it once.
  const sameMedia = reviewMediaCache.docId === s.docId;
  const cachedPhotoUrl = (sameMedia && reviewMediaCache.photoUrl === s.photoUrl) ? reviewMediaCache.photoObjectUrl : null;
  const cachedAudioUrl = (sameMedia && reviewMediaCache.audioUrl === s.audioUrl) ? reviewMediaCache.audioObjectUrl : null;
  const photoHTML = !s.photoUrl ? '' : cachedPhotoUrl
    ? `<div class="field-block" style="margin-bottom:16px;"><div class="fl">Photo</div><img id="review-photo-img" src="${cachedPhotoUrl}" style="max-width:100%;border-radius:8px;margin-top:6px;display:block;" />${photoGpsCaptionHTML(s.photoGps)}</div>`
    : `<div class="field-block" style="margin-bottom:16px;"><div class="fl">Photo</div><div id="review-photo-loading" style="font-size:11.5px;color:#999;font-style:italic;margin-top:4px;">Loading photo…</div></div>`;

  panel.innerHTML = `
    <div class="review-head">
      <div>
        <h2>${s.id} — ${s.worker}</h2>
        <div class="stamp ticket-edge" style="color:var(--teal);">📍 ${s.lat.toFixed(5)}, ${s.lng.toFixed(5)} · ${s.collected}</div>
        ${s.formName ? `<div style="margin-top:8px;display:flex;align-items:center;gap:8px;">
          <span style="font-size:12px;color:var(--ink-soft);">📋 ${s.formName}</span>
          <button class="btn-open-form" id="review-open-form">${I18N[currentLang].open_form}</button>
        </div>` : ''}
      </div>
      <span class="badge pending">${I18N[currentLang].l_pending}</span>
    </div>
    <div class="field-grid">
      ${fieldGridHTML}
    </div>
    ${photoHTML}
    <div class="voice-player">
      <button class="play-btn" id="play-toggle" ${(s.audioUrl && cachedAudioUrl) ? '' : 'disabled style="opacity:0.4;cursor:not-allowed;"'}>▶</button>
      <div class="voice-meta"><strong id="play-label">${!s.audioUrl ? 'No recording on file' : (cachedAudioUrl ? I18N[currentLang].listen : 'Loading…')}</strong>${s.memoLen}-second field memo · English required</div>
      ${cachedAudioUrl ? `<audio id="memo-audio" preload="none" src="${cachedAudioUrl}" style="display:none;"></audio>` : ''}
    </div>
    <div class="action-row">
      <button class="btn-approve" id="approve-btn">${I18N[currentLang].approve}</button>
      <button class="btn-reject" id="reject-btn">${I18N[currentLang].reject}</button>
    </div>
    <div id="review-history" style="margin-top:18px;"></div>
  `;
  const reviewOpenFormBtn = document.getElementById('review-open-form');
  if(reviewOpenFormBtn) reviewOpenFormBtn.onclick = ()=> openFormPreview(s.formId, s.formName);
  subscribeReviewHistory(s.docId);
  wireImgFallback(document.getElementById('review-photo-img'));

  function wireAudioPlayback(){
    const audioEl = document.getElementById('memo-audio');
    const toggleBtn = document.getElementById('play-toggle');
    const label = document.getElementById('play-label');
    if(!audioEl || !toggleBtn || !label) return;
    toggleBtn.onclick = ()=>{ audioEl.paused ? audioEl.play() : audioEl.pause(); };
    audioEl.onplay = ()=>{ toggleBtn.textContent = '⏸'; label.textContent = I18N[currentLang].playing; };
    audioEl.onpause = ()=>{ toggleBtn.textContent = '▶'; label.textContent = I18N[currentLang].listen; };
    audioEl.onended = ()=>{ toggleBtn.textContent = '▶'; label.textContent = I18N[currentLang].listen; };
    audioEl.onerror = ()=>{ label.textContent = 'Could not load the recording.'; toggleBtn.disabled = true; };
  }
  if(s.audioUrl && cachedAudioUrl) wireAudioPlayback();

  // Fetch whichever of photo/audio isn't already cached for this exact
  // submission + fileId. If the cache belongs to a different submission,
  // its object: URLs are stale — revoke them before overwriting.
  if(!sameMedia){
    if(reviewMediaCache.photoObjectUrl) URL.revokeObjectURL(reviewMediaCache.photoObjectUrl);
    if(reviewMediaCache.audioObjectUrl) URL.revokeObjectURL(reviewMediaCache.audioObjectUrl);
    reviewMediaCache = { docId: s.docId, photoUrl: null, photoObjectUrl: null, audioUrl: null, audioObjectUrl: null };
  }
  if(s.photoUrl && !cachedPhotoUrl){
    getMediaObjectUrl(s.photoUrl).then(objectUrl=>{
      if(selectedQueueId !== s.id){ URL.revokeObjectURL(objectUrl); return; } // selection moved on while this was loading
      if(reviewMediaCache.photoObjectUrl) URL.revokeObjectURL(reviewMediaCache.photoObjectUrl);
      reviewMediaCache.docId = s.docId;
      reviewMediaCache.photoUrl = s.photoUrl;
      reviewMediaCache.photoObjectUrl = objectUrl;
      const loadingEl = document.getElementById('review-photo-loading');
      if(loadingEl){
        loadingEl.parentElement.outerHTML = `<div class="field-block" style="margin-bottom:16px;"><div class="fl">Photo</div><img id="review-photo-img" src="${objectUrl}" style="max-width:100%;border-radius:8px;margin-top:6px;display:block;" />${photoGpsCaptionHTML(s.photoGps)}</div>`;
        wireImgFallback(document.getElementById('review-photo-img'));
      }
    }).catch(err=>{
      console.error('Could not load submission photo:', err);
      const loadingEl = document.getElementById('review-photo-loading');
      if(loadingEl) loadingEl.parentElement.innerHTML = `<div class="fl">Photo</div>${photoUnavailableHTML()}`;
    });
  }
  if(s.audioUrl && !cachedAudioUrl){
    getMediaObjectUrl(s.audioUrl).then(objectUrl=>{
      if(selectedQueueId !== s.id){ URL.revokeObjectURL(objectUrl); return; } // selection moved on while this was loading
      if(reviewMediaCache.audioObjectUrl) URL.revokeObjectURL(reviewMediaCache.audioObjectUrl);
      reviewMediaCache.docId = s.docId;
      reviewMediaCache.audioUrl = s.audioUrl;
      reviewMediaCache.audioObjectUrl = objectUrl;
      const toggleBtn = document.getElementById('play-toggle');
      const label = document.getElementById('play-label');
      const player = toggleBtn ? toggleBtn.closest('.voice-player') : null;
      if(!player) return;
      let audioEl = document.getElementById('memo-audio');
      if(!audioEl){
        audioEl = document.createElement('audio');
        audioEl.id = 'memo-audio';
        audioEl.preload = 'none';
        audioEl.style.display = 'none';
        player.appendChild(audioEl);
      }
      audioEl.src = objectUrl;
      toggleBtn.disabled = false;
      toggleBtn.style.opacity = '';
      toggleBtn.style.cursor = '';
      label.textContent = I18N[currentLang].listen;
      wireAudioPlayback();
    }).catch(err=>{
      console.error('Could not load submission voice memo:', err);
      const label = document.getElementById('play-label');
      if(label) label.textContent = 'Could not load the recording.';
    });
  }
  document.getElementById('approve-btn').onclick = async ()=>{
    const btn = document.getElementById('approve-btn');
    btn.disabled = true;
    try{
      const batch = writeBatch(db);
      batch.update(doc(db, 'submissions', s.docId), {
        status:'approved', reviewedAt: serverTimestamp(), reviewedBy: doc(db, 'users', currentUser.uid),
        updatedAt: serverTimestamp()
      });
      addReviewLogToBatch(batch, s.docId, 'approved', null);
      if(s.workerUid){
        batch.set(doc(collection(db, 'notifications')), {
          userUid: s.workerUid,
          title: `${s.formName || s.id} approved`,
          comment: 'Your submission has been reviewed and approved.',
          type: 'approved',
          submissionId: s.id,
          read: false,
          createdAt: serverTimestamp()
        });
      }
      await batch.commit();
      showToast(`${s.formName || s.id} approved and stored`);
      selectedQueueId=null;
      renderQueue();
    }catch(err){
      notifyError(err, 'Could not approve — check your connection');
      btn.disabled = false;
    }
  };
  document.getElementById('reject-btn').onclick = ()=>{ openRejectModal(s); };
}

/* Reject modal */
let rejectTarget = null;
function openRejectModal(s){
  rejectTarget = s;
  document.getElementById('reject-comment').value='';
  document.getElementById('reject-modal').classList.add('show');
}
document.getElementById('reject-cancel').onclick = ()=> document.getElementById('reject-modal').classList.remove('show');
document.getElementById('reject-confirm').onclick = async ()=>{
  const comment = document.getElementById('reject-comment').value.trim();
  if(!comment){ document.getElementById('reject-comment').focus(); return; }
  const btn = document.getElementById('reject-confirm');
  btn.disabled = true;
  try{
    const batch = writeBatch(db);
    batch.update(doc(db, 'submissions', rejectTarget.docId), {
      status:'rejected', reviewComment: comment, reviewedAt: serverTimestamp(), reviewedBy: doc(db, 'users', currentUser.uid),
      updatedAt: serverTimestamp()
    });
    addReviewLogToBatch(batch, rejectTarget.docId, 'rejected', comment);
    if(rejectTarget.workerUid){
      batch.set(doc(collection(db, 'notifications')), {
        userUid: rejectTarget.workerUid,
        title: `${rejectTarget.formName || rejectTarget.id} rejected`,
        comment,
        type: 'rejected',
        submissionId: rejectTarget.id,
        read: false,
        createdAt: serverTimestamp()
      });
    }
    await batch.commit();
    document.getElementById('reject-modal').classList.remove('show');
    showToast(`${rejectTarget.formName || rejectTarget.id} rejected — worker notified`);
    selectedQueueId=null;
    renderQueue();
  }catch(err){
    notifyError(err, 'Could not reject — check your connection');
  }
  btn.disabled = false;
};

/* ---------------- Worker PWA ---------------- */
function tickClock(){
  document.getElementById('pwa-clock').textContent = new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
}
setInterval(tickClock, 1000); tickClock();

// Offline handling now runs on Firestore's own network control (disableNetwork/
// enableNetwork) plus each doc's `metadata.hasPendingWrites` flag — no manual
// queue array needed. Writes made while disabled resolve instantly from the
// local cache and sync automatically the moment the network is re-enabled.
let simulateOffline = false;
let resubmitTargetId = null;
let workerHistoryFilter = '';
let workerActiveTab = 'new';

function isOnline(){ return navigator.onLine && !simulateOffline; }

/* ---------------- Offline drafts ----------------
   Firestore's offline persistence is great for text/GPS (it queues the
   write and syncs silently once back online), but a submission made while
   offline was previously either blocked outright (if it had a photo/voice
   memo — Storage has no equivalent offline queue) or written straight into
   that silent sync queue with no chance to review it again. Neither gives
   the worker an editable, visible "I'll finish this later" state.
   Drafts fix that: a submission started/finished while offline is saved
   as a plain JSON object (photo/voice included, base64-encoded) to
   localStorage, per worker. It shows up under the Drafts tab, where it can
   be edited like any other in-progress submission, or deleted — and is
   only ever actually sent to Firestore/Storage when the worker explicitly
   submits it (which requires being back online, same as any fresh photo/
   voice upload). */
let DRAFTS = [];
let editingDraftId = null;

function draftsStorageKey(){
  return currentUser ? `geosurvey_drafts_${currentUser.uid}` : null;
}
function loadDrafts(){
  DRAFTS = [];
  const key = draftsStorageKey();
  if(!key) return;
  try{
    DRAFTS = JSON.parse(localStorage.getItem(key) || '[]');
  }catch(err){
    console.warn('Could not read saved drafts:', err);
    DRAFTS = [];
  }
}
function persistDrafts(){
  const key = draftsStorageKey();
  if(!key) return;
  try{
    localStorage.setItem(key, JSON.stringify(DRAFTS));
  }catch(err){
    // Most likely a full/quota-exceeded localStorage (e.g. a large photo on
    // a device with little storage left) — the in-memory DRAFTS array is
    // still correct for this session, but won't survive a reload.
    console.error('Could not save draft locally — storage may be full:', err);
    showToast('Could not save this draft on your device — storage may be full.');
  }
}
function renderDraftsBadge(){
  const badge = document.getElementById('pwa-drafts-badge');
  if(!badge) return;
  badge.textContent = String(DRAFTS.length);
  badge.style.display = DRAFTS.length ? 'inline-block' : 'none';
}

/* ---------------- Downloaded forms ----------------
   Firestore's own offline persistence already keeps a live cache of the
   "forms" collection, but that cache is implicit — a worker has no way to
   confirm a specific form is actually sitent locally before they lose
   signal, and it can be evicted (storage pressure, a cleared site cache,
   etc.). Downloading a form is an explicit, worker-triggered action that
   writes that form's full schema to plain localStorage, per worker, same
   pattern as Drafts above. Once downloaded it shows up under "Downloaded
   Forms" in the sidebar and can be opened (via the existing form-preview
   modal) with zero network/Firestore dependency at all, even if this
   device has never come online since the form changed. */
let DOWNLOADED_FORMS = [];

// When a worker opens a form from the Downloaded Forms list (see
// renderDownloadedFormsSidebar → openFormPreview(..., {fromDownloads:true})),
// this is set to that form's id so assignedTemplate() treats it as the
// effective form for the rest of the New Submission flow, even if it
// doesn't match currentUser.assignedFormId or nothing in FORM_TEMPLATES
// has hydrated yet (the whole point of downloading a form is to be able
// to fill it out with zero network/Firestore dependency). Cleared by
// resetWorkerForm() once the worker submits or cancels, and at the start
// of any flow that has its own explicit form source (loading a draft,
// resubmitting a past submission) so a stale override never leaks into
// an unrelated flow.
let offlineFormOverrideId = null;

function downloadedFormsStorageKey(){
  return currentUser ? `geosurvey_downloaded_forms_${currentUser.uid}` : null;
}
function loadDownloadedForms(){
  DOWNLOADED_FORMS = [];
  const key = downloadedFormsStorageKey();
  if(!key) return;
  try{
    DOWNLOADED_FORMS = JSON.parse(localStorage.getItem(key) || '[]');
  }catch(err){
    console.warn('Could not read downloaded forms:', err);
    DOWNLOADED_FORMS = [];
  }
}
function persistDownloadedForms(){
  const key = downloadedFormsStorageKey();
  if(!key) return;
  try{
    localStorage.setItem(key, JSON.stringify(DOWNLOADED_FORMS));
  }catch(err){
    // Most likely a full/quota-exceeded localStorage — same fallback as
    // persistDrafts(): the in-memory list is still correct for this
    // session, it just won't survive a reload.
    console.error('Could not save downloaded form locally — storage may be full:', err);
    showToast(I18N[currentLang].download_form_failed);
  }
}
function isFormDownloaded(formId){
  return DOWNLOADED_FORMS.some(f=>f.id===formId);
}
function downloadedFormById(formId){
  return DOWNLOADED_FORMS.find(f=>f.id===formId) || null;
}

// Saves the worker's current effective form (whatever assignedTemplate()
// resolves to) as a standalone, fully offline-openable copy.
function downloadCurrentForm(){
  const t = assignedTemplate();
  if(!t) return;
  DOWNLOADED_FORMS = DOWNLOADED_FORMS.filter(f=>f.id!==t.id);
  DOWNLOADED_FORMS.unshift({
    id: t.id,
    name: t.name || I18N[currentLang].form_name,
    version: t.version || 1,
    questions: t.questions || [],
    downloadedAt: Date.now(),
  });
  persistDownloadedForms();
  updateDownloadFormButton();
  renderDownloadedFormsSidebar();
  showToast(I18N[currentLang].form_downloaded_toast);
}
async function removeDownloadedForm(formId){
  const confirmed = await confirmDialog(I18N[currentLang].confirm_remove_download, I18N[currentLang].remove_download);
  if(!confirmed) return;
  DOWNLOADED_FORMS = DOWNLOADED_FORMS.filter(f=>f.id!==formId);
  persistDownloadedForms();
  updateDownloadFormButton();
  renderDownloadedFormsSidebar();
  showToast(I18N[currentLang].download_removed);
}

// Keeps the Download button in the New Submission screen in sync with
// whether the form currently on screen has already been saved locally.
function updateDownloadFormButton(){
  const btn = document.getElementById('download-form-btn');
  if(!btn) return;
  const t = assignedTemplate();
  if(!t){ btn.style.display = 'none'; return; }
  btn.style.display = 'inline-block';
  const downloaded = isFormDownloaded(t.id);
  btn.textContent = downloaded ? ('✓ ' + I18N[currentLang].form_downloaded) : I18N[currentLang].download_form;
  btn.classList.toggle('downloaded', downloaded);
}

// Renders the "Downloaded Forms" page (a full nav item now, not a sidebar
// flyout) — worker-only. Also keeps the nav badge count in sync, since this
// is called from every place a download is added/removed as well as on
// entering the page itself (see refreshCurrentView()).
function renderDownloadedFormsSidebar(){
  const badge = document.getElementById('downloaded-forms-nav-badge');
  const list = document.getElementById('dlforms-page-list');
  if(badge){
    badge.textContent = String(DOWNLOADED_FORMS.length);
    badge.style.display = (currentUser && currentUser.role==='worker' && DOWNLOADED_FORMS.length) ? 'inline-block' : 'none';
  }
  if(!list) return;
  if(!currentUser || currentUser.role!=='worker') return;

  if(DOWNLOADED_FORMS.length===0){
    list.innerHTML = `<div class="sdf-empty">${I18N[currentLang].no_downloaded_forms}</div>`;
    return;
  }
  const esc = (s)=> String(s==null?'':s).replace(/</g,'&lt;');
  list.innerHTML = DOWNLOADED_FORMS.map(f=>{
    const dt = new Date(f.downloadedAt);
    const dateLbl = isNaN(dt.getTime()) ? '' : dt.toLocaleDateString();
    return `<div class="dlform-card">
      <div class="dlform-card-name">${esc(f.name || I18N[currentLang].form_name)}</div>
      <div class="dlform-card-meta">v${f.version||1}${dateLbl ? ' · '+dateLbl : ''}</div>
      <div class="dlform-card-actions">
        <button type="button" class="dlform-open-btn" data-form-id="${f.id}">${I18N[currentLang].open_form}</button>
        <button type="button" class="dlform-remove-btn" data-remove-id="${f.id}" title="${I18N[currentLang].remove_download}">✕</button>
      </div>
    </div>`;
  }).join('');
  list.querySelectorAll('.dlform-open-btn').forEach(btn=>{
    btn.onclick = ()=>{
      openFormPreview(btn.getAttribute('data-form-id'), null, { fromDownloads: true });
      closeSidebar();
    };
  });
  list.querySelectorAll('.dlform-remove-btn').forEach(btn=>{
    btn.onclick = (e)=>{
      e.stopPropagation();
      removeDownloadedForm(btn.getAttribute('data-remove-id'));
    };
  });
}
document.getElementById('download-form-btn').onclick = downloadCurrentForm;

function blobToDataURL(blob){
  return new Promise((resolve, reject)=>{
    const reader = new FileReader();
    reader.onload = ()=> resolve(reader.result);
    reader.onerror = ()=> reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
function dataURLToBlob(dataURL){
  const [meta, b64] = dataURL.split(',');
  const mime = (meta.match(/data:(.*?);base64/) || [])[1] || 'application/octet-stream';
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for(let i=0;i<bin.length;i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

// Snapshots the New Submission screen's current live state into a plain,
// JSON-serializable object (photo/voice blobs included, as base64) — same
// shape whether this is a brand-new draft or an update to one already
// being edited (editingDraftId set).
// Deliberately does NO validation of its own — a draft is allowed to be
// incomplete in every field, GPS included. It just serializes whatever is
// currently on the form. `needsGps` is a marker for the UI (e.g. the
// Drafts list badge), not a gate: it never blocks capture or save, it only
// records that GPS will need to be (re-)captured before this draft can be
// finally submitted, since updateSubmitState() re-checks that separately
// once the draft is reopened.
async function captureDraftFromForm(){
  const effectiveForm = assignedTemplate();
  return {
    id: editingDraftId || ('DRAFT-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)),
    formId: (effectiveForm && effectiveForm.id) || null,
    formVersion: (effectiveForm && effectiveForm.version) || null,
    formName: (effectiveForm && effectiveForm.name) || null,
    answers: buildAnswersObject(),
    gps: gpsCaptured ? { lat: gpsCaptured.lat, lng: gpsCaptured.lng } : null,
    needsGps: !gpsCaptured,
    photoDataUrl: photoBlob ? await blobToDataURL(photoBlob) : null,
    // photoBlob is already-compressed (EXIF-stripped) by this point, so the
    // photo's own GPS — if any was found — has to be carried alongside it
    // separately, or it's unrecoverable once the draft is reloaded.
    photoExifGps: photoExifGps || null,
    photoRemoved: !!photoRemoved,
    voiceDataUrl: recordedBlob ? await blobToDataURL(recordedBlob) : null,
    recordedSeconds: recordedSeconds || 0,
    resubmitTargetId: resubmitTargetId || null,
    savedAt: Date.now()
  };
}

// Saves (or, if editingDraftId is set, updates in place) the current form
// as a draft, resets the form, and lands the worker on the Drafts tab so
// they can see it was kept.
async function saveCurrentFormAsDraft(){
  const draft = await captureDraftFromForm();
  const idx = DRAFTS.findIndex(d=>d.id===draft.id);
  const wasEditing = !!editingDraftId;
  if(idx >= 0) DRAFTS[idx] = draft; else DRAFTS.unshift(draft);
  persistDrafts();
  renderDraftsBadge();
  editingDraftId = null;
  resubmitTargetId = null;
  resetWorkerForm();
  document.getElementById('editing-draft-banner').style.display = 'none';
  showToast(wasEditing ? I18N[currentLang].draft_updated : I18N[currentLang].draft_saved);
  goToWorkerTab('drafts');
}

// Loads a saved draft back into the live New Submission form for editing —
// mirrors startResubmit()'s approach of re-rendering the answers via
// renderAnswerFields(prefill) so labels line up even if the assigned form
// has since changed shape.
function loadDraftIntoForm(id){
  const draft = DRAFTS.find(d=>d.id===id);
  if(!draft) return;
  editingDraftId = draft.id;
  resubmitTargetId = draft.resubmitTargetId || null;
  renderAnswerFields(draft.answers || {});
  lastRenderedAnswerFormId = (assignedTemplate() || {}).id || null;

  gpsCaptured = draft.gps ? { lat: draft.gps.lat, lng: draft.gps.lng } : null;
  micCaptured = !!draft.voiceDataUrl;
  recordedBlob = draft.voiceDataUrl ? dataURLToBlob(draft.voiceDataUrl) : null;
  recordedSeconds = draft.recordedSeconds || 0;
  recordedChunks = [];
  photoCaptured = !!draft.photoDataUrl;
  photoBlob = draft.photoDataUrl ? dataURLToBlob(draft.photoDataUrl) : null;
  photoExifGps = draft.photoExifGps || null;
  photoRemoved = !!draft.photoRemoved;
  if(photoPreviewUrl){ URL.revokeObjectURL(photoPreviewUrl); photoPreviewUrl = null; }

  const gpsBox = document.getElementById('gps-box');
  const gpsReadout = document.getElementById('gps-readout');
  if(gpsCaptured){
    gpsBox.classList.add('captured');
    gpsReadout.textContent = `${gpsCaptured.lat.toFixed(5)}, ${gpsCaptured.lng.toFixed(5)}`;
    setGpsStatus('GPS Ready (from draft)');
  } else {
    // Draft was saved without a GPS fix (allowed — see captureDraftFromForm's
    // needsGps flag). Reopening it must actively prompt the worker to go
    // capture one, not just silently leave the box looking untouched —
    // reuse the "verypoor" quality badge styling (red) purely for its color,
    // not to claim an actual poor-accuracy reading exists.
    gpsBox.classList.remove('captured');
    gpsReadout.textContent = '';
    setGpsStatus(I18N[currentLang].draft_gps_needed_status, { key:'verypoor', label: I18N[currentLang].needs_gps_badge });
  }

  const preview = document.getElementById('photo-preview');
  const photoRemoveBtn = document.getElementById('photo-remove-btn');
  if(photoBlob){
    photoPreviewUrl = URL.createObjectURL(photoBlob);
    preview.src = photoPreviewUrl;
    preview.style.display = 'block';
    document.getElementById('photo-box').classList.add('captured');
    photoRemoveBtn.style.display = 'inline-block';
    setPhotoButtonLabels(true);
  } else {
    preview.style.display = 'none';
    preview.src = '';
    document.getElementById('photo-box').classList.remove('captured');
    photoRemoveBtn.style.display = 'none';
    setPhotoButtonLabels(false);
  }

  const micBox = document.getElementById('mic-box');
  const micReadout = document.getElementById('mic-readout');
  const micRemoveBtn = document.getElementById('mic-remove-btn');
  if(recordedBlob){
    micBox.classList.add('captured');
    micReadout.textContent = `${recordedSeconds}s recorded`;
    micRemoveBtn.style.display = 'inline-block';
  } else {
    micBox.classList.remove('captured');
    micReadout.textContent = '';
    micRemoveBtn.style.display = 'none';
  }

  const banner = document.getElementById('editing-draft-banner');
  document.getElementById('editing-draft-banner-text').textContent = I18N[currentLang].editing_draft_banner;
  banner.style.display = 'flex';

  document.getElementById('submit-btn').textContent = resubmitTargetId ? I18N[currentLang].resubmit_btn : I18N[currentLang].submit_data;
  updateSubmitState();
  goToWorkerTab('new');

  // Explicit nudge, in addition to the persistent status-row prompt above —
  // opening an incomplete draft shouldn't leave the worker to notice a
  // missing GPS fix on their own.
  if(!gpsCaptured){
    showToast(I18N[currentLang].draft_gps_missing_toast);
  }
}

function cancelEditingDraft(){
  editingDraftId = null;
  resubmitTargetId = null;
  resetWorkerForm();
  document.getElementById('editing-draft-banner').style.display = 'none';
}

async function deleteDraft(id){
  const confirmed = await confirmDialog(I18N[currentLang].confirm_delete_draft, I18N[currentLang].delete_draft || 'Delete');
  if(!confirmed) return;
  DRAFTS = DRAFTS.filter(d=>d.id!==id);
  persistDrafts();
  renderDraftsBadge();
  if(editingDraftId === id) cancelEditingDraft();
  showToast(I18N[currentLang].draft_deleted);
  renderDraftsList();
}

function renderDraftsList(){
  const wrap = document.getElementById('pwa-drafts-list');
  if(!wrap) return;
  if(DRAFTS.length === 0){
    wrap.innerHTML = `<div class="q-empty">${I18N[currentLang].no_drafts}</div>`;
    return;
  }
  const online = isOnline();
  wrap.innerHTML = '';
  DRAFTS.forEach(d=>{
    const savedDate = d.savedAt ? new Date(d.savedAt).toLocaleString() : '';
    const summary = Object.entries(d.answers || {}).filter(([,v])=>v).slice(0, 2)
      .map(([k,v])=> `${k}: ${v}`).join(' · ');
    const card = document.createElement('div');
    card.className = 'wh-card';
    card.innerHTML = `
      <div class="top">
        <span class="wid">${d.formName || I18N[currentLang].untitled_draft}</span>
        <div class="top-right">
          <span class="badge draft">${I18N[currentLang].l_draft}</span>
          ${(d.needsGps || !d.gps) ? `<span class="badge needs-gps">${I18N[currentLang].needs_gps_badge}</span>` : ''}
          <button class="wh-delete-btn" data-id="${d.id}" title="${I18N[currentLang].delete_draft}">🗑</button>
        </div>
      </div>
      <div class="meta">${savedDate}${d.gps ? ' · ' + d.gps.lat.toFixed(5) + ', ' + d.gps.lng.toFixed(5) : ''}</div>
      ${summary ? `<div class="meta">${summary}</div>` : ''}
      <div>
        <button class="draft-edit-btn" data-id="${d.id}">${I18N[currentLang].edit_draft}</button>
        <button class="draft-submit-btn" data-id="${d.id}" ${online ? '' : 'disabled'} title="${online ? '' : I18N[currentLang].draft_needs_connection}">${I18N[currentLang].submit_draft}</button>
      </div>
    `;
    card.querySelector('.draft-edit-btn').onclick = ()=> loadDraftIntoForm(d.id);
    card.querySelector('.draft-submit-btn').onclick = (e)=>{
      if(!isOnline()){ showToast(I18N[currentLang].draft_needs_connection); return; }
      loadDraftIntoForm(d.id);
      document.getElementById('submit-btn').click();
    };
    card.querySelector('.wh-delete-btn').onclick = ()=> deleteDraft(d.id);
    wrap.appendChild(card);
  });
}

function updateOnlineLabel(){
  const label = document.getElementById('pwa-online-label');
  const btn = document.getElementById('pwa-offline-toggle');
  if(isOnline()){
    if(label){ label.innerHTML = `🟢 <span>${I18N[currentLang].online}</span>`; label.classList.remove('offline'); }
    if(btn) btn.classList.remove('active');
  } else {
    if(label){ label.innerHTML = `🔴 <span>${I18N[currentLang].offline}</span>`; label.classList.add('offline'); }
    if(btn) btn.classList.add('active');
  }
  updateConnectivityBanner();
  // submit-btn's disabled logic branches on connectivity (full validation
  // gate online, always-enabled for automatic draft-saving offline — see
  // updateSubmitState()), so a connectivity change has to re-run it,
  // otherwise the button could be stuck in the wrong mode after a
  // reconnect/disconnect until some unrelated form change happened to
  // trigger it. Guarded because this runs before the New Submission
  // view's elements exist on first load.
  if(document.getElementById('submit-btn')) updateSubmitState();
}
document.getElementById('pwa-offline-toggle').onclick = async ()=>{
  simulateOffline = !simulateOffline;
  try{
    if(simulateOffline){ await disableNetwork(db); showToast('Simulating offline — writes will queue locally'); }
    else { await enableNetwork(db); showToast(I18N[currentLang].synced_toast.replace('submission(s) synced','Back online — syncing…')); }
  }catch(err){ console.error(err); }
  updateOnlineLabel();
};
// Manual refresh for the whole worker PWA (all tabs — New/History/Drafts,
// plus the nav badges). Firestore data is already realtime via onSnapshot,
// so this mainly re-syncs the localStorage-backed bits (drafts, downloaded
// forms) and forces a full re-render, giving the worker a clear "did
// something" action if they feel the screen is stale.
document.getElementById('pwa-refresh-btn').onclick = ()=>{
  loadDrafts();
  loadDownloadedForms();
  renderDraftsBadge();
  renderDownloadedFormsSidebar();
  updateSidebarWorkerStats();
  renderNotifDropdown();
  renderWorkerView();
  showToast(I18N[currentLang].refreshed_toast);
};
window.addEventListener('online', ()=>{
  updateOnlineLabel();
  // A gentle nudge, not an auto-sync — offline submissions are drafts now,
  // not queued writes, so nothing goes to a supervisor until the worker
  // actually reviews and submits it themselves.
  if(DRAFTS.length) showToast(I18N[currentLang].drafts_ready_toast);
  // If the profile read during session restore failed with nothing cached
  // (see initializeAuth()'s handler above), the worker is stuck looking at
  // the login screen even though their Firebase Auth session is still
  // perfectly valid underneath — that read just never succeeded. Now that
  // connectivity is back, reload so the whole restore flow runs again
  // cleanly and picks the app back up automatically, with no action needed
  // from the worker.
  if(!currentUser && getCurrentFirebaseUser()){
    window.location.reload();
  }
});
window.addEventListener('offline', updateOnlineLabel);
updateConnectivityBanner();

// Shared by all three worker tabs (New / My Submissions / Drafts) — swaps
// which panel is visible and keeps the tab buttons' active state in sync.
function setWorkerTab(tab){
  workerActiveTab = tab;
  document.getElementById('pwa-tab-new').classList.toggle('active', tab==='new');
  document.getElementById('pwa-tab-history').classList.toggle('active', tab==='history');
  document.getElementById('pwa-tab-drafts').classList.toggle('active', tab==='drafts');
  document.getElementById('pwa-view-new').style.display = tab==='new' ? 'block' : 'none';
  document.getElementById('pwa-view-history').style.display = tab==='history' ? 'block' : 'none';
  document.getElementById('pwa-view-drafts').style.display = tab==='drafts' ? 'block' : 'none';
  if(tab==='history') renderWorkerHistory();
  if(tab==='drafts') renderDraftsList();
}
// Switches tab AND makes sure the worker view is showing + the sidebar
// (which is where these tabs now live) reflects the new active tab.
function goToWorkerTab(tab){
  setWorkerTab(tab);
  switchView('worker');
}
document.getElementById('pwa-tab-new').onclick = ()=> goToWorkerTab('new');
document.getElementById('wh-status-filter').onchange = (e)=>{
  workerHistoryFilter = e.target.value;
  renderWorkerHistory();
};
document.getElementById('pwa-tab-history').onclick = ()=> goToWorkerTab('history');
document.getElementById('pwa-tab-drafts').onclick = ()=> goToWorkerTab('drafts');
document.getElementById('editing-draft-cancel-btn').onclick = ()=> cancelEditingDraft();

function renderWorkerView(){
  updateOnlineLabel();
  updateSidebarWorkerStats();
  renderNotifDropdown();

  // Gate the submission fields behind actually having a form to fill —
  // either one an admin explicitly sent, or (as a fallback) whichever
  // form is currently active in Firestore.
  const t = assignedTemplate();
  const hasForm = !!t;
  document.getElementById('pwa-no-form-state').style.display = hasForm ? 'none' : 'block';
  document.getElementById('pwa-new-fields').style.display = hasForm ? 'block' : 'none';
  if(hasForm){
    document.getElementById('pwa-form-name').textContent = t.name || I18N[currentLang].form_name;
    // Only rebuild the answer inputs when the effective form actually
    // changes — this view re-runs on every data refresh, and rebuilding
    // unconditionally would wipe out whatever the worker is mid-typing.
    if(lastRenderedAnswerFormId !== t.id){
      renderAnswerFields();
      lastRenderedAnswerFormId = t.id;
    }
  }
  updateDownloadFormButton();

  updateSubmitState();
  document.getElementById('submit-btn').textContent = resubmitTargetId ? I18N[currentLang].resubmit_btn : I18N[currentLang].submit_data;
  if(workerActiveTab==='history') renderWorkerHistory();
  if(workerActiveTab==='drafts') renderDraftsList();
  renderDraftsBadge();
}

// Keeps the "Submitted" / "Pending Sync" counters in the sidebar in sync —
// called from renderWorkerView, and also directly from the submissions
// subscription so the numbers stay current even while the worker is on a
// different tab (e.g. Account settings).
function updateSidebarWorkerStats(){
  const wrap = document.getElementById('sidebar-worker-stats');
  if(!currentUser || currentUser.role!=='worker'){
    wrap.style.display = 'none';
    return;
  }
  wrap.style.display = 'flex';
  const mine = SUBMISSIONS.filter(s=>s.workerUid===currentUser.uid);
  const pendingCount = mine.filter(s=>s.pendingSync).length;
  document.getElementById('side-stat-submitted').textContent = mine.length;
  document.getElementById('side-stat-sync').textContent = pendingCount;
}

// Populates the bell dropdown in the topbar with the worker's alerts, and
// keeps the badge count in sync. Replaces the old always-visible inline
// notifications list.
function renderNotifDropdown(){
  const badge = document.getElementById('notif-bell-badge');
  const unreadCount = workerNotifs.filter(n=>!n.read).length;
  badge.textContent = unreadCount > 9 ? '9+' : String(unreadCount);
  badge.style.display = unreadCount > 0 ? 'block' : 'none';

  const clearAllBtn = document.getElementById('notif-clear-all-btn');
  clearAllBtn.style.display = workerNotifs.length ? 'inline-block' : 'none';
  if(!clearAllBtn.dataset.confirming){
    clearAllBtn.textContent = pushNotifText('clear_all_notifs', 'Clear all');
  }

  const listWrap = document.getElementById('notif-dropdown-list');
  listWrap.innerHTML = '';
  if(workerNotifs.length === 0){
    listWrap.innerHTML = `<div class="q-empty" style="padding:10px 4px;font-size:12.5px;">${I18N[currentLang].no_alerts || I18N[currentLang].no_alerts_yet}</div>`;
    return;
  }
  if(!localStorage.getItem('geosurvey_swipe_hint_seen')){
    listWrap.innerHTML = `<div class="notif-swipe-hint">${pushNotifText('swipe_to_clear_hint', '← Swipe a notification to clear it')}</div>`;
  }
  workerNotifs.forEach(n=>{
    const wrap = document.createElement('div');
    wrap.className = 'notif-card-wrap';
    const div = document.createElement('div');
    const isFormAssign = n.type==='form_assign';
    const isApproved = n.type==='approved';
    const isSubmitted = n.type==='submitted' || n.type==='resubmitted';
    div.className = 'notif-card' + (isFormAssign ? ' assign' : '') + (isApproved ? ' approved' : '') + (isSubmitted ? ' submitted' : '');
    const icon = isFormAssign ? '📋' : isApproved ? '✅' : isSubmitted ? '📤' : '⚠';
    // form_assign notifications carry a formId — open the form preview.
    // approved/rejected/submitted notifications don't get an action
    // button at all; the worker just reads the notification text and, if
    // rejected, corrects it from their own submission history directly.
    let openBtn = '';
    if(isFormAssign && n.formId){
      openBtn = `<button class="notif-open-btn" data-action="form" data-form-id="${n.formId}" data-form-name="${(n.formName||n.title||'').replace(/"/g,'&quot;')}">${I18N[currentLang].open_form}</button>`;
    }
    const unreadDot = n.read ? '' : `<span class="unread-dot" title="Unread"></span>`;
    div.innerHTML = `<div style="display:flex;gap:7px;align-items:flex-start;flex:1;">${unreadDot}<div><div class="t">${icon} ${escapeHtml(n.title)}</div><div class="c">${escapeHtml(n.comment)}</div></div></div>${openBtn}`;
    const btn = div.querySelector('.notif-open-btn');
    if(btn) btn.onclick = ()=>{
      document.getElementById('notif-dropdown').classList.remove('show');
      if(btn.dataset.action==='form'){
        openFormPreview(btn.dataset.formId, btn.dataset.formName);
      } else {
        openSubmissionFromNotif(btn.dataset.subId);
      }
    };
    const bg = document.createElement('div');
    bg.className = 'notif-card-bg';
    bg.innerHTML = `🗑 ${pushNotifText('clear', 'Clear')}`;
    wrap.appendChild(bg);
    wrap.appendChild(div);
    attachNotifSwipeToDismiss(div, wrap, n);
    listWrap.appendChild(wrap);
  });
}

// Real swipe-to-dismiss: works with touch, mouse, and trackpad alike since
// it's built on Pointer Events rather than touch-only handlers. Swiping a
// card left past the threshold clears it (deletes the underlying
// notifications/{id} doc — already permitted by "userUid == self" in the
// Firestore rules); anything short of the threshold snaps back so a small
// accidental drag or a tap-to-open doesn't lose the notification.
function attachNotifSwipeToDismiss(cardEl, wrapEl, notif){
  const THRESHOLD = 70;
  let dragging = false, decided = null, startX = 0, startY = 0, dx = 0;
  cardEl.addEventListener('pointerdown', (e)=>{
    if(e.pointerType === 'mouse' && e.button !== 0) return;
    dragging = true; decided = null; dx = 0;
    startX = e.clientX; startY = e.clientY;
    cardEl.setPointerCapture(e.pointerId);
    cardEl.style.transition = 'none';
  });
  cardEl.addEventListener('pointermove', (e)=>{
    if(!dragging) return;
    const moveX = e.clientX - startX, moveY = e.clientY - startY;
    if(!decided && (Math.abs(moveX) > 8 || Math.abs(moveY) > 8)){
      decided = Math.abs(moveX) > Math.abs(moveY) ? 'h' : 'v';
    }
    if(decided === 'h'){
      dx = Math.min(0, moveX); // only swipe left, matches the "Clear" reveal being on the right
      cardEl.style.transform = `translateX(${dx}px)`;
    }
  });
  const endDrag = ()=>{
    if(!dragging) return;
    dragging = false;
    cardEl.style.transition = 'transform 0.18s ease, opacity 0.18s ease';
    if(decided === 'h' && dx < -THRESHOLD){
      localStorage.setItem('geosurvey_swipe_hint_seen', '1');
      cardEl.style.transform = 'translateX(-110%)';
      cardEl.style.opacity = '0';
      deleteDoc(doc(db, 'notifications', notif.id)).catch((err)=>console.warn('Could not clear notification:', err));
      setTimeout(()=>{ wrapEl.remove(); }, 180);
    } else {
      cardEl.style.transform = 'translateX(0)';
    }
    decided = null;
  };
  cardEl.addEventListener('pointerup', endDrag);
  cardEl.addEventListener('pointercancel', endDrag);
}

// Jumps the worker straight to the submission a notification refers to —
// switches into the worker view (in case they're not already there),
// flips to the "My Submissions" tab, and scrolls/flashes the matching
// card so a rejected (or approved) submission is easy to find instead of
// making them hunt through the whole history list themselves.
function openSubmissionFromNotif(submissionId){
  if(!submissionId) return;
  goToWorkerTab('history');
  requestAnimationFrame(()=>{
    const card = document.querySelector(`.wh-card[data-subid="${CSS.escape(submissionId)}"]`);
    if(card){
      card.scrollIntoView({ behavior:'smooth', block:'center' });
      card.classList.add('highlighted');
      setTimeout(()=> card.classList.remove('highlighted'), 1700);
    }
  });
}

// Marks every currently-unread notification as read — called when the
// worker opens the bell dropdown, since that's the "I've seen these" 
// moment. Uses a batch so a burst of alerts clears in one write instead
// of one update per notification. `optimistic` local notifs are flipped to
// read (and the badge re-rendered) synchronously, before this Firestore
// write resolves, so the badge disappears the instant the panel opens
// rather than waiting on a network round trip.
async function markNotificationsRead(){
  const unread = workerNotifs.filter(n=>!n.read);
  if(unread.length===0) return;
  const unreadIds = unread.map(n=>n.id);
  unread.forEach(n=> n.read = true);
  renderNotifDropdown();
  try{
    const batch = writeBatch(db);
    unreadIds.forEach(id=> batch.update(doc(db, 'notifications', id), { read: true }));
    await batch.commit();
    // The subsequent onSnapshot fire (local-write-applied, then server-ack)
    // will re-render from the authoritative Firestore data anyway, so no
    // further UI update is needed here on success.
  }catch(err){
    // Roll back the optimistic flip so the UI matches what's actually
    // stored — otherwise a failed write would leave the badge hidden while
    // the notifications are still unread server-side.
    unread.forEach(n=> n.read = false);
    renderNotifDropdown();
    // Was silently swallowed before — a permission-denied write here (e.g.
    // Firestore rules not yet allowing a worker to update their own
    // notification's `read` field) would leave the badge stuck forever
    // with zero visible sign of why. Surface it like every other write
    // failure in the app instead.
    notifyError(err, 'Could not mark notifications as read — check your connection');
  }
}
// "Clear all" needs a confirm step -- it's destructive and sits right next
// to the dropdown's open/close area, so a stray tap shouldn't be able to
// wipe every notification instantly. First tap arms it (button label swaps
// to "Tap again to clear all" for 3s); a second tap inside that window
// deletes every notification doc currently in workerNotifs, batched into
// one write. Mirrors the same delete permission the individual
// swipe-to-dismiss already relies on (Firestore rule: a worker may delete
// their own notifications/{id}).
let clearAllArmTimeout = null;
document.getElementById('notif-clear-all-btn').onclick = async (e)=>{
  e.stopPropagation();
  const btn = e.currentTarget;
  if(!btn.dataset.confirming){
    btn.dataset.confirming = '1';
    btn.textContent = pushNotifText('clear_all_notifs_confirm', 'Tap again to clear all');
    clearAllArmTimeout = setTimeout(()=>{
      delete btn.dataset.confirming;
      btn.textContent = pushNotifText('clear_all_notifs', 'Clear all');
    }, 3000);
    return;
  }
  clearTimeout(clearAllArmTimeout);
  delete btn.dataset.confirming;
  const ids = workerNotifs.map(n=>n.id);
  if(ids.length === 0) return;
  // Optimistic clear -- same pattern as markNotificationsRead(): update
  // the local list and re-render immediately rather than waiting on the
  // batch commit, then roll back and surface an error if it fails.
  const previous = workerNotifs;
  workerNotifs = [];
  renderNotifDropdown();
  try{
    const batch = writeBatch(db);
    ids.forEach(id=> batch.delete(doc(db, 'notifications', id)));
    await batch.commit();
  }catch(err){
    workerNotifs = previous;
    renderNotifDropdown();
    notifyError(err, 'Could not clear notifications — check your connection');
  }
};
document.getElementById('notif-bell-btn').onclick = (e)=>{
  e.stopPropagation();
  const dd = document.getElementById('notif-dropdown');
  const opening = !dd.classList.contains('show');
  dd.classList.toggle('show');
  if(opening) markNotificationsRead();
  else resetClearAllArm();
};
document.addEventListener('click', (e)=>{
  const dd = document.getElementById('notif-dropdown');
  if(dd.classList.contains('show') && !e.target.closest('.notif-bell-wrap')){
    dd.classList.remove('show');
    resetClearAllArm();
  }
});
function resetClearAllArm(){
  if(clearAllArmTimeout){ clearTimeout(clearAllArmTimeout); clearAllArmTimeout = null; }
  const btn = document.getElementById('notif-clear-all-btn');
  if(btn && btn.dataset.confirming){
    delete btn.dataset.confirming;
    btn.textContent = pushNotifText('clear_all_notifs', 'Clear all');
  }
}

// Shows the numeric count in a stat card as usual once there's data;
// while it's zero, shows a short friendly message instead of a bare "0".
function setStatCard(id, count, label, emptyLabel){
  const numEl = document.getElementById(id);
  const card = numEl.parentElement;
  const lblEl = card.querySelector('.l');
  if(count===0){
    numEl.textContent = '—';
    lblEl.textContent = emptyLabel;
  } else {
    numEl.textContent = count;
    lblEl.textContent = label;
  }
}

// Lets a worker open a read-only preview of a form the admin sent them,
// straight from the Alerts list — without switching to the New Submission
// tab or needing it to still be their currently-assigned form.
function openFormPreview(formId, formName, opts){
  opts = opts || {};
  const t = FORM_TEMPLATES.find(f=>f.id===formId) || downloadedFormById(formId);
  document.getElementById('fp-title').textContent = (t && t.name) || formName || I18N[currentLang].preview_form_title;
  const wrap = document.getElementById('fp-questions');
  wrap.innerHTML = '';
  const questions = (t && t.questions) || [];

  // A worker can write answers here in two cases:
  //  1. This is their current effective form (explicitly assigned, or the
  //     active form they auto-loaded) — the normal online case.
  //  2. They opened this form explicitly from the Downloaded Forms list
  //     (opts.fromDownloads) — this has to be fillable on its own terms,
  //     without needing to match whatever assignedTemplate() resolves to
  //     online, since the entire point of downloading a form is to fill
  //     it out with no network/Firestore dependency at all. Requiring an
  //     exact match here defeated that: a worker offline (so
  //     currentUser.assignedFormId/FORM_TEMPLATES may not have hydrated)
  //     opening the exact form they downloaded for this purpose would
  //     otherwise fall through to the read-only preview below.
  // A supervisor reviewing a past submission, or a worker looking at some
  // other form they're not currently acting on, still gets the read-only
  // list only.
  const fillBtn = document.getElementById('fp-fill-btn');
  const isWorker = !!(currentUser && currentUser.role==='worker');
  const isDownloaded = isFormDownloaded(formId);
  const openedFromDownloads = isWorker && opts.fromDownloads && isDownloaded;

  // Set/clear the override BEFORE resolving assignedTemplate() below, not
  // after — otherwise a leftover override from a previously-opened (and
  // not yet submitted/cancelled) downloaded form would silently shadow
  // assignedTemplate()'s normal resolution here and could make a form
  // that's genuinely the worker's current assigned/active form look like
  // it doesn't match (matchesEffective would compare against the stale
  // override instead of this form). Opening any form preview always
  // reflects the worker's current intent, so it always owns this state:
  // opening a download claims it, opening anything else releases it.
  if(openedFromDownloads){
    offlineFormOverrideId = formId;
  } else if(isWorker){
    offlineFormOverrideId = null;
  }

  const effective = isWorker ? assignedTemplate() : null;
  const matchesEffective = !!effective && formId && effective.id===formId;
  const canFill = isWorker && !!t && formId && (matchesEffective || openedFromDownloads);

  if(canFill && lastRenderedAnswerFormId !== formId){
    // Make sure answerValues actually has entries for this form before we
    // try to render/write into it — normally already done by
    // renderWorkerView, but this covers opening the modal before that's run.
    renderAnswerFields();
    lastRenderedAnswerFormId = formId;
  }

  if(questions.length===0){
    wrap.innerHTML = `<div class="q-empty">${I18N[currentLang].fp_no_questions}</div>`;
  } else if(canFill){
    const regular = questions.filter(q=>!['gps','photo','audio'].includes(q.type));
    if(regular.length){
      renderQuestionsInto(wrap, regular);
    } else {
      wrap.innerHTML = `<div class="q-empty">${I18N[currentLang].fp_media_only}</div>`;
    }
    const mediaQs = questions.filter(q=>['gps','photo','audio'].includes(q.type));
    if(mediaQs.length){
      const note = document.createElement('div');
      note.style.cssText = 'font-size:11.5px;color:var(--ink-soft);opacity:0.75;margin-top:2px;';
      note.textContent = I18N[currentLang].fp_media_note + ' ' + mediaQs.map(q=>`${qTypeMeta(q.type).icon} ${q.label}`).join(', ');
      wrap.appendChild(note);
    }
  } else {
    questions.forEach((q, i)=>{
      const meta = qTypeMeta(q.type);
      const card = document.createElement('div');
      card.className = 'fp-question';
      const opts = (q.type==='single_choice' || q.type==='multi_choice') && q.options && q.options.length
        ? `<div class="fp-q-opts">${q.options.map(o=>{
            const lbl = optLabel(o);
            const subs = (typeof o!=='string' && o.subOptions && o.subOptions.length)
              ? `<div class="fp-q-opt-subs">${o.subOptions.map(s=>`<div class="fp-q-opt-sub">↳ ${optLabel(s)}</div>`).join('')}</div>` : '';
            return `<div class="fp-q-opt">${lbl}</div>${subs}`;
          }).join('')}</div>` : '';
      card.innerHTML = `<div class="fp-q-top"><span>${meta.icon}</span><span>${i+1}. ${q.label || I18N[currentLang].untitled_question}</span>${q.required ? `<span class="fp-q-req">${I18N[currentLang].required}</span>` : ''}</div>${opts}`;
      wrap.appendChild(card);
    });
  }

  fillBtn.style.display = canFill ? 'block' : 'none';
  fillBtn.onclick = canFill ? ()=>{
    document.getElementById('form-preview-modal').classList.remove('show');
    goToWorkerTab('new');
  } : null;
  document.getElementById('form-preview-modal').classList.add('show');
}
document.getElementById('fp-close').onclick = ()=> document.getElementById('form-preview-modal').classList.remove('show');

function renderWorkerHistory(){
  const wrap = document.getElementById('pwa-history-list');
  const mine = SUBMISSIONS.filter(s=>s.workerUid===currentUser.uid && (!workerHistoryFilter || s.status===workerHistoryFilter));
  if(mine.length===0){
    wrap.innerHTML = `<div class="q-empty">${I18N[currentLang].no_history}</div>`;
    return;
  }
  wrap.innerHTML = '';
  mine.forEach(s=>{
    const statusLabel = s.pendingSync ? I18N[currentLang].pending_sync : (I18N[currentLang]['l_'+s.status] || s.status);
    const badgeClass = s.pendingSync ? 'pending' : s.status;
    // Workers can withdraw a submission themselves only while it's still
    // pending review — once a supervisor has approved or rejected it, it's
    // part of the record and gets corrected via Resubmit instead of removed.
    const canDelete = s.status==='pending' && !s.pendingSync;
    const card = document.createElement('div');
    card.className = 'wh-card';
    card.dataset.subid = s.id;
    card.innerHTML = `
      <div class="top">
        <span class="wid">${s.formName || s.id}</span>
        <div class="top-right">
          <span class="badge ${badgeClass}">${statusLabel}</span>
          ${canDelete ? `<button class="wh-delete-btn" data-docid="${s.docId}" title="${I18N[currentLang].delete_submission}">🗑</button>` : ''}
        </div>
      </div>
      <div class="meta">${s.region} · ${s.collected}</div>
      ${(s.status==='rejected' && s.comment) ? `<div class="wcomment">${s.comment}</div><button class="wh-resubmit-btn" data-id="${s.id}">${I18N[currentLang].resubmit}</button>` : ''}
    `;
    const rbtn = card.querySelector('.wh-resubmit-btn');
    if(rbtn) rbtn.onclick = ()=> startResubmit(s.id);
    const delBtn = card.querySelector('.wh-delete-btn');
    if(delBtn) delBtn.onclick = ()=> deleteOwnSubmission(s.docId, delBtn);
    wrap.appendChild(card);
  });
}

// Promise-based replacement for window.confirm()/prompt() — resolves the
// same way (true/false, or the typed string when requireTypedText is set),
// but through the app's own modal instead of a native dialog. Native
// confirm()/prompt() are unreliable (frequently a silent no-op, returning
// false/null without ever showing anything) inside an installed/standalone
// PWA on iOS Safari and several Android WebViews, which made every delete
// button that used one appear completely broken with no error at all.
function confirmDialog(message, confirmLabel, requireTypedText){
  return new Promise((resolve)=>{
    const overlay = document.getElementById('generic-confirm-modal');
    document.getElementById('gc-message').textContent = message;
    const confirmBtn = document.getElementById('gc-confirm');
    const input = document.getElementById('gc-type-input');
    confirmBtn.textContent = confirmLabel || I18N[currentLang].confirm || 'Confirm';
    if(requireTypedText){
      input.style.display = 'block';
      input.value = '';
      input.placeholder = requireTypedText;
      setTimeout(()=> input.focus(), 50);
    } else {
      input.style.display = 'none';
    }
    overlay.classList.add('show');
    const cleanup = (result)=>{
      overlay.classList.remove('show');
      confirmBtn.onclick = null;
      document.getElementById('gc-cancel').onclick = null;
      input.onkeydown = null;
      resolve(result);
    };
    confirmBtn.onclick = ()=>{
      if(requireTypedText) cleanup(input.value === requireTypedText ? input.value : false);
      else cleanup(true);
    };
    document.getElementById('gc-cancel').onclick = ()=> cleanup(false);
    input.onkeydown = (e)=>{ if(e.key === 'Enter') confirmBtn.click(); };
  });
}

async function deleteOwnSubmission(docId, btn){
  const confirmed = await confirmDialog(I18N[currentLang].confirm_delete_submission, I18N[currentLang].delete_submission);
  if(!confirmed) return;
  btn.disabled = true;
  try{
    // Deliberately deletes backend media BEFORE the Firestore doc, not
    // after: the backend's own access check looks up this file's stored
    // ownerUid, which is independent of the submission doc, but doing it
    // in this order still means a mid-failure never leaves an orphaned
    // reference. Best-effort either way — a failure here doesn't block
    // deleting the submission itself. photoUrl/audioUrl are now backend
    // fileIds, not Storage paths.
    const ownSub = SUBMISSIONS.find(x=> x.docId === docId);
    await deleteSubmissionMedia([ownSub && ownSub.photoUrl, ownSub && ownSub.audioUrl]).catch(()=>{});
    if(isOnline()){
      await deleteDoc(doc(db, 'submissions', docId));
      showToast(I18N[currentLang].submission_deleted);
    } else {
      // deleteDoc()'s promise only resolves once the backend acknowledges
      // the write — while offline that never happens until connectivity
      // returns, so awaiting it here would leave the worker staring at a
      // disabled button with zero feedback for however long they're
      // offline (this is exactly the "can't delete / never notified" bug:
      // the delete was actually going through, just silently). The write
      // still applies to the local cache immediately — the card disappears
      // from the history list right away via the onSnapshot listener — and
      // syncs to the server automatically once back online, so fire it
      // without waiting and confirm optimistically instead.
      deleteDoc(doc(db, 'submissions', docId)).catch((err)=>{
        console.error('Offline submission delete failed to sync once back online:', err);
      });
      showToast(I18N[currentLang].submission_deleted_offline);
    }
  }catch(err){
    console.error(err);
    showToast(friendlyFirestoreError(err, I18N[currentLang].err_delete_submission) || I18N[currentLang].err_delete_submission);
    btn.disabled = false;
  }
}

function resetGpsUI(){
  stopGpsWatch();
  gpsReadings = [];
  document.getElementById('gps-box').classList.remove('captured');
  document.getElementById('gps-readout').textContent = '';
  document.getElementById('gps-readout').style.color = '';
  document.getElementById('gps-btn').textContent = '📍 Capture GPS';
  document.getElementById('gps-btn').disabled = false;
  const row = document.getElementById('gps-status-row');
  if(row) row.style.display = 'none';
}

async function startResubmit(id){
  const s = SUBMISSIONS.find(x=>x.id===id);
  if(!s) return;
  resubmitTargetId = id;
  renderAnswerFields(s.answers || {});
  lastRenderedAnswerFormId = (assignedTemplate() || {}).id || null;
  gpsCaptured = null; micCaptured = false;
  recordedBlob = null; recordedSeconds = 0; recordedChunks = [];
  photoCaptured = false; photoBlob = null; photoRemoved = false; photoExifGps = null;
  if(photoPreviewUrl){ URL.revokeObjectURL(photoPreviewUrl); photoPreviewUrl = null; }
  resetGpsUI();
  document.getElementById('mic-box').classList.remove('captured');
  document.getElementById('photo-box').classList.remove('captured');
  document.getElementById('mic-readout').textContent = '';
  document.getElementById('photo-readout').textContent = '';
  document.getElementById('mic-btn').textContent = '🎙 Start Recording';
  document.getElementById('mic-remove-btn').style.display = 'none';
  const preview = document.getElementById('photo-preview');
  const removeBtn = document.getElementById('photo-remove-btn');
  if(s.photoUrl){
    // Show the existing photo so the worker can see what's on file; it stays
    // attached unless they explicitly retake or remove it. s.photoUrl is a
    // backend fileId now, not a directly-usable URL, so it has to be
    // fetched into a local blob: URL first (see getMediaObjectUrl in
    // auth/fileStorageClient.js) — reuses photoPreviewUrl/its existing
    // revocation points above and throughout this file.
    preview.style.display = 'none';
    preview.src = '';
    document.getElementById('photo-box').classList.add('captured');
    document.getElementById('photo-readout').textContent = 'Loading existing photo…';
    setPhotoButtonLabels(true);
    removeBtn.style.display = 'inline-block';
    const targetPhotoUrl = s.photoUrl;
    try{
      const objectUrl = await getMediaObjectUrl(targetPhotoUrl);
      // Bail out quietly if the worker navigated away from this photo
      // (retook/removed it, or switched to resubmitting a different
      // submission) while the fetch was in flight.
      if(resubmitTargetId !== id || s.photoUrl !== targetPhotoUrl || photoBlob || photoRemoved){
        URL.revokeObjectURL(objectUrl);
        return;
      }
      photoPreviewUrl = objectUrl;
      preview.src = photoPreviewUrl;
      preview.style.display = 'block';
      preview.onerror = ()=>{
        console.warn('Existing submission photo failed to render:', preview.src);
        preview.style.display = 'none';
        preview.src = '';
        document.getElementById('photo-readout').textContent = 'No image available — retake to replace it.';
      };
      document.getElementById('photo-readout').textContent = 'Existing photo on file — retake or remove to change it';
    }catch(err){
      console.error('Could not load existing submission photo:', err);
      if(resubmitTargetId === id){
        document.getElementById('photo-readout').textContent = 'No image available — retake to replace it.';
      }
    }
  } else {
    preview.style.display = 'none';
    preview.src = '';
    removeBtn.style.display = 'none';
    setPhotoButtonLabels(false);
  }
  document.getElementById('submit-btn').textContent = I18N[currentLang].resubmit_btn;
  goToWorkerTab('new');
  updateSubmitState();
}

// ---------------- GPS quality helpers ----------------

// "Excellent 0-5m / Good 5-10m / Fair 10-20m / Poor 20-50m / Very Poor 50+m"
function gpsQualityTier(accuracy){
  if(typeof accuracy !== 'number') return {key:'verypoor', label:'Very Poor'};
  if(accuracy <= 5) return {key:'excellent', label:'Excellent'};
  if(accuracy <= 10) return {key:'good', label:'Good'};
  if(accuracy <= 20) return {key:'fair', label:'Fair'};
  if(accuracy <= 50) return {key:'poor', label:'Poor'};
  return {key:'verypoor', label:'Very Poor'};
}

// Lightweight, dependency-free environment fingerprint for the "Save More
// Metadata" requirement — good enough for a supervisor/admin to sanity-check
// a submission's capture conditions without pulling in a full UA-parsing
// library for a handful of coarse categories.
function getCaptureDeviceMeta(){
  const ua = navigator.userAgent || '';
  let browser = 'Other';
  if(/Edg\//.test(ua)) browser = 'Edge';
  else if(/OPR\//.test(ua)) browser = 'Opera';
  else if(/SamsungBrowser/.test(ua)) browser = 'Samsung Internet';
  else if(/Chrome\//.test(ua)) browser = 'Chrome';
  else if(/CriOS/.test(ua)) browser = 'Chrome (iOS)';
  else if(/Firefox\//.test(ua)) browser = 'Firefox';
  else if(/Safari\//.test(ua)) browser = 'Safari';

  let os = 'Other';
  if(/Android/.test(ua)) os = 'Android';
  else if(/iPhone|iPad|iPod/.test(ua)) os = 'iOS';
  else if(/Windows/.test(ua)) os = 'Windows';
  else if(/Mac OS X/.test(ua)) os = 'macOS';
  else if(/Linux/.test(ua)) os = 'Linux';

  const deviceType = /iPad|Tablet/i.test(ua) ? 'Tablet' : (/Mobi|Android/i.test(ua) ? 'Mobile' : 'Desktop');

  // Network Information API — Chromium-only, gracefully absent elsewhere.
  const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  const connectionType = conn ? (conn.effectiveType || conn.type || 'unknown') : 'unknown';

  return { browser, os, deviceType, connectionType };
}

// Accuracy-weighted mean of the qualifying readings — this is what "GPS
// Averaging" actually resolves to. With only one qualifying reading this
// is mathematically identical to just using that reading (Option A falls
// naturally out of Option B rather than needing separate code paths).
function averageGpsReadings(readings){
  if(!readings || !readings.length) throw new Error('averageGpsReadings requires at least one reading'); // never silently produce NaN/Infinity coordinates
  const weights = readings.map(r=> 1 / Math.max(r.accuracy, 0.1)); // tighter accuracy = more weight
  const totalWeight = weights.reduce((a,b)=>a+b, 0);
  const lat = readings.reduce((sum,r,i)=> sum + r.lat*weights[i], 0) / totalWeight;
  const lng = readings.reduce((sum,r,i)=> sum + r.lng*weights[i], 0) / totalWeight;
  const bestAccuracy = Math.min(...readings.map(r=>r.accuracy));
  const withAlt = readings.filter(r=> typeof r.altitude === 'number');
  const altitude = withAlt.length ? withAlt.reduce((s,r)=>s+r.altitude,0)/withAlt.length : null;
  const withHeading = readings.filter(r=> typeof r.heading === 'number' && !Number.isNaN(r.heading));
  const heading = withHeading.length ? withHeading[withHeading.length-1].heading : null; // latest heading, averaging bearing is not meaningful
  const withSpeed = readings.filter(r=> typeof r.speed === 'number' && !Number.isNaN(r.speed));
  const speed = withSpeed.length ? withSpeed[withSpeed.length-1].speed : null;
  return { lat, lng, accuracy: bestAccuracy, altitude, heading, speed };
}

function setGpsStatus(text, quality){
  const row = document.getElementById('gps-status-row');
  const textEl = document.getElementById('gps-status-text');
  const badge = document.getElementById('gps-quality-badge');
  row.style.display = 'flex';
  textEl.textContent = text;
  if(quality){
    badge.style.display = 'inline-block';
    badge.dataset.quality = quality.key;
    badge.textContent = quality.label;
  } else {
    badge.style.display = 'none';
  }
}

function renderGpsReadout(reading, extra){
  const readout = document.getElementById('gps-readout');
  const rows = [
    ['Latitude', reading.lat.toFixed(6)],
    ['Longitude', reading.lng.toFixed(6)],
    ['Accuracy', `${reading.accuracy.toFixed(1)} m`],
    ['Altitude', typeof reading.altitude === 'number' ? `${Math.round(reading.altitude)} m` : '—'],
    ['Heading', (typeof reading.heading === 'number' && !Number.isNaN(reading.heading)) ? `${Math.round(reading.heading)}°` : '—'],
    ['Speed', (typeof reading.speed === 'number' && !Number.isNaN(reading.speed)) ? `${reading.speed.toFixed(1)} m/s` : '—'],
    ['Last Updated', new Date().toLocaleTimeString()],
  ];
  if(extra) rows.push(...extra);
  readout.innerHTML = rows.map(([label,val])=>
    `<div class="gr-row"><span class="gr-label">${label}:</span><span>${val}</span></div>`
  ).join('');
}

document.getElementById('gps-btn').onclick = ()=> startGpsCapture();

function startGpsCapture(){
  const box = document.getElementById('gps-box');
  const readout = document.getElementById('gps-readout');
  const btn = document.getElementById('gps-btn');

  if(!navigator.geolocation){
    setGpsStatus('GPS Disabled');
    readout.textContent = 'Location is not supported on this device/browser — GPS cannot be captured.';
    readout.style.color = 'var(--red)';
    return;
  }

  // Secure-context check: browsers block real GPS on plain http:// (except
  // localhost), silently returning a permission error instead. Surfacing
  // this explicitly saves a lot of "GPS just doesn't work" confusion.
  if(!window.isSecureContext){
    setGpsStatus('Location Unavailable');
    readout.textContent = 'Location requires a secure (https://) connection on this device.';
    readout.style.color = 'var(--red)';
    return;
  }

  stopGpsWatch(); // in case a previous attempt is still running
  gpsReadings = [];
  gpsCaptureStartedAt = Date.now();
  // Relax the accuracy bar while offline (see GPS_REQUIRED_ACCURACY_OFFLINE
  // above) — fixed for the duration of this capture attempt.
  GPS_REQUIRED_ACCURACY = isOnline() ? GPS_REQUIRED_ACCURACY_ONLINE : GPS_REQUIRED_ACCURACY_OFFLINE;

  btn.disabled = true;
  btn.textContent = 'Locating…';
  readout.style.color = '';
  readout.textContent = '';
  setGpsStatus('Searching for GPS...');

  const stopWithError = (statusText, msg)=>{
    stopGpsWatch();
    btn.disabled = false;
    btn.textContent = '📍 Capture GPS';
    setGpsStatus(statusText);
    readout.style.color = 'var(--red)';
    readout.textContent = msg;
  };

  // Shared by both the warm-up fix and the high-accuracy watch below, so a
  // reading is processed identically regardless of which one produced it.
  const handlePosition = pos=>{
    const accuracy = pos.coords.accuracy;
    if(typeof accuracy !== 'number' || accuracy > GPS_SANITY_CEILING_M) return; // "Ignore poor readings"

    const reading = {
      lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy,
      altitude: pos.coords.altitude, heading: pos.coords.heading, speed: pos.coords.speed
    };
    gpsReadings.push(reading);
    if(gpsReadings.length > GPS_READING_BUFFER_SIZE) gpsReadings.shift(); // "Store the latest 10 readings"

    const quality = gpsQualityTier(accuracy);
    const qualifying = gpsReadings.filter(r=> r.accuracy <= GPS_REQUIRED_ACCURACY);

    if(qualifying.length){
      // GPS Lock reached — stop watching and commit the averaged fix.
      finalizeGpsCapture(qualifying, 'locked');
      return;
    }

    // Still converging — live status + live readout, nothing accepted yet.
    const status = gpsReadings.length === 1 ? 'Acquiring Satellite Lock...'
      : accuracy > 50 ? 'Weak GPS Signal'
      : 'Searching for GPS...';
    setGpsStatus(`${status} (need under ${GPS_REQUIRED_ACCURACY}m)`, quality);
    renderGpsReadout(reading);
  };

  let highAccuracyStarted = false;
  const startHighAccuracyWatch = ()=>{
    if(highAccuracyStarted || gpsTimeoutHandle === null) return; // already finalized/cancelled
    highAccuracyStarted = true;
    gpsWatchId = navigator.geolocation.watchPosition(
      handlePosition,
      err=>{
        // Real GPS failed — do NOT fall back to a fake coordinate. A wrong
        // silent location is worse than no location for field data.
        //
        // On lower-end Android chipsets, forcing enableHighAccuracy:true can
        // make the GNSS radio itself error out (or never respond) even
        // though a usable network-based reading was already obtained by the
        // warm-up fix below. In that case, don't dead-end the capture —
        // treat it the same as the 30s timeout and let the worker
        // Retry / Save Anyway / Cancel using the best reading so far,
        // instead of throwing away a perfectly usable fix.
        if(err.code !== err.PERMISSION_DENIED && gpsReadings.length){
          stopGpsWatch();
          openGpsTimeoutModal();
          return;
        }
        if(err.code === err.PERMISSION_DENIED){
          stopWithError('Permission Denied', 'Location permission was denied — enable it for this site in your browser/device settings and try again.');
        } else if(err.code === err.POSITION_UNAVAILABLE){
          stopWithError('Location Unavailable', 'Could not determine your location — move to an open area (or near a window) and try again.');
        } else if(err.code === err.TIMEOUT){
          stopWithError('Location Unavailable', 'Getting a GPS fix took too long — try again, ideally outdoors with a clear sky view.');
        } else {
          stopWithError('Location Unavailable', 'Could not capture GPS — try again.');
        }
      },
      {enableHighAccuracy:true, timeout:GPS_TIMEOUT_MS, maximumAge:0}
    );
  };

  // Balanced strategy: fire a fast, low-power fix first (enableHighAccuracy:
  // false — network/Wi-Fi based) so the worker reliably gets *something*
  // quickly on every device, then let the high-accuracy GNSS watch refine
  // it further within the time that's left. This is what keeps low-end
  // Tecno-class phones (where a forced high-accuracy-only request can hang
  // or error out) working the same as flagship Samsung phones: both get a
  // baseline fix fast, and both get a chance at a tighter one afterward.
  //
  // This warm-up fix normally resolves via network/Wi-Fi lookup, which
  // needs connectivity — offline it would just burn its full timeout for
  // nothing. The actual GPS-chip fix (the high-accuracy watch) doesn't need
  // a network at all, so when the worker is offline, skip straight to it
  // instead of wasting part of the 30s budget on a warm-up that can't
  // succeed.
  if(isOnline()){
    navigator.geolocation.getCurrentPosition(
      pos=>{ handlePosition(pos); startHighAccuracyWatch(); },
      ()=>{ startHighAccuracyWatch(); }, // warm-up failed (e.g. no network fix available) — high-accuracy attempt still gets its own chance and its own error handling
      {enableHighAccuracy:false, timeout:GPS_WARMUP_TIMEOUT_MS, maximumAge:30000}
    );
  } else {
    startHighAccuracyWatch();
  }

  // Overall ceiling for the whole capture attempt (warm-up + high-accuracy
  // refinement combined) — watchPosition's own per-update "timeout" only
  // covers gaps between updates, not a total ceiling, so this is a hard
  // stop offering Retry / Save Anyway / Cancel instead of waiting forever.
  gpsTimeoutHandle = setTimeout(()=>{
    stopGpsWatch();
    openGpsTimeoutModal();
  }, GPS_TIMEOUT_MS);
}

function stopGpsWatch(){
  if(gpsWatchId !== null){ navigator.geolocation.clearWatch(gpsWatchId); gpsWatchId = null; }
  if(gpsTimeoutHandle !== null){ clearTimeout(gpsTimeoutHandle); gpsTimeoutHandle = null; }
}

// mode: 'locked' (threshold reached normally) or 'save_anyway' (best
// available reading accepted despite not meeting the threshold).
function finalizeGpsCapture(readings, mode){
  stopGpsWatch();
  const averaged = averageGpsReadings(readings);
  const meta = getCaptureDeviceMeta();
  const quality = gpsQualityTier(averaged.accuracy);
  gpsCaptured = {
    lat: averaged.lat, lng: averaged.lng, accuracy: averaged.accuracy,
    altitude: averaged.altitude, heading: averaged.heading, speed: averaged.speed,
    ts: new Date().toISOString(),
    captureDurationMs: Date.now() - gpsCaptureStartedAt,
    quality: quality.key,
    readingCount: readings.length,
    browser: meta.browser, os: meta.os, deviceType: meta.deviceType, connectionType: meta.connectionType,
    onlineAtCapture: isOnline()
  };

  const box = document.getElementById('gps-box');
  const readout = document.getElementById('gps-readout');
  const btn = document.getElementById('gps-btn');
  box.classList.add('captured');
  btn.disabled = false;
  btn.textContent = '📍 Re-capture GPS';
  readout.style.color = '';

  const extraRows = [['Capture Duration', `${(gpsCaptured.captureDurationMs/1000).toFixed(1)}s`]];
  if(mode === 'save_anyway') extraRows.push(['Note', `Saved without reaching ${GPS_REQUIRED_ACCURACY}m target`]);
  setGpsStatus(mode === 'save_anyway' ? 'GPS Ready (reduced accuracy)' : 'GPS Ready', quality);
  renderGpsReadout(gpsCaptured, extraRows);

  if(gpsCaptured.accuracy > GPS_WARN_ACCURACY_M){
    readout.innerHTML += `<div class="gr-row" style="color:var(--red);"><span>⚠ Move to an open area for better GPS reception.</span></div>`;
  }
  updateSubmitState();
}

// ---------------- 30s timeout: Retry / Save Anyway / Cancel ----------------
function openGpsTimeoutModal(){
  const overlay = document.getElementById('gps-timeout-modal');
  const msg = document.getElementById('gps-timeout-msg');
  const saveBtn = document.getElementById('gps-timeout-save-anyway');
  const best = gpsReadings.length ? gpsReadings.reduce((a,b)=> a.accuracy < b.accuracy ? a : b) : null;

  msg.textContent = best
    ? `Unable to reach ${GPS_REQUIRED_ACCURACY}m accuracy after 30 seconds. Best reading so far: ±${best.accuracy.toFixed(1)}m. Move to an open area for better GPS reception.`
    : `Unable to obtain any GPS reading after 30 seconds. Check that location is turned on and move to an open area.`;

  // Orgs can disable submitting poor-accuracy locations entirely (Admin →
  // Settings → GPS) — when that's off, "Save Anyway" isn't offered at all,
  // only Retry/Cancel.
  const allowPoor = typeof allowPoorGpsSubmission === 'undefined' ? true : allowPoorGpsSubmission;
  saveBtn.style.display = (best && allowPoor) ? 'inline-block' : 'none';

  overlay.classList.add('show');

  document.getElementById('gps-timeout-cancel').onclick = ()=>{
    overlay.classList.remove('show');
    const btn = document.getElementById('gps-btn');
    btn.disabled = false;
    btn.textContent = '📍 Capture GPS';
    setGpsStatus('Location Unavailable');
    document.getElementById('gps-readout').textContent = 'GPS capture cancelled.';
  };
  document.getElementById('gps-timeout-retry').onclick = ()=>{
    overlay.classList.remove('show');
    startGpsCapture();
  };
  saveBtn.onclick = ()=>{
    overlay.classList.remove('show');
    if(best) finalizeGpsCapture([best], 'save_anyway');
  };
}

document.getElementById('mic-btn').onclick = async ()=>{
  const box = document.getElementById('mic-box');
  const readout = document.getElementById('mic-readout');
  const btn = document.getElementById('mic-btn');

  // If we're mid-recording, this click means "stop now" — the 10s mark is
  // a ceiling, not a required duration, so workers can end early.
  if(mediaRecorder && mediaRecorder.state==='recording'){
    mediaRecorder.stop();
    return;
  }

  if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || typeof MediaRecorder==='undefined'){
    readout.textContent = 'Voice recording is not supported on this device or browser.';
    micCaptured = false;
    box.classList.remove('captured');
    updateSubmitState();
    return;
  }

  try{
    btn.classList.add('rec'); btn.textContent = '⏹ Stop Recording';
    const stream = await navigator.mediaDevices.getUserMedia({audio:true});
    recordedChunks = [];
    const mimeType = MediaRecorder.isTypeSupported('audio/webm')
      ? 'audio/webm'
      : (MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : '');
    mediaRecorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    const startedAt = Date.now();

    mediaRecorder.ondataavailable = (e)=>{ if(e.data && e.data.size>0) recordedChunks.push(e.data); };
    mediaRecorder.onstop = ()=>{
      if(micTimerInterval){ clearInterval(micTimerInterval); micTimerInterval = null; }
      stream.getTracks().forEach(t=>t.stop());
      recordedBlob = new Blob(recordedChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
      recordedSeconds = Math.max(1, Math.round((Date.now()-startedAt)/1000));
      micCaptured = true;
      box.classList.add('captured');
      btn.classList.remove('rec'); btn.disabled = false;
      btn.textContent = '🎙 Re-record';
      document.getElementById('mic-remove-btn').style.display = 'inline-block';
      readout.textContent = `${recordedSeconds}s memo captured ✓`;
      updateSubmitState();
    };

    readout.textContent = `Recording… 0.0s / 10s max — tap Stop when done`;
    mediaRecorder.start();
    let seconds = 0;
    micTimerInterval = setInterval(()=>{
      seconds += 0.2;
      readout.textContent = `Recording… ${Math.min(seconds,10).toFixed(1)}s / 10s max — tap Stop when done`;
      if(seconds>=10){
        clearInterval(micTimerInterval); micTimerInterval = null;
        if(mediaRecorder && mediaRecorder.state==='recording') mediaRecorder.stop();
      }
    }, 200);
  }catch(e){
    console.error('Microphone recording failed:', e);
    if(micTimerInterval){ clearInterval(micTimerInterval); micTimerInterval = null; }
    btn.classList.remove('rec'); btn.disabled = false;
    btn.textContent = '🎙 Start Recording';
    box.classList.remove('captured');
    micCaptured = false;
    recordedBlob = null;
    document.getElementById('mic-remove-btn').style.display = 'none';
    readout.textContent = 'Could not access the microphone — check permissions and try again.';
    updateSubmitState();
  }
};

document.getElementById('mic-remove-btn').onclick = ()=>{
  // Lets the worker discard a bad take (wrong language, too much noise,
  // cut off) without immediately having to record a replacement.
  const box = document.getElementById('mic-box');
  const readout = document.getElementById('mic-readout');
  const btn = document.getElementById('mic-btn');
  const removeBtn = document.getElementById('mic-remove-btn');
  micCaptured = false;
  recordedBlob = null; recordedSeconds = 0; recordedChunks = [];
  box.classList.remove('captured');
  readout.textContent = '';
  btn.textContent = I18N[currentLang].start_recording || '🎙 Start Recording';
  removeBtn.style.display = 'none';
  updateSubmitState();
};

// Downscales and re-encodes a photo client-side, then hands back a Blob
// ready to upload to Firebase Storage. The size target here is now just
// "reasonable over mobile data" — not a workaround for Firestore's 1MB
// document cap, since the file itself never touches Firestore anymore.
// Keeps the Take Photo / Choose from Library button labels in sync with
// whether a photo is already attached (so both read "retake"/"choose
// different" once there's one on file, whichever route was used to add it).
function setPhotoButtonLabels(hasPhoto){
  document.getElementById('photo-camera-btn').textContent = hasPhoto
    ? (I18N[currentLang].retake_camera || '📷 Retake Photo')
    : (I18N[currentLang].take_photo || '📷 Take Photo');
  document.getElementById('photo-library-btn').textContent = hasPhoto
    ? (I18N[currentLang].rechoose_library || '🖼 Choose Different Photo')
    : (I18N[currentLang].choose_photo || '🖼 Choose from Library');
}

function canvasToJpegBlob(canvas, quality){
  return new Promise(resolve=> canvas.toBlob(resolve, 'image/jpeg', quality));
}

// Reads GPS coordinates straight out of a photo's EXIF metadata, BEFORE
// readAndCompressImage() gets anywhere near it — canvas re-encoding strips
// ALL metadata, so this has to run against the raw, original File. Hand-
// rolled (no library/CDN) since it only needs the GPS IFD tags, not full
// EXIF support. Resolves to { lat, lng, altitude } or null if the file
// isn't a JPEG, has no APP1/Exif segment, or has no GPS tag in it.
function extractExifGps(file){
  return new Promise((resolve)=>{
    if(!file || !/jpe?g/i.test(file.type || file.name || '')){ resolve(null); return; }
    const reader = new FileReader();
    reader.onload = ()=>{
      try{
        const buf = reader.result;
        const view = new DataView(buf);
        if(view.getUint16(0) !== 0xFFD8){ resolve(null); return; } // not a JPEG (SOI marker)

        // Walk marker segments looking for APP1 carrying an "Exif\0\0" TIFF
        // header. Stop at SOS (start of scan) — no metadata lives past it.
        let offset = 2, tiffOffset = -1;
        while(offset + 4 <= view.byteLength){
          const marker = view.getUint16(offset);
          if(marker === 0xFFDA) break;
          if((marker & 0xFF00) !== 0xFF00) break;
          const segLen = view.getUint16(offset + 2);
          if(marker === 0xFFE1 && segLen >= 8 &&
             view.getUint32(offset + 4) === 0x45786966 && view.getUint16(offset + 8) === 0x0000){
            tiffOffset = offset + 10;
            break;
          }
          offset += 2 + segLen;
        }
        if(tiffOffset < 0){ resolve(null); return; }

        const little = view.getUint16(tiffOffset) === 0x4949; // "II" vs "MM"
        const u16 = (o)=> view.getUint16(o, little);
        const u32 = (o)=> view.getUint32(o, little);

        const ifd0Offset = tiffOffset + u32(tiffOffset + 4);
        let gpsIfdOffset = -1;
        const ifd0Count = u16(ifd0Offset);
        for(let i=0;i<ifd0Count;i++){
          const entryOffset = ifd0Offset + 2 + i * 12;
          if(u16(entryOffset) === 0x8825){ // GPSInfo IFD pointer
            gpsIfdOffset = tiffOffset + u32(entryOffset + 8);
            break;
          }
        }
        if(gpsIfdOffset < 0){ resolve(null); return; }

        const readRational = (o)=> u32(o) / (u32(o + 4) || 1);
        const readDMS = (ptr)=> readRational(ptr) + readRational(ptr + 8) / 60 + readRational(ptr + 16) / 3600;

        let latRef=null, lonRef=null, altRef=0, lat=null, lon=null, alt=null;
        const gpsCount = u16(gpsIfdOffset);
        for(let i=0;i<gpsCount;i++){
          const entryOffset = gpsIfdOffset + 2 + i * 12;
          const tag = u16(entryOffset);
          const valueOrOffset = entryOffset + 8;
          if(tag === 1) latRef = String.fromCharCode(view.getUint8(valueOrOffset));
          else if(tag === 3) lonRef = String.fromCharCode(view.getUint8(valueOrOffset));
          else if(tag === 5) altRef = view.getUint8(valueOrOffset);
          else if(tag === 2) lat = readDMS(tiffOffset + u32(valueOrOffset));
          else if(tag === 4) lon = readDMS(tiffOffset + u32(valueOrOffset));
          else if(tag === 6) alt = readRational(tiffOffset + u32(valueOrOffset));
        }
        if(lat == null || lon == null){ resolve(null); return; }
        if(latRef === 'S') lat = -lat;
        if(lonRef === 'W') lon = -lon;
        if(altRef === 1 && alt != null) alt = -alt;
        resolve({ lat, lng: lon, altitude: (alt != null ? alt : null) });
      }catch(err){
        console.warn('EXIF GPS parse failed — falling back to submission GPS:', err);
        resolve(null);
      }
    };
    reader.onerror = ()=> resolve(null);
    // EXIF always lives in the first APP1 segment, near the start of the
    // file — no need to read the whole (multi-MB) original photo for it.
    reader.readAsArrayBuffer(file.slice(0, 131072));
  });
}
// Given whatever is currently attached, decides which GPS point belongs to
// the photo: EXIF (from the original file) if present, otherwise the
// submission's own GPS capture. Returns null if there's no photo attached
// at all, or a photo with neither EXIF GPS nor a submission GPS fix to fall
// back to. The returned object always records its own `source` so this is
// auditable later rather than just asserted.
function computePhotoGps(){
  if(!photoBlob) return null;
  if(photoExifGps){
    return { lat: photoExifGps.lat, lng: photoExifGps.lng, altitude: (typeof photoExifGps.altitude === 'number' ? photoExifGps.altitude : null), source: 'exif' };
  }
  if(gpsCaptured){
    return { lat: gpsCaptured.lat, lng: gpsCaptured.lng, altitude: (typeof gpsCaptured.altitude === 'number' ? gpsCaptured.altitude : null), source: 'submission' };
  }
  return null;
}
function readAndCompressImage(file){
  const MAX_BYTES = 3 * 1024 * 1024; // generous now that this goes to Storage, not a Firestore doc
  return new Promise((resolve, reject)=>{
    const reader = new FileReader();
    reader.onload = ()=>{
      const img = new Image();
      img.onload = async ()=>{
        try{
          const maxDim = 1600;
          let { width, height } = img;
          if(width > height && width > maxDim){ height = Math.round(height * maxDim/width); width = maxDim; }
          else if(height > maxDim){ width = Math.round(width * maxDim/height); height = maxDim; }
          const canvas = document.createElement('canvas');
          canvas.width = width; canvas.height = height;
          canvas.getContext('2d').drawImage(img, 0, 0, width, height);
          let quality = 0.85;
          let blob = await canvasToJpegBlob(canvas, quality);
          while(blob && blob.size > MAX_BYTES && quality > 0.4){
            quality -= 0.1;
            blob = await canvasToJpegBlob(canvas, quality);
          }
          if(!blob || blob.size > MAX_BYTES){ reject(new Error('Photo is too large even after compression.')); return; }
          resolve(blob);
        }catch(err){ reject(err); }
      };
      img.onerror = ()=> reject(new Error('Could not read that image.'));
      img.src = reader.result;
    };
    reader.onerror = ()=> reject(new Error('Could not read that file.'));
    reader.readAsDataURL(file);
  });
}

document.getElementById('photo-camera-btn').onclick = ()=> document.getElementById('photo-input-camera').click();
document.getElementById('photo-library-btn').onclick = ()=> document.getElementById('photo-input-library').click();

async function handlePhotoFileSelected(e){
  const file = e.target.files[0];
  e.target.value = ''; // allow re-selecting the same file later
  if(!file) return;
  const box = document.getElementById('photo-box');
  const readout = document.getElementById('photo-readout');
  const removeBtn = document.getElementById('photo-remove-btn');
  const preview = document.getElementById('photo-preview');
  readout.textContent = 'Processing photo…';
  try{
    // Read EXIF GPS from the ORIGINAL file first — readAndCompressImage()
    // re-encodes through a <canvas>, which strips all metadata, so this is
    // the only point where the photo's own coordinates (if any) are
    // recoverable at all.
    photoExifGps = await extractExifGps(file);
    photoBlob = await readAndCompressImage(file);
    photoCaptured = true;
    photoRemoved = false;
    box.classList.add('captured');
    if(photoPreviewUrl) URL.revokeObjectURL(photoPreviewUrl);
    photoPreviewUrl = URL.createObjectURL(photoBlob);
    preview.src = photoPreviewUrl;
    preview.style.display = 'block';
    setPhotoButtonLabels(true);
    removeBtn.style.display = 'inline-block';
    readout.textContent = photoExifGps ? 'Photo attached ✓ (location from photo)' : 'Photo attached ✓';
  }catch(err){
    console.error(err);
    photoCaptured = false; photoBlob = null; photoExifGps = null;
    if(photoPreviewUrl){ URL.revokeObjectURL(photoPreviewUrl); photoPreviewUrl = null; }
    box.classList.remove('captured');
    preview.style.display = 'none';
    removeBtn.style.display = 'none';
    readout.textContent = 'Could not attach that photo — try again.';
  }
  updateSubmitState();
}
document.getElementById('photo-input-camera').addEventListener('change', handlePhotoFileSelected);
document.getElementById('photo-input-library').addEventListener('change', handlePhotoFileSelected);

document.getElementById('photo-remove-btn').onclick = ()=>{
  // Lets the worker drop a blurry or unwanted photo without picking a
  // replacement. photoRemoved is tracked separately from photoCaptured so a
  // resubmit knows to clear a *previously saved* photo, not just skip
  // attaching a new one.
  const box = document.getElementById('photo-box');
  const readout = document.getElementById('photo-readout');
  const removeBtn = document.getElementById('photo-remove-btn');
  const preview = document.getElementById('photo-preview');
  photoCaptured = false;
  photoBlob = null;
  photoExifGps = null;
  if(photoPreviewUrl){ URL.revokeObjectURL(photoPreviewUrl); photoPreviewUrl = null; }
  photoRemoved = true;
  box.classList.remove('captured');
  preview.style.display = 'none';
  preview.src = '';
  readout.textContent = '';
  setPhotoButtonLabels(false);
  removeBtn.style.display = 'none';
  updateSubmitState();
};

function updateSubmitState(){
  const t = assignedTemplate();
  const regular = ((t && t.questions) || []).filter(q=>!['gps','photo','audio'].includes(q.type));
  const answersOk = regular.every(q=>{
    if(!q.required) return true;
    const v = answerValues[q.id];
    return q.type==='multi_choice' ? (Array.isArray(v) && v.length>0) : !!(v && String(v).trim());
  });

  // GPS is always captured as a location stamp for the submission, so it
  // stays required regardless of whether the form has an explicit GPS
  // question. Mic/photo, however, should only block submission when the
  // assigned form actually asks for them — otherwise a form with no audio
  // question (or a device where mic access fails/is denied) would leave
  // workers permanently unable to submit.
  const gpsOk = !!gpsCaptured;
  const micOk = !currentAudioQ || !currentAudioQ.required || micCaptured;
  const photoOk = !currentPhotoQ || !currentPhotoQ.required || (photoCaptured || (resubmitTargetId && !photoRemoved));
  const onlineOk = isOnline();

  const missing = [];
  if(!gpsOk) missing.push(I18N[currentLang].gps_location || 'GPS location');
  if(!micOk) missing.push(currentAudioQ ? currentAudioQ.label : (I18N[currentLang].voice_memo || 'Voice memo'));
  if(!photoOk) missing.push(currentPhotoQ ? currentPhotoQ.label : (I18N[currentLang].photo || 'Photo'));

  // The validation hint (and the disabled state below) only ever describes
  // FINAL SUBMISSION's requirements, and only applies while online. While
  // offline, tapping Submit automatically saves a draft instead of
  // submitting (see the submit-btn handler) — exactly as it always has —
  // and that path is deliberately validation-free, so there is nothing to
  // warn about or block here when offline.
  const hint = document.getElementById('submit-hint');
  if(hint){
    if(!onlineOk){
      hint.textContent = '';
      hint.style.display = 'none';
    } else if(!answersOk){
      hint.textContent = 'Fill in all required questions above before submitting.';
      hint.style.display = 'block';
    } else if(missing.length){
      hint.textContent = `Still needed before you can submit: ${missing.join(', ')}.`;
      hint.style.display = 'block';
    } else {
      hint.textContent = '';
      hint.style.display = 'none';
    }
  }

  // Save Draft (the standalone button) is intentionally NOT referenced
  // anywhere in this function — it has no disabled state and none of the
  // checks above apply to it.
  //
  // submit-btn's disabled state, however, now branches on connectivity:
  //   - Online: same full validation gate as always
  //     (answersOk && gpsOk && micOk && photoOk) — unchanged from the
  //     original online submission workflow.
  //   - Offline: never disabled by validation. Tapping it while offline
  //     doesn't perform a real submission at all (see the click handler),
  //     it automatically saves a draft — so it must stay clickable even
  //     with missing GPS/required fields/photo/voice, exactly like the
  //     explicit Save Draft button.
  document.getElementById('submit-btn').disabled = onlineOk
    ? !(answersOk && gpsOk && micOk && photoOk)
    : false;
}

function resetWorkerForm(){
  // A downloaded form opened for offline filling (see offlineFormOverrideId)
  // is done being "the effective form" once its submission is saved or the
  // worker cancels out of it — clear it before re-resolving, so the next
  // time the worker lands on New Submission it goes back to the normal
  // assigned/active form resolution rather than staying pinned to whatever
  // they filled out previously.
  offlineFormOverrideId = null;
  resetGpsUI();
  renderAnswerFields();
  lastRenderedAnswerFormId = (assignedTemplate() || {}).id || null;
  gpsCaptured=null; micCaptured=false;
  recordedBlob = null; recordedSeconds = 0; recordedChunks = [];
  photoCaptured = false; photoBlob = null; photoRemoved = false; photoExifGps = null;
  if(photoPreviewUrl){ URL.revokeObjectURL(photoPreviewUrl); photoPreviewUrl = null; }
  document.getElementById('mic-box').classList.remove('captured');
  document.getElementById('photo-box').classList.remove('captured');
  document.getElementById('mic-readout').textContent='';
  document.getElementById('photo-readout').textContent='';
  document.getElementById('photo-preview').style.display='none';
  document.getElementById('photo-preview').src='';
  document.getElementById('photo-remove-btn').style.display='none';
  document.getElementById('mic-remove-btn').style.display='none';
  document.getElementById('gps-btn').textContent='📍 Capture GPS';
  document.getElementById('mic-btn').textContent='🎙 Start Recording';
  setPhotoButtonLabels(false);
  document.getElementById('submit-btn').textContent = I18N[currentLang].submit_data;
}

// ---------------- Submission media: company-owned backend API ----------------
// Photos and voice memos now go PWA -> our backend API -> company storage
// (auth/fileStorageClient.js), instead of straight to Firebase Storage.
// The backend organizes files by its own upload category + surveyId
// (see fileStorageService.js on the backend); this submission's docId
// IS the surveyId it uploads under, so re-uploading on a correction is
// still just "a new file under this same submission's folder" — the
// backend keeps every version rather than silently overwriting one
// fixed path, and the submission doc simply gets pointed at whichever
// fileId is current.
//
// Submission docs now store a `fileId` (a companyFiles Firestore doc
// id returned by the backend) in photoUrl/voiceUrl instead of a public
// https:// Storage download URL. IMPORTANT DISPLAY-SIDE IMPLICATION:
// GET /api/files/:id requires an Authorization header, so it can no
// longer be dropped straight into `<img src>`/`<audio src>` — anywhere
// this app currently does that with photoUrl/voiceUrl needs to be
// changed to call `await getMediaObjectUrl(fileId)` and assign the
// resulting blob: URL instead (and URL.revokeObjectURL() it once the
// element is done with it). That update is NOT included here — this
// pass covers the upload/capture/retry path.

async function uploadSubmissionPhoto(subId, blob, formId, { onProgress } = {}){
  const record = await apiUploadPhoto(blob, subId, formId, { onProgress });
  return record.fileId;
}

async function uploadSubmissionVoice(subId, blob, formId, { onProgress } = {}){
  const record = await apiUploadAudio(blob, subId, formId, { onProgress });
  return record.fileId;
}

// Best-effort cleanup — used when a worker removes a photo without
// replacing it, and when a submission itself is deleted. Deliberately
// swallows "not found" (there was nothing to delete) and logs but
// doesn't throw on other errors, since a lingering orphaned file on
// the backend is a much smaller problem than blocking a submission
// delete or edit the user is otherwise entitled to make.
async function deleteSubmissionMedia(fileIds){
  const ids = (fileIds || []).filter(Boolean);
  const results = await Promise.allSettled(ids.map(id => apiDeleteFile(id)));
  results.forEach(r=>{
    if(r.status === 'rejected' && r.reason && r.reason.status !== 404){
      console.error('Could not delete submission media:', r.reason);
    }
  });
}

// Wires the offline upload queue (auth/uploadQueue.js) to this app's
// Firestore schema. A queued upload only knows "kind / blob / surveyId
// / meta" — it doesn't know about submissions docs at all — so this is
// the one place that translates "a queued upload finally succeeded"
// into "write its fileId onto the right submission doc's field."
uploadQueue.configure({
  onUploadSuccess: async (item, record) => {
    const { docId, field } = item.meta || {};
    if(!docId || !field) return;
    try{
      await updateDoc(doc(db, 'submissions', docId), { [field]: record.fileId, updatedAt: serverTimestamp() });
      showToast('A queued photo/voice memo upload finished and was attached to your submission.');
      renderWorkerView();
    }catch(err){
      // The upload itself succeeded — the file is safely on the backend
      // and won't be retried again. Only the Firestore link-up failed
      // (e.g. the submission was since deleted). Log it; don't re-throw,
      // since retrying the upload itself would just re-create the file.
      console.error('Queued upload succeeded, but updating the submission failed:', err);
    }
  },
  onUploadPermanentFail: (item, err) => {
    console.error(`Giving up on a queued ${item.kind} upload after repeated failures:`, err);
    showToast('A queued photo/voice memo upload keeps failing — check your connection. It will keep retrying in the background.');
  },
});

// Shows upload progress on the submit button itself rather than adding
// new DOM/CSS — keeps this change scoped to behavior, not layout.
function setUploadProgressLabel(btn, label, fraction){
  const pct = typeof fraction === 'number' ? ` ${Math.round(fraction * 100)}%` : '';
  btn.textContent = `${label}${pct}`;
}


// ---------------- Draft Saving: fully independent path from Submit ----------------
// No call to updateSubmitState(), no answersOk/gpsOk/micOk/photoOk check, no
// isOnline() check — this button is never disabled and this handler never
// blocks. It exists specifically so an incomplete form (missing GPS,
// missing required questions, missing photo/voice) can still be saved
// locally and finished later. All the "is this good enough to actually
// submit" logic lives solely in updateSubmitState()/submit-btn below and is
// re-run independently when a draft is reopened via loadDraftIntoForm().
document.getElementById('save-draft-btn').onclick = async ()=>{
  const btn = document.getElementById('save-draft-btn');
  btn.disabled = true; // guard against double-taps only; not a validation gate
  try{
    await saveCurrentFormAsDraft();
    renderWorkerView();
  } finally {
    btn.disabled = false;
  }
};

document.getElementById('submit-btn').onclick = async ()=>{
  const btn = document.getElementById('submit-btn');
  btn.disabled = true;

  try{
    // Automatic draft saving — restored to its original behavior: a
    // worker tapping Submit while offline is routed to an editable draft
    // rather than attempting to write anything, same as it always was.
    // The ONLY change from the original is that this is now reachable
    // regardless of validation — updateSubmitState() no longer disables
    // submit-btn while offline (missing GPS/required fields/photo/voice
    // no longer block this), whereas previously the button itself would
    // stay disabled and silently prevent this branch from ever firing.
    // This is deliberately separate from (and in addition to) the
    // standalone Save Draft button above — that one is an explicit,
    // always-available action; this one is the automatic fallback baked
    // into Submit specifically for the "tried to submit, but offline" case.
    if(!isOnline()){
      await saveCurrentFormAsDraft();
      renderWorkerView();
      btn.disabled = false;
      return;
    }

    // Start from the worker's typed/selected answers, then fold the GPS,
    // photo, and voice captures in under whichever question in the assigned
    // form they belong to — this is what links those captures to the form
    // itself instead of treating them as separate, unlabeled fields.
    const answers = buildAnswersObject();
    if(currentGpsQ && gpsCaptured){
      answers[safeAnswerKey(currentGpsQ)] = `${gpsCaptured.lat.toFixed(5)}, ${gpsCaptured.lng.toFixed(5)}`;
    }
    const gps = new GeoPoint(gpsCaptured.lat, gpsCaptured.lng);
    // Everything about HOW that fix was obtained — kept as a separate
    // object (not flattened into top-level fields) so it's one clean,
    // additive field rather than several, matching "adding new GPS fields"
    // without touching any existing field's shape.
    const gpsMeta = {
      accuracy: typeof gpsCaptured.accuracy === 'number' ? gpsCaptured.accuracy : null,
      altitude: typeof gpsCaptured.altitude === 'number' ? gpsCaptured.altitude : null,
      heading: typeof gpsCaptured.heading === 'number' ? gpsCaptured.heading : null,
      speed: typeof gpsCaptured.speed === 'number' ? gpsCaptured.speed : null,
      quality: gpsCaptured.quality || null,
      captureDurationMs: gpsCaptured.captureDurationMs || null,
      readingCount: gpsCaptured.readingCount || null,
      browser: gpsCaptured.browser || null,
      os: gpsCaptured.os || null,
      deviceType: gpsCaptured.deviceType || null,
      connectionType: gpsCaptured.connectionType || null,
      onlineAtCapture: !!gpsCaptured.onlineAtCapture,
      capturedAt: gpsCaptured.ts || null
    };
    // The form the worker is actually collecting against right now — either
    // one explicitly sent to them, or the active form they auto-loaded.
    const effectiveForm = assignedTemplate();

    if(resubmitTargetId){
      const s = SUBMISSIONS.find(x=>x.id===resubmitTargetId);
      if(s){
        // Same fallback already used when writing the submission doc's own
        // formId below (s.formId, falling back to whichever form is
        // currently active) — reused here so the media upload and the
        // submission record always agree on which form this belongs to.
        const uploadFormId = s.formId || (effectiveForm && effectiveForm.id) || null;
        let voiceUrl = s.audioUrl || null;
        let memoLen = s.memoLen;
        if(recordedBlob){
          memoLen = recordedSeconds;
          try{
            setUploadProgressLabel(btn, 'Uploading voice memo…', 0);
            voiceUrl = await uploadSubmissionVoice(s.docId, recordedBlob, uploadFormId, {
              onProgress: (f)=> setUploadProgressLabel(btn, 'Uploading voice memo…', f),
            });
          }catch(err){
            // Offline, or the upload dropped mid-flight: queue it instead
            // of failing the whole resubmission. The submission keeps its
            // PREVIOUS recording for now; once the queued upload succeeds
            // (auto-retried when connectivity returns), the configured
            // onUploadSuccess handler above points voiceUrl at the new file.
            console.warn('Voice memo upload failed — queued for retry:', err);
            await uploadQueue.enqueue({ kind: 'audio', blob: recordedBlob, surveyId: s.docId, formId: uploadFormId, meta: { docId: s.docId, field: 'voiceUrl' } });
            showToast('Could not upload the new voice memo right now — it will be attached automatically once you\u2019re back online.');
          }
        }
        let photoUrl = s.photoUrl || null;
        // Only recomputed when a NEW photo is attached this resubmission
        // (or the old one is being removed) — otherwise the previously
        // stored photoGps (and its source) is left exactly as-is.
        let photoGps = s.photoGps || null;
        if(photoBlob){
          try{
            setUploadProgressLabel(btn, 'Uploading photo…', 0);
            photoUrl = await uploadSubmissionPhoto(s.docId, photoBlob, uploadFormId, {
              onProgress: (f)=> setUploadProgressLabel(btn, 'Uploading photo…', f),
            });
            photoGps = computePhotoGps();
          }catch(err){
            console.warn('Photo upload failed — queued for retry:', err);
            await uploadQueue.enqueue({ kind: 'photo', blob: photoBlob, surveyId: s.docId, formId: uploadFormId, meta: { docId: s.docId, field: 'photoUrl' } });
            showToast('Could not upload the new photo right now — it will be attached automatically once you\u2019re back online.');
            // Upload is queued for retry, but the coordinates are already
            // known locally — record them now so they aren't lost if the
            // worker closes the app before the retry completes.
            photoGps = computePhotoGps();
          }
        } else if(photoRemoved){
          // Worker explicitly removed the existing photo without replacing
          // it — clear the field AND delete the now-orphaned file on the backend.
          photoUrl = null;
          photoGps = null;
          await deleteSubmissionMedia([s.photoUrl]);
        }
        btn.textContent = I18N[currentLang].submit_data;
        if(currentPhotoQ) answers[safeAnswerKey(currentPhotoQ)] = photoUrl ? 'Photo attached' : '';
        if(currentAudioQ) answers[safeAnswerKey(currentAudioQ)] = voiceUrl ? 'Voice memo attached' : '';
        // gpsMeta is intentionally attempted, then retried without it on
        // failure — NOT wrapped in a plain try/catch like the notification
        // write below. Unlike that case, gpsMeta has to be part of THIS
        // SAME update() call: the worker-resubmission Firestore rule only
        // permits this write while resource.data.status == 'rejected', a
        // precondition that stops being true the instant the first write
        // succeeds — so a second, separate "add gpsMeta" call afterward
        // would always be rejected regardless of whether gpsMeta itself is
        // allowed. Retrying the whole update without gpsMeta is what keeps
        // resubmission working even if that rules update isn't live yet.
        const commitResubmission = async (includeGpsMeta)=>{
          const batch = writeBatch(db);
          const payload = {
            status: 'pending',
            gps, memoLen, photoUrl, photoGps, voiceUrl,
            answers,
            formId: s.formId || (effectiveForm && effectiveForm.id) || null,
            formVersion: s.formVersion || (effectiveForm && effectiveForm.version) || null,
            formName: s.formName || (effectiveForm && effectiveForm.name) || null,
            // Corrected data goes back into review, so the prior review
            // decision no longer applies — cleared until a reviewer acts again.
            reviewComment: null, reviewedBy: null, reviewedAt: null,
            updatedAt: serverTimestamp()
          };
          if(includeGpsMeta) payload.gpsMeta = gpsMeta;
          batch.update(doc(db, 'submissions', s.docId), payload);
          // clear the notification(s) tied to this submission — batched with
          // the status update above so the two never drift apart (e.g. a
          // network drop leaving the old "rejected" notification behind
          // while the submission itself is already back to pending).
          workerNotifs.filter(n=>n.submissionId===s.id).forEach(n=>{
            batch.delete(doc(db, 'notifications', n.id));
          });
          await batch.commit();
        };
        try{
          await commitResubmission(true);
        }catch(err){
          console.warn('Resubmission with GPS metadata failed (rules may not allow gpsMeta yet) — retrying without it:', err);
          await commitResubmission(false);
        }
      
        try{
          await addDoc(collection(db, 'notifications'), {
            userUid: currentUser.uid,
            title: `${s.formName || s.id} resubmitted`,
            comment: 'Your corrected submission was sent back to your supervisor for review.',
            type: 'resubmitted',
            submissionId: s.id,
            read: false,
            createdAt: serverTimestamp()
          });
        }catch(notifErr){
          console.warn('Resubmission succeeded, but the confirmation notification could not be created:', notifErr);
        }
      }
      resubmitTargetId = null;
      showToast('Corrected submission sent back to your supervisor');
    } else {

      const subDocRef = doc(collection(db, 'submissions'));
      const submissionId = 'SB-' + Date.now().toString().slice(-6);
      if(currentPhotoQ) answers[safeAnswerKey(currentPhotoQ)] = photoBlob ? 'Photo attached' : '';
      if(currentAudioQ) answers[safeAnswerKey(currentAudioQ)] = recordedBlob ? 'Voice memo attached' : '';
      await setDoc(subDocRef, {
        submissionId,
        workerId: currentUser.uid, workerName: currentUser.name,
        supervisorId: currentUser.supervisorId || null,
        // Records exactly which form (and version of it) the worker was
        // using to collect this data, so reviewers can see/open the same
        // form later even if the worker is later reassigned a different one.
        formId: (effectiveForm && effectiveForm.id) || null,
        formVersion: (effectiveForm && effectiveForm.version) || null,
        formName: (effectiveForm && effectiveForm.name) || null,
        answers,
        gps,
        gpsMeta,
        // photoGps can be computed here even though the upload itself
        // happens afterward: it only depends on client-known values
        // (photoExifGps, or gpsCaptured as the fallback), not on the
        // upload actually succeeding.
        photoGps: computePhotoGps(),
        photoUrl: null,
        voiceUrl: null,
        memoLen: recordedSeconds || 10,
        status: 'pending',
        reviewComment: null,
        reviewedBy: null,
        reviewedAt: null,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });
     
      try{
        await addDoc(collection(db, 'notifications'), {
          userUid: currentUser.uid,
          title: `${(effectiveForm && effectiveForm.name) || submissionId} submitted`,
          comment: 'Your submission was received and is waiting for your supervisor to review.',
          type: 'submitted',
          submissionId,
          read: false,
          createdAt: serverTimestamp()
        });
      }catch(notifErr){
        console.warn('Submission succeeded, but the confirmation notification could not be created:', notifErr);
      }
    
      const uploadFormId = (effectiveForm && effectiveForm.id) || null;
      const mediaUpdates = {};
      let anyQueued = false;
      if(recordedBlob){
        try{
          setUploadProgressLabel(btn, 'Uploading voice memo…', 0);
          mediaUpdates.voiceUrl = await uploadSubmissionVoice(subDocRef.id, recordedBlob, uploadFormId, {
            onProgress: (f)=> setUploadProgressLabel(btn, 'Uploading voice memo…', f),
          });
        }catch(err){
          console.warn('Voice memo upload failed — queued for retry:', err);
          await uploadQueue.enqueue({ kind: 'audio', blob: recordedBlob, surveyId: subDocRef.id, formId: uploadFormId, meta: { docId: subDocRef.id, field: 'voiceUrl' } });
          anyQueued = true;
        }
      }
      if(photoBlob){
        try{
          setUploadProgressLabel(btn, 'Uploading photo…', 0);
          mediaUpdates.photoUrl = await uploadSubmissionPhoto(subDocRef.id, photoBlob, uploadFormId, {
            onProgress: (f)=> setUploadProgressLabel(btn, 'Uploading photo…', f),
          });
        }catch(err){
          console.warn('Photo upload failed — queued for retry:', err);
          await uploadQueue.enqueue({ kind: 'photo', blob: photoBlob, surveyId: subDocRef.id, formId: uploadFormId, meta: { docId: subDocRef.id, field: 'photoUrl' } });
          anyQueued = true;
        }
      }
      btn.textContent = I18N[currentLang].submit_data;
      try{
        if(Object.keys(mediaUpdates).length){
          await updateDoc(subDocRef, { ...mediaUpdates, updatedAt: serverTimestamp() });
        }
        if(anyQueued){
          showToast('Submission saved. Your photo/voice memo could not be uploaded right now — it will finish automatically once you\u2019re back online.');
        } else {
          showToast(isOnline() ? 'Submission saved — sent to your supervisor for review. You can submit another response for this form anytime.' : I18N[currentLang].offline_saved);
        }
      }catch(mediaErr){
        console.error('Submission saved, but recording the uploaded media on it failed:', mediaErr);
        showToast('Submission saved, but the photo/voice memo could not be linked to it — check your connection and try resubmitting it.');
      }
    }
    // If this submission came from an edited draft, it's now safely in
    // Firestore — the local draft copy is no longer needed.
    if(editingDraftId){
      DRAFTS = DRAFTS.filter(d=>d.id!==editingDraftId);
      persistDrafts();
      renderDraftsBadge();
      editingDraftId = null;
      document.getElementById('editing-draft-banner').style.display = 'none';
    }
    resetWorkerForm();
  }catch(err){
    notifyError(err, 'Something went wrong saving this submission');
  }
  renderWorkerView();
  btn.disabled = false;
};


const KOBO_API_BASE = 'http://localhost:8080';
let KOBO_FORMS = [];
let koboConnected = false;
let koboSelected = new Set();
// Lets the admin preview a form's actual questions in the Kobo Forms
// browser table (toggleKoboVfFieldsRow) before importing it:
//   koboFieldsCache — formId -> fields[] already fetched, so toggling
//                     a row's detail closed/open doesn't re-fetch.
let koboFieldsCache = new Map();

async function koboApiFetch(path, options={}){
  const idToken = await auth.currentUser.getIdToken();
  const res = await fetch(`${KOBO_API_BASE}/api/kobo${path}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${idToken}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  let body = null;
  try{ body = await res.json(); }catch{ /* no JSON body */ }
  if(!res.ok) throw new Error((body && body.error) || `Request failed (${res.status})`);
  return body;
}

/* ---------------- System alerts (admin overview) ----------------
   GET/PATCH /api/admin/system-alerts — same Express backend as the
   Kobo endpoints above (KOBO_API_BASE), just a different path, so
   this reuses that same origin rather than introducing a second
   "where's the backend" constant. Fed by scripts/monitor-disk-space.ps1
   POSTing to /api/system/alerts; see routes/systemAlerts.js. */
async function backendApiFetch(path, options={}){
  const idToken = await auth.currentUser.getIdToken();
  const res = await fetch(`${KOBO_API_BASE}${path}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${idToken}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  let body = null;
  try{ body = await res.json(); }catch{ /* no JSON body */ }
  if(!res.ok) throw new Error((body && body.error) || `Request failed (${res.status})`);
  return body;
}

let systemAlertsPollHandle = null;
let SYSTEM_ALERTS = [];

async function loadSystemAlerts(){
  if(!currentUser || currentUser.role !== 'admin') return;
  const panel = document.getElementById('system-alerts-panel');
  try{
    const data = await backendApiFetch('/api/admin/system-alerts?acknowledged=false&limit=25');
    SYSTEM_ALERTS = data.alerts || [];
    panel.style.display = SYSTEM_ALERTS.length ? 'block' : 'none';
    renderSystemAlertsPanel();
  }catch(err){
    console.error('Could not load system alerts:', err);
    // Fails quietly rather than a toast on every poll tick — a down
    // backend for this one panel shouldn't interrupt an admin working
    // on everything else on this screen.
  }
}

// Severity -> emoji, matching the "🔴 CRITICAL / 🟡 WARNING" look asked
// for on the admin panel. INFO isn't emitted by DISK_USAGE today but is
// a valid severity (see ALLOWED_SEVERITIES in systemAlertService.js),
// so it gets an icon too rather than falling through to nothing.
const SYSTEM_ALERT_ICON = { CRITICAL:'🔴', WARNING:'🟡', INFO:'🔵' };

// "23 July 2026 12:00" — a fixed, locale-independent format (unlike
// toLocaleString(), which varies by browser/OS locale and could print
// M/D/Y, D/M/Y, or a 12-hour clock depending on the admin's machine).
function formatAlertTimestamp(ts){
  if(!ts || !ts._seconds) return '';
  const d = new Date(ts._seconds*1000);
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const hh = String(d.getHours()).padStart(2,'0');
  const mm = String(d.getMinutes()).padStart(2,'0');
  return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()} ${hh}:${mm}`;
}

function renderSystemAlertsPanel(){
  const listWrap = document.getElementById('system-alerts-list');
  if(!listWrap) return;
  listWrap.innerHTML = '';
  if(SYSTEM_ALERTS.length === 0){
    listWrap.innerHTML = `<div class="sys-alerts-empty">${I18N[currentLang].no_system_alerts}</div>`;
    return;
  }
  SYSTEM_ALERTS.forEach((a, idx)=>{
    const sevClass = (a.severity||'').toLowerCase();
    const icon = SYSTEM_ALERT_ICON[a.severity] || '⚪';
    const card = document.createElement('div');
    card.className = 'sys-alert-card ' + sevClass;
    const when = formatAlertTimestamp(a.eventTimestamp);
    // "details" is type-specific (see systemAlertService.js's
    // buildDetails) — DISK_USAGE carries storageRoot/usagePercent
    // today, but a future alert type might not, so both lines below
    // are guarded rather than assumed present.
    const details = a.details || {};
    const hasLocation = typeof details.storageRoot === 'string' && details.storageRoot.length > 0;
    const hasUsage = typeof details.usagePercent === 'number';
    card.innerHTML = `
      <div class="sac-main">
        <div class="sac-top"><span class="sac-icon">${icon}</span><span class="badge ${sevClass}">${a.severity}</span></div>
        <div class="sac-msg">${a.message}</div>
        ${hasLocation ? `<div class="sac-location">📁 ${details.storageRoot}</div>` : ''}
        ${hasUsage ? `<div class="sac-usage">Usage: ${details.usagePercent}%</div>` : ''}
        <div class="sac-meta">${a.source ? a.source+' · ' : ''}${when}</div>
      </div>
      <button class="sys-alert-ack-btn" data-id="${a.alertId}">${I18N[currentLang].acknowledge}</button>`;
    card.querySelector('.sys-alert-ack-btn').onclick = (e)=> acknowledgeSystemAlert(a.alertId, e.currentTarget);
    listWrap.appendChild(card);
    // Divider between cards only — mirrors the plain-text mock-up's
    // "--------" separator, but never trails the last (or only) card.
    if(idx < SYSTEM_ALERTS.length - 1){
      const divider = document.createElement('div');
      divider.className = 'sys-alert-divider';
      listWrap.appendChild(divider);
    }
  });
}

async function acknowledgeSystemAlert(id, btnEl){
  if(btnEl) btnEl.disabled = true;
  try{
    await backendApiFetch(`/api/admin/system-alerts/${id}/acknowledge`, { method:'PATCH' });
    SYSTEM_ALERTS = SYSTEM_ALERTS.filter(a=>a.alertId!==id);
    const panel = document.getElementById('system-alerts-panel');
    panel.style.display = SYSTEM_ALERTS.length ? 'block' : 'none';
    renderSystemAlertsPanel();
  }catch(err){
    notifyError(err, 'Could not acknowledge this alert — check your connection');
    if(btnEl) btnEl.disabled = false;
  }
}

// Polls only while the admin overview view is actually on screen —
// same "view-scoped listener" pattern switchView() already uses for
// versionsUnsub/koboFormsUnsub, just an interval instead of a Firestore
// unsubscribe since this data comes from the REST endpoint, not a live
// Firestore listener.
function startSystemAlertsPolling(){
  if(systemAlertsPollHandle) return;
  loadSystemAlerts();
  systemAlertsPollHandle = setInterval(loadSystemAlerts, 60000);
}
function stopSystemAlertsPolling(){
  if(systemAlertsPollHandle){ clearInterval(systemAlertsPollHandle); systemAlertsPollHandle = null; }
}

// Streaming counterpart of koboApiFetch, for the import endpoint —
// that one responds with newline-delimited JSON progress events as
// they happen rather than a single JSON body at the end (see
// routes/kobo.js's own comment on why: pulling every submission's
// attachments is a real Kobo HTTP round trip each, so admins watching
// a multi-submission import need to see it moving). Per that same
// comment, the response is ALWAYS HTTP 200 even on failure — a bad
// outcome shows up as a `{type:'error'}` line, not a rejected fetch —
// so onEvent is how the caller finds out, not a thrown error, except
// for genuine transport failures before streaming even started.
//
// onEvent is invoked once per parsed line, in order, as they arrive.
async function koboApiFetchStream(path, options={}, onEvent){
  const idToken = await auth.currentUser.getIdToken();
  const res = await fetch(`${KOBO_API_BASE}/api/kobo${path}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${idToken}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if(!res.ok || !res.body){
    throw new Error(`Request failed (${res.status})`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for(;;){
    const { done, value } = await reader.read();
    if(done) break;
    buffer += decoder.decode(value, { stream:true });
    let nl;
    while((nl = buffer.indexOf('\n')) >= 0){
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if(!line.trim()) continue;
      try{ onEvent(JSON.parse(line)); }
      catch{ /* malformed line — skip rather than kill the whole import */ }
    }
  }
}

// Called on entering the admin-import view (see switchView()). Asks
// the backend whether a connection already exists — it survives page
// reloads, since the token lives server-side, not in this tab.
async function subscribeKoboForms(){
  try{
    const status = await koboApiFetch('/status');
    if(status && status.connected){
      koboConnected = true;
      document.getElementById('kobo-conn-status').innerHTML = `● <span>${I18N[currentLang].kobo_connected}</span>`;
      document.getElementById('kobo-conn-status').style.color = 'var(--olive)';
      document.getElementById('kobo-forms-panel').style.display = 'block';
      updateKoboConnectButtonUI();
      await loadKoboForms();
    }
  }catch(err){
    console.error('Could not check KoboToolbox connection status:', err);
  }
}

async function loadKoboForms(){
  const wrap = document.getElementById('kobo-form-list');
  wrap.innerHTML = `<p style="font-size:12.5px;color:var(--ink-soft);opacity:0.65;">${I18N[currentLang].kobo_loading_forms || 'Loading forms…'}</p>`;
  try{
    const data = await koboApiFetch('/forms');
    KOBO_FORMS = data.forms || [];
    renderKoboForms();
  }catch(err){
    console.error('Could not load KoboToolbox forms:', err);
    wrap.innerHTML = '';
    showToast(err.message || 'Could not load forms from KoboToolbox.');
  }
}

document.getElementById('kobo-server').addEventListener('change', (e)=>{
  document.getElementById('kobo-custom-url-wrap').style.display = e.target.value==='custom' ? 'block' : 'none';
});

// Keeps the single Connect/Disconnect button (and the credential fields
// above it) in sync with koboConnected -- "Connect account" + visible
// server/token inputs while disconnected, "Disconnect" + those inputs
// hidden while connected, since there's nothing to fill in once an account
// is already linked. Called after every state change: on page-load status
// check, after a successful connect, and after a successful disconnect.
function updateKoboConnectButtonUI(){
  const btn = document.getElementById('kobo-connect-btn');
  const fields = document.getElementById('kobo-credentials-fields');
  if(koboConnected){
    btn.textContent = I18N[currentLang].kobo_disconnect;
    btn.dataset.i18n = 'kobo_disconnect';
    btn.style.background = 'var(--red)';
    fields.style.display = 'none';
  } else {
    btn.textContent = I18N[currentLang].kobo_connect_btn;
    btn.dataset.i18n = 'kobo_connect_btn';
    btn.style.background = '';
    fields.style.display = '';
  }
}

// Shared by both the primary toggle button (once connected) and the
// legacy #kobo-disconnect-btn (kept in the DOM, just hidden, since other
// code still binds to it by id -- see the markup comment above it).
async function performKoboDisconnect(){
  try{
    await koboApiFetch('/disconnect', { method:'POST' });
  }catch(err){
    console.error('Kobo disconnect failed:', err);
  }
  koboConnected = false;
  koboSelected.clear();
  koboFieldsCache.clear();
  KOBO_FORMS = [];
  KOBO_VF_FORMS = null;
  document.getElementById('kobo-conn-status').innerHTML = `● <span>${I18N[currentLang].kobo_not_connected}</span>`;
  document.getElementById('kobo-conn-status').style.color = 'var(--ink-soft)';
  document.getElementById('kobo-forms-panel').style.display = 'none';
  document.getElementById('kobo-view-forms-panel').style.display = 'none';
  document.getElementById('kobo-progress-panel').style.display = 'none';
  document.getElementById('kobo-result-panel').style.display = 'none';
  updateKoboConnectButtonUI();
}

document.getElementById('kobo-connect-btn').onclick = async ()=>{
  const btn = document.getElementById('kobo-connect-btn');

  if(koboConnected){
    // Toggled into "Disconnect" mode -- tear the connection down instead
    // of trying to connect again.
    btn.disabled = true;
    btn.textContent = I18N[currentLang].kobo_disconnecting;
    try{
      await performKoboDisconnect();
    } finally {
      btn.disabled = false;
      // updateKoboConnectButtonUI() (called inside performKoboDisconnect)
      // already reset the label back to "Connect account".
    }
    return;
  }

  const token = document.getElementById('kobo-token').value.trim();
  if(!token){ document.getElementById('kobo-token').focus(); return; }
  const serverSelect = document.getElementById('kobo-server').value;
  const server = serverSelect === 'custom'
    ? document.getElementById('kobo-custom-url').value.trim()
    : serverSelect;
  if(!server){ document.getElementById('kobo-custom-url').focus(); return; }

  const orig = btn.textContent;
  btn.textContent = I18N[currentLang].kobo_connecting;
  btn.disabled = true;
  try{
    // The backend actually calls KoboToolbox with this token before
    // saving anything — an invalid/expired token throws here rather
    // than silently "connecting".
    await koboApiFetch('/connect', { method:'POST', body: JSON.stringify({ server, token }) });
    koboConnected = true;
    document.getElementById('kobo-conn-status').innerHTML = `● <span>${I18N[currentLang].kobo_connected}</span>`;
    document.getElementById('kobo-conn-status').style.color = 'var(--olive)';
    document.getElementById('kobo-forms-panel').style.display = 'block';
    document.getElementById('kobo-token').value = '';
    updateKoboConnectButtonUI(); // flips the button to "Disconnect" and hides the credential fields
    await loadKoboForms();
  }catch(err){
    console.error('Kobo connect failed:', err);
    showToast(err.message || 'Could not connect to KoboToolbox.');
    btn.textContent = orig;
  }finally{
    btn.disabled = false;
  }
};

// Legacy button, hidden now that the toggle above covers disconnecting --
// left wired to the same shared logic in case it's ever unhidden.
document.getElementById('kobo-disconnect-btn').onclick = performKoboDisconnect;


function renderKoboForms(){
  const wrap = document.getElementById('kobo-form-list');
  wrap.innerHTML = '';
  KOBO_FORMS.forEach(f=>{
    const item = document.createElement('div');
    item.className = 'kobo-form-item';

    // The checkbox means "include this form in the import" — by
    // default that's every submission in it. (To preview a form's
    // actual questions first, use "View Forms" above instead — see
    // toggleKoboVfFieldsRow.)
    const row = document.createElement('label');
    row.className = 'kobo-form-row';
    row.innerHTML = `
      <input type="checkbox" data-formid="${f.id}" ${koboSelected.has(f.id)?'checked':''} />
      <div>
        <div class="kf-name">${f.name}</div>
        <div class="kf-meta mono">${f.id} · ${I18N[currentLang].kobo_last_modified} ${f.modified}</div>
      </div>
      <div class="kf-count"><div class="n">${f.count}</div><div class="l">${I18N[currentLang].kobo_submissions}</div></div>
    `;
    row.querySelector('input').onchange = (e)=>{
      if(e.target.checked){
        koboSelected.add(f.id);
      } else {
        koboSelected.delete(f.id);
      }
      document.getElementById('kobo-import-btn').disabled = koboSelected.size===0;
    };
    item.appendChild(row);

    wrap.appendChild(item);
  });
}

// Keeps the whole-form checkbox up above in sync after a change made
// from inside its own submissions panel (e.g. unchecking every
// submission should also uncheck the form itself, and vice versa).
function syncKoboFormCheckbox(formId){
  const checkbox = document.querySelector(`#kobo-form-list input[type="checkbox"][data-formid="${formId}"]`);
  if(checkbox) checkbox.checked = koboSelected.has(formId);
  document.getElementById('kobo-import-btn').disabled = koboSelected.size===0;
}

/* ---------------- Kobo: View Forms browser ----------------
   Read-only catalog of EVERY Kobo project/form -- draft, deployed, or
   archived -- pulled from GET /api/kobo/forms/overview. Distinct from
   the "Available Forms" list above (kobo-form-list/KOBO_FORMS), which
   koboService.listForms() already filters down to just deployed forms
   ready to import. This browser is for finding/inspecting a form
   (searchable by name, shows owner/created/status/submission count);
   its "Import" action just hands off into that existing select+import
   flow rather than duplicating it. */
let KOBO_VF_FORMS = null; // null = never loaded (or last load failed); [] = loaded, zero forms
const koboVfFieldsCache = koboFieldsCache; // same per-form question cache the Available Forms panel already fills

document.getElementById('kobo-view-forms-btn').onclick = ()=>{
  const panel = document.getElementById('kobo-view-forms-panel');
  panel.style.display = 'block';
  panel.scrollIntoView({ behavior:'smooth', block:'start' });
  if(KOBO_VF_FORMS === null) loadKoboFormsOverview();
};
document.getElementById('kobo-view-forms-close-btn').onclick = ()=>{
  document.getElementById('kobo-view-forms-panel').style.display = 'none';
};
document.getElementById('kobo-vf-refresh').onclick = ()=> loadKoboFormsOverview();
document.getElementById('kobo-vf-search').addEventListener('input', ()=> renderKoboVfTable());

async function loadKoboFormsOverview(){
  const loadingEl = document.getElementById('kobo-vf-loading');
  const errorEl = document.getElementById('kobo-vf-error');
  const emptyEl = document.getElementById('kobo-vf-empty');
  const tableWrap = document.getElementById('kobo-vf-table-wrap');
  errorEl.style.display = 'none';
  emptyEl.style.display = 'none';
  tableWrap.style.display = 'none';
  document.getElementById('kobo-vf-count').textContent = '';
  loadingEl.style.display = 'block';
  document.getElementById('kobo-vf-refresh').disabled = true;
  try{
    const data = await koboApiFetch('/forms/overview');
    KOBO_VF_FORMS = data.forms || [];
    renderKoboVfTable();
  }catch(err){
    console.error('Could not load Kobo forms overview:', err);
    KOBO_VF_FORMS = null;
    loadingEl.style.display = 'none';
    errorEl.style.display = 'block';
    errorEl.textContent = err.message || I18N[currentLang].kobo_vf_load_error;
  }finally{
    document.getElementById('kobo-vf-refresh').disabled = false;
  }
}

function renderKoboVfTable(){
  const errorEl = document.getElementById('kobo-vf-error');
  const emptyEl = document.getElementById('kobo-vf-empty');
  const tableWrap = document.getElementById('kobo-vf-table-wrap');
  const countEl = document.getElementById('kobo-vf-count');
  const tbody = document.getElementById('kobo-vf-tbody');
  document.getElementById('kobo-vf-loading').style.display = 'none';
  errorEl.style.display = 'none';

  if(KOBO_VF_FORMS === null) return; // an error is already showing instead

  const q = document.getElementById('kobo-vf-search').value.trim().toLowerCase();
  const filtered = q ? KOBO_VF_FORMS.filter(f=> (f.name||'').toLowerCase().includes(q)) : KOBO_VF_FORMS;
  countEl.textContent = KOBO_VF_FORMS.length ? `${filtered.length} / ${KOBO_VF_FORMS.length}` : '';

  if(filtered.length === 0){
    tableWrap.style.display = 'none';
    emptyEl.style.display = 'block';
    tbody.innerHTML = '';
    return;
  }
  emptyEl.style.display = 'none';
  tableWrap.style.display = 'block';
  tbody.innerHTML = '';

  filtered.forEach(f=>{
    const tr = document.createElement('tr');
    const statusKey = `kobo_vf_status_${f.status}`;
    const statusLabel = I18N[currentLang][statusKey] || f.status;
    const statusClass = f.status === 'deployed' ? 'approved' : (f.status === 'draft' ? 'draft' : 'pending');
    const countDisplay = typeof f.submissionCount === 'number' ? f.submissionCount : '—';
    tr.innerHTML = `
      <td class="kvf-name-cell">${f.name}</td>
      <td class="mono">${f.id}</td>
      <td>${f.owner || '—'}</td>
      <td>${f.dateCreated || '—'}</td>
      <td>${countDisplay}</td>
      <td><span class="badge ${statusClass}">${statusLabel}</span></td>
      <td class="kvf-actions">
        <button type="button" data-action="fields">${I18N[currentLang].kobo_vf_view_questions}</button>
        <button type="button" data-action="export">${I18N[currentLang].kobo_vf_export}</button>
      </td>
    `;
    tr.querySelector('[data-action="fields"]').onclick = ()=> toggleKoboVfFieldsRow(f.id, tr);
    const exportBtn = tr.querySelector('[data-action="export"]');
    exportBtn.onclick = ()=> exportKoboVfForm(f.id, exportBtn, f.name);
    tbody.appendChild(tr);
  });
}

// Inline "view questions" row under a given form's row in the table,
// reusing the same GET /forms/:id/fields endpoint (and koboFieldsCache,
// so re-opening a form already viewed once doesn't re-fetch it). Only
// one detail row is kept open at a time, same as an accordion.
async function toggleKoboVfFieldsRow(formId, tr){
  const btn = tr.querySelector('[data-action="fields"]');
  const existingDetail = tr.nextElementSibling;
  if(existingDetail && existingDetail.classList.contains('kobo-vf-detail-row')){
    existingDetail.remove();
    btn.textContent = I18N[currentLang].kobo_vf_view_questions;
    return;
  }
  // Collapse any other open row first.
  document.querySelectorAll('#kobo-vf-tbody .kobo-vf-detail-row').forEach(r=>r.remove());
  document.querySelectorAll('#kobo-vf-tbody [data-action="fields"]').forEach(b=>{ b.textContent = I18N[currentLang].kobo_vf_view_questions; });

  const detailRow = document.createElement('tr');
  detailRow.className = 'kobo-vf-detail-row';
  const td = document.createElement('td');
  td.colSpan = 7;
  td.className = 'kobo-fields-wrap';
  td.style.borderRadius = '0';
  td.innerHTML = `<div class="kobo-fields-loading">${I18N[currentLang].kobo_loading_form}</div>`;
  detailRow.appendChild(td);
  tr.after(detailRow);
  btn.textContent = I18N[currentLang].kobo_vf_hide_questions;

  try{
    let fields = koboVfFieldsCache.get(formId);
    if(!fields){
      const data = await koboApiFetch(`/forms/${encodeURIComponent(formId)}/fields`);
      fields = data.fields || [];
      koboVfFieldsCache.set(formId, fields);
    }
    if(!detailRow.isConnected) return; // panel row was closed again while this was in flight
    td.innerHTML = fields.length
      ? `<div class="kobo-fields-head">
           <span>${I18N[currentLang].kobo_vf_questions_heading}</span>
           <span class="kfh-count">${I18N[currentLang].kobo_field_count.replace('{n}', fields.length)}</span>
         </div>
         <div class="kobo-fields-list">${fields.map(fl=>`
           <div class="kobo-field-row">
             <div class="kfr-label">
               <div class="kfr-name mono">${fl.name}</div>
               ${fl.label ? `<div class="kfr-question">${fl.label}</div>` : ''}
             </div>
             <span class="kfr-type mono">${fl.type || ''}</span>
           </div>`).join('')}</div>`
      : `<div class="kobo-fields-empty">${I18N[currentLang].kobo_no_fields}</div>`;
  }catch(err){
    console.error('Could not load KoboToolbox form fields:', err);
    if(detailRow.isConnected) detailRow.remove();
    btn.textContent = I18N[currentLang].kobo_vf_view_questions;
    showToast(err.message || I18N[currentLang].kobo_vf_load_error);
  }
}

// Binary counterpart of koboApiFetch, for the one Kobo endpoint that
// returns a file instead of JSON (the .xlsx export below) — same auth
// header, but reads the response as a Blob and pulls the filename Kobo
// route's Content-Disposition header set, rather than parsing a JSON
// body.
async function koboApiFetchBlob(path, fallbackFilename){
  const idToken = await auth.currentUser.getIdToken();
  const res = await fetch(`${KOBO_API_BASE}/api/kobo${path}`, {
    headers: { 'Authorization': `Bearer ${idToken}` },
  });
  if(!res.ok){
    // Errors from this endpoint still come back as JSON ({error: ...}),
    // same shape as every other /api/kobo/* route — only the success
    // path is binary.
    let message = `Request failed (${res.status})`;
    try{
      const body = await res.json();
      if(body && body.error) message = body.error;
    }catch{ /* no JSON body */ }
    throw new Error(message);
  }
  const disposition = res.headers.get('Content-Disposition') || '';
  const starMatch = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  const plainMatch = disposition.match(/filename="([^"]+)"/i);
  // The server always sets Content-Disposition with a form-name-based
  // filename (see koboService.buildFormExportWorkbook), so this only
  // matters if that header is ever missing or fails to parse — in
  // which case fall back to a name the caller supplies (e.g. the
  // form's own name) rather than a generic constant.
  const filename = starMatch ? decodeURIComponent(starMatch[1]) : (plainMatch ? plainMatch[1] : (fallbackFilename || 'export.xlsx'));
  // Only the form-export endpoint sends these (see kobo.js's
  // /forms/:formId/export route) — null/false on any other blob
  // response, which callers that don't care simply ignore.
  const templateId = res.headers.get('X-Template-Id') || null;
  const templateCreated = res.headers.get('X-Template-Created') === 'true';
  const surveyTemplateCreated = res.headers.get('X-Survey-Template-Created') === 'true';
  const blob = await res.blob();
  return {
    blob, filename, templateId, templateCreated, surveyTemplateCreated,
  };
}

// Triggers a browser "Save As"/download for an in-memory Blob — no
// server round trip beyond whatever already produced the blob. Used
// for the Kobo form export below; general enough to reuse for any
// future client-side file download.
function downloadBlob(blob, filename){
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Deferred, not immediate -- revoking the object URL synchronously
  // can race the download the click() just kicked off in some browsers.
  setTimeout(()=> URL.revokeObjectURL(url), 1000);
}

// Exports one Kobo form's *definition* (survey/choices/settings/
// metadata -- see koboService.buildFormExportWorkbook's own doc
// comment) as an .xlsx file the admin can save and later re-import.
// Never touches this form's submissions. Available for any form
// regardless of deployment status -- a draft's schema is just as
// exportable as a deployed one's.
//
// The backend also finds-or-creates a matching inactive Draft
// Template AND its first Survey Templates version as part of the same
// request (see koboService.exportFormAndSaveAsTemplate) -- no separate
// save step here; both show up in their respective lists on their own
// via the existing onSnapshot listeners on 'forms' and
// 'surveyTemplates'. This just toasts whether a new Survey Templates
// entry was created or one already existed, using the
// surveyTemplateCreated koboApiFetchBlob read off the response
// headers -- that's the list an admin actually lands on to reuse a
// form, so it's the more useful of the two flags to surface here.
async function exportKoboVfForm(formId, btnEl, formName){
  const original = btnEl.textContent;
  btnEl.disabled = true;
  btnEl.textContent = I18N[currentLang].kobo_vf_exporting;
  try{
    const fallbackFilename = `${sanitizeExportName(formName || formId)}.xlsx`;
    const { blob, filename, surveyTemplateCreated } = await koboApiFetchBlob(`/forms/${encodeURIComponent(formId)}/export`, fallbackFilename);
    downloadBlob(blob, filename);
    showToast(surveyTemplateCreated ? I18N[currentLang].kobo_vf_export_saved_template : I18N[currentLang].kobo_vf_export_template_exists);
  }catch(err){
    console.error('Could not export Kobo form:', err);
    showToast(err.message || I18N[currentLang].kobo_vf_export_error);
  }finally{
    btnEl.disabled = false;
    btnEl.textContent = original;
  }
}

document.getElementById('kobo-import-btn').onclick = async ()=>{
  const forms = KOBO_FORMS.filter(f=>koboSelected.has(f.id));
  document.getElementById('kobo-forms-panel').style.display = 'none';
  document.getElementById('kobo-progress-panel').style.display = 'block';
  const listEl = document.getElementById('kobo-progress-list');
  listEl.innerHTML = '';
  forms.forEach(f=>{
    const row = document.createElement('div');
    row.className = 'kobo-progress-row';
    row.innerHTML = `
      <div class="kpr-top"><span class="kf-name">${f.name}</span><span class="mono" id="kpr-pct-${f.id}">0%</span></div>
      <div class="kobo-progress-track"><div class="kobo-progress-fill" id="kpr-fill-${f.id}"></div></div>
      <div class="kpr-log" id="kpr-log-${f.id}"></div>
    `;
    listEl.appendChild(row);
  });

  let totalImported = 0, totalSkipped = 0, totalFailed = 0;
  const koboImportResults = []; // {name, geoSurveyFormId, imported, skipped, failed}

  // One form at a time, in sequence — but each bar now fills in step
  // with the backend's real NDJSON progress stream (submission N of
  // total, downloading, saving, done/skipped/failed, ...) rather than
  // jumping straight to 100% when the whole request finally resolves.
  for(const f of forms){
    const fill = document.getElementById('kpr-fill-'+f.id);
    const pctLabel = document.getElementById('kpr-pct-'+f.id);
    const logEl = document.getElementById('kpr-log-'+f.id);

    const appendLogLine = (cls, message)=>{
      const line = document.createElement('div');
      line.className = `kpr-log-line ${cls}`;
      const classes = cls.split(' ');
      const dot = classes.includes('done') ? '✓'
        : classes.includes('skipped') ? '↷'
        : classes.includes('failed') ? '✕'
        : classes.includes('complete') ? '■' : '·';
      line.innerHTML = `<span class="kpr-log-dot">${dot}</span><span></span>`;
      line.lastElementChild.textContent = message;
      logEl.appendChild(line);
      logEl.scrollTop = logEl.scrollHeight;
    };

    let formFailed = false;
    let formImported = 0, formSkipped = 0, formFailedCount = 0;
    // Set from the backend's completion event below — the Firestore
    // "forms" doc id the import actually wrote to, so we can offer a
    // direct "Edit form" link into the Form Builder afterwards.
    let geoSurveyFormId = null;
    try{
      await koboApiFetchStream(`/forms/${encodeURIComponent(f.id)}/import`, {
        method:'POST',
        body: JSON.stringify({ formName: f.name }),
      }, (event)=>{
        switch(event.type){
          case 'submission_start':
            pctLabel.textContent = `${Math.round((event.current/event.total)*100)}%`;
            fill.style.width = `${Math.round((event.current/event.total)*100)}%`;
            appendLogLine('start', event.message);
            break;
          case 'downloading':
          case 'saving':
            appendLogLine('sub', event.message);
            break;
          case 'attachment_failed':
            // One media file failing doesn't fail the submission (the
            // backend still saves it, just without that attachment) —
            // so this is a sub-line under the current submission, not
            // counted against totalFailed, which only tracks whole
            // submissions.
            appendLogLine('sub failed', event.message);
            break;
          case 'submission_done':
            totalImported += 1;
            formImported += 1;
            appendLogLine('done', event.message);
            break;
          case 'submission_skipped':
            totalSkipped += 1;
            formSkipped += 1;
            appendLogLine('skipped', event.message);
            break;
          case 'submission_failed':
            totalFailed += 1;
            formFailedCount += 1;
            appendLogLine('failed', event.message);
            break;
          case 'import_complete':
          case 'result':
            if(event.formId) geoSurveyFormId = event.formId;
            appendLogLine('complete', event.message
              || `Import complete: ${event.imported} imported, ${event.skipped} skipped, ${event.failed} failed.`);
            break;
          case 'error':
            formFailed = true;
            appendLogLine('failed', event.error || 'Import failed.');
            break;
          default:
            break;
        }
      });
    }catch(err){
      console.error(`Kobo import failed for form "${f.name}":`, err);
      showToast(err.message || `Could not import "${f.name}".`);
      appendLogLine('failed', err.message || `Could not import "${f.name}".`);
      totalFailed += f.count || 0;
      formFailedCount += f.count || 0;
      formFailed = true;
    }
    fill.style.width = '100%';
    fill.classList.add(formFailed ? 'failed' : 'done');
    pctLabel.textContent = '100%';
    koboImportResults.push({
      name: f.name, geoSurveyFormId,
      imported: formImported, skipped: formSkipped, failed: formFailedCount,
    });
  }

  document.getElementById('kobo-progress-panel').style.display = 'none';
  document.getElementById('kobo-result-panel').style.display = 'block';
  document.getElementById('kobo-result-imported').textContent = totalImported;
  document.getElementById('kobo-result-skipped').textContent = totalSkipped;
  document.getElementById('kobo-result-failed').textContent = totalFailed;
  renderKoboResultForms(koboImportResults);
  koboSelected.clear();
  koboFieldsCache.clear();
  showToast(`Imported ${totalImported} submissions from ${forms.length} Kobo form${forms.length>1?'s':''}`);
};

// Lists each just-imported Kobo form with an "Edit form →" link into the
// Form Builder, so the admin doesn't have to go hunt for it in "Your
// Forms" afterwards. Only forms the backend actually wrote to Firestore
// (geoSurveyFormId set) get the link — a form that failed outright has
// nothing to edit yet.
function renderKoboResultForms(results){
  const wrap = document.getElementById('kobo-result-forms');
  wrap.innerHTML = '';
  if(!results || results.length === 0) return;

  const title = document.createElement('div');
  title.className = 'kobo-result-forms-title';
  title.textContent = I18N[currentLang].kobo_result_forms_title;
  wrap.appendChild(title);

  results.forEach(r=>{
    const row = document.createElement('div');
    row.className = 'kobo-result-row';
    row.innerHTML = `
      <div>
        <div class="krr-name">${r.name}</div>
        <div class="krr-meta">${I18N[currentLang].kobo_result_row_meta
          .replace('{imported}', r.imported).replace('{skipped}', r.skipped).replace('{failed}', r.failed)}</div>
      </div>
    `;
    if(r.geoSurveyFormId){
      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'krr-edit-btn';
      editBtn.textContent = I18N[currentLang].kobo_edit_form;
      editBtn.onclick = ()=> editKoboImportedForm(r.geoSurveyFormId);
      row.appendChild(editBtn);
    }
    wrap.appendChild(row);
  });
}

// Jumps straight into the Form Builder with the imported form selected,
// ready to edit — same "forms" Firestore collection as any hand-built
// form, so nothing Kobo-specific happens here beyond picking the id.
function editKoboImportedForm(formId){
  currentTemplateId = formId;
  switchView('admin-builder');
}

document.getElementById('kobo-import-more-btn').onclick = ()=>{
  document.getElementById('kobo-result-panel').style.display = 'none';
  document.getElementById('kobo-forms-panel').style.display = 'block';
  renderKoboForms();
};

/* ---------------- Form builder ---------------- */
const QUESTION_TYPES = [
  {type:'short_text', key:'q_short_text', icon:'✏️'},
  {type:'number', key:'q_number', icon:'#️⃣'},
  {type:'single_choice', key:'q_single_choice', icon:'🔘'},
  {type:'multi_choice', key:'q_multi_choice', icon:'☑️'},
  {type:'date', key:'q_date', icon:'📅'},
  {type:'gps', key:'q_gps', icon:'📍'},
  {type:'photo', key:'q_photo', icon:'📷'},
  {type:'audio', key:'q_audio', icon:'🎙'},
];
function qTypeMeta(type){ return QUESTION_TYPES.find(t=>t.type===type) || QUESTION_TYPES[0]; }
function newQId(){ return 'q' + Math.random().toString(36).slice(2,9); }
function newOptId(){ return 'o' + Math.random().toString(36).slice(2,8); }
// Options used to be plain strings. They're now {id, label, subOptions:[{id,label}]}
// objects so each choice can carry its own nested sub-choices. This upgrades
// any legacy string-based options in place the first time a question is touched.
function normalizeOptions(q){
  if(!q.options){
    // A choice-type question should never have an undefined options
    // array — the builder's own "add question" flow always seeds one,
    // but an imported file (JSON or xlsx) can name a single/multi
    // choice type without supplying any options. Rather than leave
    // q.options undefined (which crashes renderQuestionList's
    // q.options.map()), give it one placeholder option to edit.
    if(q.type==='single_choice' || q.type==='multi_choice'){
      q.options = [{id:newOptId(), label:'Option 1', subOptions:[]}];
    }
    return;
  }
  q.options = q.options.map(o=>{
    if(typeof o === 'string') return {id:newOptId(), label:o, subOptions:[]};
    return {
      id: o.id || newOptId(),
      label: o.label || '',
      subOptions: (o.subOptions||[]).map(s=> typeof s==='string' ? {id:newOptId(), label:s} : {id:s.id||newOptId(), label:s.label||''})
    };
  });
}
// Reads an option's display label whether it's the legacy string form or the
// new {id,label,subOptions} object form — used anywhere options are shown
// outside the builder (worker answer form, form preview, etc).
function optLabel(o){ return typeof o === 'string' ? o : (o.label || ''); }

// FORM_TEMPLATES now mirrors the Firestore "forms" collection live
// (see subscribeFormTemplates()). It starts empty and fills in the instant
// we get a snapshot back — same pattern as WORKERS_LIST / SUBMISSIONS.
let FORM_TEMPLATES = [];
let currentTemplateId = null;
// Ids of templates added to FORM_TEMPLATES optimistically (before their
// Firestore write has come back through onSnapshot) — see
// subscribeFormTemplates, which needs to know not to treat "not in this
// snapshot yet" as "was deleted".
let pendingTemplateIds = new Set();
let draggedQId = null;

function currentTemplate(){ return FORM_TEMPLATES.find(t=>t.id===currentTemplateId); }

// Writes the given fields to this template's Firestore doc. Used for
// structural edits (add/delete/reorder/toggle) that should save right away.
function persistTemplate(t, fields){
  if(!t || !t.id) return;
  updateDoc(doc(db, 'forms', t.id), {...fields, updatedAt: serverTimestamp()}).catch(err=>{
    console.error('Failed to save form template:', err);
    showToast('Could not save — check your connection.');
  });
}

// Debounced version for free-typed text (question labels, option text, form
// name) so we're not firing a write on every single keystroke.
let builderSaveTimers = {};
function debouncedPersistTemplate(t, fields, key){
  if(!t || !t.id) return;
  clearTimeout(builderSaveTimers[key]);
  builderSaveTimers[key] = setTimeout(()=> persistTemplate(t, fields), 500);
}

function renderTemplateList(){
  const wrap = document.getElementById('template-list');
  wrap.innerHTML = '';
  if(FORM_TEMPLATES.length===0){
    wrap.innerHTML = `<div class="q-empty" style="font-size:12.5px;">No forms yet — create one above.</div>`;
    return;
  }
  FORM_TEMPLATES.forEach(t=>{
    const row = document.createElement('div');
    row.className = 'tpl-item' + (t.id===currentTemplateId ? ' selected' : '');
    row.innerHTML = `
      <div>
        <div class="tn">${t.name}</div>
        <div class="tq">${t.questions.length} question${t.questions.length===1?'':'s'}</div>
      </div>
      ${t.active ? '<span class="tpl-active-pill" title="Active form"></span>' : ''}
    `;
    row.onclick = ()=>{ currentTemplateId = t.id; renderTemplateList(); renderBuilderMain(); };
    wrap.appendChild(row);
  });
}

/* ---------------- Survey Templates page ---------------- */

// Template Name/Description/Kobo Form ID/creator name all come from
// user- or Kobo-supplied text and get rendered via innerHTML below, so
// they need escaping the same way every other free-text field in this
// app is (see e.g. the option/suboption inputs in renderQuestionList).
function escTplText(s){
  return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Firestore Timestamp -> localized date string, or an em dash while it's
// still an unresolved serverTimestamp() sentinel (or simply absent).
function tplDateLabel(ts){
  return (ts && ts.toDate) ? ts.toDate().toLocaleDateString() : '—';
}

function tplUserName(uid){
  if(!uid) return I18N[currentLang].unknown_user;
  const u = WORKERS_LIST.find(w=>w.uid===uid);
  return (u && (u.name || u.email)) || I18N[currentLang].unknown_user;
}

// Renders the Survey Templates table: one row per template lineage
// (grouped by sourceFormId), showing its latest version, with an
// expandable list of every earlier version underneath — so nothing a
// previous "Save Template" click wrote ever disappears from view.
function renderSurveyTemplatesTable(){
  const emptyEl = document.getElementById('survey-templates-empty');
  const wrapEl = document.getElementById('survey-templates-table-wrap');
  const body = document.getElementById('survey-templates-table-body');
  body.innerHTML = '';

  if(SURVEY_TEMPLATES.length === 0){
    emptyEl.style.display = 'block';
    wrapEl.style.display = 'none';
    return;
  }
  emptyEl.style.display = 'none';
  wrapEl.style.display = 'block';

  // Group every version by its lineage (sourceFormId). SURVEY_TEMPLATES
  // is already ordered version-desc (see subscribeSurveyTemplates), so
  // the first entry pushed into each group is that lineage's latest.
  const groups = new Map();
  SURVEY_TEMPLATES.forEach(tpl=>{
    const key = tpl.sourceFormId || tpl.id; // fall back to its own id if somehow missing
    if(!groups.has(key)) groups.set(key, []);
    groups.get(key).push(tpl);
  });

  // Sort lineages by their latest version's dateModified, newest first.
  const lineages = Array.from(groups.values()).sort((a,b)=>{
    const am = a[0].dateModified?.toMillis?.() || 0;
    const bm = b[0].dateModified?.toMillis?.() || 0;
    return bm - am;
  });

  lineages.forEach(versions=>{
    const latest = versions[0];
    const older = versions.slice(1);
    const lineageKey = latest.sourceFormId || latest.id;

    const row = document.createElement('tr');
    row.innerHTML = `
      <td class="tpl-name-cell">${escTplText(latest.name)}</td>
      <td class="tpl-desc-cell">${escTplText(latest.description || '')}</td>
      <td>${latest.koboFormId ? escTplText(latest.koboFormId) : I18N[currentLang].tpl_no_kobo_id}</td>
      <td><span class="tpl-version-pill">v${latest.version}</span></td>
      <td>${tplDateLabel(latest.dateImported)}</td>
      <td>${tplDateLabel(latest.dateModified)}</td>
      <td>${escTplText(tplUserName(latest.createdBy))}</td>
      <td class="tpl-actions">
        <button type="button" class="tpl-use-btn">${I18N[currentLang].tpl_use_btn}</button>
        ${older.length ? `<button type="button" class="tpl-versions-toggle">${I18N[currentLang].tpl_versions_btn.replace('{n}', versions.length)}</button>` : ''}
        <button type="button" class="tpl-remove-btn">${I18N[currentLang].tpl_remove_btn}</button>
      </td>
    `;
    row.querySelector('.tpl-use-btn').onclick = ()=> useTemplateForNewSurvey(latest);
    row.querySelector('.tpl-remove-btn').onclick = ()=> removeTemplateVersion(latest);
    const toggleBtn = row.querySelector('.tpl-versions-toggle');
    if(toggleBtn){
      toggleBtn.onclick = ()=>{
        if(expandedTemplateLineages.has(lineageKey)) expandedTemplateLineages.delete(lineageKey);
        else expandedTemplateLineages.add(lineageKey);
        renderSurveyTemplatesTable();
      };
    }
    body.appendChild(row);

    if(older.length && expandedTemplateLineages.has(lineageKey)){
      const historyRow = document.createElement('tr');
      historyRow.className = 'tpl-versions-row';
      const historyCell = document.createElement('td');
      historyCell.colSpan = 8;
      const historyWrap = document.createElement('div');
      historyWrap.className = 'tpl-versions-wrap';
      older.forEach(v=>{
        const line = document.createElement('div');
        line.className = 'tpl-version-history-row';
        line.innerHTML = `
          <span class="tvh-v">v${v.version}</span>
          <span>${tplDateLabel(v.dateModified)}</span>
          <span>${escTplText(tplUserName(v.savedBy || v.createdBy))}</span>
          <button type="button" class="tvh-use">${I18N[currentLang].tpl_use_btn}</button>
          <button type="button" class="tvh-remove">${I18N[currentLang].tpl_remove_btn}</button>
        `;
        line.querySelector('.tvh-use').onclick = ()=> useTemplateForNewSurvey(v);
        line.querySelector('.tvh-remove').onclick = ()=> removeTemplateVersion(v);
        historyWrap.appendChild(line);
      });
      historyCell.appendChild(historyWrap);
      historyRow.appendChild(historyCell);
      body.appendChild(historyRow);
    }
  });
}

// Clones a saved template version into a brand-new, independent draft
// form in "forms" — the template itself is never modified by this. Fresh
// question/option ids are generated (same reasoning as the JSON
// import-form-btn handler above) so nothing here can collide with ids
// already in use on another form.
async function useTemplateForNewSurvey(tpl){
  const titleEl = document.getElementById('gc-title');
  const previousTitle = titleEl.textContent;
  titleEl.textContent = I18N[currentLang].tpl_use_confirm_title;
  const confirmed = await confirmDialog(
    I18N[currentLang].tpl_use_confirm_body.replace('{v}', tpl.version),
    I18N[currentLang].tpl_use_confirm_btn
  );
  titleEl.textContent = previousTitle;
  if(!confirmed) return;

  const clonedQuestions = (tpl.questions || []).map(q=>{
    const cloned = { ...q, id: newQId() };
    if(Array.isArray(q.options)){
      cloned.options = q.options.map(o=>({
        id: newOptId(),
        label: optLabel(o),
        subOptions: (o.subOptions || []).map(s=> ({ id: newOptId(), label: optLabel(s) })),
      }));
    }
    return cloned;
  });

  try{
    const ref = await addDoc(collection(db, 'forms'), {
      name: tpl.name,
      description: tpl.description || '',
      active: false,
      questions: clonedQuestions,
      version: 1,
      createdBy: currentUser.uid,
      // Traceability back to the template this was spawned from — purely
      // informational, doesn't link the two docs' lifecycles together.
      sourceTemplateId: tpl.sourceFormId || null,
      sourceTemplateVersion: tpl.version || null,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    currentTemplateId = ref.id;
    if(!FORM_TEMPLATES.find(f=>f.id===ref.id)){
      pendingTemplateIds.add(ref.id);
      FORM_TEMPLATES.unshift({
        id: ref.id, name: tpl.name, description: tpl.description || '', active:false,
        questions: clonedQuestions, version:1, createdBy: currentUser.uid,
      });
    }
    switchView('admin-builder');
    renderTemplateList(); renderBuilderMain();
    showToast(I18N[currentLang].tpl_new_form_created);
  }catch(err){
    notifyError(err, 'Could not create a form from this template — check your connection.');
  }
}

// Permanently deletes a single Survey Templates version doc — admin only
// (enforced both here via the nav being admin-only, and server-side by the
// surveyTemplates Firestore rule). Confirms first since this is the one
// place in the app that can erase a piece of version history that used to
// be permanent by design. If it's the last remaining version in its
// lineage, the whole row simply disappears on the next render (the
// lineage grouping in renderSurveyTemplatesTable has nothing left to
// group); if earlier versions remain, the next-newest becomes "latest"
// automatically, no extra bookkeeping needed since SURVEY_TEMPLATES is
// live via onSnapshot.
async function removeTemplateVersion(tpl){
  const titleEl = document.getElementById('gc-title');
  const previousTitle = titleEl.textContent;
  titleEl.textContent = I18N[currentLang].tpl_remove_confirm_title;
  const confirmed = await confirmDialog(
    I18N[currentLang].tpl_remove_confirm_body.replace('{v}', tpl.version).replace('{name}', tpl.name),
    I18N[currentLang].tpl_remove_confirm_btn
  );
  titleEl.textContent = previousTitle;
  if(!confirmed) return;
  try{
    await deleteDoc(doc(db, 'surveyTemplates', tpl.id));
    showToast(I18N[currentLang].tpl_removed);
  }catch(err){
    notifyError(err, 'Could not remove this template version — check your connection.');
  }
}

document.getElementById('new-form-btn').onclick = async ()=>{
  const btn = document.getElementById('new-form-btn');
  btn.disabled = true;
  try{
    const ref = await addDoc(collection(db, 'forms'), {
      name: I18N[currentLang].untitled_form, description:'', active:false, questions:[], version:1,
      createdBy: currentUser.uid, createdAt: serverTimestamp(), updatedAt: serverTimestamp()
    });
    currentTemplateId = ref.id;
    // Firestore's offline cache resolves this promise instantly (even
    // offline), but just in case the snapshot hasn't landed in
    // FORM_TEMPLATES yet, add an optimistic local copy so the UI updates
    // right away instead of waiting on a round trip.
    if(!FORM_TEMPLATES.find(t=>t.id===ref.id)){
      pendingTemplateIds.add(ref.id);
      FORM_TEMPLATES.unshift({ id:ref.id, name:I18N[currentLang].untitled_form, description:'', active:false, questions:[], version:1, createdBy: currentUser.uid });
    }
    renderTemplateList(); renderBuilderMain();
  }catch(err){
    notifyError(err, 'Could not create form — check your connection.');
  }
  btn.disabled = false;
};

// Question "type" as it can appear in an imported .xlsx sheet — the
// internal codes (QUESTION_TYPES above) plus common human-readable
// synonyms an admin might type into a spreadsheet by hand. Keys are
// lowercased with spaces/hyphens collapsed to underscores before lookup
// (see resolveImportedQuestionType).
const XLSX_TYPE_ALIASES = {
  short_text:'short_text', text:'short_text', string:'short_text',
  number:'number', num:'number', numeric:'number',
  single_choice:'single_choice', choice:'single_choice', radio:'single_choice', dropdown:'single_choice', select_one:'single_choice',
  multi_choice:'multi_choice', multiple_choice:'multi_choice', checkbox:'multi_choice', select_multiple:'multi_choice',
  date:'date',
  gps:'gps', location:'gps', geopoint:'gps',
  photo:'photo', image:'photo', picture:'photo',
  audio:'audio', sound:'audio', recording:'audio',
};
function resolveImportedQuestionType(raw){
  const key = String(raw||'').trim().toLowerCase().replace(/[\s-]+/g,'_');
  return XLSX_TYPE_ALIASES[key] || 'short_text';
}
function isTruthyImportCell(raw){
  const v = String(raw==null?'':raw).trim().toLowerCase();
  return v==='true' || v==='yes' || v==='y' || v==='1' || v==='x' || v==='required';
}
// Lowercases every key on a row object so header lookups (label/type/
// required/options) don't depend on the exact casing/spacing an admin
// used in the spreadsheet.
// Guarantees a single/multi-choice question always has a non-empty
// options array — an imported file (JSON or xlsx) can name a choice
// type without actually supplying any options for that row, and an
// undefined options array crashes renderQuestionList's q.options.map()
// even though normalizeOptions() has its own fallback for the same
// case. Applied once here, at import time, for both formats.
function ensureChoiceOptions(q){
  if((q.type==='single_choice' || q.type==='multi_choice') && (!q.options || !q.options.length)){
    q.options = ['Option 1'];
  }
  return q;
}
function lowerKeys(row){
  const out = {};
  Object.keys(row||{}).forEach(k=>{ out[String(k).trim().toLowerCase()] = row[k]; });
  return out;
}
// Parses a form-builder .xlsx import into {name, description, questions}.
// Expected layout: a sheet (first one, or one named "Questions") with a
// header row containing at least "label" — plus optional "type",
// "required", and "options" (options separated by "|"). An optional
// second sheet named "Form" or "Info" with Name/Description key-value
// rows supplies the form's name/description; otherwise the name falls
// back to the file name, matching the .json import's behavior.
function parseFormWorkbook(workbook, fallbackName){
  const questionsSheetName = workbook.SheetNames.find(n=> /^questions?$/i.test(n)) || workbook.SheetNames[0];
  const questionsSheet = workbook.Sheets[questionsSheetName];
  if(!questionsSheet) throw new Error('workbook has no sheets');
  const rows = XLSX.utils.sheet_to_json(questionsSheet, {defval:''}).map(lowerKeys);
  const importedQuestions = rows
    .filter(r => String(r.label||r.question||'').trim() !== '')
    .map(r => {
      const label = String(r.label||r.question||'').trim();
      const type = resolveImportedQuestionType(r.type);
      const required = isTruthyImportCell(r.required);
      const options = String(r.options||'').split('|').map(s=>s.trim()).filter(Boolean);
      return ensureChoiceOptions({ id:newQId(), type, label, required, ...(options.length ? {options} : {}) });
    });
  if(!importedQuestions.length) throw new Error('no question rows found');

  let name = '';
  let description = '';
  const infoSheetName = workbook.SheetNames.find(n=> /^(form|info)$/i.test(n));
  if(infoSheetName){
    const infoRows = XLSX.utils.sheet_to_json(workbook.Sheets[infoSheetName], {header:1, defval:''});
    infoRows.forEach(row=>{
      const key = String(row[0]||'').trim().toLowerCase();
      const value = String(row[1]||'').trim();
      if(key==='name') name = value;
      if(key==='description') description = value;
    });
  }
  name = name || fallbackName;
  return { name, description, questions: importedQuestions };
}
// Shared by both the .json and .xlsx import paths: writes the parsed
// form as a new, inactive template, same as "+ New form" followed by
// filling it in.
async function createImportedForm(name, description, importedQuestions){
  const ref = await addDoc(collection(db, 'forms'), {
    name, description, active:false, questions: importedQuestions, version:1,
    createdBy: currentUser.uid, createdAt: serverTimestamp(), updatedAt: serverTimestamp()
  });
  currentTemplateId = ref.id;
  if(!FORM_TEMPLATES.find(t=>t.id===ref.id)){
    pendingTemplateIds.add(ref.id);
    FORM_TEMPLATES.unshift({ id:ref.id, name, description, active:false, questions: importedQuestions, version:1, createdBy: currentUser.uid });
  }
  renderTemplateList(); renderBuilderMain();
  showToast(I18N[currentLang].form_imported);
}

document.getElementById('import-form-btn').onclick = ()=>{
  document.getElementById('import-form-file').value = '';
  document.getElementById('import-form-file').click();
};
document.getElementById('import-form-file').addEventListener('change', async (e)=>{
  const file = e.target.files[0];
  if(!file) return;
  const btn = document.getElementById('import-form-btn');
  btn.disabled = true;
  const isXlsx = /\.xlsx$/i.test(file.name || '');
  try{
    if(isXlsx){
      const buf = await file.arrayBuffer();
      const workbook = XLSX.read(buf, {type:'array'});
      const { name, description, questions } = parseFormWorkbook(workbook, file.name.replace(/\.xlsx$/i,''));
      await createImportedForm(name, description, questions);
    } else {
      const text = await file.text();
      const data = JSON.parse(text);
      if(!data || typeof data !== 'object' || !Array.isArray(data.questions)){
        throw new Error('missing questions array');
      }
      // Give every question a fresh id so an imported form never collides
      // with question ids already used elsewhere.
      const importedQuestions = data.questions.map(q=> ensureChoiceOptions({
        id:newQId(), type:q.type||'short_text', label:q.label||'', required:!!q.required,
        ...(q.options ? {options:[...q.options]} : {})
      }));
      const name = (data.name && String(data.name).trim()) || file.name.replace(/\.json$/i,'');
      const description = (data.description && String(data.description).trim()) || '';
      await createImportedForm(name, description, importedQuestions);
    }
  }catch(err){
    console.error('Failed to import form file:', err);
    showToast(I18N[currentLang].err_invalid_form_file);
  }
  btn.disabled = false;
});

// Shared by every form/template export button (json + xlsx, Form
// Builder + Survey Templates): strips only the characters actually
// invalid in a Windows/macOS filename (/ \ : * ? " < > |), replacing
// each run with a single "-". Spaces and casing from the form's own
// name are preserved — same rule exportSubmission() already uses for
// per-submission exports — so "Water Point Survey.xlsx" downloads as
// "Water Point Survey.xlsx", not "Water_Point_Survey.xlsx".
function sanitizeExportName(name){
  const cleaned = String(name||'').replace(/[\/\\:*?"<>|]+/g, '-').trim();
  return (cleaned || 'form').slice(0, 80);
}
function triggerFileDownload(blob, filename){
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
function downloadFormAsJson(name, description, questions, filenameBase){
  const payload = JSON.stringify({ name: name||'', description: description||'', questions: questions||[] }, null, 2);
  const blob = new Blob([payload], {type:'application/json'});
  triggerFileDownload(blob, `${filenameBase}.json`);
}
// Builds a .xlsx in the same "Questions" (+ optional "Form") sheet
// shape parseFormWorkbook() reads back on import, so exporting a form
// and re-importing that same file round-trips its questions cleanly.
function downloadFormAsXlsx(name, description, questions, filenameBase){
  const rows = (questions||[]).map(q=> ({
    label: q.label || '',
    type: q.type || 'short_text',
    required: q.required ? 'true' : 'false',
    options: (q.options||[]).map(o=> typeof o==='string' ? o : (o.label||'')).filter(Boolean).join('|'),
  }));
  const wb = XLSX.utils.book_new();
  const questionsSheet = XLSX.utils.json_to_sheet(rows, {header:['label','type','required','options']});
  XLSX.utils.book_append_sheet(wb, questionsSheet, 'Questions');
  const infoSheet = XLSX.utils.aoa_to_sheet([['name', name||''], ['description', description||'']]);
  XLSX.utils.book_append_sheet(wb, infoSheet, 'Form');
  const wbout = XLSX.write(wb, {bookType:'xlsx', type:'array'});
  const blob = new Blob([wbout], {type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
  triggerFileDownload(blob, `${filenameBase}.xlsx`);
}

document.getElementById('export-json-btn').onclick = ()=>{
  const t = currentTemplate();
  if(!t) return;
  downloadFormAsJson(t.name, t.description||'', t.questions, sanitizeExportName(t.name));
  showToast(I18N[currentLang].form_exported);
};
document.getElementById('export-xlsx-btn').onclick = ()=>{
  const t = currentTemplate();
  if(!t) return;
  downloadFormAsXlsx(t.name, t.description||'', t.questions, sanitizeExportName(t.name));
  showToast(I18N[currentLang].form_exported);
};

function renderBuilderMain(){
  const t = currentTemplate();
  const nameInput = document.getElementById('builder-form-name');
  const descInput = document.getElementById('builder-form-description');
  const activeCb = document.getElementById('builder-form-active');
  const saveBtn = document.getElementById('save-template-btn');
  const saveAsTemplateBtn = document.getElementById('save-as-template-btn');
  const sendBtn = document.getElementById('send-template-btn');
  const deleteBtn = document.getElementById('delete-template-btn');
  const exportJsonBtn = document.getElementById('export-json-btn');
  const exportXlsxBtn = document.getElementById('export-xlsx-btn');
  if(!t){
    nameInput.value = '';
    nameInput.disabled = true;
    descInput.value = '';
    descInput.disabled = true;
    activeCb.checked = false;
    activeCb.disabled = true;
    saveBtn.disabled = true;
    saveAsTemplateBtn.disabled = true;
    sendBtn.disabled = true;
    deleteBtn.disabled = true;
    exportJsonBtn.disabled = true;
    exportXlsxBtn.disabled = true;
    document.getElementById('question-list').innerHTML = '';
    document.getElementById('qtype-palette').innerHTML = '';
    return;
  }
  nameInput.disabled = false;
  descInput.disabled = false;
  saveBtn.disabled = false;
  saveAsTemplateBtn.disabled = false;
  sendBtn.disabled = false;
  deleteBtn.disabled = false;
  exportJsonBtn.disabled = false;
  exportXlsxBtn.disabled = false;
  nameInput.value = t.name;
  descInput.value = t.description || '';
  activeCb.checked = t.active;
  renderQuestionList();
  renderQTypePalette();
}

document.getElementById('builder-form-name').addEventListener('input', (e)=>{
  const t = currentTemplate();
  if(t){
    t.name = e.target.value;
    renderTemplateList();
    debouncedPersistTemplate(t, {name: t.name}, 'name-'+t.id);
  }
});

document.getElementById('builder-form-description').addEventListener('input', (e)=>{
  const t = currentTemplate();
  if(t){
    t.description = e.target.value;
    debouncedPersistTemplate(t, {description: t.description}, 'desc-'+t.id);
  }
});

document.getElementById('save-template-btn').onclick = async ()=>{
  const t = currentTemplate();
  if(!t) return;
  const btn = document.getElementById('save-template-btn');
  const name = document.getElementById('builder-form-name').value.trim() || I18N[currentLang].untitled_form;
  const description = document.getElementById('builder-form-description').value.trim();
  const wasActive = document.getElementById('builder-form-active').checked;
  // Every question needs a real label — an empty q.label ends up as the
  // KEY in a submission's answers{} object (answers[q.label] = ...), and
  // Firestore's setDoc()/update() reject documents with an empty field
  // name. Block the save here rather than letting it surface later as a
  // broken worker submission.
  const emptyLabelQuestions = t.questions.filter(q => !(q.label || '').trim());
  if (emptyLabelQuestions.length) {
    alert(`Please give every question a label before saving. ${emptyLabelQuestions.length} question(s) are missing one.`);
    return; // block save
  }
  btn.disabled = true;
  try{
    // "At most one active form template" is an invariant that spans
    // multiple documents, so this runs as a transaction rather than
    // separate updateDoc() calls: it re-reads every template's *current*
    // server state (not the possibly-stale local cache) and only then
    // decides what to deactivate and what version number to write —
    // closing the race where two admins activate different templates at
    // the same moment, or where this admin's local version number has
    // drifted from the server's.
    const targetRef = doc(db, 'forms', t.id);
    const otherRefs = FORM_TEMPLATES.filter(f=>f.id!==t.id).map(f=> doc(db, 'forms', f.id));
    const { nextVersion } = await runTransaction(db, async (tx)=>{
      const targetSnap = await tx.get(targetRef);
      if(!targetSnap.exists()){
        throw Object.assign(new Error('This form no longer exists — it may have been deleted elsewhere.'), {code:'not-found'});
      }
      const otherSnaps = await Promise.all(otherRefs.map(ref=> tx.get(ref)));
      const nextVersion = (targetSnap.data().version || 1) + 1;
      if(wasActive){
        otherSnaps.forEach((snap, i)=>{
          if(snap.exists() && snap.data().active){
            tx.update(otherRefs[i], {active:false, updatedAt: serverTimestamp()});
          }
        });
      }
      tx.update(targetRef, {name, description, active: wasActive, questions: t.questions, version: nextVersion, updatedAt: serverTimestamp()});
      return { nextVersion };
    });
    if(wasActive) FORM_TEMPLATES.forEach(f=>{ if(f.id!==t.id) f.active=false; });
    t.name = name; t.description = description; t.active = wasActive; t.version = nextVersion;
    renderTemplateList(); renderBuilderMain();
    showToast(wasActive ? `"${name}" ${I18N[currentLang].form_set_active}` : I18N[currentLang].form_saved);
  }catch(err){
    notifyError(err, 'Could not save — check your connection.');
  }
  btn.disabled = false;
};

document.getElementById('save-as-template-btn').onclick = async ()=>{
  const t = currentTemplate();
  if(!t) return;
  const btn = document.getElementById('save-as-template-btn');
  const name = document.getElementById('builder-form-name').value.trim() || I18N[currentLang].untitled_form;
  const description = document.getElementById('builder-form-description').value.trim();
  // Same guard as "Save form" — an empty question label would break both
  // paths the same way, so require it here too rather than letting a
  // template be saved with a question that can never actually be used.
  const emptyLabelQuestions = t.questions.filter(q => !(q.label || '').trim());
  if (emptyLabelQuestions.length) {
    alert(`Please give every question a label before saving as a template. ${emptyLabelQuestions.length} question(s) are missing one.`);
    return;
  }
  btn.disabled = true;
  try{
    // Every version of this form's template lineage shares the same
    // sourceFormId (the forms/{id} doc being edited). Look up the most
    // recent one already saved, if any, so this write becomes version
    // N+1 rather than colliding with — or overwriting — an earlier one,
    // and so "Date imported" stays pinned to when the lineage first
    // became a template instead of drifting on every save.
    const priorQuery = query(
      collection(db, 'surveyTemplates'),
      where('sourceFormId', '==', t.id),
      orderBy('version', 'desc'),
      limit(1)
    );
    const priorSnap = await getDocs(priorQuery);
    const prior = priorSnap.empty ? null : priorSnap.docs[0].data();
    const nextVersion = prior ? (prior.version || 1) + 1 : 1;
    // First save in a lineage: "imported" means "when this form first
    // became a template", using the underlying form's own createdAt if
    // we have it locally (falls back to now for the rare case a template
    // is saved before that field has synced down from Firestore yet).
    const dateImported = prior ? prior.dateImported : (t.createdAt || serverTimestamp());
    await addDoc(collection(db, 'surveyTemplates'), {
      name,
      description,
      koboFormId: t.koboSourceFormId || null,
      version: nextVersion,
      sourceFormId: t.id,
      // Deep-cloned so later edits in the Form Builder (which mutates
      // t.questions in place) can never reach back and alter a version
      // that's already been saved.
      questions: JSON.parse(JSON.stringify(t.questions)),
      dateImported,
      dateModified: serverTimestamp(),
      createdBy: prior ? prior.createdBy : currentUser.uid,
      savedBy: currentUser.uid,
      createdAt: serverTimestamp(),
    });
    showToast(`${I18N[currentLang].template_saved} (v${nextVersion})`);
  }catch(err){
    notifyError(err, 'Could not save template — check your connection.');
  }
  btn.disabled = false;
};

document.getElementById('delete-template-btn').onclick = async ()=>{
  const t = currentTemplate();
  if(!t) return;

  // Deleting a form doesn't cascade to its submissions — Firestore has
  // no built-in "related docs" cleanup, and submissionArchiveService
  // looks up forms/{formId} on every archive attempt (see
  // formFolderService.getStorageFolderName()). Deleting a form that
  // still has submissions attached permanently orphans them: they'll
  // never archive to disk and will log "Form not found" on every
  // backend restart, forever. So: count attached submissions first,
  // and require typed confirmation (not just a click) if there are
  // any — same "type DELETE" pattern as the bulk version-delete tool.
  let attachedCount = 0;
  try{
    const attachedSnap = await getDocs(query(collection(db,'submissions'), where('formId','==', t.id)));
    attachedCount = attachedSnap.size;
  }catch(err){
    // Can't verify attached submissions — fail safe by blocking rather
    // than silently allowing an unchecked delete.
    notifyError(err, 'Could not verify attached submissions — check your connection and try again.');
    return;
  }

  let confirmed;
  if(attachedCount > 0){
    confirmed = await confirmDialog(
      I18N[currentLang].confirm_delete_form_has_submissions.replace('{n}', attachedCount),
      I18N[currentLang].delete_label || 'Delete',
      'DELETE'
    );
  } else {
    confirmed = await confirmDialog(I18N[currentLang].confirm_delete_form, I18N[currentLang].delete_label || 'Delete');
  }
  if(!confirmed) return;

  const btn = document.getElementById('delete-template-btn');
  btn.disabled = true;
  try{
    await deleteDoc(doc(db, 'forms', t.id));
    FORM_TEMPLATES = FORM_TEMPLATES.filter(f=>f.id!==t.id);
    pendingTemplateIds.delete(t.id);
    currentTemplateId = FORM_TEMPLATES[0]?.id || null;
    renderTemplateList();
    renderBuilderMain();
    showToast(I18N[currentLang].form_deleted);
  }catch(err){
    notifyError(err, 'Could not delete — check your connection.');
    btn.disabled = false;
  }
};

document.getElementById('send-template-btn').onclick = ()=>{
  const t = currentTemplate();
  if(!t) return;
  const list = document.getElementById('sf-worker-list');
  const eligible = WORKERS_LIST.filter(w=>w.role==='worker' && w.active);
  document.getElementById('sf-error').style.display = 'none';
  document.getElementById('sf-select-all').checked = false;
  if(eligible.length===0){
    list.innerHTML = `<div style="font-size:12.5px;color:var(--ink-soft);padding:6px 2px;">${I18N[currentLang].no_workers_to_send}</div>`;
  } else {
    list.innerHTML = eligible.map(w=>`<label class="choice-opt" style="display:flex;align-items:center;gap:8px;font-size:13px;margin-bottom:6px;cursor:pointer;"><input type="checkbox" class="sf-worker-cb" value="${w.uid}" data-name="${escapeHtml(w.name)}" style="width:16px;height:16px;flex-shrink:0;accent-color:var(--clay);"> ${escapeHtml(w.name)}</label>`).join('');
  }
  updateSendFormCount();
  document.getElementById('send-form-modal').classList.add('show');
};
function updateSendFormCount(){
  const boxes = Array.from(document.querySelectorAll('.sf-worker-cb'));
  const checked = boxes.filter(b=>b.checked).length;
  document.getElementById('sf-count').textContent = checked ? `${checked} / ${boxes.length} selected` : '';
  document.getElementById('sf-select-all').checked = boxes.length>0 && checked===boxes.length;
}
document.getElementById('sf-worker-list').addEventListener('change', (e)=>{
  if(!e.target.classList.contains('sf-worker-cb')) return;
  const label = e.target.closest('.choice-opt');
  if(label) label.classList.toggle('selected', e.target.checked);
  updateSendFormCount();
});
document.getElementById('sf-select-all').onclick = (e)=>{
  const on = e.target.checked;
  document.querySelectorAll('.sf-worker-cb').forEach(cb=>{
    cb.checked = on;
    const label = cb.closest('.choice-opt');
    if(label) label.classList.toggle('selected', on);
  });
  updateSendFormCount();
};
document.getElementById('sf-cancel').onclick = ()=> document.getElementById('send-form-modal').classList.remove('show');
document.getElementById('sf-confirm').onclick = async ()=>{
  const t = currentTemplate();
  const checked = Array.from(document.querySelectorAll('.sf-worker-cb:checked'));
  const errBox = document.getElementById('sf-error');
  if(!t || checked.length===0){
    errBox.textContent = I18N[currentLang].err_pick_worker;
    errBox.style.display = 'block';
    return;
  }
  const btn = document.getElementById('sf-confirm');
  btn.disabled = true;
  errBox.style.display = 'none';
  // Send to every selected worker independently so one failure (e.g. a
  // worker doc that no longer exists) doesn't block the others from
  // getting the form.
  const results = await Promise.allSettled(checked.map(async (cb)=>{
    const workerUid = cb.value;
    await updateDoc(doc(db, 'users', workerUid), { assignedFormId: t.id, assignedFormName: t.name, assignedFormVersion: t.version || 1, updatedAt: serverTimestamp() });
    await addDoc(collection(db, 'notifications'), {
      userUid: workerUid,
      title: t.name,
      comment: I18N[currentLang].send_form_sub,
      type: 'form_assign',
      formId: t.id,
      formName: t.name,
      read: false,
      createdAt: serverTimestamp()
    });
   
    const worker = WORKERS_LIST.find(w=>w.uid===workerUid);
    if(worker && worker.personalEmail){
      try{
        await addDoc(collection(db, 'mail'), {
          to: [worker.personalEmail],
          message: {
            subject: `New form assigned: ${t.name}`,
            text: `Hi ${worker.name || ''},\n\n"${t.name}" has been sent to you on GeoSurvey. Open the app and check My Submissions to start collecting.\n\n— GeoSurvey`,
            html: `<p>Hi ${worker.name || ''},</p><p><strong>${t.name}</strong> has been sent to you on GeoSurvey. Open the app to start collecting.</p><p>— GeoSurvey</p>`
          },
          createdAt: serverTimestamp()
        });
      }catch(mailErr){
        // Don't fail the whole assignment over the email copy — the worker
        // still got the in-app notification either way. Just log it so a
        // missing/misconfigured "mail" collection rule doesn't fail silently.
        console.error('Could not queue email copy for', worker.personalEmail, mailErr);
      }
    }
  }));
  const ok = results.filter(r=>r.status==='fulfilled').length;
  const fail = results.length - ok;
  btn.disabled = false;
  if(fail===0){
    document.getElementById('send-form-modal').classList.remove('show');
    showToast(I18N[currentLang].form_sent_count.replace('{n}', ok));
  } else if(ok===0){
    console.error('Failed to send form to any worker:', results);
    errBox.textContent = friendlyFirestoreError(results.find(r=>r.status==='rejected').reason, 'Could not send — check your connection.');
    errBox.style.display = 'block';
  } else {
    console.error('Failed to send form to some workers:', results);
    document.getElementById('send-form-modal').classList.remove('show');
    showToast(I18N[currentLang].form_sent_partial.replace('{ok}', ok).replace('{fail}', fail));
  }
};

function renderQTypePalette(){
  const wrap = document.getElementById('qtype-palette');
  wrap.innerHTML = '';
  QUESTION_TYPES.forEach(qt=>{
    const chip = document.createElement('button');
    chip.className = 'qtype-chip';
    chip.innerHTML = `<span>${qt.icon}</span><span>${I18N[currentLang][qt.key]}</span>`;
    chip.onclick = ()=> addQuestion(qt.type);
    wrap.appendChild(chip);
  });
}

function addQuestion(type){
  const t = currentTemplate();
  if(!t) return;
  const q = {id:newQId(), type, label:'', required:false};
  if(type==='single_choice' || type==='multi_choice') q.options = [{id:newOptId(), label:'Option 1', subOptions:[]}, {id:newOptId(), label:'Option 2', subOptions:[]}];
  t.questions.push(q);
  renderQuestionList();
  renderTemplateList();
  persistTemplate(t, {questions: t.questions});
  setTimeout(()=>{
    const el = document.querySelector(`.q-card[data-qid="${q.id}"] .q-label-input`);
    if(el) el.focus();
  }, 30);
}

function renderQuestionList(){
  const t = currentTemplate();
  const wrap = document.getElementById('question-list');
  wrap.innerHTML = '';
  if(!t || t.questions.length===0){
    wrap.innerHTML = `<div class="q-empty">${I18N[currentLang].no_questions}</div>`;
    return;
  }
  t.questions.forEach((q, idx)=>{
    const meta = qTypeMeta(q.type);
    const card = document.createElement('div');
    card.className = 'q-card';
    card.setAttribute('draggable', 'false');
    card.dataset.qid = q.id;

    let optionsHTML = '';
    if(q.type==='single_choice' || q.type==='multi_choice'){
      normalizeOptions(q);
      optionsHTML = `<div class="q-options">` +
        q.options.map((opt, oi)=>`
          <div class="q-option-row">
            <span style="font-size:12px;opacity:0.4;">${q.type==='single_choice'?'🔘':'☑️'}</span>
            <input type="text" value="${opt.label.replace(/"/g,'&quot;')}" data-oidx="${oi}" class="q-option-input" />
            <button class="q-icon-btn danger q-option-remove" data-oidx="${oi}" style="width:24px;height:24px;font-size:11px;">✕</button>
          </div>
          <div class="q-suboptions" data-oidx="${oi}">
            ${opt.subOptions.map((sub, si)=>`
              <div class="q-suboption-row">
                <span style="font-size:11px;opacity:0.4;">↳</span>
                <input type="text" value="${sub.label.replace(/"/g,'&quot;')}" data-oidx="${oi}" data-sidx="${si}" class="q-suboption-input" />
                <button class="q-icon-btn danger q-suboption-remove" data-oidx="${oi}" data-sidx="${si}" style="width:22px;height:22px;font-size:10px;">✕</button>
              </div>
            `).join('')}
            <button class="q-add-suboption" data-oidx="${oi}">${I18N[currentLang].add_suboption}</button>
          </div>
        `).join('') +
        `<button class="q-add-option">${I18N[currentLang].add_option}</button>` +
      `</div>`;
    }

    let hintHTML = '';
    if(q.type==='photo' || q.type==='audio'){
      hintHTML = `<div class="q-hint">
        <label class="q-hint-label">${I18N[currentLang].hint_label}</label>
        <textarea class="q-hint-input" rows="2" placeholder="${q.type==='photo' ? I18N[currentLang].photo_prompt : I18N[currentLang].mic_prompt}">${(q.hint||'').replace(/</g,'&lt;')}</textarea>
      </div>`;
    }

    card.innerHTML = `
      <div class="q-card-top">
        <div class="q-drag-handle">⠿</div>
        <div class="q-type-badge">${meta.icon} ${I18N[currentLang][meta.key]}</div>
        <div class="q-main">
          <input type="text" class="q-label-input" placeholder="${I18N[currentLang].untitled_question}" value="${(q.label||'').replace(/"/g,'&quot;')}" />
        </div>
        <div class="q-actions">
          <label class="q-required-toggle"><input type="checkbox" class="q-required-cb" ${q.required?'checked':''} />${I18N[currentLang].required}</label>
          <button class="q-icon-btn" data-act="up" title="Move up">↑</button>
          <button class="q-icon-btn" data-act="down" title="Move down">↓</button>
          <button class="q-icon-btn danger" data-act="delete" title="Delete">🗑</button>
        </div>
      </div>
      ${optionsHTML}
      ${hintHTML}
    `;

    // The card needs to be draggable so it can be reordered by its ⠿
    // handle, but leaving `draggable="true"` on all the time is what causes
    // the bug: Chromium (Chrome/Edge) resolves the drag source by walking
    // up from wherever the mousedown happened, and a click-and-drag inside
    // a nested text field can still get resolved to this ancestor card
    // instead of starting a native text selection — even if the field
    // itself is marked draggable="false". Rather than trying to opt every
    // descendant out of that lookup, only arm the card as draggable for as
    // long as the mouse/touch is actually held down on the handle, and
    // disarm it again as soon as the press ends (whether that turns into a
    // drag or just a click). With the card non-draggable the rest of the
    // time, there's nothing for the browser to resolve a text-field
    // mousedown to, so normal selection, double-click, and Ctrl+A all work.
    const dragHandle = card.querySelector('.q-drag-handle');
    const armDrag = ()=> card.setAttribute('draggable', 'true');
    const disarmDrag = ()=> card.setAttribute('draggable', 'false');
    dragHandle.addEventListener('mousedown', armDrag);
    dragHandle.addEventListener('touchstart', armDrag, {passive:true});
    dragHandle.addEventListener('mouseup', disarmDrag);
    dragHandle.addEventListener('touchend', disarmDrag);

    card.querySelector('.q-label-input').addEventListener('input', (e)=>{
      q.label = e.target.value;
      debouncedPersistTemplate(t, {questions: t.questions}, 'qlabel-'+q.id);
    });
    card.querySelector('.q-required-cb').addEventListener('change', (e)=>{
      q.required = e.target.checked;
      persistTemplate(t, {questions: t.questions});
    });
    if(q.type==='photo' || q.type==='audio'){
      card.querySelector('.q-hint-input').addEventListener('input', (e)=>{
        q.hint = e.target.value;
        debouncedPersistTemplate(t, {questions: t.questions}, 'qhint-'+q.id);
      });
    }
    card.querySelector('[data-act="delete"]').onclick = ()=>{
      t.questions = t.questions.filter(x=>x.id!==q.id);
      renderQuestionList(); renderTemplateList();
      persistTemplate(t, {questions: t.questions});
    };
    card.querySelector('[data-act="up"]').onclick = ()=>{
      if(idx>0){
        [t.questions[idx-1], t.questions[idx]] = [t.questions[idx], t.questions[idx-1]];
        renderQuestionList();
        persistTemplate(t, {questions: t.questions});
      }
    };
    card.querySelector('[data-act="down"]').onclick = ()=>{
      if(idx<t.questions.length-1){
        [t.questions[idx+1], t.questions[idx]] = [t.questions[idx], t.questions[idx+1]];
        renderQuestionList();
        persistTemplate(t, {questions: t.questions});
      }
    };

    if(q.type==='single_choice' || q.type==='multi_choice'){
      card.querySelectorAll('.q-option-input').forEach(inp=>{
        inp.addEventListener('input', (e)=>{
          q.options[+e.target.dataset.oidx].label = e.target.value;
          debouncedPersistTemplate(t, {questions: t.questions}, 'qopt-'+q.id+'-'+e.target.dataset.oidx);
        });
      });
      card.querySelectorAll('.q-option-remove').forEach(btn=>{
        btn.onclick = ()=>{
          q.options.splice(+btn.dataset.oidx, 1);
          renderQuestionList();
          persistTemplate(t, {questions: t.questions});
        };
      });
      const addOptBtn = card.querySelector('.q-add-option');
      if(addOptBtn) addOptBtn.onclick = ()=>{
        q.options.push({id:newOptId(), label:`Option ${q.options.length+1}`, subOptions:[]});
        renderQuestionList();
        persistTemplate(t, {questions: t.questions});
      };
      card.querySelectorAll('.q-suboption-input').forEach(inp=>{
        inp.addEventListener('input', (e)=>{
          q.options[+e.target.dataset.oidx].subOptions[+e.target.dataset.sidx].label = e.target.value;
          debouncedPersistTemplate(t, {questions: t.questions}, 'qsub-'+q.id+'-'+e.target.dataset.oidx+'-'+e.target.dataset.sidx);
        });
      });
      card.querySelectorAll('.q-suboption-remove').forEach(btn=>{
        btn.onclick = ()=>{
          q.options[+btn.dataset.oidx].subOptions.splice(+btn.dataset.sidx, 1);
          renderQuestionList();
          persistTemplate(t, {questions: t.questions});
        };
      });
      card.querySelectorAll('.q-add-suboption').forEach(btn=>{
        btn.onclick = ()=>{
          const opt = q.options[+btn.dataset.oidx];
          opt.subOptions.push({id:newOptId(), label:`Sub-choice ${opt.subOptions.length+1}`});
          renderQuestionList();
          persistTemplate(t, {questions: t.questions});
        };
      });
    }

    // drag & drop reorder
    card.addEventListener('dragstart', ()=>{ draggedQId = q.id; card.classList.add('dragging'); });
    card.addEventListener('dragend', ()=>{ card.classList.remove('dragging'); draggedQId = null; disarmDrag(); });
    card.addEventListener('dragover', (e)=>{ e.preventDefault(); });
    card.addEventListener('drop', (e)=>{
      e.preventDefault();
      if(!draggedQId || draggedQId===q.id) return;
      const from = t.questions.findIndex(x=>x.id===draggedQId);
      const to = t.questions.findIndex(x=>x.id===q.id);
      const [moved] = t.questions.splice(from,1);
      t.questions.splice(to,0,moved);
      renderQuestionList();
      persistTemplate(t, {questions: t.questions});
    });

    wrap.appendChild(card);
  });
}

/* ---------------- Account settings ---------------- */
function showAcctMsg(text, type){
  const el = document.getElementById('acct-msg');
  el.textContent = text;
  el.style.display = 'block';
  if(type==='error'){
    el.style.background = 'rgba(180,67,47,0.1)';
    el.style.color = 'var(--red)';
    el.style.border = '1px solid rgba(180,67,47,0.3)';
  } else {
    el.style.background = 'rgba(107,122,63,0.12)';
    el.style.color = 'var(--olive)';
    el.style.border = '1px solid rgba(107,122,63,0.3)';
  }
}
function renderAccountView(){
  document.getElementById('acct-email').value = currentUser.email;
  document.getElementById('acct-current-pass').value = '';
  document.getElementById('acct-new-pass').value = '';
  document.getElementById('acct-confirm-pass').value = '';
  document.getElementById('acct-msg').style.display = 'none';
  // Only workers get form-assignment notifications, so the extra
  // "also email me" address is only relevant — and only shown — for them.
  const isWorker = currentUser.role === 'worker';
  document.getElementById('acct-notify-email-wrap').style.display = isWorker ? 'block' : 'none';
  document.getElementById('acct-notify-email').value = currentUser.personalEmail || '';
  updatePushButtonUI();
}
document.getElementById('acct-save-btn').onclick = async ()=>{
  const newEmail = document.getElementById('acct-email').value.trim().toLowerCase();
  const currentPass = document.getElementById('acct-current-pass').value;
  const newPass = document.getElementById('acct-new-pass').value;
  const confirmPass = document.getElementById('acct-confirm-pass').value;
  const isWorker = currentUser.role === 'worker';
  const notifyEmail = isWorker ? document.getElementById('acct-notify-email').value.trim().toLowerCase() : '';
  const btn = document.getElementById('acct-save-btn');

  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if(!emailPattern.test(newEmail)){
    showAcctMsg(I18N[currentLang].err_email_invalid, 'error'); return;
  }
  if(notifyEmail && !emailPattern.test(notifyEmail)){
    showAcctMsg(I18N[currentLang].err_email_invalid, 'error'); return;
  }
  if((newPass || confirmPass) && newPass !== confirmPass){
    showAcctMsg(I18N[currentLang].err_pass_mismatch, 'error'); return;
  }
  if(newPass && newPass.length < 6){
    showAcctMsg('New password needs to be at least 6 characters.', 'error'); return;
  }

  // Changing the sign-in email or password needs a fresh re-auth (Firebase
  // requirement); the notify-only email is a plain Firestore field and
  // doesn't touch auth at all, so don't force a password re-entry just to
  // save that.
  const emailChanged = newEmail !== currentUser.email;
  const notifyChanged = notifyEmail !== (currentUser.personalEmail || '');
  const touchesAuth = emailChanged || !!newPass;
  if(touchesAuth && !currentPass){
    showAcctMsg(I18N[currentLang].err_current_pass_required, 'error'); return;
  }

  btn.disabled = true;
  try{
    if(touchesAuth){
      // Firebase requires a recent sign-in before letting you change email or
      // password — re-supplying the current password proves it's really them.
      const cred = EmailAuthProvider.credential(auth.currentUser.email, currentPass);
      await reauthenticateWithCredential(auth.currentUser, cred);
    }

    const userDocUpdates = {};
    if(emailChanged){
      await updateEmail(auth.currentUser, newEmail);
      userDocUpdates.email = newEmail;
    }
    if(notifyChanged) userDocUpdates.personalEmail = notifyEmail || null;
    if(Object.keys(userDocUpdates).length){
      userDocUpdates.updatedAt = serverTimestamp();
      await updateDoc(doc(db, 'users', currentUser.uid), userDocUpdates);
      if(emailChanged) currentUser.email = newEmail;
      if(notifyChanged) currentUser.personalEmail = notifyEmail || null;
    }
    if(newPass){
      await updatePassword(auth.currentUser, newPass);
    }
    document.getElementById('acct-current-pass').value = '';
    document.getElementById('acct-new-pass').value = '';
    document.getElementById('acct-confirm-pass').value = '';
    showAcctMsg(I18N[currentLang].acct_saved, 'success');
    showToast(I18N[currentLang].acct_saved);
  }catch(err){
    console.error(err);
    if(err.code === 'auth/wrong-password' || err.code === 'auth/invalid-credential'){
      showAcctMsg(I18N[currentLang].err_wrong_pass, 'error');
    } else if(err.code === 'auth/email-already-in-use'){
      showAcctMsg(I18N[currentLang].err_email_taken, 'error');
    } else {
      showAcctMsg(err.message || 'Something went wrong.', 'error');
    }
  }
  btn.disabled = false;
};

/* ---------------- Push notifications (Firebase Cloud Messaging) ----------------
   In-app notifications (subscribeNotifications/renderNotifDropdown above) only
   reach someone who already has this tab open. This section adds real push:
   a browser permission prompt, an FCM registration token stored on the
   user's profile, and a foreground handler — the background case is handled
   by sw.js's onBackgroundMessage. Actually *delivering* a push when the
   app is fully closed still requires a server-side send (Firestore can't
   push to a device by itself); see functions/index.js for the Cloud
   Function that watches the "notifications" collection and sends it. */
let messaging = null;
let messagingSupported = false;
let messagingReady = (async ()=>{
  try{
    messagingSupported = await isMessagingSupported();
    if(messagingSupported){
      messaging = getMessaging(firebaseApp);
      // Same reasoning as window.getToken above: `messaging` is a
      // module-scoped `let`, so window.messaging stays undefined for
      // the console until we assign it here, right after it's created.
      window.messaging = messaging;
      // Foreground push (app open in this tab right now) — surface it the
      // same way an in-app notification would, since subscribeNotifications'
      // onSnapshot will also pick up the underlying Firestore doc shortly.
      onMessage(messaging, (payload)=>{
        const data = payload.data || {};
        const title = (payload.notification && payload.notification.title) || data.title || 'GeoSurvey';
        const body = (payload.notification && payload.notification.body) || data.comment || '';
        showToast(`${title} — ${body}`, 5000);
      });
    }
  }catch(err){
    console.warn('FCM not supported in this browser:', err);
  }
  return messagingSupported;
})();

function pushNotifText(key, fallback){
  return (I18N[currentLang] && I18N[currentLang][key]) || fallback;
}

function updatePushButtonUI(){
  const btn = document.getElementById('push-notif-btn');
  const status = document.getElementById('push-notif-status');
  if(!btn || !status) return;
  if(!messagingSupported || typeof Notification === 'undefined'){
    btn.disabled = true;
    btn.textContent = pushNotifText('push_not_supported', 'Not supported');
    status.textContent = pushNotifText('push_not_supported_sub', "This browser doesn't support push notifications.");
    return;
  }
  btn.disabled = false;
  const perm = Notification.permission;
  const hasToken = !!(currentUser && Array.isArray(currentUser.fcmTokens) && currentUser.fcmTokens.length);
  if(perm === 'granted' && hasToken){
    btn.textContent = pushNotifText('disable', 'Disable');
    status.textContent = pushNotifText('push_notif_on', "You'll get notified on this device, even when the app is closed.");
  } else if(perm === 'denied'){
    btn.textContent = pushNotifText('blocked', 'Blocked');
    btn.disabled = true;
    status.textContent = pushNotifText('push_notif_blocked', 'Notifications are blocked for this site in your browser settings.');
  } else {
    btn.textContent = pushNotifText('enable', 'Enable');
    status.textContent = pushNotifText('push_notif_sub', 'Get notified on this device, even when the app is closed.');
  }
}

async function enablePush(){
  await messagingReady;
  if(!messagingSupported || !messaging) return;
  const reg = await swRegistrationReady;
  if(!reg){ showToast('Could not register the service worker needed for push.'); return; }
  const perm = await Notification.requestPermission();
  if(perm !== 'granted'){ updatePushButtonUI(); return; }
  try{
    const token = await getToken(messaging, { vapidKey: VAPID_KEY, serviceWorkerRegistration: reg });
    if(!token) throw new Error('No registration token returned');
    await updateDoc(doc(db, 'users', currentUser.uid), { fcmTokens: arrayUnion(token) });
    currentUser.fcmTokens = Array.from(new Set([...(currentUser.fcmTokens||[]), token]));
    showToast(pushNotifText('push_enabled', 'Push notifications enabled on this device'));
  }catch(err){
    console.error('Could not enable push notifications:', err);
    showToast(pushNotifText('push_enable_failed', 'Could not enable push notifications — check your connection and try again'));
  }
  updatePushButtonUI();
}

async function disablePush(){
  await messagingReady;
  if(!messagingSupported || !messaging) return;
  try{
    const reg = await swRegistrationReady;
    const token = reg ? await getToken(messaging, { vapidKey: VAPID_KEY, serviceWorkerRegistration: reg }).catch(()=>null) : null;
    if(token){
      await updateDoc(doc(db, 'users', currentUser.uid), { fcmTokens: arrayRemove(token) });
      currentUser.fcmTokens = (currentUser.fcmTokens||[]).filter(t=>t!==token);
      await deleteToken(messaging).catch(()=>{});
    }
    showToast(pushNotifText('push_disabled', 'Push notifications disabled on this device'));
  }catch(err){
    console.error('Could not disable push notifications:', err);
  }
  updatePushButtonUI();
}

document.getElementById('push-notif-btn').onclick = ()=>{
  const perm = typeof Notification !== 'undefined' ? Notification.permission : 'denied';
  const hasToken = !!(currentUser && Array.isArray(currentUser.fcmTokens) && currentUser.fcmTokens.length);
  if(perm === 'granted' && hasToken) disablePush(); else enablePush();
};

// Called from enterApp() once currentUser is known — silently keeps the
// stored token fresh if permission was already granted in an earlier
// session, without re-prompting.
async function initPushOnLogin(){
  await messagingReady;
  updatePushButtonUI();
  if(!messagingSupported || typeof Notification === 'undefined') return;
  if(Notification.permission === 'granted'){
    const reg = await swRegistrationReady;
    if(!reg || !messaging) return;
    try{
      const token = await getToken(messaging, { vapidKey: VAPID_KEY, serviceWorkerRegistration: reg });
      if(token && !(currentUser.fcmTokens||[]).includes(token)){
        await updateDoc(doc(db, 'users', currentUser.uid), { fcmTokens: arrayUnion(token) });
        currentUser.fcmTokens = [...(currentUser.fcmTokens||[]), token];
      }
    }catch(err){
      console.warn('Could not refresh push token:', err);
    }
  }
  updatePushButtonUI();
}

// Shared by the FCM background-click handler (sw.js postMessage) and any
// future ?openForm=/?openSubmission= deep link on cold start.
function handleNotificationNavigation(data){
  if(!data) return;
  if(data.formId) openFormPreview(data.formId, data.formName);
  else if(data.submissionId) openSubmissionFromNotif(data.submissionId);
}
(function handleColdStartDeepLink(){
  const params = new URLSearchParams(window.location.search);
  const formId = params.get('openForm');
  const submissionId = params.get('openSubmission');
  if(!formId && !submissionId) return;
  const tryNav = ()=>{
    if(!currentUser) return;
    handleNotificationNavigation({ formId, submissionId });
    history.replaceState(null, '', window.location.pathname);
  };
  if(currentUser) tryNav();
  else document.addEventListener('geosurvey:entered-app', tryNav, { once:true });
})();

let toastTimeout;
function showToast(msg, ms){
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.style.display='block';
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(()=>{ t.style.display='none'; }, ms || 3200);
}