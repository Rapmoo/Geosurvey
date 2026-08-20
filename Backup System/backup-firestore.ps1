<#
.SYNOPSIS
    Daily backup of the project's Firestore database via the managed
    export API (`gcloud firestore export`).

.DESCRIPTION
    Windows/PowerShell equivalent of scripts/backup-firestore.sh. Uses
    the managed export -- NOT the Admin SDK -- because it's Google's
    supported, transactionally-consistent way to back up an entire
    database in one call: this API's own companyFiles/auditLogs AND
    the rest of the app's existing collections (users, submissions,
    forms, notifications, reviews, ...), without this script needing
    to know or maintain a list of them.

    Requires the Google Cloud SDK (gcloud, gsutil) installed for
    Windows: https://cloud.google.com/sdk/docs/install -- the commands
    themselves are identical to the Linux/Mac version once the SDK is
    on PATH.

.PARAMETER ProjectId
    Firebase/GCP project id. Falls back to $env:PROJECT_ID.

.PARAMETER FirestoreBackupBucket
    GCS bucket name (no gs:// prefix) to export into. Should be a
    DIFFERENT bucket/region than any bucket used for file storage
    backups, so a regional outage doesn't take out backup and primary
    together. Falls back to $env:FIRESTORE_BACKUP_BUCKET.

.PARAMETER RetainDaily
    Days of exports to keep. Default 30.

.PARAMETER FirestoreDatabaseId
    Firestore database id. Default "(default)". Required if the
    project uses a named database -- `gcloud firestore export`
    silently targets "(default)" otherwise.

.PARAMETER LockFile
    Lock file path preventing overlapping runs.
    Default "$env:TEMP\geosurvey-backup-firestore.lock".

.EXAMPLE
    $env:PROJECT_ID = "geosurvey-update"
    $env:FIRESTORE_BACKUP_BUCKET = "geosurvey-backups"
    .\backup-firestore.ps1

.NOTES
    Exit codes: 0 = export accepted and completed. Non-zero = failure
    -- `gcloud firestore export --async=false` blocks until the
    operation finishes, so a non-zero exit here means today's backup
    genuinely did not complete. Designed to be run from Windows Task
    Scheduler (see BACKUP_STRATEGY.md).
#>

[CmdletBinding()]
param(
    [string]$ProjectId             = $env:PROJECT_ID,
    [string]$FirestoreBackupBucket = $env:FIRESTORE_BACKUP_BUCKET,
    [int]   $RetainDaily           = $(if ($env:RETAIN_DAILY) { [int]$env:RETAIN_DAILY } else { 30 }),
    [string]$FirestoreDatabaseId   = $(if ($env:FIRESTORE_DATABASE_ID) { $env:FIRESTORE_DATABASE_ID } else { "(default)" }),
    [string]$LockFile              = $(if ($env:LOCK_FILE) { $env:LOCK_FILE } else { Join-Path $env:TEMP "geosurvey-backup-firestore.lock" })
)

$ErrorActionPreference = "Stop"

function Log {
    param([string]$Message)
    $ts = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    Write-Output "[backup-firestore] $ts $Message"
}

if (-not $ProjectId)             { Log "ERROR: Set -ProjectId or `$env:PROJECT_ID"; exit 1 }
if (-not $FirestoreBackupBucket) { Log "ERROR: Set -FirestoreBackupBucket or `$env:FIRESTORE_BACKUP_BUCKET"; exit 1 }

if (-not (Get-Command gcloud -ErrorAction SilentlyContinue)) {
    Log "ERROR: gcloud not found on PATH. Install the Google Cloud SDK for Windows first."
    exit 1
}
if (-not (Get-Command gsutil -ErrorAction SilentlyContinue)) {
    Log "ERROR: gsutil not found on PATH. It ships with the Google Cloud SDK."
    exit 1
}

# ---- Prevent overlapping runs. An export can take a while on a large
# database; if Task Scheduler fires again before the previous export
# finishes, two concurrent exports would race on the retention-prune
# logic below and waste export quota.
$lockStream = $null
try {
    $lockStream = [System.IO.File]::Open($LockFile, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
} catch {
    Log "ERROR: another backup-firestore.ps1 run appears to be in progress (lock: $LockFile). Exiting."
    exit 1
}

try {
    $timestamp = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")
    $exportUri = "gs://$FirestoreBackupBucket/firestore/$timestamp"

    Log "Starting Firestore export for project $ProjectId (database: $FirestoreDatabaseId) -> $exportUri"

    # Blocks until the export operation completes (or fails) -- no
    # need to poll a separate operation-status command.
    & gcloud firestore export $exportUri --project=$ProjectId --database=$FirestoreDatabaseId --async=false
    if ($LASTEXITCODE -ne 0) { throw "gcloud firestore export failed with exit code $LASTEXITCODE" }

    Log "Export completed: $exportUri"

    # ---- Retention: prune export folders older than RetainDaily days ----
    Log "Pruning Firestore exports older than $RetainDaily days..."
    $cutoff = (Get-Date).ToUniversalTime().AddDays(-$RetainDaily)

    $prefixes = & gsutil ls "gs://$FirestoreBackupBucket/firestore/"
    foreach ($prefix in $prefixes) {
        if (-not $prefix) { continue }
        # Each line looks like gs://bucket/firestore/20260714T023000Z/
        $folderName = ($prefix.TrimEnd('/') -split '/')[-1]
        if ($folderName -notmatch '^\d{8}T\d{6}Z$') { continue }  # not one of our timestamped export folders

        try {
            $folderDate = [DateTime]::ParseExact($folderName, "yyyyMMdd'T'HHmmss'Z'", [System.Globalization.CultureInfo]::InvariantCulture)
        } catch {
            continue
        }

        if ($folderDate -lt $cutoff) {
            Log "Deleting old export: $prefix"
            & gsutil -m rm -r $prefix
            if ($LASTEXITCODE -ne 0) { Log "WARNING: could not delete $prefix" }
        }
    }

    Log "SUCCESS: Firestore backup $timestamp completed."
    exit 0
} catch {
    Log "ERROR: $($_.Exception.Message)"
    exit 1
} finally {
    if ($lockStream) { $lockStream.Close() }
}