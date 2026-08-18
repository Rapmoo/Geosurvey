/* ===================================================================
   files.routes.test.js
   ---------------------------------------------------------------
   End-to-end (within the process) test of GET/DELETE /api/files/:id:
   real verifyFirebaseToken + real canAccessFile, with only the
   external edges mocked (Firebase Admin SDK, Firestore-backed
   services, disk I/O). This is what actually proves a worker cannot
   read or delete another worker's uploads while an admin/supervisor
   can -- the property the whole authorization model exists for.
   =================================================================== */
const express = require('express');
const request = require('supertest');

jest.mock('../../config/firebaseAdmin', () => ({
  auth: { verifyIdToken: jest.fn() },
  db: { collection: jest.fn() },
  admin: { firestore: { FieldValue: { serverTimestamp: jest.fn() } } },
}));
jest.mock('../../services/fileMetadataService');
jest.mock('../../services/fileStorageService');
jest.mock('../../services/auditLogService');

const { auth, db } = require('../../config/firebaseAdmin');
const fileMetadataService = require('../../services/fileMetadataService');
const fileStorageService = require('../../services/fileStorageService');
const auditLogService = require('../../services/auditLogService');
const filesRouter = require('../../routes/files');
const { ROLES } = require('../../utils/roles');

function buildTestApp() {
  const app = express();
  app.use('/api', filesRouter);
  return app;
}

function signedInAs(uid, role, { active = true } = {}) {
  auth.verifyIdToken.mockResolvedValue({ uid });
  db.collection.mockReturnValue({
    doc: jest.fn().mockReturnValue({
      get: jest.fn().mockResolvedValue({ exists: true, data: () => ({ role, active }) }),
    }),
  });
}

// Every signedInAs() caller needs an actual Bearer token on the
// request too -- signedInAs only controls what the mocked Admin SDK
// *returns*, it doesn't attach anything to the outgoing request.
const AUTHED_HEADER = { Authorization: 'Bearer test-token' };
const authedGet = (app, url) => request(app).get(url).set(AUTHED_HEADER);
const authedDelete = (app, url) => request(app).delete(url).set(AUTHED_HEADER);

const VALID_FILE_ID = 'aBcD1234efGH5678';

describe('GET /api/files/:id', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    auditLogService.logEvent.mockResolvedValue();
    app = buildTestApp();
  });

  test('rejects an unauthenticated request with 401 before ever looking up the file', async () => {
    const res = await request(app).get(`/api/files/${VALID_FILE_ID}`);
    expect(res.status).toBe(401);
    expect(fileMetadataService.getRecord).not.toHaveBeenCalled();
  });

  test('rejects a malformed/unsafe id with 400 before any auth-adjacent lookup', async () => {
    signedInAs('worker-1', ROLES.WORKER);
    const res = await authedGet(app, '/api/files/..%2F..%2Fetc%2Fpasswd');
    expect(res.status).toBe(400);
    expect(fileMetadataService.getRecord).not.toHaveBeenCalled();
  });

  test('returns 404 (and audit-logs it) when the file record does not exist', async () => {
    signedInAs('worker-1', ROLES.WORKER);
    fileMetadataService.getRecord.mockResolvedValue(null);

    const res = await authedGet(app, `/api/files/${VALID_FILE_ID}`);

    expect(res.status).toBe(404);
    expect(auditLogService.logEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'download', result: 'not_found' }));
  });

  test("a worker CANNOT read another worker's file (403), and it never touches storage", async () => {
    signedInAs('worker-b', ROLES.WORKER);
    fileMetadataService.getRecord.mockResolvedValue({
      fileType: 'image/jpeg',
      filePath: 'FormA/photo/photo_1.jpg',
      surveyId: 'survey-1',
      accessPermissions: { ownerUid: 'worker-a', allowedRoles: [ROLES.ADMIN, ROLES.SUPERVISOR], allowedUids: [] },
    });

    const res = await authedGet(app, `/api/files/${VALID_FILE_ID}`);

    expect(res.status).toBe(403);
    expect(fileStorageService.readFile).not.toHaveBeenCalled();
    expect(auditLogService.logEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'download', result: 'denied', reason: 'not_authorized' }));
  });

  test('the owning worker CAN read their own file', async () => {
    signedInAs('worker-a', ROLES.WORKER);
    fileMetadataService.getRecord.mockResolvedValue({
      fileType: 'image/jpeg',
      filePath: 'FormA/photo/photo_1.jpg',
      surveyId: 'survey-1',
      accessPermissions: { ownerUid: 'worker-a', allowedRoles: [ROLES.ADMIN, ROLES.SUPERVISOR], allowedUids: [] },
    });
    fileStorageService.readFile.mockResolvedValue(Buffer.from('fake-bytes'));

    const res = await authedGet(app, `/api/files/${VALID_FILE_ID}`);

    expect(res.status).toBe(200);
    expect(auditLogService.logEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'download', result: 'success' }));
  });

  test("an admin CAN read a worker's file via allowedRoles, without owning it", async () => {
    signedInAs('admin-1', ROLES.ADMIN);
    fileMetadataService.getRecord.mockResolvedValue({
      fileType: 'image/jpeg',
      filePath: 'FormA/photo/photo_1.jpg',
      surveyId: 'survey-1',
      accessPermissions: { ownerUid: 'worker-a', allowedRoles: [ROLES.ADMIN, ROLES.SUPERVISOR], allowedUids: [] },
    });
    fileStorageService.readFile.mockResolvedValue(Buffer.from('fake-bytes'));

    const res = await authedGet(app, `/api/files/${VALID_FILE_ID}`);

    expect(res.status).toBe(200);
  });

  test('a disabled account is rejected with 403 before the file lookup even happens', async () => {
    signedInAs('worker-1', ROLES.WORKER, { active: false });

    const res = await authedGet(app, `/api/files/${VALID_FILE_ID}`);

    expect(res.status).toBe(403);
    expect(fileMetadataService.getRecord).not.toHaveBeenCalled();
  });

  test('an internal storage error results in 500, not a crash, and is audit-logged', async () => {
    signedInAs('worker-a', ROLES.WORKER);
    fileMetadataService.getRecord.mockResolvedValue({
      fileType: 'image/jpeg',
      filePath: 'FormA/photo/photo_1.jpg',
      surveyId: 'survey-1',
      accessPermissions: { ownerUid: 'worker-a', allowedRoles: [], allowedUids: [] },
    });
    fileStorageService.readFile.mockRejectedValue(new Error('disk on fire'));
    jest.spyOn(console, 'error').mockImplementation(() => {});

    const res = await authedGet(app, `/api/files/${VALID_FILE_ID}`);

    expect(res.status).toBe(500);
    expect(auditLogService.logEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'download', result: 'error' }));
  });
});

