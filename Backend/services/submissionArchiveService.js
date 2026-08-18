
const path = require('path');
const { db, admin } = require('../config/firebaseAdmin');
const formFolderService = require('./formFolderService');
const fileStorageService = require('./fileStorageService');
const fileMetadataService = require('./fileMetadataService');

const SUBMISSIONS_COLLECTION = 'submissions';

// Matches a base64 data: URI of any mime type, e.g.
// "data:image/jpeg;base64,/9j/4AAQ...". See "NO INLINE FILE DATA,
// EVER" above — this is a defense-in-depth guard, not something the
// app's current submission flow is expected to ever trigger.
const DATA_URI_PATTERN = /^data:[^;,]+;base64,/i;
const REDACTED_DATA_URI_PLACEHOLDER = '[omitted: inline base64 file data is never archived — see photoFiles/audioFiles/documentFiles]';

function toPlainJson(value) {
  if (typeof value === 'string') {
    if (DATA_URI_PATTERN.test(value)) {
      console.warn('[submissionArchiveService] found an inline base64 data URI on a submission field — redacting it from the archive.');
      return REDACTED_DATA_URI_PLACEHOLDER;
    }
    return value;
  }
  if (value === null || typeof value !== 'object') return value;
  if (typeof value.toDate === 'function') return value.toDate().toISOString(); // Timestamp
  if (typeof value.latitude === 'number' && typeof value.longitude === 'number') {
    return { latitude: value.latitude, longitude: value.longitude }; // GeoPoint
  }
  if (typeof value.path === 'string' && typeof value.firestore === 'object') {
    return value.path; // DocumentReference -> "workers/abc123"
  }
  if (Array.isArray(value)) return value.map(toPlainJson);

  // Only recurse into plain objects ({} or Object.create(null)). Anything
  // else — other SDK/class instances not covered above — is left as-is
  // rather than recursed into, since those can hold circular internal
  // references (this is what previously caused "Maximum call stack size
  // exceeded": a DocumentReference's internals loop back to the Firestore
  // instance, and Object.entries() walked that graph forever).
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;

  const out = {};
  for (const [key, val] of Object.entries(value)) out[key] = toPlainJson(val);
  return out;
}

// --- Gate 1: validation --------------------------------------------
// The minimum a submission doc must have for an archive of it to be
// meaningful. `gps` is included because the worker-facing form always
// requires capturing a GPS point before the submit button is even
// enabled (see index.html's "Capture your current location before
// submitting" flow) — a submission doc missing it is not a normal,
// still-in-progress write, it's a data problem worth surfacing loudly.
const REQUIRED_TOP_LEVEL_FIELDS = ['formId', 'workerId', 'answers', 'gps'];

/**
 * Returns a short human-readable reason the doc fails validation, or
 * null if it passes. Never throws.
 */
function validationFailureReason(data) {
  if (!data || typeof data !== 'object') return 'submission has no data';
  for (const field of REQUIRED_TOP_LEVEL_FIELDS) {
    if (data[field] === undefined || data[field] === null) return `missing required field "${field}"`;
  }
  if (typeof data.answers !== 'object' || Array.isArray(data.answers)) return '"answers" is not an object';
  return null;
}

// --- Gate 2: required uploads succeeded -----------------------------
// index.html sets a photo/audio question's answer to one of these
// exact literal strings at submit time — BEFORE the corresponding
// upload has even started (see the header comment above) — so their
// presence means "the worker attached something here," independent of
// whether the upload has actually finished yet.
const PENDING_UPLOAD_MARKERS = [
  { placeholder: 'Photo attached', field: 'photoUrl', label: 'photo' },
  { placeholder: 'Voice memo attached', field: 'voiceUrl', label: 'voice memo' },
];

/**
 * Returns a short label ("photo" / "voice memo") for the first
 * attached-but-not-yet-uploaded file found on this submission, or null
 * if every attachment the worker made already has a fileId recorded.
 */
