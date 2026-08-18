/* ===================================================================
   routes/systemAlerts.js
   ---------------------------------------------------------------
   Windows Monitoring Script
           | HTTP POST (X-Monitor-Key)
           v
   POST /api/system/alerts        <- this file, verifyMonitorKey
           |
           v
   systemAlertService.createAlert (validates + stores in Firestore)
           |
           v
   GET /api/admin/system-alerts   <- this file, verifyFirebaseToken +
           |                          requireRole(ADMIN)
           v
   Admin dashboard renders the list

   Two different auth models on purpose, matching who's actually
   calling each route:
     - POST /system/alerts is called by a trusted monitoring agent
       (the PowerShell script) with no Firebase session — gated by a
       shared monitoring key (verifyMonitorKey, header
       `X-Monitor-Key`), never reachable without it.
     - GET/PATCH /admin/system-alerts are called by a signed-in admin
       from the dashboard, gated the same way every other admin-only
       route in this app is (verifyFirebaseToken + requireRole).
   =================================================================== */
const express = require('express');
const { verifyFirebaseToken } = require('../middleware/verifyFirebaseToken');
const { requireRole } = require('../middleware/requireRole');
const { verifyMonitorKey } = require('../middleware/verifyMonitorKey');
const { ROLES } = require('../utils/roles');
const systemAlertService = require('../services/systemAlertService');

const router = express.Router();

// ---------------------------------------------------------------
// POST /api/system/alerts — ingest endpoint for trusted monitoring
// agents only. NOT behind the Firebase auth middleware (a monitoring
// script has no user session) — instead gated by verifyMonitorKey,
// which requires a valid `X-Monitor-Key` header matching this
// server's MONITOR_API_KEY. There is no code path that stores an
// alert without that header validating first, so this endpoint is
// never reachable anonymously/publicly. Still behind the same
// app-wide helmet/CORS/rate-limit stack from app.js on top of that.
//
// Flow: 1) verifyMonitorKey validates the monitoring key (401/503 if
// missing/wrong/unconfigured) -> 2) systemAlertService validates the
// payload shape (400 if malformed) -> 3) the alert is stored in
// Firestore -> 4) a success response is returned.
// ---------------------------------------------------------------
router.post('/system/alerts', verifyMonitorKey, async (req, res) => {
  try {
    const alert = await systemAlertService.createAlert(req.body);
    return res.status(201).json({ success: true, message: 'Alert stored', alert });
  } catch (err) {
    if (err.statusCode === 400) {
      return res.status(400).json({ success: false, error: err.message });
    }
    console.error('[system/alerts] failed to store alert:', err);
    return res.status(500).json({ success: false, error: 'Could not store alert.' });
  }
});

// ---------------------------------------------------------------
// GET /api/admin/system-alerts — admin dashboard read path.
// Query params: limit (default 50, max 200), severity
// (INFO|WARNING|CRITICAL), acknowledged (true|false).
// ---------------------------------------------------------------
router.get('/admin/system-alerts', verifyFirebaseToken, requireRole(ROLES.ADMIN), async (req, res) => {
  try {
    const { limit, severity, acknowledged } = req.query;
    const alerts = await systemAlertService.listAlerts({ limit, severity, acknowledged });
    return res.status(200).json({ success: true, alerts });
  } catch (err) {
    console.error('[admin/system-alerts] failed to list alerts:', err);
    return res.status(500).json({ success: false, error: 'Could not load system alerts.' });
  }
});

// ---------------------------------------------------------------
// PATCH /api/admin/system-alerts/:id/acknowledge — lets an admin
// clear an alert off the dashboard's "unread" count without deleting
// the record, so there's still a history to look back on.
// ---------------------------------------------------------------
router.patch('/admin/system-alerts/:id/acknowledge', verifyFirebaseToken, requireRole(ROLES.ADMIN), async (req, res) => {
  try {
    const updated = await systemAlertService.acknowledgeAlert(req.params.id, req.uid);
    return res.status(200).json({ success: true, alert: updated });
  } catch (err) {
    if (err.statusCode === 404) {
      return res.status(404).json({ success: false, error: err.message });
    }
    console.error('[admin/system-alerts/acknowledge] failed:', err);
    return res.status(500).json({ success: false, error: 'Could not acknowledge alert.' });
  }
});

module.exports = router;