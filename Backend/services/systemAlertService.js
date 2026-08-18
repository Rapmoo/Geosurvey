/* ===================================================================
   services/systemAlertService.js
   ---------------------------------------------------------------
   Backs the internal alert pipeline:

     monitor-disk-space.ps1 --POST--> /api/system/alerts
                                          |
                                          v
                              systemAlertService.createAlert()
                                          |
                                          v
                        Firestore "systemAlerts" collection
                                          |
                                          v
              GET/PATCH /api/admin/system-alerts (admin dashboard)

   Collection: "systemAlerts" — deliberately separate from the
   client-writable "notifications" collection (see firestore.rules).
   Like "companyFiles", this collection is written/read ONLY through
   this backend's Admin SDK; nothing in firestore.rules grants any
   client direct access to it (the file's trailing
   `match /{document=**} { allow read, write: if false; }` default-
   deny covers it automatically), so an admin can only ever see these
   alerts through the authenticated GET below, never a raw Firestore
   listener the frontend spins up on its own.

   Every document:
     alertId        -> Firestore doc id, mirrored onto the doc itself
     type           -> e.g. "DISK_USAGE" (see ALLOWED_TYPES)
     severity       -> "WARNING" | "CRITICAL" | "INFO"
     message        -> human-readable summary, script-provided
     source         -> free-text origin, e.g. hostname of the box that
                        sent it (optional; not authenticated/verified,
                        purely informational for the dashboard)
     eventTimestamp -> the moment the SCRIPT observed the condition
                        (from the payload's `timestamp` field) — kept
                        distinct from receivedAt so a delayed/retried
                        POST doesn't misrepresent when the underlying
                        event actually happened
     receivedAt     -> Firestore server timestamp, when this backend
                        actually stored it
     acknowledged   -> bool, defaults false
     acknowledgedBy -> uid of the admin who acknowledged it, or null
     acknowledgedAt -> Firestore server timestamp, or null
     details        -> free-form object for type-specific fields
                        (storageRoot/usagePercent/freeSpaceGB/
                        totalSpaceGB for DISK_USAGE today; kept as a
                        nested object rather than flattened top-level
                        fields so future alert types can carry their
                        own shape without a schema migration)
   =================================================================== */
const { db, admin } = require('../config/firebaseAdmin');

const COLLECTION = 'systemAlerts';

// Extend this as new monitoring scripts/checks come online (e.g. a
// future BACKUP_FAILURE or CERT_EXPIRY alert type) — the ingest route
// rejects anything not in this list rather than silently accepting
// arbitrary type strings from whatever's POSTing to it.
const ALLOWED_TYPES = ['DISK_USAGE'];
const ALLOWED_SEVERITIES = ['INFO', 'WARNING', 'CRITICAL'];

const MAX_MESSAGE_LEN = 2000;
const MAX_STRING_FIELD_LEN = 500;

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

function isFiniteNumber(n) {
  return typeof n === 'number' && Number.isFinite(n);
}

/**
 * Validates the raw HTTP body from the monitoring script. Throws a
 * 400-flagged error describing the first problem found, rather than
 * collecting every error at once — this endpoint is machine-to-
 * machine, not a form, so a single clear reason is more useful than a
 * field-by-field report.
 */
