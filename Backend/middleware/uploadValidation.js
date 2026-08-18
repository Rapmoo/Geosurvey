
const multer = require('multer');
// `file-type` v17+ is ESM-only, so it can't be loaded with a top-level
// require(). Lazily dynamic-import it once and cache the resolved
// function — this works whether the installed version is CJS (v16.x,
// exports `fromBuffer`) or ESM (v17+, exports `fileTypeFromBuffer`).
// IMPORTANT: do NOT also `require('file-type')` at the top level below —
// if the installed version is ESM-only, that require() throws
// ERR_REQUIRE_ESM at module load and crashes the server before this
// helper ever gets a chance to run.
let _fileTypeFromBuffer = null;
async function getFileTypeFromBuffer() {
  if (_fileTypeFromBuffer) return _fileTypeFromBuffer;
  const mod = await import('file-type');
  // file-type@16.x's index.js re-exports core.js via
  // `module.exports = require('./core')`, which Node's CJS/ESM interop
  // doesn't always surface as named exports on a dynamic import() — so
  // the real functions can end up under mod.default instead of mod
  // directly. Check both shapes, and both possible function names
  // across major versions (fileTypeFromBuffer in v17+, fromBuffer in
  // v16 and earlier).
  _fileTypeFromBuffer = mod.fileTypeFromBuffer || mod.fromBuffer
    || (mod.default && (mod.default.fileTypeFromBuffer || mod.default.fromBuffer));
  if (typeof _fileTypeFromBuffer !== 'function') {
    throw new Error('file-type module did not expose a recognizable fromBuffer function');
  }
  return _fileTypeFromBuffer;
}

// Off by default. Set DEBUG_UPLOADS=1 to re-enable the verbose
// per-request tracing below without editing code — useful for
// reproducing an upload issue locally or temporarily in a deployed
// environment without shipping log noise on every request by default.
const DEBUG_UPLOADS = process.env.DEBUG_UPLOADS === '1';

const MAX_PHOTO_BYTES = Number(process.env.MAX_PHOTO_BYTES || 15 * 1024 * 1024);
const MAX_AUDIO_BYTES = Number(process.env.MAX_AUDIO_BYTES || 25 * 1024 * 1024);
const MAX_DOCUMENT_BYTES = Number(process.env.MAX_DOCUMENT_BYTES || 20 * 1024 * 1024);

const ALLOWED_PHOTO_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);
const ALLOWED_AUDIO_MIME = new Set(['audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/webm', 'audio/ogg', 'audio/x-m4a']);
const ALLOWED_DOCUMENT_MIME = new Set([
  'application/pdf', 'text/csv', 'text/plain',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

function makeUploader({ maxBytes, allowedMime }) {
  return multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxBytes, files: 1 },
    fileFilter(req, file, cb) {
      if (!allowedMime.has(file.mimetype)) {
        return cb(new Error(`Unsupported file type: ${file.mimetype}`));
      }
      cb(null, true);
    },
  }).single('file');
}

const uploadPhotoMulter = makeUploader({ maxBytes: MAX_PHOTO_BYTES, allowedMime: ALLOWED_PHOTO_MIME });
const uploadAudioMulter = makeUploader({ maxBytes: MAX_AUDIO_BYTES, allowedMime: ALLOWED_AUDIO_MIME });
const uploadDocumentMulter = makeUploader({ maxBytes: MAX_DOCUMENT_BYTES, allowedMime: ALLOWED_DOCUMENT_MIME });

// Wraps a multer middleware so its errors become clean JSON instead of
// an unhandled exception / default Express HTML error page.
function wrapMulter(multerMw) {
  return (req, res, next) => {
    multerMw(req, res, (err) => {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(413).json({ error: 'File too large.' });
        }
        return res.status(400).json({ error: err.message });
      }
      if (err) {
        return res.status(400).json({ error: err.message });
      }
      if (!req.file) {
        return res.status(400).json({ error: 'No file provided. Send it as multipart/form-data under field name "file".' });
      }
      // Confirms multer actually produced a populated in-memory buffer
      // before the magic-byte sniff below ever runs, so a failure can
      // be told apart as "multer parsed nothing usable" vs "multer was
      // fine, file-type choked on what it got." Gated behind
      // DEBUG_UPLOADS — this fires on every successful upload, so it
      // stays off by default rather than logging on every request.
      if (DEBUG_UPLOADS) {
        console.log(`[uploadValidation] multer parsed file: mimetype=${req.file.mimetype}, size=${req.file.buffer ? req.file.buffer.length : 'NO BUFFER'} bytes, originalname=${req.file.originalname}`);
      }
      next();
    });
  };
}

