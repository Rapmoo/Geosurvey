/* ===================================================================
   middleware/verifyMonitorKey.js
   ---------------------------------------------------------------
   Auth gate for trusted monitoring agents — machine callers that
   AREN'T a signed-in GeoSurvey user. Right now that's just the
   Windows monitoring script (scripts/monitor-disk-space.ps1) posting
   disk-usage alerts to POST /api/system/alerts. Those callers have no
   Firebase Auth session and can never obtain a Firebase ID token the
   way the frontend does, so verifyFirebaseToken doesn't apply here —
   this is a separate, narrower gate used ONLY on that one ingest
   route, specifically so it's never reachable without authentication
   (see routes/systemAlerts.js).

   Model: a single shared secret, provisioned out-of-band (e.g. a
   Windows environment variable set alongside STORAGE_ROOT/etc. — see
   BACKUP_STRATEGY.md-style wrapper scripts) and configured on the
   backend via MONITOR_API_KEY. Sent as the `X-Monitor-Key` header —
   this isn't a bearer *token* in the OAuth/JWT sense, it's a static
   key issued to a specific class of caller (monitoring agents), so it
   deliberately doesn't share the Authorization header with
   verifyFirebaseToken's `Bearer <idToken>` convention for human users.

   Compared with crypto.timingSafeEqual rather than `===` so a
   response doesn't leak how many leading characters of the key were
   correct via response-time differences.

   If MONITOR_API_KEY isn't configured on this deployment at all,
   every request is rejected (503, not 401) — a missing secret should
   read as "this feature isn't set up here" for whoever's debugging,
   not as "your key was wrong." Either way, nothing about this
   endpoint is reachable without a valid key: there is no unauthenticated
   fallback path.
   =================================================================== */
const crypto = require('crypto');

function verifyMonitorKey(req, res, next) {
  const configuredKey = process.env.MONITOR_API_KEY || '';
  if (!configuredKey) {
    return res.status(503).json({ success: false, error: 'Monitoring alert ingestion is not configured on this server.' });
  }

  const providedKey = req.headers['x-monitor-key'] || '';
  const configuredBuf = Buffer.from(configuredKey);
  const providedBuf = Buffer.from(String(providedKey));

  // Buffers of different length would throw inside timingSafeEqual, so
  // that mismatch itself has to be checked outside the constant-time
  // compare — this length check alone leaks only the length of the
  // (public, non-secret) expected key, not anything about a guess.
  const isValid = configuredBuf.length === providedBuf.length
    && crypto.timingSafeEqual(configuredBuf, providedBuf);

  if (!isValid) {
    return res.status(401).json({ success: false, error: 'Missing or invalid X-Monitor-Key header.' });
  }

  next();
}

module.exports = { verifyMonitorKey };