function validateAlertPayload(body) {
  if (!body || typeof body !== 'object') throw badRequest('Request body must be a JSON object.');

  const { type, severity, message, timestamp } = body;

  if (typeof type !== 'string' || !ALLOWED_TYPES.includes(type)) {
    throw badRequest(`"type" must be one of: ${ALLOWED_TYPES.join(', ')}`);
  }
  if (typeof severity !== 'string' || !ALLOWED_SEVERITIES.includes(severity)) {
    throw badRequest(`"severity" must be one of: ${ALLOWED_SEVERITIES.join(', ')}`);
  }
  if (typeof message !== 'string' || !message.trim()) {
    throw badRequest('"message" is required and must be a non-empty string.');
  }
  if (message.length > MAX_MESSAGE_LEN) {
    throw badRequest(`"message" must be ${MAX_MESSAGE_LEN} characters or fewer.`);
  }
  if (typeof timestamp !== 'string' || Number.isNaN(Date.parse(timestamp))) {
    throw badRequest('"timestamp" is required and must be a valid ISO 8601 date string.');
  }

  // Type-specific required fields. DISK_USAGE is the only type today
  // (from monitor-disk-space.ps1); a future type would get its own
  // branch here rather than making these fields universally required.
  if (type === 'DISK_USAGE') {
    const { storageRoot, usagePercent, freeSpaceGB, totalSpaceGB } = body;
    if (typeof storageRoot !== 'string' || !storageRoot.trim()) {
      throw badRequest('"storageRoot" is required for DISK_USAGE alerts.');
    }
    if (storageRoot.length > MAX_STRING_FIELD_LEN) {
      throw badRequest(`"storageRoot" must be ${MAX_STRING_FIELD_LEN} characters or fewer.`);
    }
    if (!isFiniteNumber(usagePercent) || usagePercent < 0 || usagePercent > 100) {
      throw badRequest('"usagePercent" is required and must be a number between 0 and 100.');
    }
    if (!isFiniteNumber(freeSpaceGB) || freeSpaceGB < 0) {
      throw badRequest('"freeSpaceGB" is required and must be a non-negative number.');
    }
    if (!isFiniteNumber(totalSpaceGB) || totalSpaceGB < 0) {
      throw badRequest('"totalSpaceGB" is required and must be a non-negative number.');
    }
  }
}

/**
 * Builds the type-specific `details` sub-object from a validated
 * payload. Keeping this separate from validateAlertPayload keeps
 * "is this shape allowed" and "what do we actually persist" as two
 * distinct concerns.
 */
function buildDetails(body) {
  if (body.type === 'DISK_USAGE') {
    return {
      storageRoot: body.storageRoot,
      usagePercent: body.usagePercent,
      freeSpaceGB: body.freeSpaceGB,
      totalSpaceGB: body.totalSpaceGB,
    };
  }
  return {};
}

async function createAlert(body) {
  validateAlertPayload(body);

  const docRef = db.collection(COLLECTION).doc();
  const doc = {
    alertId: docRef.id,
    type: body.type,
    severity: body.severity,
    message: body.message.trim(),
    source: typeof body.source === 'string' ? body.source.slice(0, MAX_STRING_FIELD_LEN) : null,
    eventTimestamp: admin.firestore.Timestamp.fromDate(new Date(body.timestamp)),
    receivedAt: admin.firestore.FieldValue.serverTimestamp(),
    acknowledged: false,
    acknowledgedBy: null,
    acknowledgedAt: null,
    details: buildDetails(body),
  };

  await docRef.set(doc);
  // Mirror serverTimestamp() as a client-visible Date for the
  // immediate HTTP response, same pattern as fileMetadataService's
  // createRecord — the write itself uses FieldValue.serverTimestamp(),
  // but the caller (the monitoring script, which only cares about a
  // 2xx/4xx here, not this value) gets something JSON-serializable
  // back immediately rather than an unresolved sentinel.
  return { ...doc, receivedAt: new Date() };
}

/**
 * listAlerts({ limit, severity, acknowledged }) — used by the admin
 * dashboard. Defaults to the most recent 50 alerts, newest first by
 * the event's own timestamp (not receivedAt), so a delayed POST still
 * sorts where it actually happened rather than when it arrived.
 */
async function listAlerts({ limit = 50, severity, acknowledged } = {}) {
  const cappedLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);

  let q = db.collection(COLLECTION).orderBy('eventTimestamp', 'desc').limit(cappedLimit);
  if (typeof severity === 'string' && ALLOWED_SEVERITIES.includes(severity)) {
    q = q.where('severity', '==', severity);
  }
  if (acknowledged === 'true' || acknowledged === true) {
    q = q.where('acknowledged', '==', true);
  } else if (acknowledged === 'false' || acknowledged === false) {
    q = q.where('acknowledged', '==', false);
  }

  const snap = await q.get();
  return snap.docs.map((d) => d.data());
}

async function acknowledgeAlert(id, adminUid) {
  const ref = db.collection(COLLECTION).doc(id);
  const snap = await ref.get();
  if (!snap.exists) {
    const err = new Error('Alert not found.');
    err.statusCode = 404;
    throw err;
  }
  await ref.update({
    acknowledged: true,
    acknowledgedBy: adminUid,
    acknowledgedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  const updated = await ref.get();
  return updated.data();
}

module.exports = {
  createAlert,
  listAlerts,
  acknowledgeAlert,
  ALLOWED_TYPES,
  ALLOWED_SEVERITIES,
};