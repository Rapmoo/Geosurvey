/* ===================================================================
   utils/authorizeFileAccess.js
   ---------------------------------------------------------------
   Who can GET or DELETE a given file — driven entirely by that file's
   own `accessPermissions` metadata (see fileMetadataService.js), not a
   hardcoded rule, so a specific file's access can diverge from the
   defaults later (e.g. shared with an additional uid) without a code
   change:

     - req.uid === accessPermissions.ownerUid            -> allowed
     - req.userProfile.role is in accessPermissions.allowedRoles
                                                            -> allowed
     - req.uid is in accessPermissions.allowedUids         -> allowed
     - otherwise                                           -> denied

   Defaults are set at upload time in fileMetadataService.js
   (owner + admin/supervisor roles), mirroring this app's existing role
   model (session.js / firestore.rules) rather than inventing a
   separate one here.
   =================================================================== */
function canAccessFile(userProfile, fileRecord) {
  if (!fileRecord) return false;
  const perms = fileRecord.accessPermissions || {};

  if (perms.ownerUid === userProfile.uid) return true;
  if (Array.isArray(perms.allowedRoles) && perms.allowedRoles.includes(userProfile.role)) return true;
  if (Array.isArray(perms.allowedUids) && perms.allowedUids.includes(userProfile.uid)) return true;

  return false;
}

module.exports = { canAccessFile };
