/* ===================================================================
   services/formFolderService.js
   ---------------------------------------------------------------
   Owns the permanent, one-time mapping between a form and its
   top-level storage folder. This is the piece that makes "every form
   maps to exactly one folder, forever, and duplicate names become
   (1)/(2)/(3)" an actual guarantee rather than a convention.

   Forms are created directly from the PWA into Firestore
   (addDoc(collection(db,'forms'), ...) — see index.html) — there is no
   backend HTTP route for form creation. So instead of hooking a route,
   this service runs a Firestore listener (Admin SDK) that watches the
   `forms` collection and assigns a folder the instant a new form doc
   appears, entirely from the backend process. routes/upload.js also
   calls the same assignment function defensively before every upload,
   so an upload can never fail just because it happened to race the
   listener (e.g. right after the backend restarted) — the function is
   idempotent, so calling it twice for the same form is always safe
   and never reassigns anything.

   Firestore collections used:

     forms/{formId}
       ...existing fields (name, description, active, questions,
       version, createdBy, createdAt, updatedAt)...
       + storageFolderName   <- written EXACTLY ONCE, by this service.
                                Every later read of this field must be
                                trusted as-is; nothing downstream ever
                                recomputes it from the live `name`.

     formFolderClaims/{folderName}
       Document ID IS the literal, final folder name (e.g.
       "Building Survey (1)"). Existence of this doc means that exact
       folder name is taken. Firestore guarantees at most one client
       can ever successfully `create` a doc at a given ID, so this is
       what makes "never overwrite another form's folder" an atomic
       guarantee instead of a check-then-write race. Never deleted,
       even if the owning form is later deleted — releasing a name
       would let a future form claim a folder that may still hold a
       prior form's historical files.
       Fields: { formId, createdAt }

     formFolderCounters/{baseName}
       One doc per SANITIZED base name (pre-suffix). Tracks the next
       suffix to try, so claiming the Nth form named "Building Survey"
       is a single doc read instead of probing "(1)", "(2)", "(3)"...
       one at a time.
       Fields: { nextSuffix }

   All three writes (claim doc, counter doc, storageFolderName on the
   form doc) happen inside one Firestore transaction, so they either
   all land together or none do — no form can ever end up with a
   folder claim that isn't reflected in its own doc, or vice versa.
   =================================================================== */
const { db, admin } = require('../config/firebaseAdmin');
const fileStorageService = require('./fileStorageService');

const FORMS_COLLECTION = 'forms';
const CLAIMS_COLLECTION = 'formFolderClaims';
const COUNTERS_COLLECTION = 'formFolderCounters';

// Same charset Firestore auto-generated document IDs actually use
// (base62), which is what `formId` always is here — it's the `ref.id`
// from index.html's addDoc(collection(db,'forms'), ...) call. Rejects
// anything else before it's ever used in a Firestore doc path or
// passed to the Admin SDK.
const FORM_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function assertSafeFormId(formId) {
  if (typeof formId !== 'string' || !FORM_ID_PATTERN.test(formId)) {
    const err = new Error('Invalid formId.');
    err.statusCode = 400;
    throw err;
  }
}

/**
 * Idempotently ensures the given form has a permanent storageFolderName,
 * assigning one (and physically creating the directory) if it doesn't
 * already have one. Safe to call multiple times for the same form —
 * every call after the first is a single read that returns the
 * already-assigned value and writes nothing.
 *
 * Returns the folder name (string).
 * Throws if the form doc doesn't exist.
 */
