/* ===================================================================
   auth/logout.js
   ---------------------------------------------------------------
   The ONLY sanctioned way to end a session by choice. Closing a tab,
   closing the browser, losing connectivity, restarting the device, or a
   background token refresh must never route through here or produce
   the same effect — persistence (firebaseAuth.js) already guarantees
   none of those end the session on their own; this file is just what
   the Logout button itself calls.
   =================================================================== */
import { auth, signOut } from './firebaseAuth.js';

/**
 * logoutUser()
 * Ends the Firebase Auth session. This is what actually revokes local
 * access — after this resolves, the app's onAuthStateChanged handler
 * fires with `user = null`, which is what index.html's own exitApp()
 * responds to by clearing in-memory app state (SUBMISSIONS, WORKERS_LIST,
 * every live Firestore listener, etc.) and returning to the login
 * screen.
 *
 * Deliberately does NOT delete this device's locally-saved offline
 * drafts (geosurvey_drafts_<uid> in localStorage). Two reasons:
 *  1. Those keys are already namespaced per-uid, so a different person
 *     signing in afterward can never see them — the "another user can't
 *     access previous worker data" requirement is satisfied by that
 *     namespacing alone, not by deleting anything.
 *  2. A draft can represent field data that hasn't made it back to
 *     Firestore yet (that's the whole point of drafts — see index.html's
 *     offline-drafts section). Wiping them on logout would mean a
 *     worker who logs out (or gets force-signed-out for any reason)
 *     before reconnecting permanently loses unsynced survey data. That
 *     failure mode is worse than the near-zero risk of same-uid data
 *     being visible only to that same, re-authenticated uid later.
 *
 * Similarly, this does NOT call Firestore's clearIndexedDbPersistence().
 * That cache is already gated document-by-document by Firestore Security
 * Rules — a signed-out client can't read anything from it regardless of
 * what's physically still on disk — and clearing it would also risk
 * discarding any of this worker's writes that queued locally but hadn't
 * finished reaching the server yet.
 */
export async function logoutUser(){
  await signOut(auth);
}
