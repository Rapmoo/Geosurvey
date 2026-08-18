
const express = require('express');
// multer parses the multipart/form-data upload for /forms/import-file
// below — not part of this backend's existing dependencies, so:
//   npm install multer
const multer = require('multer');
const { verifyFirebaseToken } = require('../middleware/verifyFirebaseToken');
const { requireRole } = require('../middleware/requireRole');
const koboService = require('../services/koboService');

const router = express.Router();

// requireRole takes the role string(s) directly (see its own usage
// comment) — passing the literal 'admin' here matches how role is
// stored on users/{uid} and checked everywhere else in the app
// (index.html: currentUser.role === 'admin', etc.).
const requireAdmin = requireRole('admin');

// Kobo asset uids look like "aBcDeFgH1234567890abcdefgh" — base62,
// bounded length. Reject anything else before it's ever interpolated
// into an outbound Kobo API URL.
const FORM_ID_PATTERN = /^[A-Za-z0-9]{1,40}$/;

// Memory storage (not disk) — the uploaded workbook is only ever read
// once, straight into ExcelJS in koboService.importFormFromWorkbookBuffer,
// so there's no reason to touch the filesystem for it. Size-capped so
// an oversized or malformed upload can't tie up the request; a real
// form-definition workbook is a few KB to a couple MB at most.
const IMPORT_FILE_MAX_BYTES = 10 * 1024 * 1024; // 10MB
const XLSX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: IMPORT_FILE_MAX_BYTES },
  fileFilter: (req, file, cb) => {
    // Belt-and-suspenders: check both the browser-supplied mimetype and
    // the filename extension, since either alone can be wrong/spoofed —
    // koboService.importFormFromWorkbookBuffer's own ExcelJS.load() is
    // the real gate against a file that merely has an .xlsx name.
    const hasXlsxMime = file.mimetype === XLSX_MIME_TYPE;
    const hasXlsxExt = /\.xlsx$/i.test(file.originalname || '');
    if (!hasXlsxMime && !hasXlsxExt) {
      cb(new Error('Only .xlsx files are accepted.'));
      return;
    }
    cb(null, true);
  },
});

router.get('/kobo/status', verifyFirebaseToken, requireAdmin, async (req, res) => {
  try {
    const conn = await koboService.getConnection();
    return res.status(200).json({ connected: !!conn, serverUrl: conn ? conn.serverUrl : null });
  } catch (err) {
    console.error('[kobo/status] failed:', err);
    return res.status(500).json({ error: 'Could not check KoboToolbox connection status.' });
  }
});

router.post('/kobo/connect', verifyFirebaseToken, requireAdmin, async (req, res) => {
  const { server, token } = req.body || {};
  try {
    const result = await koboService.saveConnection(server, token, req.uid);
    return res.status(200).json({ connected: true, serverUrl: result.serverUrl });
  } catch (err) {
    console.error('[kobo/connect] failed:', err);
    return res.status(err.statusCode || 500).json({ error: err.message || 'Could not connect to KoboToolbox.' });
  }
});

router.post('/kobo/disconnect', verifyFirebaseToken, requireAdmin, async (req, res) => {
  try {
    await koboService.clearConnection();
    return res.status(200).json({ connected: false });
  } catch (err) {
    console.error('[kobo/disconnect] failed:', err);
    return res.status(500).json({ error: 'Could not disconnect from KoboToolbox.' });
  }
});

router.get('/kobo/forms', verifyFirebaseToken, requireAdmin, async (req, res) => {
  try {
    const forms = await koboService.listForms();
    return res.status(200).json({ forms });
  } catch (err) {
    console.error('[kobo/forms] failed:', err);
    return res.status(err.statusCode || 500).json({ error: err.message || 'Could not load forms from KoboToolbox.' });
  }
});

