/* ===================================================================
   auth/uploadQueue.js
   ---------------------------------------------------------------
   Handles the "PWA is offline, or the upload drops mid-flight" case
   for photo/audio/document uploads to the backend file storage API
   (fileStorageClient.js). A submission's TEXT/GPS answers already have
   an offline story (Firestore's own cache, or the app's drafts
   fallback for a fully-offline submit) — this module is specifically
   for the media bytes, which fileStorageClient.js sends over a plain
   authenticated HTTP request that has no offline queue of its own.

   Design:
     - Every queued item is persisted to IndexedDB (NOT
       localStorage/sessionStorage — those can't hold Blobs and have
       much smaller quotas), so a queued upload survives the tab being
       closed or the app crashing before connectivity returns.
     - enqueue() is called whenever a call to fileStorageClient's
       uploadPhoto/uploadAudio/uploadDocument throws — whether that's
       because navigator.onLine is false, or because the request
       itself failed mid-flight (dropped connection, timeout, 5xx).
     - flush() walks every queued item and retries it. Triggered
       automatically on:
         (a) the browser's 'online' event,
         (b) a periodic timer while online (catches the case where the
             browser fires no 'online' event but connectivity is back,
             e.g. flaky captive portals),
         (c) once, right after enqueue(), in case the caller is
             actually online and this was a one-off transient failure.
     - Exponential backoff per item (capped) so a permanently-broken
       item (e.g. backend rejected it with a 4xx that will never
       succeed) doesn't hammer the network forever — attempts beyond
       MAX_ATTEMPTS are kept queued but no longer auto-retried; only
       flush({ force: true }) (e.g. a manual "Retry" button) tries them
       again.
     - subscribe(callback) lets the UI show "N uploads pending" and
       react to per-item success/failure without polling.

   This module otherwise avoids knowing about Firestore or submission
   documents — that would couple it to this specific app's schema.
   Instead, each enqueued item carries an opaque `onSuccessMeta` object,
   and the caller registers a single onUploadSuccess(item, record)
   callback via configure() to do whatever app-specific thing needs to
   happen next (e.g. writing record.fileId onto submissions/{docId}.photoUrl).
   The one deliberate exception is backfillMissingFormId() below, which
   reads submissions/{surveyId}.formId — narrowly, read-only, and only
   to self-heal items enqueued by a build that predated formId being
   mandatory. See that function's comment for why.
   =================================================================== */
import { uploadPhoto, uploadAudio, uploadDocument } from './fileStorageClient.js';
// DEBUG: session.js already gates individual getIdToken() calls on the
// first auth check (see fileStorageClient.js), but flush() itself is
// called at module-load time (see the bottom of this file) — before
// initializeAuth() has even been invoked in index.html. Without this,
// a queued item present at startup gets its FIRST attempt (and its
// resulting backoff) spent purely on "auth hasn't finished restoring
// yet," not on any real failure. Waiting here means flush() doesn't
// touch the network — or count an attempt — until that first check has
// settled, regardless of which of the three auto-triggers below fired.
import { whenAuthReady, getCurrentUser } from './session.js';
// Recovery path for items enqueued by a build that predates formId
// being a required field on queue items (enqueue() below now throws
// without one, but that check can't retroactively fix items already
// sitting in IndexedDB from before it existed). See backfillMissingFormId().
import { firebaseApp } from './firebaseAuth.js';
import { getFirestore, doc, getDoc } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js';

const DB_NAME = 'geosurvey-upload-queue';
const DB_VERSION = 1;
const STORE = 'pendingUploads';

const MAX_ATTEMPTS = 8;
const BASE_BACKOFF_MS = 15_000;     // 15s, 30s, 60s, ... capped below
const MAX_BACKOFF_MS = 10 * 60_000; // 10 min ceiling
const PERIODIC_FLUSH_MS = 30_000;   // safety net alongside the 'online' event

const UPLOADERS = { photo: uploadPhoto, audio: uploadAudio, document: uploadDocument };

let dbPromise = null;
let onUploadSuccess = null;   // (item, record) => Promise|void
let onUploadPermanentFail = null; // (item, error) => void — after MAX_ATTEMPTS
const subscribers = new Set();
let flushing = false;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function withStore(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const store = tx.objectStore(STORE);
    const result = fn(store);
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
  });
}

function notify() {
  getAll().then((items) => subscribers.forEach((cb) => cb(items)));
}

/**
 * configure({ onUploadSuccess, onUploadPermanentFail })
 * Must be called once during app startup, before anything enqueues.
 */
function configure({ onUploadSuccess: success, onUploadPermanentFail: permanentFail } = {}) {
  onUploadSuccess = success || null;
  onUploadPermanentFail = permanentFail || null;
}

