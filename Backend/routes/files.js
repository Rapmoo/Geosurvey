const express = require('express');
const path = require('path');
const { verifyFirebaseToken } = require('../middleware/verifyFirebaseToken');
const { canAccessFile } = require('../utils/authorizeFileAccess');
const fileStorageService = require('../services/fileStorageService');
const fileMetadataService = require('../services/fileMetadataService');
const auditLogService = require('../services/auditLogService');
const { isValidFileId } = require('../utils/fileIdPattern');

const router = express.Router();

// Only allow a small, known-safe set of characters through into the ASCII
// "filename" fallback param. Anything else (including raw Unicode, quotes,
// backslashes, control chars) is stripped. This string is built from
// `fileId` (already validated by isValidFileId) plus a sanitized extension,
// so it never contains path separators or user-controlled folder names.
function sanitizeAsciiFilename(name) {
  return name.replace(/[^A-Za-z0-9._-]/g, '_');
}

// Extract just the file extension from the on-disk path and keep only
// safe characters. This is the ONLY piece of `filePath` that ends up in
// the ASCII fallback filename — never the full basename, and never any
// directory component (which is where Unicode folder names could sneak in).
function sanitizeExtension(filePath) {
  const ext = path.extname(filePath); // e.g. ".jpg", ".mp4", ".pdf"
  const safe = ext.replace(/[^A-Za-z0-9.]/g, '');
  return safe;
}

// RFC 5987 percent-encoding for the ext-value used in filename*=UTF-8''...
// encodeURIComponent() is a good start, but it leaves a few characters
// unescaped (* ' ( )) that RFC 5987's attr-char set does not permit, so
// we escape those explicitly. This lets us safely carry the *real*,
// human-readable filename (including Amharic or any other script) as a
// header value, per RFC 6266, without ever putting raw Unicode bytes
// into the header directly.
function encodeRFC5987(str) {
  return encodeURIComponent(str)
    .replace(/['()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
    .replace(/\*/g, '%2A');
}

// Build a spec-compliant, header-safe Content-Disposition value.
//   - `filename="..."` is an ASCII-only fallback for older/non-compliant
//     clients. It never contains raw path data — just the validated
//     fileId plus a sanitized extension.
//   - `filename*=UTF-8''...` carries the actual on-disk filename
//     (which may legitimately contain Unicode, e.g. from Kobo/GeoSurvey
//     imports with non-Latin form names), percent-encoded so it can
//     never violate the HTTP header charset restrictions.
function buildContentDisposition(fileId, filePath) {
  const ext = sanitizeExtension(filePath);
  const asciiFallback = sanitizeAsciiFilename(`${fileId}${ext}`);
  const realFilename = path.basename(filePath);
  const encodedRealFilename = encodeRFC5987(realFilename);

  return `inline; filename="${asciiFallback}"; filename*=UTF-8''${encodedRealFilename}`;
}

router.get('/files/:id', verifyFirebaseToken, async (req, res) => {
  const { id } = req.params;
  if (!isValidFileId(id)) return res.status(400).json({ error: 'Invalid file id.' });

  try {
    const record = await fileMetadataService.getRecord(id);
    if (!record) {
      await auditLogService.logEvent({ action: 'download', result: 'not_found', req, fileId: id });
      return res.status(404).json({ error: 'File not found.' });
    }

    if (!canAccessFile(req.userProfile, record)) {
      await auditLogService.logEvent({
        action: 'download', result: 'denied', req, fileId: id, surveyId: record.surveyId,
        fileType: record.fileType, reason: 'not_authorized',
      });
      return res.status(403).json({ error: 'Not authorized to access this file.' });
    }

    const buffer = await fileStorageService.readFile(record.filePath);
    res.setHeader('Content-Type', record.fileType);
    res.setHeader('Content-Length', buffer.length);
    res.setHeader('Cache-Control', 'private, max-age=0, no-store');
    // Safe for Unicode folder/file names (e.g. Amharic form names from
    // Kobo/GeoSurvey imports): the raw path never goes into the header
    // directly. See buildContentDisposition() above.
    res.setHeader('Content-Disposition', buildContentDisposition(id, record.filePath));

    await auditLogService.logEvent({
      action: 'download', result: 'success', req, fileId: id, surveyId: record.surveyId, fileType: record.fileType,
    });

    return res.status(200).send(buffer);
  } catch (err) {
    console.error(`[files/:id GET] failed for ${id}:`, err);
    await auditLogService.logEvent({ action: 'download', result: 'error', req, fileId: id, reason: 'internal_error' });
    return res.status(500).json({ error: 'Could not retrieve file.' });
  }
});

router.delete('/files/:id', verifyFirebaseToken, async (req, res) => {
  const { id } = req.params;
  if (!isValidFileId(id)) return res.status(400).json({ error: 'Invalid file id.' });

  try {
    const record = await fileMetadataService.getRecord(id);
    if (!record) {
      await auditLogService.logEvent({ action: 'delete', result: 'not_found', req, fileId: id });
      return res.status(404).json({ error: 'File not found.' });
    }

    if (!canAccessFile(req.userProfile, record)) {
      await auditLogService.logEvent({
        action: 'delete', result: 'denied', req, fileId: id, surveyId: record.surveyId,
        fileType: record.fileType, reason: 'not_authorized',
      });
      return res.status(403).json({ error: 'Not authorized to delete this file.' });
    }

    // Delete the metadata record first: if storage deletion then fails,
    // a retried/repeat DELETE still finds nothing in Firestore and
    // returns a clean 404 instead of re-attempting against a record
    // that's in a half-deleted state.
    await fileMetadataService.deleteRecord(id);
    await fileStorageService.deleteFile(record.filePath);

    await auditLogService.logEvent({
      action: 'delete', result: 'success', req, fileId: id, surveyId: record.surveyId, fileType: record.fileType,
    });

    return res.status(204).send();
  } catch (err) {
    console.error(`[files/:id DELETE] failed for ${id}:`, err);
    await auditLogService.logEvent({ action: 'delete', result: 'error', req, fileId: id, reason: 'internal_error' });
    return res.status(500).json({ error: 'Could not delete file.' });
  }
});

module.exports = router;