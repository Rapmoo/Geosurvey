/* ===================================================================
   middleware/requireRole.js
   ---------------------------------------------------------------
   Generic "only these roles may proceed" gate for endpoints that
   aren't about a specific file (where authorizeFileAccess.js's
   per-record accessPermissions check is what applies instead). Must
   run AFTER verifyFirebaseToken, which is what populates
   req.userProfile.role in the first place.

   Usage: router.get('/admin/whatever', verifyFirebaseToken,
   requireRole(ROLES.ADMIN), handler)
   =================================================================== */
function requireRole(...allowedRoles) {
  return function (req, res, next) {
    if (!req.userProfile || !allowedRoles.includes(req.userProfile.role)) {
      return res.status(403).json({ error: 'Not authorized for this endpoint.' });
    }
    next();
  };
}

module.exports = { requireRole };