async function assignFolderIfNeeded(formId, formNameHint) {
  assertSafeFormId(formId);
  const formRef = db.collection(FORMS_COLLECTION).doc(formId);

  const folderName = await db.runTransaction(async (tx) => {
    const formSnap = await tx.get(formRef);
    if (!formSnap.exists) {
      const err = new Error(`Form ${formId} does not exist.`);
      err.statusCode = 404;
      throw err;
    }

    // Already assigned — this is the "never rename, never reassign"
    // guarantee. Nothing past this point runs; the transaction reads
    // and returns without writing anything.
    const existing = formSnap.data().storageFolderName;
    if (existing) return existing;

    const rawName = formSnap.data().name || formNameHint || '';
    const base = fileStorageService.sanitizeFormName(rawName);

    const counterRef = db.collection(COUNTERS_COLLECTION).doc(base);
    const counterSnap = await tx.get(counterRef);

    let candidate;
    let nextSuffix;
    if (!counterSnap.exists) {
      // First form ever to sanitize down to this base name — no
      // suffix, matches "Building Survey" with nothing appended.
      candidate = base;
      nextSuffix = 1;
    } else {
      const n = counterSnap.data().nextSuffix || 1;
      candidate = `${base} (${n})`;
      nextSuffix = n + 1;
    }

    const claimRef = db.collection(CLAIMS_COLLECTION).doc(candidate);
    const claimSnap = await tx.get(claimRef);
    if (claimSnap.exists) {
      // Should be unreachable given the counter is the single source
      // of truth for the next suffix, and this function is the only
      // writer of both collections. Left as a hard safety net rather
      // than a silent overwrite — surfaces a data-integrity bug loudly
      // instead of ever letting two forms share a folder.
      const err = new Error(`Storage folder "${candidate}" is already claimed by another form.`);
      err.statusCode = 409;
      throw err;
    }

    tx.set(claimRef, { formId, createdAt: admin.firestore.FieldValue.serverTimestamp() });
    tx.set(counterRef, { nextSuffix }, { merge: true });
    tx.update(formRef, {
      storageFolderName: candidate,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return candidate;
  });

  // Physically create the directory now, at assignment time — not
  // lazily deferred to the first upload. Outside the transaction
  // (filesystem calls can't participate in a Firestore transaction
  // anyway) but safe: ensureFolderExists is idempotent, and the
  // Firestore claim above is what actually prevents two forms from
  // ever being assigned the same folderName in the first place.
  await fileStorageService.ensureFolderExists(folderName);

  return folderName;
}

/**
 * Read-only lookup used by routes/upload.js on every upload. Returns
 * the form's storageFolderName, self-healing (via assignFolderIfNeeded)
 * if the Firestore listener hasn't processed this form yet for any
 * reason — so an upload never fails merely due to a timing gap between
 * form creation and the listener picking it up.
 */
async function getStorageFolderName(formId) {
  assertSafeFormId(formId);
  const formRef = db.collection(FORMS_COLLECTION).doc(formId);
  const snap = await formRef.get();
  if (!snap.exists) {
    const err = new Error('Form not found.');
    err.statusCode = 400;
    throw err;
  }
  const existing = snap.data().storageFolderName;
  if (existing) return existing;

  // Not yet assigned — assign it now, synchronously, rather than
  // rejecting the upload. Idempotent and safe even if the listener
  // fires for the same form a moment later.
  return assignFolderIfNeeded(formId, snap.data().name);
}

/**
 * Starts the backend-side listener that assigns a folder the instant a
 * new form document appears in Firestore. Call this once at server
 * startup (see the "wiring" note below). Returns the unsubscribe
 * function Firestore's onSnapshot gives back, in case the caller ever
 * needs to tear it down (e.g. graceful shutdown).
 *
 * Note: onSnapshot's initial callback fires an 'added' event for every
 * document that already exists in the collection at listener-attach
 * time, not just genuinely new ones. That's fine here — for any form
 * that already has storageFolderName set, assignFolderIfNeeded() reads
 * and returns immediately without writing anything, so replaying the
 * whole collection on every backend restart is a harmless no-op after
 * the first time each form is processed.
 */
function startFormFolderWatcher() {
  return db.collection(FORMS_COLLECTION).onSnapshot(
    (snapshot) => {
      snapshot.docChanges().forEach((change) => {
        if (change.type !== 'added') return; // renames/edits never need a new folder
        const doc = change.doc;
        const data = doc.data();
        if (data.storageFolderName) return; // already assigned, nothing to do
        assignFolderIfNeeded(doc.id, data.name)
          .then((folderName) => {
            console.log(`[formFolderService] assigned folder "${folderName}" to form ${doc.id}`);
          })
          .catch((err) => {
            console.error(`[formFolderService] failed to assign folder for form ${doc.id}:`, err);
          });
      });
    },
    (err) => {
      console.error('[formFolderService] forms collection listener error:', err);
    },
  );
}

module.exports = {
  assignFolderIfNeeded,
  getStorageFolderName,
  startFormFolderWatcher,
  assertSafeFormId,
};
