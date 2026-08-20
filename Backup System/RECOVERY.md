# Recovery Runbook (Windows)

Companion to `BACKUP_STRATEGY.md`. Each scenario below assumes the
backups described there (daily file archive + daily Firestore export)
already exist in a bucket separate from primary storage.

Before starting any restore: **stop writes** where possible (put the
API behind maintenance mode, or at minimum disable the scheduled
backup tasks in Task Scheduler) so you're not restoring onto a target
that's still changing underneath you.

All commands below are PowerShell, run from an elevated prompt where
noted.

---

## Scenario 1 — Single file or record accidentally deleted

*Someone deleted a file or its metadata record that shouldn't have
been deleted; everything else is fine.*

1. Download the most recent daily archive and manifest, then extract
   just the one file:
   ```powershell
   rclone copy "remote:geosurvey-backups/files/geosurvey-files-<TIMESTAMP>.tar.gz" .
   rclone copy "remote:geosurvey-backups/files/geosurvey-files-<TIMESTAMP>.sha256" .
   tar -xzf "geosurvey-files-<TIMESTAMP>.tar.gz" "storage/photos/<surveyId>/<filename>"
   ```
   (`tar.exe` on Windows can extract a single path out of the archive
   the same way GNU tar does — no need to unpack the whole thing.)
2. Verify it against that backup's manifest:
   ```powershell
   Select-String -Path "geosurvey-files-<TIMESTAMP>.sha256" -Pattern "<filename>"
   Get-FileHash ".\storage\photos\<surveyId>\<filename>" -Algorithm SHA256
   # compare the Hash value by eye against the manifest line above
   ```
3. Copy the restored file back onto `STORAGE_ROOT` at its original
   relative path, e.g.:
   ```powershell
   Copy-Item ".\storage\photos\<surveyId>\<filename>" `
     -Destination "C:\GeoSurvey\storage\photos\<surveyId>\<filename>"
   ```
4. If the Firestore metadata doc was also deleted: find it in the
   matching Firestore export (`gcloud firestore export` output is
   organized by collection) and re-create it via the Admin SDK/console
   — do NOT bulk-import the whole export over the live database for a
   single doc; see Scenario 3 for why.

## Scenario 2 — Disk failure / STORAGE_ROOT corrupted or lost

1. Provision a new disk/volume (or attach a new data disk to the VM).
2. Download and extract the most recent archive onto it:
   ```powershell
   rclone copy "remote:geosurvey-backups/files/geosurvey-files-<TIMESTAMP>.tar.gz" .
   rclone copy "remote:geosurvey-backups/files/geosurvey-files-<TIMESTAMP>.sha256" .
   New-Item -ItemType Directory -Force -Path "D:\GeoSurvey\storage" | Out-Null
   tar -xzf "geosurvey-files-<TIMESTAMP>.tar.gz" -C "D:\GeoSurvey"
   ```
3. **Verify before resuming traffic** — recompute hashes and diff
   against the manifest so a corrupted restore is caught now, not
   discovered later when a worker can't open an old photo:
   ```powershell
   Set-Location "D:\GeoSurvey\storage"
   $manifest = Get-Content "..\..\geosurvey-files-<TIMESTAMP>.sha256"
   $mismatches = foreach ($line in $manifest) {
       $expectedHash, $relPath = $line -split '\s+', 2
       $relPath = $relPath.TrimStart('.', '/') -replace '/', '\'
       $actualHash = (Get-FileHash -LiteralPath $relPath -Algorithm SHA256).Hash.ToLower()
       if ($actualHash -ne $expectedHash) { $relPath }
   }
   if ($mismatches) { Write-Warning "Mismatched files: $($mismatches -join ', ')" }
   else { Write-Output "All files verified OK." }
   ```
4. Point `STORAGE_ROOT` at the new volume (update the `.env`/service
   environment variable, e.g. `STORAGE_ROOT=D:\GeoSurvey\storage`,
   then restart the app — via IIS app pool recycle, NSSM service
   restart, or however it's hosted on this box), confirm `/healthz` is
   green, then resume traffic.
5. Any files uploaded AFTER the last backup and lost in the failure
   are gone — this is the RPO gap described in `BACKUP_STRATEGY.md`.
   If your risk tolerance needs a tighter window, increase backup
   frequency rather than trying to recover them after the fact.

## Scenario 3 — Bad Firestore write (bad migration, accidental bulk edit)

**Never import a Firestore export directly into the live, in-use
database** — Firestore import *merges* with existing data rather than
replacing it, so a bad write already in the live database survives
the import right alongside the restored copy, which is rarely what
you actually want after a corruption incident.

1. Create a **new, empty** Firestore database (or a scratch GCP
   project) for verification:
   ```powershell
   gcloud firestore databases create --database=recovery-check --location=<region>
   ```
2. Import the export into that scratch database:
   ```powershell
   gcloud firestore import "gs://<bucket>/firestore/<TIMESTAMP>" `
     --database=recovery-check
   ```
3. Verify it looks right (spot-check a few `submissions`/`users` docs,
   confirm the point-in-time you exported is indeed before the bad
   write).
4. Only then plan the actual cutover:
   - **If PITR is enabled** on the real database, prefer
     [Point-in-Time Recovery](https://cloud.google.com/firestore/docs/backups)
     directly on the live database instead of a full import — it's
     the built-in, safer path for "roll back to 20 minutes/hours ago"
     and avoids the merge problem above entirely.
   - **If not**, the safe path is: export the *current* (bad) database
     as a safety net, then work with Google Cloud support / a
     `gcloud firestore import` into a **freshly recreated** database
     (not the live one) to get a clean replace rather than a merge,
     then repoint the app's Firebase config at it.
5. Re-run this API's own smoke test (`GET /healthz`, a test upload,
   `GET /api/admin/storage-status`) before declaring the incident
   closed.

## Scenario 4 — Full regional outage

This is exactly why the backup bucket (both file archives and
Firestore exports) lives in a different region from primary storage
(see `BACKUP_STRATEGY.md`). Recovery is a combination of Scenario 2
(restore files onto a volume in the surviving region) and Scenario 3
(import Firestore into a database in the surviving region), followed
by repointing DNS/`ALLOWED_ORIGINS`/the frontend's `FILE_API_BASE_URL`
at the new deployment.

---

## After any recovery

- Write down what was lost (time window, which records/files, if any)
  and communicate it to whoever owns the data (admins/supervisors) —
  don't let a quiet recovery hide a real data gap from the people who
  need to know about it.
- Re-run the quarterly test-restore checklist ahead of schedule if
  this recovery surfaced anything the runbook didn't anticipate —
  update this document while it's fresh.