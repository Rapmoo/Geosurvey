/* ===================================================================
   uploadValidation.test.js
   ---------------------------------------------------------------
   Exercises the real multer + file-type pipeline end to end — no
   mocking of file-type or multer, since the whole point of this
   middleware is "does the actual byte content match what's claimed."
   Fixtures are minimal-but-real file headers (just enough for magic-
   byte sniffing to positively identify them), not full valid images —
   file-type only reads the header, so that's sufficient and keeps
   fixtures inline instead of needing binary test assets on disk.

   Covers the specific properties called out in README.md's Security
   notes: declared mimetype is never trusted, size limits are
   enforced, and content is verified against real bytes, not headers.
   =================================================================== */
const express = require('express');
const request = require('supertest');
const { uploadPhoto, uploadDocument } = require('../../middleware/uploadValidation');

// Minimal real magic-byte headers -- enough for `file-type` to
// positively sniff each format without needing a fully valid image.
const REAL_PNG_BYTES = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108020000009077' +
  '53de0000000049454e44ae426082',
  'hex',
);
const REAL_JPEG_BYTES = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex');
const REAL_PDF_BYTES = Buffer.from('%PDF-1.4\n%%EOF');
// Real GIF magic bytes -- used to simulate a client lying about the
// Content-Type of a non-photo file it's trying to pass off as a jpeg.
const REAL_GIF_BYTES = Buffer.from('GIF89a' + '\x00'.repeat(20));

function buildTestApp() {
  const app = express();
  app.post('/upload/photo', uploadPhoto, (req, res) => {
    res.status(200).json({ ok: true, sniffed: req.sniffedFileType });
  });
  app.post('/upload/document', uploadDocument, (req, res) => {
    res.status(200).json({ ok: true, sniffed: req.sniffedFileType });
  });
  return app;
}

describe('upload validation middleware', () => {
  let app;
  let consoleLogSpy;
  let consoleWarnSpy;
  let consoleErrorSpy;

  beforeEach(() => {
    app = buildTestApp();
    // The middleware intentionally logs on every upload (debug) and on
    // rejected content (warn) -- silence it so test output stays
    // readable, without hiding a genuine test failure.
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  test('accepts a real PNG with correct declared content-type', async () => {
    const res = await request(app)
      .post('/upload/photo')
      .attach('file', REAL_PNG_BYTES, { filename: 'photo.png', contentType: 'image/png' });

    expect(res.status).toBe(200);
    expect(res.body.sniffed.mime).toBe('image/png');
  });

  test('accepts a real JPEG with correct declared content-type', async () => {
    const res = await request(app)
      .post('/upload/photo')
      .attach('file', REAL_JPEG_BYTES, { filename: 'photo.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(200);
    expect(res.body.sniffed.mime).toBe('image/jpeg');
  });

  test('rejects when no file field is sent at all', async () => {
    const res = await request(app).post('/upload/photo');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/No file provided/);
  });

  test("rejects a declared content-type multer's fileFilter doesn't allow (e.g. text/plain for a photo)", async () => {
    const res = await request(app)
      .post('/upload/photo')
      .attach('file', Buffer.from('not a photo'), { filename: 'notes.txt', contentType: 'text/plain' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Unsupported file type/);
  });

  test('rejects a file whose real bytes do NOT match the declared, allowed content-type (spoofing)', async () => {
    // Declares image/jpeg (passes multer's fileFilter, which only
    // checks the header multer itself sees) but the actual bytes are
    // a GIF -- the magic-byte sniff must catch this even though the
    // declared type was on the allowlist.
    const res = await request(app)
      .post('/upload/photo')
      .attach('file', REAL_GIF_BYTES, { filename: 'fake.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/does not match an allowed type/);
  });

  test('rejects a file larger than the configured limit with 413', async () => {
    const oversized = Buffer.concat([REAL_JPEG_BYTES, Buffer.alloc(Number(process.env.MAX_PHOTO_BYTES || 15 * 1024 * 1024) + 1)]);
    const res = await request(app)
      .post('/upload/photo')
      .attach('file', oversized, { filename: 'huge.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(413);
    expect(res.body.error).toMatch(/too large/i);
  });

  test('accepts a real PDF document', async () => {
    const res = await request(app)
      .post('/upload/document')
      .attach('file', REAL_PDF_BYTES, { filename: 'report.pdf', contentType: 'application/pdf' });

    expect(res.status).toBe(200);
    expect(res.body.sniffed.mime).toBe('application/pdf');
  });

  test('accepts plain CSV text via the text-fallback path (file-type cannot sniff plain text)', async () => {
    const res = await request(app)
      .post('/upload/document')
      .attach('file', Buffer.from('name,value\nfoo,1\n'), { filename: 'data.csv', contentType: 'text/csv' });

    expect(res.status).toBe(200);
    expect(res.body.sniffed.mime).toBe('text/csv');
  });

  test('rejects CSV-declared content containing a NUL byte (fails the plain-text sanity check)', async () => {
    const res = await request(app)
      .post('/upload/document')
      .attach('file', Buffer.from('name,value\x00\nfoo,1\n'), { filename: 'data.csv', contentType: 'text/csv' });

    expect(res.status).toBe(400);
  });

  test('a PDF submitted to the photo endpoint is rejected even though PDF is a real, valid type elsewhere', async () => {
    const res = await request(app)
      .post('/upload/photo')
      .attach('file', REAL_PDF_BYTES, { filename: 'sneaky.pdf', contentType: 'image/jpeg' });

    // Declared content-type is on the photo allowlist (passes multer's
    // fileFilter), but the real bytes are a PDF -- must be caught by
    // the magic-byte layer, not just the declared-type layer.
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/does not match an allowed type/);
  });
});
