/* ===================================================================
   routes/adminStorage.js
   ---------------------------------------------------------------
   GET /api/admin/storage-status — admin-only. Exposes the same disk
   usage stats scripts/monitor-disk-space.sh checks via cron, so an
   internal ops dashboard (or just `curl` during an incident) can see
   current usage without shelling into the host.

   Deliberately admin-only (not supervisor/worker) — disk usage isn't
   part of this app's existing per-file accessPermissions model, it's
   operational data about the whole deployment, so it uses the
   simpler requireRole gate instead of authorizeFileAccess.
   =================================================================== */
const express = require('express');
const { verifyFirebaseToken } = require('../middleware/verifyFirebaseToken');
const { requireRole } = require('../middleware/requireRole');
const { ROLES } = require('../utils/roles');
const storageMonitorService = require('../services/storageMonitorService');

const router = express.Router();

router.get('/admin/storage-status', verifyFirebaseToken, requireRole(ROLES.ADMIN), async (req, res) => {
  try {
    const usage = await storageMonitorService.getDiskUsage();
    return res.status(200).json({
      ...usage,
      warningThresholdPct: storageMonitorService.WARNING_PCT,
      criticalThresholdPct: storageMonitorService.CRITICAL_PCT,
      status: usage.percentUsed >= storageMonitorService.CRITICAL_PCT ? 'critical'
        : usage.percentUsed >= storageMonitorService.WARNING_PCT ? 'warning' : 'ok',
    });
  } catch (err) {
    console.error('[admin/storage-status] failed:', err);
    return res.status(500).json({ error: 'Could not read storage status.' });
  }
});

module.exports = router;
