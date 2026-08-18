/* ===================================================================
   services/fileMetadataService.js
   ---------------------------------------------------------------
   Firestore holds metadata ONLY — never file bytes (those live in
   fileStorageService's company-owned storage). Every record has
   exactly these fields, matching the app's data model 1:1:

     file_id             -> Firestore doc id (docRef.id), also mirrored
                             onto the doc itself as `fileId` so it's
                             visible in exports/queries without a join
     Firebase user UID    -> firebaseUid   (who uploaded it)
     survey ID             -> surveyId      (which survey it belongs to)
     form ID                -> formId        (which form this survey's
                                              submission was filled out
                                              against — added alongside
                                              the storage-folder-per-form
                                              work; lets files be queried
                                              by form without parsing
                                              filePath, and is the same
                                              formId used to resolve
                                              storageFolderName at
                                              upload time, see
                                              formFolderService.js)
     file type              -> fileType      (sniffed MIME type, e.g.
                                              "image/jpeg" — the actual
                                              type of the bytes, not
                                              just "photo/audio/doc";
                                              which folder it's in
                                              already encodes that, see
                                              filePath)
     file path                -> filePath      (relative path under
                                              STORAGE_ROOT, e.g.
                                              "Building Survey/photo/photo_survey123_...jpg")
     upload date                -> uploadDate    (Firestore server timestamp)
     file size                    -> fileSize      (bytes)
     access permissions            -> accessPermissions (see below)

   No other fields are stored — deliberately not persisting the
   client's original filename or anything else outside this list.

   accessPermissions shape:
     { ownerUid: <uid>, allowedRoles: [...], allowedUids: [...] }
   `ownerUid` always grants access. `allowedRoles` defaults to
   ELEVATED_ROLES (admin + supervisor — see utils/roles.js, the single
   place that string is defined) to match this app's existing
   elevated-role model (session.js / firestore.rules). A worker gets
   NO implicit access beyond files they own — `allowedUids` starts
   empty and exists so a specific file can be shared with named users
   later without changing the schema.
   utils/authorizeFileAccess.js is what actually evaluates this on
   every GET/DELETE.

   Collection: "companyFiles" (kept distinct from the app's existing
   Firestore collections like users/, notifications/, submissions/, so
   firestore.rules for those is unaffected — this backend is the only
   thing that ever reads/writes companyFiles, via the Admin SDK, which
   bypasses Security Rules entirely; the rules file's trailing
   `match /{document=**} { allow read, write: if false; }` default-deny
   also means no client can ever reach this collection directly even by
   accident).
   =================================================================== */
const { db, admin } = require('../config/firebaseAdmin');
const { ELEVATED_ROLES } = require('../utils/roles');

const COLLECTION = 'companyFiles';

async function createRecord({ firebaseUid, surveyId, formId, fileType, filePath, fileSize, accessPermissions }) {
  const docRef = db.collection(COLLECTION).doc(); // server-generated id, unrelated to the on-disk filename

  const permissions = accessPermissions || {
    ownerUid: firebaseUid,
    allowedRoles: ELEVATED_ROLES,
    allowedUids: [],
  };

  const doc = {
    fileId: docRef.id,
    firebaseUid,
    surveyId,
    formId,
    fileType,
    filePath,
    uploadDate: admin.firestore.FieldValue.serverTimestamp(),
    fileSize,
    accessPermissions: permissions,
  };
  await docRef.set(doc);
  return { ...doc, uploadDate: new Date() };
}

async function getRecord(id) {
  const snap = await db.collection(COLLECTION).doc(id).get();
  if (!snap.exists) return null;
  return snap.data();
}

async function deleteRecord(id) {
  await db.collection(COLLECTION).doc(id).delete();
}

module.exports = { createRecord, getRecord, deleteRecord, DEFAULT_ALLOWED_ROLES: ELEVATED_ROLES };