// Re-checks the real bytes against the declared category after multer
// has buffered the upload. Attaches req.sniffedFileType ({ ext, mime }).
//
// `file-type` sniffs binary signatures — it can't identify plain-text
// formats like text/csv or text/plain (they have none) and returns
// undefined for them. For those two, fall back to a basic sanity check
// (decodes as UTF-8 with no embedded NUL bytes) instead of rejecting
// every CSV/text upload outright; everything else must be positively
// identified by content.
const TEXT_FALLBACK_MIME = new Set(['text/csv', 'text/plain']);

function looksLikePlainText(buffer) {
  if (buffer.includes(0x00)) return false; // NUL byte -> not text
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    return true;
  } catch {
    return false;
  }
}

// WebM is a Matroska-based container shared by both audio and video —
// file-type only reads the container header, not whether an actual
// video track is present, so an audio-only WebM blob from the browser's
// MediaRecorder routinely sniffs as `video/webm` instead of
// `audio/webm`. That's a correct read of the container, not a spoofed
// upload, so treat it as a match when the client declared audio/webm
// and this endpoint's allowlist includes it.
function isAudioWebmMisclassifiedAsVideo(sniffed, declaredMime, allowedMime) {
  return sniffed && sniffed.mime === 'video/webm'
    && declaredMime === 'audio/webm'
    && allowedMime.has('audio/webm');
}

function makeMagicByteVerifier(allowedMime) {
  return async (req, res, next) => {
    try {
      const fileTypeFromBuffer = await getFileTypeFromBuffer();
      const sniffed = await fileTypeFromBuffer(req.file.buffer);
      if (sniffed && allowedMime.has(sniffed.mime)) {
        req.sniffedFileType = sniffed;
        return next();
      }
      if (isAudioWebmMisclassifiedAsVideo(sniffed, req.file.mimetype, allowedMime)) {
        req.sniffedFileType = { mime: 'audio/webm', ext: 'webm' };
        return next();
      }
      if (!sniffed && TEXT_FALLBACK_MIME.has(req.file.mimetype) && allowedMime.has(req.file.mimetype)
          && looksLikePlainText(req.file.buffer)) {
        req.sniffedFileType = { mime: req.file.mimetype, ext: req.file.mimetype === 'text/csv' ? 'csv' : 'txt' };
        return next();
      }
      console.warn(`[uploadValidation] content did not match an allowed type: declared=${req.file.mimetype}, sniffed=${sniffed ? sniffed.mime : 'undetected'}`);
      return res.status(400).json({
        error: 'File content does not match an allowed type for this endpoint.',
      });
    } catch (err) {
      // This used to be swallowed entirely — no console output at all —
      // which is why "Could not read file content." was unexplainable
      // from the client side. Always log at least the error message so
      // that failure is never silent again; the full stack trace and
      // buffer-state dump are extra detail only needed while actively
      // debugging a specific report, so those stay behind DEBUG_UPLOADS.
      console.error('[uploadValidation] fileTypeFromBuffer threw:', err && err.message ? err.message : err);
      if (DEBUG_UPLOADS) {
        console.error('[uploadValidation] full stack:', err && err.stack ? err.stack : err);
        console.error('[uploadValidation] buffer state at failure: isBuffer=' + Buffer.isBuffer(req.file && req.file.buffer) + ', length=' + (req.file && req.file.buffer ? req.file.buffer.length : 'n/a'));
      }
      return res.status(400).json({ error: 'Could not read file content.' });
    }
  };
}

module.exports = {
  uploadPhoto: [wrapMulter(uploadPhotoMulter), makeMagicByteVerifier(ALLOWED_PHOTO_MIME)],
  uploadAudio: [wrapMulter(uploadAudioMulter), makeMagicByteVerifier(ALLOWED_AUDIO_MIME)],
  uploadDocument: [wrapMulter(uploadDocumentMulter), makeMagicByteVerifier(ALLOWED_DOCUMENT_MIME)],
};