function findPendingRequiredUpload(data) {
  const answers = (data && data.answers) || {};
  const answerValues = Object.values(answers);
  for (const { placeholder, field, label } of PENDING_UPLOAD_MARKERS) {
    if (answerValues.includes(placeholder) && !data[field]) return label;
  }
  return null;
}


// id) rather than the file itself. `Urls`-suffixed plural variants are
// included for forward-compatibility, in case a form ever adds
// multi-file questions — none of today's forms produce them (see the
// header comment), so these simply resolve to nothing for now.
const FILE_REFERENCE_FIELDS = [
  { field: 'photoUrl', group: 'photoFiles', multiple: false },
  { field: 'photoUrls', group: 'photoFiles', multiple: true },
  { field: 'voiceUrl', group: 'audioFiles', multiple: false },
  { field: 'voiceUrls', group: 'audioFiles', multiple: true },
  { field: 'documentUrl', group: 'documentFiles', multiple: false },
  { field: 'documentUrls', group: 'documentFiles', multiple: true },
];
// Excluded from "additional metadata" below since resolveFileReferences()
// replaces each of these with a resolved, human-readable path in
// photoFiles/audioFiles/documentFiles instead.
const RAW_FILE_ID_KEYS = new Set(FILE_REFERENCE_FIELDS.map((f) => f.field));

/**
 * Resolves a single backend fileId to a path relative to the form's
 * own storage folder (e.g. "photos/photo_survey123_....jpg"), or null
 * if it can't be resolved (already deleted, bad id, etc.) — logged,
 * never thrown, so one missing file never fails the whole archive.
 */
async function resolveFilePath(fileId, storageFolderName, submissionId) {
  if (!fileId || typeof fileId !== 'string') return null;
  try {
    const record = await fileMetadataService.getRecord(fileId);
    if (!record || !record.filePath) {
      console.warn(`[submissionArchiveService] submission ${submissionId}: referenced file ${fileId} not found — omitting from archive.`);
      return null;
    }
    // filePath is relative to STORAGE_ROOT and already begins with
    // storageFolderName (see fileMetadataService.js's field docs) — the
    // archive JSON lives inside that same folder, at
    // <storageFolderName>/submissions/, so re-express the reference
    // relative to the folder instead of repeating its own name.
    return path.relative(storageFolderName, record.filePath).split(path.sep).join('/');
  } catch (err) {
    console.warn(`[submissionArchiveService] submission ${submissionId}: could not resolve file ${fileId} — omitting from archive:`, err.message);
    return null;
  }
}

/**
 * Resolves every file-reference field on the submission doc (see
 * FILE_REFERENCE_FIELDS) into { photoFiles, audioFiles, documentFiles }
 * arrays of storage-relative path strings — never fileIds, never file
 * bytes. Resolved serially (submissions reference at most a couple of
 * files today), one fs/Firestore lookup at a time.
 *
 * Also returns `unresolved`: the field names of any fileId that IS
 * present on the doc but couldn't be resolved to a real companyFiles
 * record. That's gate 3 (METADATA SUCCESSFULLY RECORDED) — the caller
 * treats a non-empty `unresolved` as "don't archive this event at
 * all," not "archive with that one file missing."
 */
async function resolveFileReferences(data, storageFolderName, submissionId) {
  const groups = { photoFiles: [], audioFiles: [], documentFiles: [] };
  const unresolved = [];
  for (const { field, group, multiple } of FILE_REFERENCE_FIELDS) {
    const value = data[field];
    if (!value) continue;
    const fileIds = multiple ? (Array.isArray(value) ? value : [value]) : [value];
    for (const fileId of fileIds) {
      const relativePath = await resolveFilePath(fileId, storageFolderName, submissionId);
      if (relativePath) {
        groups[group].push(relativePath);
      } else {
        unresolved.push(field);
      }
    }
  }
  return { groups, unresolved };
}

