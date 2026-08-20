# Backup & Recovery Strategy (Windows)

This backend has two things worth losing sleep over:

1. **File bytes** on `STORAGE_ROOT` (photos/audio/documents) — company-owned
   storage on a Windows host or file share, not Firebase Storage (see
   `fileStorageService.js`).
2. **Firestore data** — `companyFiles` (this API's metadata) and
   `auditLogs` (this API's audit trail), plus the rest of the app's
   existing collections (`users`, `submissions`, `forms`, `notifications`,
   `reviews`, etc.) that this backend doesn't own but that live in the
   same project.

Both need backups that are **separate from the primary copy** — a
backup that lives on the same disk/volume as the original doesn't
protect against disk failure, accidental deletion, a bad deploy, or
ransomware, which are exactly the scenarios backups exist for.

## Prerequisites (Windows-specific)

- **PowerShell 5.1+** (ships with Windows 10/11/Server 2016+; PowerShell 7
  works too).
- **`tar.exe`** — ships built-in with Windows 10 1803+/11/Server 2019+
  (it's bsdtar under the hood). Produces the same `.tar.gz` format as the
  Linux/Mac scripts, so archives are restorable on any OS. Check with
  `tar --version` in PowerShell.
- **rclone** — `winget install Rclone.Rclone`, then `rclone config` to set
  up your remote (S3, GCS, Azure Blob, B2, etc.).
- **Google Cloud SDK** — for `gcloud`/`gsutil`, install from
  https://cloud.google.com/sdk/docs/install (Windows installer).

## Targets (RPO / RTO)

| | RPO (max data loss) | RTO (max time to restore) |
|---|---|---|
| File storage | 24h (daily backup) | A few hours for a full restore; minutes for a single file |
| Firestore | 24h (daily export) + point-in-time via Firestore's own PITR if enabled | Under an hour for a full database import |

If 24h of potential data loss is too much for your risk tolerance,
tighten the Task Scheduler trigger below (e.g. every 6h) — the scripts
don't assume "once a day," that's just the default.

## 1. Daily file backup

`scripts\backup-files.ps1`:
- Tars + gzips `STORAGE_ROOT` (via `tar.exe`), computes a SHA-256 manifest
  of every file with `Get-FileHash` (so corruption/truncation is
  detectable later, not just "the backup ran"), and uploads the archive
  to a **separate** bucket (`BACKUP_BUCKET`) using `rclone` (works against
  S3, GCS, Azure, B2, etc.).
- Retains the last `RETAIN_DAILY` daily archives and prunes older
  ones — keeps storage cost bounded without a human having to
  remember to clean up.
- Every run is logged with a clear success/failure line so it can be
  picked up by whatever log-based alerting you already have (Windows
  Event Log forwarding, a log shipper, Cloud Logging, etc.).
- Exits non-zero on ANY failure (tar, checksum, or upload) so Task
  Scheduler can be configured to alert on a non-zero exit code rather
  than silently producing an empty/partial backup.
- Refuses to start if two runs would overlap (an exclusive file lock,
  the Windows equivalent of `flock`), and refuses to stage the archive
  if `WORKDIR` doesn't have enough free space on its drive to hold it
  (`MIN_FREE_MB`, default 1024) — both fail loudly *before* touching
  disk rather than filling the host mid-backup.

Run it daily via **Task Scheduler**. Either use the GUI (Task
Scheduler → Create Task → Trigger: Daily 2:15 AM → Action: Start a
program) or create it from an elevated PowerShell prompt:

```powershell
$action  = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument '-NoProfile -ExecutionPolicy Bypass -File "C:\GeoSurvey\scripts\backup-files.ps1"' `
  -WorkingDirectory "C:\GeoSurvey\scripts"

$trigger = New-ScheduledTaskTrigger -Daily -At 2:15AM

$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable `
  -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 3)

# Environment variables for a scheduled task are set via a small
# wrapper script (below) rather than passed on the trigger itself.
Register-ScheduledTask -TaskName "GeoSurvey Daily File Backup" `
  -Action $action -Trigger $trigger -Settings $settings `
  -User "SYSTEM" -RunLevel Highest
```

Since Scheduled Tasks don't take environment variables directly, set
them at the top of a small wrapper (or in the script's own
`param()` defaults) — e.g. `run-backup-files.ps1`:

```powershell
$env:STORAGE_ROOT   = "C:\GeoSurvey\storage"
$env:BACKUP_BUCKET  = "remote:geosurvey-backups/files"
& "C:\GeoSurvey\scripts\backup-files.ps1" *>> "C:\GeoSurvey\logs\backup-files.log"
exit $LASTEXITCODE
```
...and point the scheduled task's Action at `run-backup-files.ps1`
instead. (Or pass them as `-StorageRoot`/`-BackupBucket` parameters on
the `-Argument` line — either works.)

## 2. Firestore backup

`scripts\backup-firestore.ps1` uses Firestore's own **managed export**
(`gcloud firestore export`) rather than reading documents through the
Admin SDK — it's the supported, consistent, doesn't-rate-limit-itself
way to back up an entire Firestore database, and covers every
collection in the project (this API's `companyFiles`/`auditLogs` AND
the rest of the app's `users`/`submissions`/`forms`/etc.) in one
operation, so nothing needs to be listed/maintained by hand.

- Exports to `gs://$FIRESTORE_BACKUP_BUCKET/firestore/<timestamp>/`.
- Prunes exports older than `RETAIN_DAILY` days from that bucket.
- Requires the Blaze plan (already true for this project — see
  `PWA_SETUP.md`/README) and a service account with
  `datastore.databases.export` permission (the `Cloud Datastore Import
  Export Admin` role). Run `gcloud auth login` (or
  `gcloud auth activate-service-account` with a key file) once on the
  Windows host so `gcloud` has credentials to use non-interactively.
- Targets the `(default)` Firestore database unless
  `FIRESTORE_DATABASE_ID` is set — required if this project ever
  moves to a named (non-default) database, otherwise the export
  silently targets the wrong (empty) database.

```powershell
$action  = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument '-NoProfile -ExecutionPolicy Bypass -File "C:\GeoSurvey\scripts\run-backup-firestore.ps1"'
$trigger = New-ScheduledTaskTrigger -Daily -At 2:45AM
Register-ScheduledTask -TaskName "GeoSurvey Daily Firestore Backup" `
  -Action $action -Trigger $trigger -User "SYSTEM" -RunLevel Highest
```

with `run-backup-firestore.ps1`:

```powershell
$env:FIRESTORE_BACKUP_BUCKET = "geosurvey-backups"
$env:PROJECT_ID              = "geosurvey-update"
& "C:\GeoSurvey\scripts\backup-firestore.ps1" *>> "C:\GeoSurvey\logs\backup-firestore.log"
exit $LASTEXITCODE
```

Optional, stronger RPO: enable **Point-in-Time Recovery (PITR)** on
the Firestore database itself (a project setting, not a script) —
gives up to 7 days of any-second recovery on top of the daily export,
at a modest storage-cost increase. Worth it once this is handling real
field data; the daily export alone is the baseline.

## 3. Recovery procedure

See `RECOVERY.md` for the full runbook (per-scenario steps). Summary:

1. **Single accidental file/record loss** (a worker or admin deleted
   something they shouldn't have) — restore just that file from the
   most recent daily archive, and/or that one Firestore doc from the
   most recent export, without touching anything else.
2. **Disk failure / corrupted STORAGE_ROOT** — provision a new
   volume, restore the latest file archive onto it, point
   `STORAGE_ROOT` at it, verify the SHA-256 manifest matches before
   resuming traffic.
3. **Corrupted/bad Firestore write (e.g. a bad migration)** — import
   the most recent (or a specific dated) Firestore export into a
   **new, empty database** first, verify it looks right, then cut
   over — never import over a live database, which merges rather than
   replaces and can leave a mix of old and bad data.
4. **Full regional outage** — both the file backup bucket and the
   Firestore export bucket should be in a different region (or a
   multi-region bucket) than primary storage, specifically so this
   scenario doesn't take out the backups along with the primary copy.

## 4. Storage monitoring & disk space alerts

Two layers:

- **`scripts\monitor-disk-space.ps1`** — a simple, dependency-free
  check using `Get-PSDrive`/`Get-Volume`, run frequently (every 5–15
  min) via a separate Scheduled Task. Alerts (via a webhook —
  Slack/PagerDuty/anything that accepts a POST, using
  `Invoke-RestMethod`) at a **warning** threshold (default 75%) and a
  **critical** threshold (default 90%), and exits non-zero at critical
  so Task Scheduler's "on failure" history (or an external health
  check hitting the same host) can pick it up.
- **`services/storageMonitorService.js`** + **`routes/adminStorage.js`**
  — an admin-only `GET /api/admin/storage-status` endpoint exposing
  live disk usage (used/total/percent, per the same `STORAGE_ROOT`)
  and the timestamp/size of the most recent backup, for a simple
  ops dashboard — and an in-process periodic check that logs a
  structured warning if usage crosses the same thresholds, so you're
  covered even if the Scheduled Task layer above isn't set up in a
  given environment. (These two files are Node.js and run unchanged on
  Windows.)
- **`routes/systemAlerts.js`** + **`services/systemAlertService.js`**
  — `monitor-disk-space.ps1` no longer posts to a generic external
  webhook (Slack/PagerDuty/etc). Instead it `POST`s straight into this
  API at `/api/system/alerts`, which validates and stores the alert in
  Firestore's `systemAlerts` collection; the admin dashboard's
  overview screen polls `GET /api/admin/system-alerts` and shows a
  "System Alerts" panel there. Backend-side, set
  `MONITOR_API_KEY` to a random shared secret (this is what
  `middleware/verifyMonitorKey.js` checks on the way in) — without
  it, `/api/system/alerts` refuses every request with 503.

```powershell
$action  = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument '-NoProfile -ExecutionPolicy Bypass -File "C:\GeoSurvey\scripts\monitor-disk-space.ps1"'
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
  -RepetitionInterval (New-TimeSpan -Minutes 10) `
  -RepetitionDuration ([TimeSpan]::MaxValue)
Register-ScheduledTask -TaskName "GeoSurvey Disk Space Monitor" `
  -Action $action -Trigger $trigger -User "SYSTEM" -RunLevel Highest
```

with env vars set the same way as the other tasks, e.g. in a
`run-monitor-disk-space.ps1` wrapper:

```powershell
$env:STORAGE_ROOT          = "C:\GeoSurvey\storage"
$env:BACKEND_URL           = "https://api.geosurvey.example.com"
$env:MONITOR_API_KEY = "<same random secret as the backend's MONITOR_API_KEY>"
& "C:\GeoSurvey\scripts\monitor-disk-space.ps1" *>> "C:\GeoSurvey\logs\monitor-disk-space.log"
exit $LASTEXITCODE
```

`monitor-disk-space.ps1` resolves `STORAGE_ROOT`'s drive with
`Get-PSDrive` (used/free/total), posts warning/critical alerts via
`Invoke-RestMethod` to `$BackendUrl/api/system/alerts`, and exits
non-zero at the critical threshold —
same behavior as the bash version, just PowerShell-native instead of
`df`/`curl`.

## What to verify periodically (not just set-and-forget)

- **Test-restore quarterly**: actually restore a backup archive and a
  Firestore export into a scratch environment and confirm the app
  boots against them. An untested backup is a hypothesis, not a
  guarantee.
- **Alert on backup absence, not just backup failure**: if the
  Scheduled Task itself stops running (host down, task disabled, an
  update reset the trigger), a failure-only alert never fires. Check
  Task Scheduler's task history (or `Get-ScheduledTaskInfo`'s
  `LastRunTime`) for "no successful run in the last 26 hours → alert,"
  the Windows equivalent of a dead-man's-switch check.