describe('DELETE /api/files/:id', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    auditLogService.logEvent.mockResolvedValue();
    app = buildTestApp();
  });

  test('rejects an unauthenticated delete with 401', async () => {
    const res = await request(app).delete(`/api/files/${VALID_FILE_ID}`);
    expect(res.status).toBe(401);
    expect(fileMetadataService.deleteRecord).not.toHaveBeenCalled();
  });

  test("a worker CANNOT delete another worker's file", async () => {
    signedInAs('worker-b', ROLES.WORKER);
    fileMetadataService.getRecord.mockResolvedValue({
      fileType: 'image/jpeg',
      filePath: 'FormA/photo/photo_1.jpg',
      surveyId: 'survey-1',
      accessPermissions: { ownerUid: 'worker-a', allowedRoles: [ROLES.ADMIN], allowedUids: [] },
    });

    const res = await authedDelete(app, `/api/files/${VALID_FILE_ID}`);

    expect(res.status).toBe(403);
    expect(fileMetadataService.deleteRecord).not.toHaveBeenCalled();
    expect(fileStorageService.deleteFile).not.toHaveBeenCalled();
  });

  test('the owner CAN delete their own file, and metadata is removed before bytes (write-order guarantee)', async () => {
    signedInAs('worker-a', ROLES.WORKER);
    fileMetadataService.getRecord.mockResolvedValue({
      fileType: 'image/jpeg',
      filePath: 'FormA/photo/photo_1.jpg',
      surveyId: 'survey-1',
      accessPermissions: { ownerUid: 'worker-a', allowedRoles: [], allowedUids: [] },
    });
    const callOrder = [];
    fileMetadataService.deleteRecord.mockImplementation(async () => { callOrder.push('metadata'); });
    fileStorageService.deleteFile.mockImplementation(async () => { callOrder.push('bytes'); });

    const res = await authedDelete(app, `/api/files/${VALID_FILE_ID}`);

    expect(res.status).toBe(204);
    expect(callOrder).toEqual(['metadata', 'bytes']);
    expect(auditLogService.logEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'delete', result: 'success' }));
  });

  test('returns 404 when deleting a file id that does not exist', async () => {
    signedInAs('worker-a', ROLES.WORKER);
    fileMetadataService.getRecord.mockResolvedValue(null);

    const res = await authedDelete(app, `/api/files/${VALID_FILE_ID}`);

    expect(res.status).toBe(404);
  });

  test('a supervisor CAN delete a file they do not own, via allowedRoles', async () => {
    signedInAs('supervisor-1', ROLES.SUPERVISOR);
    fileMetadataService.getRecord.mockResolvedValue({
      fileType: 'image/jpeg',
      filePath: 'FormA/photo/photo_1.jpg',
      surveyId: 'survey-1',
      accessPermissions: { ownerUid: 'worker-a', allowedRoles: [ROLES.ADMIN, ROLES.SUPERVISOR], allowedUids: [] },
    });
    fileMetadataService.deleteRecord.mockResolvedValue();
    fileStorageService.deleteFile.mockResolvedValue();

    const res = await authedDelete(app, `/api/files/${VALID_FILE_ID}`);

    expect(res.status).toBe(204);
  });
});
