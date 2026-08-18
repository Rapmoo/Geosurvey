/* ===================================================================
   services/auditLogService.js
   ---------------------------------------------------------------
   Append-only audit trail for every upload, download, and delete
   attempt — including denied and failed ones, since "someone tried to
   access a file they don't own" is exactly the kind of event a
   security review needs to find later.

   Stored in Firestore as a SEPARATE collection ("auditLogs") from
   companyFiles, written only by this backend via the Admin SDK
   (same trust boundary as companyFiles — see fileMetadataService.js).
   Never mutated or deleted by app code; treat it as append-only.

   Each entry:
     action       -> 'upload' | 'download' | 'delete'
     result       -> 'success' | 'denied' | 'not_found' | 'error'
     uid          -> caller's Firebase uid (null if auth itself failed
                     upstream, though verifyFirebaseToken always runs
                     before any route that logs)
     role         -> caller's role at the time of the request
     fileId       -> Firestore companyFiles doc id, when known
     surveyId     -> which survey the file belongs to, when known
     fileType     -> mime type, when known
     reason       -> short machine-readable reason for denied/error
                     results (e.g. 'not_owner', 'malware_detected')
     ip           -> req.ip (respects `trust proxy`, already set in
                     app.js, so this is the real client IP behind a
                     reverse proxy, not the proxy's own address)
     userAgent    -> req.headers['user-agent']
     timestamp    -> Firestore server timestamp

   Logging failures must NEVER break the actual request — a Firestore
   hiccup here should not turn a successful download into a 500. Every
   call is fire-and-forget from the caller's perspective: awaited so
   ordering is preserved for tests, but errors are caught and only
   console.error'd, never rethrown.
   =================================================================== */
const { db, admin } = require('../config/firebaseAdmin');

const COLLECTION = 'auditLogs';

async function logEvent({ action, result, req, fileId = null, surveyId = null, fileType = null, reason = null }) {
  try {
    const entry = {
      action,
      result,
      uid: (req && req.uid) || null,
      role: (req && req.userProfile && req.userProfile.role) || null,
      fileId,
      surveyId,
      fileType,
      reason,
      ip: (req && req.ip) || null,
      userAgent: (req && req.headers && req.headers['user-agent']) || null,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    };
    await db.collection(COLLECTION).add(entry);
  } catch (err) {
    // Auditing is best-effort. Losing an audit entry is bad; failing
    // the user's request because Firestore hiccuped is worse.
    console.error('[auditLogService] failed to write audit entry:', err);
  }
}

module.exports = { logEvent };
