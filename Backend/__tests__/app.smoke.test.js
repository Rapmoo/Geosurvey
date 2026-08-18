/* ===================================================================
   __tests__/app.smoke.test.js
   ---------------------------------------------------------------
   Minimal smoke test: confirms the Express app boots (all routes/
   middleware require cleanly) and the unauthenticated health check
   responds. Doesn't require real Firebase credentials — Admin SDK
   credentials are only validated lazily, on first actual use (see
   config/firebaseAdmin.js), not at require() time.

   This is intentionally small. It exists so `npm test` does
   something real instead of the placeholder `exit 1` script that
   shipped before, and so a broken require chain (missing module,
   syntax error, etc.) fails CI immediately. Add real endpoint tests
   (auth rejection, upload validation, access control) alongside this
   as the suite grows.
   =================================================================== */
const request = require('supertest');

// Required by app.js at import time (dotenv.config() reads it), but
// no real Firebase project is needed for this smoke test.
process.env.ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS || 'http://localhost:3000';

const app = require('../app');

describe('app', () => {
  test('GET /healthz responds 200 with { ok: true }', async () => {
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  test('unmatched /api route responds 404', async () => {
    const res = await request(app).get('/api/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not found.' });
  });

  test('unauthenticated file access is rejected, not allowed through', async () => {
    const res = await request(app).get('/api/files/some-id');
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});
