
const express = require('express');
const { verifyFirebaseToken } = require('../middleware/verifyFirebaseToken');
const { uploadPhoto, uploadAudio, uploadDocument } = require('../middleware/uploadValidation');
const fileStorageService = require('../services/fileStorageService');
const fileMetadataService = require('../services/fileMetadataService');
const formFolderService = require('../services/formFolderService');
const malwareScanService = require('../services/malwareScanService');
const auditLogService = require('../services/auditLogService');

const router = express.Router();

async function handleUpload(req, res, category) {
  const surveyId = req.body && req.body.surveyId;
  const formId = req.body && req.body.formId;

  try {
    fileStorageService.assertSafeSurveyId(surveyId);
  } catch (err) {
    await auditLogService.logEvent({
      action: 'upload', result: 'denied', req, surveyId, formId, reason: 'invalid_survey_id',
    });
    return res.status(err.statusCode || 400).json({ error: err.message });
  }

  try {
    formFolderService.assertSafeFormId(formId);
  } catch (err) {
    await auditLogService.logEvent({
      action: 'upload', result: 'denied', req, surveyId, formId, reason: 'invalid_form_id',
    });
    return res.status(err.statusCode || 400).json({ error: err.message });
  }

  let storageFolderName;
  try {
    storageFolderName = await formFolderService.getStorageFolderName(formId);
  } catch (err) {
    console.error(`[upload/${category}] could not resolve storage folder for form ${formId}:`, err);
    await auditLogService.logEvent({
      action: 'upload', result: 'denied', req, surveyId, formId, reason: 'form_not_found',
    });
    return res.status(err.statusCode || 400).json({ error: err.message || 'Could not resolve storage folder for this form.' });
  }

  const { buffer } = req.file;
  const mime = req.sniffedFileType.mime; // trust the sniffed type, not the client-declared one

  // Scan before the bytes ever touch disk. A positive detection or an
  // unreachable scanner (fail-closed by default — see
  // malwareScanService.js) both result in the upload being rejected.
  try {
    const scanResult = await malwareScanService.scanBuffer(buffer);
    if (!scanResult.clean) {
      await auditLogService.logEvent({
        action: 'upload', result: 'denied', req, surveyId, formId, fileType: mime, reason: `malware_detected:${scanResult.reason}`,
      });
      return res.status(422).json({ error: 'File failed a security scan and was rejected.' });
    }
  } catch (err) {
    console.error(`[upload/${category}] malware scan failed:`, err);
    await auditLogService.logEvent({
      action: 'upload', result: 'error', req, surveyId, formId, fileType: mime, reason: 'scan_unavailable',
    });
    return res.status(503).json({ error: 'File security scan is temporarily unavailable. Try again shortly.' });
  }

  try {
    const timestamp = Date.now();

    const { relativePath, bytes } = await fileStorageService.saveFile({
      surveyId,
      storageFolderName, // resolved server-side above; controls the top-level folder
      category,          // controls sub-folder + filename prefix only; not itself stored in the DB record
      buffer,
      mime,
      timestamp,
    });

    const record = await fileMetadataService.createRecord({
      firebaseUid: req.uid,
      surveyId,
      formId,
      fileType: mime,       // the actual MIME type of the bytes, e.g. "image/jpeg"
      filePath: relativePath,
      fileSize: bytes,
    });

    await auditLogService.logEvent({
      action: 'upload', result: 'success', req, fileId: record.fileId, surveyId, formId, fileType: mime,
    });

    return res.status(201).json({
      fileId: record.fileId,
      firebaseUid: record.firebaseUid,
      surveyId: record.surveyId,
      formId: record.formId,
      fileType: record.fileType,
      filePath: record.filePath,
      uploadDate: record.uploadDate.toISOString(),
      fileSize: record.fileSize,
      accessPermissions: record.accessPermissions,
    });
  } catch (err) {
    console.error(`[upload/${category}] failed:`, err);
    await auditLogService.logEvent({
      action: 'upload', result: 'error', req, surveyId, formId, fileType: mime, reason: 'internal_error',
    });
    return res.status(500).json({ error: 'Upload failed.' });
  }
}

router.post('/upload/photo', verifyFirebaseToken, uploadPhoto, (req, res) => handleUpload(req, res, 'photo'));
router.post('/upload/audio', verifyFirebaseToken, uploadAudio, (req, res) => handleUpload(req, res, 'audio'));
router.post('/upload/document', verifyFirebaseToken, uploadDocument, (req, res) => handleUpload(req, res, 'document'));

module.exports = router;
