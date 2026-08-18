/* ===================================================================
   services/storageMonitorService.js
   ---------------------------------------------------------------
   Two jobs:
     1. getDiskUsage() — current usage stats for the filesystem
        STORAGE_ROOT lives on, for the admin status endpoint
        (routes/adminStorage.js) and for scripts/monitor-disk-space.sh's
        cron-based check to have an in-process equivalent.
     2. startPeriodicCheck() — runs the same check on a timer inside
        this Node process and logs a structured warning/critical line
        when usage crosses a threshold, so environments where the cron
        script (scripts/monitor-disk-space.sh) isn't deployed
        alongside this API (e.g. a container platform where you don't
        control the host's crontab) still get *some* disk-space
        alerting, via whatever log-based alerting already watches this
        process's stdout (Cloud Logging, CloudWatch, etc).

   Uses `df` via a child process rather than an npm package — one less
   dependency for something this small, and `df` is available on
   every Linux/macOS host this would realistically run on. If this
   ever runs on Windows, swap getDiskUsage()'s implementation for the
   `check-disk-space` npm package instead.
   =================================================================== */
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const checkDiskSpace = require('check-disk-space').default;

const STORAGE_ROOT = process.env.STORAGE_ROOT || require('path').join(__dirname, '..', '..', 'storage');
const WARNING_PCT = Number(process.env.DISK_WARNING_PCT || 75);
const CRITICAL_PCT = Number(process.env.DISK_CRITICAL_PCT || 90);
const CHECK_INTERVAL_MS = Number(process.env.DISK_CHECK_INTERVAL_MS || 10 * 60 * 1000); // 10 min

/**
 * getDiskUsage() -> { path, totalBytes, usedBytes, availableBytes, percentUsed }
 */
async function getDiskUsage() {

  // Windows support
  if (process.platform === 'win32') {

    const drive = path.parse(path.resolve(STORAGE_ROOT)).root;

    const disk = await checkDiskSpace(drive);

    const totalBytes = disk.size;
    const availableBytes = disk.free;
    const usedBytes = totalBytes - availableBytes;

    const percentUsed =
      Math.round((usedBytes / totalBytes) * 1000) / 10;

    return {
      path: STORAGE_ROOT,
      totalBytes,
      usedBytes,
      availableBytes,
      percentUsed
    };
  }


  // Linux/macOS support
  const { stdout } = await execFileAsync(
    'df',
    ['-Pk', STORAGE_ROOT]
  );

  const lines = stdout.trim().split('\n');

  const cols = lines[lines.length - 1]
    .trim()
    .split(/\s+/);


  const totalBytes = Number(cols[1]) * 1024;
  const usedBytes = Number(cols[2]) * 1024;
  const availableBytes = Number(cols[3]) * 1024;

  const percentUsed =
    Math.round((usedBytes / totalBytes) * 1000) / 10;


  return {
    path: STORAGE_ROOT,
    totalBytes,
    usedBytes,
    availableBytes,
    percentUsed
  };
}

function logIfOverThreshold(usage) {
  if (usage.percentUsed >= CRITICAL_PCT) {
    console.error(`[storageMonitor] CRITICAL: ${usage.path} at ${usage.percentUsed}% (${(usage.availableBytes / 1e9).toFixed(1)}GB free) — uploads may start failing soon.`);
  } else if (usage.percentUsed >= WARNING_PCT) {
    console.warn(`[storageMonitor] WARNING: ${usage.path} at ${usage.percentUsed}% (${(usage.availableBytes / 1e9).toFixed(1)}GB free).`);
  }
}

let intervalHandle = null;

function startPeriodicCheck() {
  if (intervalHandle) return; // idempotent — don't stack multiple timers
  const run = () => {
    getDiskUsage().then(logIfOverThreshold).catch((err) => {
      console.error('[storageMonitor] disk usage check failed:', err.message);
    });
  };
  run(); // once at startup, don't wait a full interval for the first reading
  intervalHandle = setInterval(run, CHECK_INTERVAL_MS);
  // Don't let this timer keep the process alive on its own during shutdown.
  intervalHandle.unref();
}

module.exports = { getDiskUsage, startPeriodicCheck, WARNING_PCT, CRITICAL_PCT };