// Every Kobo project/form regardless of deployment state (drafts and
// archived included, not just the "ready to import" deployed ones
// /kobo/forms above returns), with the extra owner/created/status
// columns the admin's "View Forms" browser shows. Read-only, nothing
// written to Firestore.
router.get('/kobo/forms/overview', verifyFirebaseToken, requireAdmin, async (req, res) => {
  try {
    const forms = await koboService.listFormsOverview();
    return res.status(200).json({ forms });
  } catch (err) {
    console.error('[kobo/forms/overview] failed:', err);
    return res.status(err.statusCode || 500).json({ error: err.message || 'Could not load forms from KoboToolbox.' });
  }
});

// Downloads a single form's *definition* — the survey/choices/settings
// schema, exactly what buildFormExportWorkbook builds — as a real
// .xlsx file. Deliberately never touches /data/ (submissions); see
// koboService.buildFormExportWorkbook's own doc comment for the sheet
// layout.
// Exporting a form's definition also finds-or-creates the matching
// GeoSurvey Draft Template (see koboService.exportFormAndSaveAsTemplate)
// — an admin downloading a form's schema almost always wants it
// available in the Form Builder too, not just as a file on disk, and
// this saves them a separate trip through /forms/import-file to get
// there. Same as any Kobo-sourced template: created inactive, and
// never overwritten if one already exists for this Kobo form (see
// resolveFormTemplate's own doc comment for why).
router.get('/kobo/forms/:formId/export', verifyFirebaseToken, requireAdmin, async (req, res) => {
  const { formId } = req.params;
  if (!FORM_ID_PATTERN.test(formId)) {
    return res.status(400).json({ error: 'Invalid form id.' });
  }
  try {
    const {
      workbook, filename, templateId, templateCreated, surveyTemplateCreated,
    } = await koboService.exportFormAndSaveAsTemplate(formId, req.uid);
    const buffer = await workbook.xlsx.writeBuffer();
    res.writeHead(200, {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      // encodeURIComponent handles a form name with non-ASCII/special
      // characters; quoted plain filename kept alongside for older
      // clients that don't understand filename*.
      'Content-Disposition': `attachment; filename="${filename.replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      'Content-Length': buffer.length,
      // Custom headers carrying the template-save outcome alongside the
      // file itself, since this route's success response is the binary
      // workbook — there's no JSON body left to put this in.
      'X-Template-Id': templateId,
      'X-Template-Created': templateCreated ? 'true' : 'false',
      'X-Survey-Template-Created': surveyTemplateCreated ? 'true' : 'false',
      // Content-Disposition (and the X-Template-*/X-Survey-Template-*
      // headers above) are NOT in the handful of response headers
      // browsers expose to JS by default on a cross-origin fetch (the
      // CORS-safelisted set is just Cache-Control, Content-Language,
      // Content-Length, Content-Type, Expires, Last-Modified, Pragma).
      // Without this, index.html's koboApiFetchBlob() calling
      // res.headers.get('Content-Disposition') always gets null —
      // regardless of what value this route sends — and silently falls
      // back to its generic default filename; same problem would apply
      // to the other custom headers. This is what actually makes all of
      // them reach the browser.
      'Access-Control-Expose-Headers': 'Content-Disposition, Content-Length, X-Template-Id, X-Template-Created, X-Survey-Template-Created',
    });
    return res.end(buffer);
  } catch (err) {
    console.error(`[kobo/forms/${formId}/export] failed:`, err);
    return res.status(err.statusCode || 500).json({ error: err.message || 'Could not export this form from KoboToolbox.' });
  }
});

// Read-only preview of a form's question list (its actual Kobo schema
// — name/label/type per question), not its submissions. Lets an admin
// see what a Kobo form actually asks before importing it. Reuses
// whatever koboService already parses for the field-mapping pipeline
// (see services/koboService.js's getFormFields/computeAutoMapping),
// just returned directly instead of matched against GeoSurvey fields.
router.get('/kobo/forms/:formId/fields', verifyFirebaseToken, requireAdmin, async (req, res) => {
  const { formId } = req.params;
  if (!FORM_ID_PATTERN.test(formId)) {
    return res.status(400).json({ error: 'Invalid form id.' });
  }
  try {
    const fields = await koboService.getFormFields(formId);
    return res.status(200).json({ fields });
  } catch (err) {
    console.error(`[kobo/forms/${formId}/fields] failed:`, err);
    return res.status(err.statusCode || 500).json({ error: err.message || 'Could not load this form from KoboToolbox.' });
  }
});

// Import streams progress as newline-delimited JSON (NDJSON) rather
// than returning one JSON response at the end: pulling every
// submission's attachments is one Kobo HTTP round trip each, so a
// form with dozens of submissions can take a while — administrators
// watching the import need to see it moving, not just a spinner until
// the whole batch finishes.
//
// Each line is a JSON object with at least a `type` field — see
// koboService.importForm's onProgress events for the full set
// ('submission_start', 'downloading', 'saving', 'submission_done',
// 'submission_skipped', 'submission_failed', 'import_complete') — plus
// exactly one final line:
//   { type: 'result', imported, skipped, failed, total, formId }  on success
//   { type: 'error', error: '<message>' }                         on failure
// `formId` here is the Firestore "forms" collection doc id this import
// wrote (or matched, on a re-import) — the admin UI uses it to link
// straight into the Form Builder for that form afterwards, so
// koboService.importForm's resolved result needs to include it.
//
// IMPORTANT for callers: because streaming starts before the outcome
// is known, this endpoint ALWAYS responds with HTTP 200 — a failure
// is a JSON error event in the stream, not an HTTP error status. Any
// caller checking res.ok/response status for success needs to instead
// read the stream to its final line and check that line's `type`.
router.post('/kobo/forms/:formId/import', verifyFirebaseToken, requireAdmin, async (req, res) => {
  const { formId } = req.params;
  const formName = (req.body && req.body.formName) || formId;
  if (!FORM_ID_PATTERN.test(formId)) {
    return res.status(400).json({ error: 'Invalid form id.' });
  }

  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson',
    'Cache-Control': 'no-cache',
    'X-Accel-Buffering': 'no', // disable response buffering if this ever sits behind an nginx proxy
  });

  const sendEvent = (event) => {
    res.write(`${JSON.stringify(event)}\n`);
  };

  try {
    const result = await koboService.importForm(formId, formName, req.uid, sendEvent);
    sendEvent({ type: 'result', ...result });
  } catch (err) {
    console.error(`[kobo/forms/${formId}/import] failed:`, err);
    sendEvent({ type: 'error', error: err.message || 'Import failed.' });
  }
  res.end();
});

// File-based counterpart to the live-API import above: an admin
// uploads a .xlsx that /forms/:formId/export (this same router)
// produced earlier — or one handed to them by someone else, or
// touched up by hand — rather than pulling from a live Kobo
// connection. See koboService.importFormFromWorkbookBuffer for the
// validation/parsing/dedupe rules; this route just wires the upload
// and translates that function's thrown errors (400 = invalid
// structure, 409 = already imported) into the matching HTTP status.
router.post('/kobo/forms/import-file', verifyFirebaseToken, requireAdmin, (req, res) => {
  upload.single('file')(req, res, async (uploadErr) => {
    if (uploadErr) {
      const message = uploadErr.code === 'LIMIT_FILE_SIZE'
        ? `File is too large (${IMPORT_FILE_MAX_BYTES / (1024 * 1024)}MB max).`
        : (uploadErr.message || 'Could not read the uploaded file.');
      return res.status(400).json({ error: message });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No file was uploaded.' });
    }
    try {
      const result = await koboService.importFormFromWorkbookBuffer(req.file.buffer, req.uid);
      return res.status(200).json({ imported: true, ...result });
    } catch (err) {
      console.error('[kobo/forms/import-file] failed:', err);
      return res.status(err.statusCode || 500).json({
        error: err.message || 'Could not import this form file.',
        ...(err.validationErrors ? { validationErrors: err.validationErrors } : {}),
        ...(err.existingFormId ? { existingFormId: err.existingFormId } : {}),
      });
    }
  });
});

module.exports = router;