/**
 * enqueue({ kind, blob, surveyId, formId, meta })
 * kind: 'photo' | 'audio' | 'document'
 * blob: the File/Blob to upload (stored as-is in IndexedDB)
 * surveyId: passed straight through to fileStorageClient
 * formId: passed straight through to fileStorageClient — required for
 *       the same reason surveyId already is: the backend uses it to
 *       resolve which form's storage folder this file belongs in (see
 *       formFolderService.js on the backend), and rejects a request
 *       missing it. Persisted on the item so a retry hours or days
 *       later (after an app restart, even) still carries it — without
 *       this, a queued item created before the form-folder change
 *       would retry forever with no formId and never succeed.
 * meta: opaque, app-defined — handed back to onUploadSuccess so the
 *       caller knows which submission/field this upload belongs to.
 * Returns the queue item's id.
 */
async function enqueue({ kind, blob, surveyId, formId, meta }) {
  if (!UPLOADERS[kind]) throw new Error(`Unknown upload kind: ${kind}`);
  if (!formId) throw new Error('formId is required to enqueue an upload.');
  const item = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    kind, blob, surveyId, formId, meta,
    attempts: 0,
    lastError: null,
    createdAt: Date.now(),
    nextAttemptAt: Date.now(), // eligible immediately
  };
  await withStore('readwrite', (store) => store.put(item));
  notify();
  // Try right away in case this is actually a transient, already-online
  // failure rather than a genuine offline gap.
  flush().catch(() => { /* flush() already logs; don't let this reject silently break callers */ });
  return item.id;
}

