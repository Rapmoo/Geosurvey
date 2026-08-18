/* ===================================================================
   utils/fileIdPattern.js
   ---------------------------------------------------------------
   Single source of truth for "what does a valid backend file ID look
   like" — a Firestore auto-generated companyFiles doc id (see
   fileMetadataService.js: db.collection('companyFiles').doc(), and
   its accompanying field doc: "file_id -> Firestore doc id
   (docRef.id)").

   Previously this pattern only existed inline in routes/files.js as
   ID_PATTERN, checked on the way IN to a GET/DELETE request. That's a
   consumer-side check — it protects the read/delete routes, but gives
   nothing that PRODUCES a file id (e.g. services/koboService.js,
   after calling fileMetadataService.createRecord) any importable way
   to confirm its own output actually matches what those routes will
   later require. That gap is exactly how a Kobo-imported submission
   could previously end up with fileMetadataService's filePath (a
   "<Form Folder>/photo/photo_....jpg" style relative path) sitting in
   photoUrl/voiceUrl instead of the record's fileId — nothing on the
   write side ever checked the value against the shape the read side
   was going to demand.

   Extracted here so a producer and the consumer share ONE definition
   instead of two copies that could silently drift apart again.

   routes/files.js's request-validation BEHAVIOR is unchanged by this
   extraction: it still runs the exact same regex, against the exact
   same input (req.params.id), at the exact same point in the request
   lifecycle, returning the exact same 400 "Invalid file id." This
   file only gives that regex a name other modules can import instead
   of duplicating it.
   =================================================================== */
const FILE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function isValidFileId(id) {
  return typeof id === 'string' && FILE_ID_PATTERN.test(id);
}

module.exports = { FILE_ID_PATTERN, isValidFileId };