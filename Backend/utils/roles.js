/* ===================================================================
   utils/roles.js
   ---------------------------------------------------------------
   Single source of truth for the app's three roles. Previously
   'admin'/'supervisor' were hardcoded as string literals in
   fileMetadataService.js (DEFAULT_ALLOWED_ROLES) with no equivalent
   constant for the third role ("field worker" — the default/base role
   with no elevated access). Centralizing them here means:

     - No typo'd role strings silently failing an `includes()` check.
     - ELEVATED_ROLES is defined once and reused anywhere "admin or
       supervisor" access needs to be granted (currently just
       fileMetadataService's default accessPermissions, but this is
       where any future elevated-role check should read from too).

   Field workers get no implicit elevated access to anyone else's
   files — they only ever see files where they are the
   `ownerUid` or have been explicitly added to `allowedUids`. That's
   enforced by authorizeFileAccess.js reading accessPermissions;
   nothing here grants access by itself.
   =================================================================== */
const ROLES = Object.freeze({
  ADMIN: 'admin',
  SUPERVISOR: 'supervisor',
  // Matches firestore.rules' isWorker() (role == 'worker') and the rest
  // of the existing app — deliberately NOT "field_worker", to avoid a
  // second, divergent role string for the same role.
  WORKER: 'worker',
});

// Roles that get access to every file by default (mirrors this app's
// existing elevated-role model in session.js / firestore.rules).
const ELEVATED_ROLES = Object.freeze([ROLES.ADMIN, ROLES.SUPERVISOR]);

module.exports = { ROLES, ELEVATED_ROLES };
