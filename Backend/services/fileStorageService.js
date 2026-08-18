
const fs = require('fs/promises');
const path = require('path');


const STORAGE_ROOT = process.env.STORAGE_ROOT || path.join(__dirname, '..', 'storage');

// Directory names on disk (plural, matching the "photos/audio/documents"
// layout above). FILENAME_PREFIX stays singular ("photo_", "audio_",
// "document_") — that's an unrelated, independent naming choice for the
// files themselves and changing dir names doesn't need to touch it.
const CATEGORY_DIRS = {
  photo: 'photos', audio: 'audio', video: 'videos', document: 'documents',
};
const FILENAME_PREFIX = {
  photo: 'photo', audio: 'audio', video: 'video', document: 'document',
};

// Reserved top-level directory created alongside the category folders
// for every form (see ensureFolderExists). Not a "category" in the
// UPLOADERS/CATEGORY_DIRS sense — no upload route writes here today.
const SUBMISSIONS_DIR = 'submissions';

// Survey IDs are used to build a directory name, so they're restricted
// to a safe, boring character set. This also blocks path traversal
// (`..`, `/`) and null-byte tricks outright, rather than trying to
// strip/escape them after the fact.
const SURVEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function assertSafeSurveyId(surveyId) {
  if (typeof surveyId !== 'string' || !SURVEY_ID_PATTERN.test(surveyId)) {
    const err = new Error('Invalid surveyId. Use only letters, numbers, "-" and "_".');
    err.statusCode = 400;
    throw err;
  }
}

// Submission ids are Firestore document ids (base62 auto-generated, or
// the doc's own `submissionId` field — see submissionArchiveService.js),
// so the same safe, boring character set as surveyId applies, and for
// the same reason: this gets dropped straight into a filename below.
const SUBMISSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function assertSafeSubmissionId(submissionId) {
  if (typeof submissionId !== 'string' || !SUBMISSION_ID_PATTERN.test(submissionId)) {
    const err = new Error('Invalid submissionId. Use only letters, numbers, "-" and "_".');
    err.statusCode = 400;
    throw err;
  }
}


