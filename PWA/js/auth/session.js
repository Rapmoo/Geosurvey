/* ===================================================================
   auth/session.js
   ---------------------------------------------------------------
   The single place onAuthStateChanged is wired up. Firebase's own
   guidance (and this app's security model) is that onAuthStateChanged
   is the one source of truth for "is anyone signed in right now" — not
   a locally-cached flag, not whether a login form was submitted this
   page-load. Every auth transition the app cares about (session
   restored on reopen, fresh sign-in, sign-out) flows through here.

   IMPORTANT: this module deliberately knows nothing about Firestore
   profiles, roles, or which app view to show. That logic (reading
   users/{uid}, checking active/role, calling the app's enterApp() /
   exitApp()) stays in index.html, passed in as the onChange callback —
   because "is this Firebase Auth session valid" and "is this account
   currently allowed to use GeoSurvey, and as what role" are two
   different questions. The second one is re-answered from Firestore
   every single time this fires (see index.html), never trusted from a
   cached object here — that's what stops a demoted/disabled account
   from keeping access just because its local session is still valid.

   DEBUG: temporary console logging has been added throughout this
   module (tagged "[auth]") to trace initialization order, persistence
   timing, and state changes. Remove once the upload race is confirmed
   fixed.
   =================================================================== */
import { auth, onAuthStateChanged, authPersistenceReady } from './firebaseAuth.js';

console.log('[auth] session.js module evaluated — import.meta.url:', import.meta.url);

let currentFirebaseUser = null;
let firstStateResolved = false;
let resolveAuthReady;
const authReady = new Promise((resolve) => { resolveAuthReady = resolve; });

// Tracks whether initializeAuth() has already been called. If some
// other code path (a duplicate import, a second <script>, a service
// worker) calls this a second time, that's a strong signal of the
// "two module instances" failure mode described above — surface it
// loudly instead of silently attaching a second listener.
let initializeAuthCalled = false;

/**
 * initializeAuth(onChange)
 * Waits for browserLocalPersistence to be applied, then attaches the
 * app's one-and-only onAuthStateChanged listener. `onChange(user)` is
 * called with the Firebase Auth user (or null) on the initial session
 * check AND on every subsequent sign-in/sign-out — exactly what
 * index.html's existing handler already expects, so it can be dropped
 * in unchanged as this function's argument.
 *
 * Waiting for authPersistenceReady first (rather than firing
 * onAuthStateChanged immediately) is what guarantees a session being
 * restored from local storage is checked under the right persistence
 * mode, instead of potentially first evaluating against a default that
 * gets swapped out a moment later.
 */
export async function initializeAuth(onChange){
  if (initializeAuthCalled) {
    console.warn('[auth] initializeAuth() called more than once — this usually means ' +
      'session.js was imported via two different paths (duplicate module instance) ' +
      'or index.html wired it up twice. Only the first listener will drive currentFirebaseUser.');
  }
  initializeAuthCalled = true;

  console.log('[auth] initializeAuth() called, waiting on authPersistenceReady...');
  await authPersistenceReady;
  console.log('[auth] persistence confirmed ready, attaching onAuthStateChanged listener');

  onAuthStateChanged(auth, (user)=>{
    console.log('[auth] onAuthStateChanged fired. uid =', user ? user.uid : null);
    currentFirebaseUser = user;
    if(!firstStateResolved){
      firstStateResolved = true;
      console.log('[auth] first auth state resolved, authReady promise settling with uid =', user ? user.uid : null);
      resolveAuthReady(user);
    }
    onChange(user);
  });
}

/**
 * Resolves once the very first auth-state check has completed (session
 * restored from local storage, or confirmed nobody is signed in). Useful
 * for anything that must not run before that initial check settles —
 * the app's own spinner-until-resolved pattern in index.html already
 * does this via the onChange callback itself, so this is mainly exposed
 * for any future caller that needs it independently.
 *
 * ANY code that calls getCurrentUser() outside of the onChange callback
 * — including fileStorageClient.js and the upload queue — MUST await
 * this first. Calling getCurrentUser() before this resolves is not a
 * bug in this module, it's a legitimate "we don't know yet" state; the
 * bug is in whichever caller doesn't wait for it.
 */
export function whenAuthReady(){
  return authReady;
}

/**
 * getCurrentUser()
 * The raw Firebase Auth user object (or null) — uid/email/etc. This is
 * NOT the app's role-aware profile object (that one lives in index.html
 * as `currentUser`, populated from Firestore). Anything that needs to
 * know "is this person an admin/supervisor/worker" must go through the
 * Firestore-backed profile, never through this function alone — Auth
 * only proves who someone is, not what they're allowed to do.
 */
export function getCurrentUser(){
  console.log('[auth] getCurrentUser() called ->', currentFirebaseUser ? currentFirebaseUser.uid : null,
    firstStateResolved ? '' : '(WARNING: called before first auth state resolved)');
  return currentFirebaseUser;
}

/**
 * getCurrentUserAsync()
 * Convenience for callers (upload queue, fileStorageClient) that would
 * otherwise call getCurrentUser() blindly on startup and fail during
 * the legitimate pre-restoration window. Waits for the first auth
 * state check to resolve, then returns whatever user is (or isn't)
 * signed in at that point. Does NOT wait for a user to exist — a
 * resolved "null" (nobody signed in) is a valid, final answer.
 */
export async function getCurrentUserAsync(){
  await authReady;
  return getCurrentUser();
}