async function getAll() {
  return withStore('readonly', (store) => new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

async function remove(id) {
  await withStore('readwrite', (store) => store.delete(id));
  notify();
}

async function update(item) {
  await withStore('readwrite', (store) => store.put(item));
  notify();
}

function backoffFor(attempts) {
  return Math.min(BASE_BACKOFF_MS * 2 ** (attempts - 1), MAX_BACKOFF_MS);
}

let _db = null;
function getDb() {
  // index.html already calls initializeFirestore(firebaseApp, {...})
  // with this app's persistent-cache config before this module's
  // flush() can ever run (it happens synchronously at module load,
  // long before whenAuthReady() resolves). getFirestore() on an app
  // that's already had initializeFirestore() called on it just returns
  // that same instance rather than creating a second one, so this is
  // safe to call lazily here without duplicating that config.
  if (!_db) _db = getFirestore(firebaseApp);
  return _db;
}

/**
 * Recovers formId for a queued item that predates formId being
 * mandatory (see enqueue()'s guard, and the DEBUG comment on
 * `formId` in its jsdoc above). Such items can never succeed as-is —
 * the backend needs formId to resolve the form's storage folder — but
 * item.surveyId is the submissions/{docId} this upload belongs to,
 * and every submission carries its own formId. One Firestore read
 * recovers it; from then on the item behaves like any other queued
 * item. Returns true if formId was recovered and patched onto `item`
 * (caller is responsible for persisting it), false if it couldn't be
 * (submission missing, deleted, or itself predates formId).
 */
async function backfillMissingFormId(item) {
  try {
    const subSnap = await getDoc(doc(getDb(), 'submissions', item.surveyId));
    const recoveredFormId = subSnap.exists() && subSnap.data().formId;
    if (recoveredFormId) {
      item.formId = recoveredFormId;
      console.log(`[uploadQueue] backfilled missing formId (${recoveredFormId}) for legacy queued item ${item.id}`);
      return true;
    }
  } catch (err) {
    console.warn(`[uploadQueue] formId backfill lookup failed for item ${item.id}:`, err);
  }
  return false;
}

/**
 * flush({ force })
 * Attempts every due item in the queue, one at a time (deliberately
 * serial, not parallel — on a weak/limited mobile connection, racing
 * several large photo/audio uploads at once is more likely to make all
 * of them time out than to finish any of them sooner).
 */
async function flush({ force = false } = {}) {
  if (flushing) return; // avoid overlapping runs from timer + 'online' + enqueue firing together
  if (!navigator.onLine) return;
  flushing = true;
  try {
    // Wait for Firebase's first auth-state check to settle before doing
    // anything else. This is a one-time wait per page load (the promise
    // is already resolved for every flush() call after the first), so
    // it costs nothing once the app is up — it only matters for the
    // handful of flush() calls that can legitimately fire before that
    // check has completed (enqueue()'s post-write flush, the 'online'
    // event, or the periodic timer, any of which could in principle
    // fire during the brief startup window before auth resolves).
    // Deliberately awaited BEFORE reading the queue/looping items, so
    // no item's `attempts`/backoff is spent on this race.
    console.log('[uploadQueue] flush() waiting for first auth-state check to resolve...');
    await whenAuthReady();

    // whenAuthReady() only guarantees the FIRST auth-state check has
    // settled — it does NOT guarantee anyone is actually signed in.
    // A resolved-but-null state (device opened while logged out, or
    // between sign-out and the next sign-in) is a legitimate outcome.
    // Proceeding past this point with no user would mean every queued
    // item's uploader() call goes on to call getIdToken(), which itself
    // has to reject on a null user (see fileStorageClient.js) — and
    // that rejection would then be treated as a real failed upload
    // attempt (consuming one of MAX_ATTEMPTS and setting backoff) even
    // though no actual upload was ever attempted. So: never call
    // getIdToken() (via uploader()) while there's no current user —
    // bail out here, before touching a single item. resumeAfterAuthChange()
    // (wired up in index.html's initializeAuth callback) is what
    // re-triggers a real flush the moment someone actually signs in.
    const user = getCurrentUser();
    if (!user) {
      console.log('[uploadQueue] flush(): auth state resolved with no signed-in user — skipping this flush, no items touched.');
      return;
    }
    console.log('[uploadQueue] auth state resolved with signed-in user', user.uid, '— proceeding with flush');

    const items = await getAll();
    console.log(`[uploadQueue] flush(): ${items.length} item(s) in queue`);
    const now = Date.now();
    for (const item of items) {
      if (!force && item.nextAttemptAt > now) continue;
      if (!force && item.attempts >= MAX_ATTEMPTS) continue; // needs an explicit manual retry now

      if (!item.formId) {
        // Legacy item from before formId was required — see
        // backfillMissingFormId() above. Recover it here rather than
        // ever handing `undefined` to the uploader, which would just
        // fail against the backend every time.
        const recovered = await backfillMissingFormId(item);
        if (!recovered) {
          // Nothing to recover from (submission missing/deleted, or
          // itself predates formId) — this item can never succeed on
          // its own. Jump straight to MAX_ATTEMPTS instead of quietly
          // re-querying Firestore every flush cycle forever; only a
          // manual force-retry (after a real data fix) will try again.
          item.attempts = MAX_ATTEMPTS;
          item.lastError = 'Missing formId and it could not be recovered from the submission.';
          await update(item);
          if (onUploadPermanentFail) onUploadPermanentFail(item, new Error(item.lastError));
          continue;
        }
        await update(item); // persist the recovered formId before attempting the upload below
      }

      try {
        console.log(`[uploadQueue] attempting queued ${item.kind} upload (id=${item.id}, attempt ${item.attempts + 1})`);
        const uploader = UPLOADERS[item.kind];
        const record = await uploader(item.blob, item.surveyId, item.formId);
        await remove(item.id);
        console.log(`[uploadQueue] queued ${item.kind} upload succeeded (id=${item.id})`);
        if (onUploadSuccess) await onUploadSuccess(item, record);
      } catch (err) {
        item.attempts += 1;
        item.lastError = err && err.message;
        item.nextAttemptAt = Date.now() + backoffFor(item.attempts);
        await update(item);
        if (item.attempts >= MAX_ATTEMPTS && onUploadPermanentFail) {
          onUploadPermanentFail(item, err);
        }
        console.warn(`[uploadQueue] retry ${item.attempts}/${MAX_ATTEMPTS} failed for queued ${item.kind} upload:`, err);
      }
    }
  } finally {
    flushing = false;
  }
}

function subscribe(callback) {
  subscribers.add(callback);
  getAll().then(callback); // fire once immediately with current state
  return () => subscribers.delete(callback);
}

async function pendingCount() {
  return (await getAll()).length;
}

// ---- Automatic retry triggers ----
console.log('[uploadQueue] upload queue module initialized');
window.addEventListener('online', () => { console.log('[uploadQueue] online event — triggering flush()'); flush(); });
setInterval(() => flush(), PERIODIC_FLUSH_MS);
// NOTE: there is deliberately no separate "try once at startup" flush()
// call here anymore. That used to fire unconditionally based on
// navigator.onLine alone, with no regard for auth state — so on a
// normal startup it ran essentially simultaneously with
// resumeAfterAuthChange() below (wired up in index.html's
// initializeAuth callback, which also fires on the very first auth
// resolution). Two flush() calls racing at startup for the same
// underlying event ("we now know the auth state and might be online")
// is exactly the duplicate this module should avoid — the flushing
// guard stopped them from overlapping, but the second call was still a
// wasted, confusing no-op. resumeAfterAuthChange() alone now covers
// "app opened, leftover queued items, connectivity/auth both ready" —
// and it does so more correctly, since (per the fix above) flush()
// itself now refuses to do anything until a real user is present.

// resumeAfterAuthChange()
// Call this whenever the app's auth state actually changes to a signed-
// in user — both the initial session restore AND a fresh interactive
// login. Exported separately from flush() (rather than relying solely
// on the 'online'/periodic triggers) because those don't fire on "the
// user just logged in on a device that was already online the whole
// time" — without this, a queued item that failed before login would
// otherwise sit for up to PERIODIC_FLUSH_MS before being retried. Wired
// up in index.html's initializeAuth() callback.
function resumeAfterAuthChange() {
  console.log('[uploadQueue] resumeAfterAuthChange() — auth state changed to a signed-in user, triggering flush()');
  return flush();
}

export { configure, enqueue, flush, subscribe, pendingCount, resumeAfterAuthChange };