const UNSAFE_PATH_CHARS = /[\/\\:*?"<>|\x00-\x1f]/g;
// Reserve room for the longest realistic duplicate suffix (" (999)"
// is 6 chars) so a maxed-out base name plus a suffix never exceeds a
// sane total folder-name length.
const MAX_FORM_FOLDER_BASE_LEN = 94;
const FALLBACK_FORM_FOLDER = '_untitled-form';

function sanitizeFormName(formName) {
  if (typeof formName !== 'string') return FALLBACK_FORM_FOLDER;
  let name = formName
    .normalize('NFC')
    .replace(UNSAFE_PATH_CHARS, '')
    .replace(/\s+/g, ' ')
    .trim();
  // Strip leading/trailing dots so the folder can never resolve to
  // "." / ".." or read as a hidden dotfile-style directory.
  name = name.replace(/^\.+/, '').replace(/\.+$/, '').trim();
  if (!name) return FALLBACK_FORM_FOLDER;
  return name.slice(0, MAX_FORM_FOLDER_BASE_LEN);
}

// Defense-in-depth check on an already-assigned storageFolderName
// immediately before it's used to build a path. This value should
// only ever originate from formFolderService.js's claim process (which
// already ran it through sanitizeFormName + a de-dup suffix), so this
// should never actually fail in normal operation — it exists purely
// to catch a bug or a corrupted Firestore doc before it can reach the
// filesystem.
const FOLDER_NAME_PATTERN = /^[^\/\\:*?"<>|\x00-\x1f]{1,110}$/;

function assertSafeStorageFolderName(storageFolderName) {
  if (typeof storageFolderName !== 'string'
      || !FOLDER_NAME_PATTERN.test(storageFolderName)
      || storageFolderName.trim() !== storageFolderName
      || storageFolderName === '.' || storageFolderName === '..'
      || storageFolderName.startsWith('.')) {
    const err = new Error('Invalid storageFolderName resolved for this form.');
    err.statusCode = 500; // this is a server-side data-integrity problem, not a client input error
    throw err;
  }
}

function extForMime(mime) {
  const map = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
    'image/heic': 'heic', 'image/heif': 'heif',
    'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/wav': 'wav',
    'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/x-m4a': 'm4a',
    'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
    'video/3gpp': '3gp', 'video/x-msvideo': 'avi',
    'application/pdf': 'pdf', 'text/csv': 'csv', 'text/plain': 'txt',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  };
  return map[mime] || 'bin';
}

function normalizeStoredPath(segment) {
  return path.join(...String(segment).split(/[\\/]+/).filter(Boolean));
}

function safeResolve(...segments) {
  const resolved = path.resolve(STORAGE_ROOT, ...segments.map(normalizeStoredPath));
  if (!resolved.startsWith(path.resolve(STORAGE_ROOT) + path.sep)) {
    throw new Error('Resolved storage path escaped STORAGE_ROOT');
  }
  return resolved;
}

async function ensureFolderExists(storageFolderName) {
  assertSafeStorageFolderName(storageFolderName);
  const fullPath = safeResolve(storageFolderName);
  await fs.mkdir(fullPath, { recursive: true });

  
  const subdirs = [SUBMISSIONS_DIR, ...Object.values(CATEGORY_DIRS)];
  await Promise.all(
    subdirs.map((subdir) => fs.mkdir(safeResolve(path.join(storageFolderName, subdir)), { recursive: true })),
  );

  return fullPath;
}

async function saveFile({ surveyId, storageFolderName, category, buffer, mime, timestamp }) {
  assertSafeSurveyId(surveyId);
  assertSafeStorageFolderName(storageFolderName);
  const categoryDir = CATEGORY_DIRS[category];
  if (!categoryDir) throw new Error(`Unknown file category: ${category}`);

  const ext = extForMime(mime);
  const ts = timestamp || Date.now();
  const dir = path.join(storageFolderName, categoryDir);
  await fs.mkdir(safeResolve(dir), { recursive: true });

  let filename = `${FILENAME_PREFIX[category]}_${surveyId}_${ts}.${ext}`;
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const relativePath = path.join(dir, filename);
    const fullPath = safeResolve(relativePath);
    try {
      await fs.writeFile(fullPath, buffer, { flag: 'wx', mode: 0o600 }); // owner read/write only
      return { relativePath, filename, bytes: buffer.length };
    } catch (err) {
      if (err.code !== 'EEXIST' || attempt >= 5) throw err;
      attempt += 1;
      filename = `${FILENAME_PREFIX[category]}_${surveyId}_${ts}-${attempt}.${ext}`;
    }
  }
}


async function saveSubmissionRecord({ storageFolderName, submissionId, data }) {
  assertSafeStorageFolderName(storageFolderName);
  assertSafeSubmissionId(submissionId);

  const json = JSON.stringify(data, null, 2);
  const dir = path.join(storageFolderName, SUBMISSIONS_DIR);
  await fs.mkdir(safeResolve(dir), { recursive: true });

  const filename = `submission_${submissionId}.json`;
  const relativePath = path.join(dir, filename);
  const fullPath = safeResolve(relativePath);

  try {
    await fs.writeFile(fullPath, json, { flag: 'wx', mode: 0o600 }); // owner read/write only
    return { relativePath, filename, bytes: Buffer.byteLength(json), skipped: false };
  } catch (err) {
    if (err.code === 'EEXIST') {
   
      return { relativePath, filename, bytes: null, skipped: true };
    }
    throw err;
  }
}

function assertNotReservedSubmissionsPath(relativePath) {

  const segments = String(relativePath).split(/[\\/]+/).filter(Boolean);
  if (segments[1] === SUBMISSIONS_DIR) {
    const err = new Error('This path belongs to the reserved submissions archive and cannot be served through the general file API.');
    err.statusCode = 403;
    throw err;
  }
}

async function readFile(relativePath) {
  assertNotReservedSubmissionsPath(relativePath);
  const fullPath = safeResolve(relativePath);
  return fs.readFile(fullPath);
}

async function deleteFile(relativePath) {
  assertNotReservedSubmissionsPath(relativePath);
  const fullPath = safeResolve(relativePath);
  try {
    await fs.unlink(fullPath);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err; // already gone is fine, anything else isn't
  }
}

module.exports = {
  saveFile,
  readFile,
  deleteFile,
  saveSubmissionRecord,
  assertSafeSurveyId,
  assertSafeSubmissionId,
  sanitizeFormName,
  assertSafeStorageFolderName,
  ensureFolderExists,
  FALLBACK_FORM_FOLDER,
  SUBMISSIONS_DIR,
};