// Fields already normalized into the canonical shape below, keyed by
// their ORIGINAL name on the Firestore doc — excluded from the
// "additional metadata" pass-through so nothing appears twice under
// two different names (e.g. both raw `workerId` and canonical
// `workerUid`, or both raw `createdAt` and canonical `submittedAt`).
// Also excludes RAW_FILE_ID_KEYS (photoUrl, voiceUrl, ...) — those are
// replaced by the resolved photoFiles/audioFiles/documentFiles arrays.
const CANONICAL_SOURCE_KEYS = new Set([
  'submissionId', 'formId', 'formName', 'workerId', 'createdAt', 'answers', 'gps',
  ...RAW_FILE_ID_KEYS,
]);

/**
 * Builds the exact object that gets written to disk. Required fields
 * are pulled out explicitly and given clear, stable names — so the
 * archive is guaranteed to contain them even if the underlying doc's
 * `answers`/`gps` were ever missing (falls back to `{}`/`null` rather
 * than silently omitting the key) — followed by every other field
 * currently stored on the submission doc, verbatim, as additional
 * metadata (e.g. status, formVersion, reviewComment, gpsMeta,
 * memoLen, updatedAt...).
 *
 * `fileReferences` is the pre-resolved { photoFiles, audioFiles,
 * documentFiles } object from resolveFileReferences() — resolving
 * fileId -> on-disk path requires an async Firestore lookup, so it's
 * computed by the caller and passed in rather than done inline here.
 */
function buildArchiveRecord(docId, data, submissionId, fileReferences) {
  const converted = toPlainJson(data) || {};

  const canonical = {
    submissionId,
    formId: data.formId,
    formName: data.formName != null ? data.formName : null,
    workerUid: data.workerId != null ? data.workerId : null, // worker's Firebase UID
    submittedAt: converted.createdAt != null ? converted.createdAt : null, // ISO string, converted from the Firestore Timestamp
    answers: converted.answers || {}, // all form answers
    gps: converted.gps || null, // { latitude, longitude }, converted from the Firestore GeoPoint
    photoFiles: (fileReferences && fileReferences.photoFiles) || [], // storage-relative paths, never fileIds or bytes
    audioFiles: (fileReferences && fileReferences.audioFiles) || [],
    documentFiles: (fileReferences && fileReferences.documentFiles) || [],
  };

  const additionalMetadata = {};
  for (const [key, value] of Object.entries(converted)) {
    if (!CANONICAL_SOURCE_KEYS.has(key)) additionalMetadata[key] = value;
  }

  return { ...canonical, ...additionalMetadata, _docId: docId };
}

/**
 * Idempotently records where the archive JSON landed, on the
 * submission's own Firestore doc — see "FIRESTORE INDEXING, NOT
 * FIRESTORE STORAGE" above. `currentArchiveFilePath` is whatever the
 * triggering snapshot's data already had for that field (may be
 * undefined/null on a doc that's never been archived before); if it
 * already matches `archiveFilePath`, this is a no-op, which is what
 * breaks the listener feedback loop this write would otherwise cause.
 */
