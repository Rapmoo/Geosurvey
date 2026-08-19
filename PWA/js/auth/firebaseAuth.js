/* ===================================================================
   auth/firebaseAuth.js
   ---------------------------------------------------------------
   Owns the Firebase Auth instance itself and the one setting that makes
   "stay logged in until I explicitly log out" work: persistence mode.

   browserLocalPersistence stores the session in the browser's local
   storage (IndexedDB), scoped to the origin, not to a single tab or
   window. That's what survives closing tabs, closing the browser
   entirely, and reopening the installed PWA later — as opposed to
   browserSessionPersistence (cleared when the tab closes) or
   inMemoryPersistence (cleared on refresh). This is set once, here, as
   soon as the module loads — before any sign-in attempt or
   onAuthStateChanged listener is attached — so a restored session is
   never raced against Firebase's own default persistence behavior.

   Nothing in this file touches Firestore, app state, or UI. It only
   exports the raw Firebase Auth primitives the rest of the app already
   uses (sign-in, sign-out, password/email updates, re-auth) so every
   other module/script keeps working unchanged, just importing from here
   instead of constructing its own Auth instance.
   =================================================================== */
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut,
  createUserWithEmailAndPassword, updatePassword, updateEmail,
  EmailAuthProvider, reauthenticateWithCredential,
  setPersistence, browserLocalPersistence
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";

export const firebaseConfig = {
  apiKey: "AIzaSyAMWfkAfulgOHVpp4Ek913jXs3oAmQQhys",
  authDomain: "geosurvey-update.firebaseapp.com",
  projectId: "geosurvey-update",
  storageBucket: "geosurvey-update.firebasestorage.app",
  messagingSenderId: "329449390220",
  appId: "1:329449390220:web:b8c1f77e4940016054fba9"
};

export const firebaseApp = initializeApp(firebaseConfig);
export const auth = getAuth(firebaseApp);

// Kicked off immediately at module load. Consumers that need to be sure
// persistence is actually in place before relying on session restore
// (see session.js's initializeAuth()) can await this directly instead of
// racing it.
export const authPersistenceReady = setPersistence(auth, browserLocalPersistence).catch((err) => {
  // Falls back to Firebase's own default persistence (still local, on
  // most browsers) rather than throwing — a worker should never be
  // blocked from using the app just because this one call failed (e.g.
  // in a locked-down storage mode). Logged so it's easy to notice during
  // testing on an unusual browser/profile.
  console.warn("Could not set browserLocalPersistence — falling back to Firebase's default persistence:", err.code);
});

// Re-exported so every other script in the app can import Auth's
// building blocks from this one module instead of each constructing its
// own Auth instance (which would silently fragment persistence/session
// state across the app).
export {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut,
  createUserWithEmailAndPassword, updatePassword, updateEmail,
  EmailAuthProvider, reauthenticateWithCredential
};
