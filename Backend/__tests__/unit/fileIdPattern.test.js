/* ===================================================================
   fileIdPattern.test.js
   ---------------------------------------------------------------
   isValidFileId is the first line of defense before req.params.id is
   ever used to build a Firestore doc path (routes/files.js). These
   tests focus especially on the inputs an attacker would actually
   try: path traversal, null bytes, and oversized ids.
   =================================================================== */
const { isValidFileId } = require('../../utils/fileIdPattern');

describe('isValidFileId', () => {
  test('accepts a typical Firestore auto-generated id', () => {
    expect(isValidFileId('aB3xQ9zT7mK2pL8w')).toBe(true);
  });

  test('accepts ids with hyphens and underscores', () => {
    expect(isValidFileId('file-id_123')).toBe(true);
  });

  test('rejects path traversal attempts', () => {
    expect(isValidFileId('../../etc/passwd')).toBe(false);
    expect(isValidFileId('..%2F..%2Fetc%2Fpasswd')).toBe(false);
    expect(isValidFileId('....//....//etc/passwd')).toBe(false);
  });

  test('rejects ids containing a path separator', () => {
    expect(isValidFileId('sub/dir')).toBe(false);
    expect(isValidFileId('sub\\dir')).toBe(false);
  });

  test('rejects empty string', () => {
    expect(isValidFileId('')).toBe(false);
  });

  test('rejects ids over 64 characters', () => {
    expect(isValidFileId('a'.repeat(65))).toBe(false);
  });

  test('accepts an id at exactly the 64 character boundary', () => {
    expect(isValidFileId('a'.repeat(64))).toBe(true);
  });

  test('rejects non-string input without throwing', () => {
    expect(() => isValidFileId(null)).not.toThrow();
    expect(() => isValidFileId(undefined)).not.toThrow();
    expect(isValidFileId(null)).toBe(false);
    expect(isValidFileId(undefined)).toBe(false);
    expect(isValidFileId(12345)).toBe(false);
    expect(isValidFileId({})).toBe(false);
    expect(isValidFileId(['x'])).toBe(false);
  });

  test('rejects ids with embedded null bytes or whitespace', () => {
    expect(isValidFileId('abc\0def')).toBe(false);
    expect(isValidFileId('abc def')).toBe(false);
    expect(isValidFileId(' abc')).toBe(false);
    expect(isValidFileId('abc\n')).toBe(false);
  });
});