async function recordArchiveIndex(docId, archiveFilePath, currentArchiveFilePath) {
  if (currentArchiveFilePath === archiveFilePath) return; // already indexed, and writing again would just retrigger this listener
  try {
    await db.collection(SUBMISSIONS_COLLECTION).doc(docId).update({
      archiveFilePath,
      archivedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (err) {
    // Best-effort, same as auditLogService: the JSON archive itself
    // already succeeded and is the authoritative record. Losing this
    // index write means a future event on this same doc gets another
    // chance to set it (currentArchiveFilePath will still be stale),
    // so it's not permanently lost, just delayed.
    console.error(`[submissionArchiveService] submission ${docId}: failed to record archiveFilePath on Firestore doc:`, err);
  }
}

/**
 * archiveSubmission(docId, data)
 * data is the raw Firestore document data (doc.data()), not the
 * UI-shaped object index.html's submissionFromDoc() builds — this
 * writes the canonical Firestore fields, not display-only derived ones
 * (worker/region/collected/etc. added client-side for rendering).
 *
 * Runs the three gates described in the header comment, IN ORDER,
 * stopping at the first one that isn't satisfied — no file is written
 * unless all three pass on this exact call. A gate not passing isn't
 * necessarily permanent: the next Firestore change to this same doc
 * (e.g. the media-attach updateDoc index.html does once an upload
 * finishes) calls this function again from scratch.
 *
 * Best-effort in the sense that auditLogService.logEvent is: archiving
 * is a side-effect of a submission existing, not something that should
 * ever be able to break the submission itself (which already succeeded
 * by the time this listener sees it — the doc is already in
 * Firestore). Unexpected errors (a Firestore/filesystem hiccup, not a
 * gate failing) are caught and logged, never thrown back to the
 * listener.
 */
async function archiveSubmission(docId, data) {
  const submissionId = (data && data.submissionId) || docId;

  // --- Gate 1: validation ---
  const invalidReason = validationFailureReason(data);
  if (invalidReason) {
    console.error(`[submissionArchiveService] submission ${docId} failed validation (${invalidReason}) — not archiving.`);
    return;
  }

  // --- Gate 2: required uploads succeeded ---
  const pendingUploadLabel = findPendingRequiredUpload(data);
  if (pendingUploadLabel) {
    console.log(`[submissionArchiveService] submission ${submissionId} is still waiting on its ${pendingUploadLabel} upload — not archiving yet.`);
    return;
  }

  try {
    const storageFolderName = await formFolderService.getStorageFolderName(data.formId);

    // --- Gate 3: metadata successfully recorded ---
    const { groups: fileReferences, unresolved } = await resolveFileReferences(data, storageFolderName, submissionId);
    if (unresolved.length) {
      console.error(`[submissionArchiveService] submission ${submissionId}: metadata for ${unresolved.join(', ')} could not be resolved — not archiving.`);
      return;
    }

    // All three gates passed — safe to write.
    const record = buildArchiveRecord(docId, data, submissionId, fileReferences);
    const result = await fileStorageService.saveSubmissionRecord({
      storageFolderName,
      submissionId,
      data: record,
    });

    // result.relativePath is built with path.join, so it's OS-native
    // (backslashes on Windows) — normalize to forward slashes the same
    // way resolveFilePath() does, so archiveFilePath is a portable,
    // consistent string regardless of what OS the backend runs on.
    const archiveFilePath = result.relativePath.split(path.sep).join('/');

    if (result.skipped) {
      console.log(`[submissionArchiveService] submission ${submissionId} already archived — skipping (already written, or listener replay).`);
    } else {
      console.log(`[submissionArchiveService] archived submission ${submissionId} -> "${archiveFilePath}"`);
    }

    // Index the path on the submission's own doc whether this call
    // wrote the file just now or found it already written — either
    // way the doc should end up with archiveFilePath set. Skipped for
    // this call if the doc already has it (see recordArchiveIndex).
    await recordArchiveIndex(docId, archiveFilePath, data.archiveFilePath);
  } catch (err) {
    console.error(`[submissionArchiveService] failed to archive submission ${submissionId} (doc ${docId}):`, err);
  }
}


function startSubmissionArchiveWatcher() {
  return db.collection(SUBMISSIONS_COLLECTION).onSnapshot(
    (snapshot) => {
      snapshot.docChanges().forEach((change) => {
        
        if (change.type !== 'added' && change.type !== 'modified') return;
        archiveSubmission(change.doc.id, change.doc.data());
      });
    },
    (err) => {
      console.error('[submissionArchiveService] submissions collection listener error:', err);
    },
  );
}

module.exports = { startSubmissionArchiveWatcher, archiveSubmission };
