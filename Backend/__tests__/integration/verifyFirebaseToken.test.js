/* ===================================================================
   verifyFirebaseToken.test.js
   ---------------------------------------------------------------
   Every route in the API sits behind this middleware, so its
   rejection paths are the single highest-value thing to have real
   tests for. config/firebaseAdmin is mocked so these run without a
   real Firebase project, real network access, or real credentials —
   only the Admin SDK's *interface* (auth.verifyIdToken, db.collection)
   is faked, not its behavior; each test controls exactly what that
   fake returns/throws to exercise one specific branch.
   =================================================================== */
const express = require('express');
const request = require('supertest');

jest.mock('../../config/firebaseAdmin', () => ({
  auth: { verifyIdToken: jest.fn() },
  db: { collection: jest.fn() },
}));

const { auth, db } = require('../../config/firebaseAdmin');
const { verifyFirebaseToken } = require('../../middleware/verifyFirebaseToken');

function buildTestApp() {
  const app = express();
  app.get('/protected', verifyFirebaseToken, (req, res) => {
    res.status(200).json({ uid: req.uid, role: req.userProfile.role });
  });
  return app;
}

// Helper to make db.collection('users').doc(uid).get() resolve/reject
// however a given test needs.
function mockUserProfileGet(implementation) {
  db.collection.mockReturnValue({
    doc: jest.fn().mockReturnValue({ get: implementation }),
  });
}

describe('verifyFirebaseToken', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildTestApp();
  });

  test('rejects with 401 when Authorization header is missing entirely', async () => {
    const res = await request(app).get('/protected');
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/Missing or malformed Authorization header/);
    expect(auth.verifyIdToken).not.toHaveBeenCalled();
  });

  test('rejects with 401 when the header does not use the Bearer scheme', async () => {
    const res = await request(app).get('/protected').set('Authorization', 'Basic sometoken');
    expect(res.status).toBe(401);
    expect(auth.verifyIdToken).not.toHaveBeenCalled();
  });

  test('rejects with 401 when Bearer scheme is present but the token is empty', async () => {
    const res = await request(app).get('/protected').set('Authorization', 'Bearer ');
    expect(res.status).toBe(401);
    expect(auth.verifyIdToken).not.toHaveBeenCalled();
  });

  test('rejects with 401 when the token fails verification (invalid/expired/wrong project)', async () => {
    auth.verifyIdToken.mockRejectedValue(Object.assign(new Error('bad token'), { code: 'auth/argument-error' }));

    const res = await request(app).get('/protected').set('Authorization', 'Bearer garbage-token');

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/Invalid or expired token/);
  });

  test('rejects with 401 and a distinct message when the token was revoked', async () => {
    auth.verifyIdToken.mockRejectedValue(Object.assign(new Error('revoked'), { code: 'auth/id-token-revoked' }));

    const res = await request(app).get('/protected').set('Authorization', 'Bearer revoked-token');

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/Session revoked/);
  });

  test('calls verifyIdToken with checkRevoked=true so signOut() takes effect immediately', async () => {
    auth.verifyIdToken.mockResolvedValue({ uid: 'u1' });
    mockUserProfileGet(jest.fn().mockResolvedValue({ exists: true, data: () => ({ role: 'worker', active: true }) }));

    await request(app).get('/protected').set('Authorization', 'Bearer valid-token');

    expect(auth.verifyIdToken).toHaveBeenCalledWith('valid-token', true);
  });

  test('rejects with 403 when the token is valid but no users/{uid} profile exists', async () => {
    auth.verifyIdToken.mockResolvedValue({ uid: 'ghost-uid' });
    mockUserProfileGet(jest.fn().mockResolvedValue({ exists: false }));

    const res = await request(app).get('/protected').set('Authorization', 'Bearer valid-token');

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/No GeoSurvey profile/);
  });

  test('rejects with 403 when the account has been explicitly disabled (active === false)', async () => {
    auth.verifyIdToken.mockResolvedValue({ uid: 'disabled-uid' });
    mockUserProfileGet(jest.fn().mockResolvedValue({
      exists: true,
      data: () => ({ role: 'worker', active: false }),
    }));

    const res = await request(app).get('/protected').set('Authorization', 'Bearer valid-token');

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/disabled/);
  });

  test('rejects with 503 when the Firestore profile lookup itself fails', async () => {
    auth.verifyIdToken.mockResolvedValue({ uid: 'u1' });
    mockUserProfileGet(jest.fn().mockRejectedValue(new Error('firestore unavailable')));

    const res = await request(app).get('/protected').set('Authorization', 'Bearer valid-token');

    expect(res.status).toBe(503);
  });

  test('allows the request through and attaches req.uid/req.userProfile on success', async () => {
    auth.verifyIdToken.mockResolvedValue({ uid: 'good-uid' });
    mockUserProfileGet(jest.fn().mockResolvedValue({
      exists: true,
      data: () => ({ role: 'admin', active: true }),
    }));

    const res = await request(app).get('/protected').set('Authorization', 'Bearer valid-token');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ uid: 'good-uid', role: 'admin' });
  });

  test('treats a profile with no explicit "active" field as active (undefined !== false)', async () => {
    auth.verifyIdToken.mockResolvedValue({ uid: 'legacy-uid' });
    mockUserProfileGet(jest.fn().mockResolvedValue({
      exists: true,
      data: () => ({ role: 'worker' }), // no `active` field at all
    }));

    const res = await request(app).get('/protected').set('Authorization', 'Bearer valid-token');

    expect(res.status).toBe(200);
  });

  test('a demoted/disabled account loses access on the very next request, not just next login', async () => {
    // First request: still an active admin.
    auth.verifyIdToken.mockResolvedValue({ uid: 'was-admin' });
    mockUserProfileGet(jest.fn().mockResolvedValue({
      exists: true,
      data: () => ({ role: 'admin', active: true }),
    }));
    const firstRes = await request(app).get('/protected').set('Authorization', 'Bearer valid-token');
    expect(firstRes.status).toBe(200);

    // Second request, same token: profile has since been disabled server-side.
    mockUserProfileGet(jest.fn().mockResolvedValue({
      exists: true,
      data: () => ({ role: 'admin', active: false }),
    }));
    const secondRes = await request(app).get('/protected').set('Authorization', 'Bearer valid-token');
    expect(secondRes.status).toBe(403);
  });
});
