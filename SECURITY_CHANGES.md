# Security requirements — what was added

Most of the requested items were already implemented in the uploaded
code. This pass adds the two that weren't, plus a small cleanup:

| Requirement | Status before | What changed |
|---|---|---|
| Firebase token verification | ✅ already done | none |
| Role-based access control (Admin/Supervisor/Worker) | ✅ enforced per-file in `authorizeFileAccess.js` | extracted role strings into `utils/roles.js` (`ROLES`, `ELEVATED_ROLES`) so they're defined once instead of duplicated as string literals |
| File type validation | ✅ already done (magic-byte sniffing) | none |
| File size limits | ✅ already done (multer `limits.fileSize`) | none |
| **Virus/malware scanning** | ❌ README note only | **new:** `services/malwareScanService.js`, called in `routes/upload.js` before bytes are written to disk |
| Prevent unauthorized file access | ✅ already done | none |
| Prevent path traversal | ✅ already done (`assertSafeSurveyId` + `safeResolve`) | none |
| Secure file naming | ✅ already done (server-generated filenames) | none |
| **Audit logs for uploads/downloads** | ❌ not implemented | **new:** `services/auditLogService.js`, called from `routes/upload.js` and `routes/files.js` on every outcome (success, denied, not found, error) |

## New files

- `services/malwareScanService.js` — scans upload buffers via a ClamAV
  `clamd` daemon over TCP (INSTREAM protocol). Controlled by env vars:
  - `MALWARE_SCAN_PROVIDER=clamav` (unset/`none` = scanning disabled,
    logs a warning on first upload so it's not silently skipped)
  - `CLAMAV_HOST`, `CLAMAV_PORT` (default `127.0.0.1:3310`)
  - `MALWARE_SCAN_FAIL_OPEN=true` to allow uploads through if the
    scanner is unreachable (default is **fail closed** — upload
    rejected with `503` if the scan itself can't run)
  - A positive detection always rejects the upload (`422`), regardless
    of the fail-open setting — that only applies to scanner
    *unavailability*, never to an actual infected file.

- `services/auditLogService.js` — writes to a new Firestore collection,
  `auditLogs`, via the Admin SDK (never touched by client code — the
  existing `firestore.rules` default-deny at the bottom of the file
  already blocks any direct client access, so no rules change was
  needed). Each entry: `action` (upload/download/delete), `result`
  (success/denied/not_found/error), `uid`, `role`, `fileId`,
  `surveyId`, `fileType`, `reason`, `ip`, `userAgent`, `timestamp`.
  Logging failures are swallowed (console-logged only) so a Firestore
  hiccup never turns a successful request into a 500.

- `utils/roles.js` — `ROLES` (`ADMIN`/`SUPERVISOR`/`WORKER`, matching
  the strings already used in `firestore.rules`) and `ELEVATED_ROLES`
  (`[ADMIN, SUPERVISOR]`), used by `fileMetadataService.js` instead of
  a locally hardcoded array.

## Setup

Add to `.env`:

```
MALWARE_SCAN_PROVIDER=clamav
CLAMAV_HOST=127.0.0.1
CLAMAV_PORT=3310
# MALWARE_SCAN_FAIL_OPEN=true   # only if you'd rather accept unscanned
                                 # files than block uploads during a
                                 # scanner outage — off by default
```

Run a `clamd` daemon reachable at that host/port — the usual approach
is a ClamAV sidecar container next to this API (e.g.
`clamav/clamav:stable` on the same network/Cloud Run service, or a
managed antivirus scanning service if your infra has one — swap the
implementation in `malwareScanService.js`'s `scanWithClamd` for
whatever HTTP/SDK call your provider needs; the `scanBuffer()` contract
the rest of the app calls stays the same).

No other setup is needed for audit logging — it uses the same Firebase
Admin credentials already configured for `companyFiles`.
