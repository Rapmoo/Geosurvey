<#
.SYNOPSIS
    Daily backup of $StorageRoot (the company-owned filesystem where
    actual file bytes live) to a SEPARATE remote location.

.DESCRIPTION
    Windows/PowerShell equivalent of scripts/backup-files.sh. A backup
    on the same disk/volume as the original doesn't protect against
    disk failure, accidental deletion, a bad deploy, or ransomware --
    it has to leave the machine, same as the Linux/Mac version.

    Uses rclone for upload (works against S3, GCS, Azure Blob, B2,
    etc. -- install via `winget install Rclone.Rclone` or
    https://rclone.org/downloads/). Uses the tar.exe that ships with
    Windows 10 (1803+) / Windows 11 / Server 2019+ to build a
    .tar.gz, so archives are identical to the ones the Linux/Mac
    version produces and can be restored on any OS.

.PARAMETER StorageRoot
    Path to back up (matches the backend's own STORAGE_ROOT env var),
    e.g. "C:\GeoSurvey\storage". Falls back to $env:STORAGE_ROOT.

.PARAMETER BackupBucket
    rclone remote:path to upload to, e.g. "remote:geosurvey-backups/files".
    Falls back to $env:BACKUP_BUCKET.

.PARAMETER RetainDaily
    How many days of archives to keep remotely. Default 30.

.PARAMETER WorkDir
    Scratch space for building the archive. Default $env:TEMP.

.PARAMETER MinFreeMB
    Abort if WorkDir's drive has less than this many MB free before
    staging the archive. Default 1024.

.PARAMETER LockFile
    Lock file path preventing overlapping runs.
    Default "$env:TEMP\geosurvey-backup-files.lock".

.EXAMPLE
    $env:STORAGE_ROOT = "C:\GeoSurvey\storage"
    $env:BACKUP_BUCKET = "remote:geosurvey-backups/files"
    .\backup-files.ps1

.NOTES
    Exit codes: 0 = success. Non-zero = failure at some stage -- treat
    ANY non-zero exit as "today's backup did not complete," not a
    partial success. Designed to be run from Windows Task Scheduler
    (see BACKUP_STRATEGY.md).
#>

[CmdletBinding()]
param(
    [string]$StorageRoot    = $env:STORAGE_ROOT,
    [string]$BackupBucket   = $env:BACKUP_BUCKET,
    [int]   $RetainDaily    = $(if ($env:RETAIN_DAILY) { [int]$env:RETAIN_DAILY } else { 30 }),
    [string]$WorkDir        = $(if ($env:WORKDIR) { $env:WORKDIR } else { $env:TEMP }),
    [int]   $MinFreeMB      = $(if ($env:MIN_FREE_MB) { [int]$env:MIN_FREE_MB } else { 1024 }),
    [string]$LockFile       = $(if ($env:LOCK_FILE) { $env:LOCK_FILE } else { Join-Path $env:TEMP "geosurvey-backup-files.lock" })
)

$ErrorActionPreference = "Stop"

function Log {
    param([string]$Message)
    $ts = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    Write-Output "[backup-files] $ts $Message"
}

if (-not $StorageRoot)  { Log "ERROR: Set -StorageRoot or `$env:STORAGE_ROOT"; exit 1 }
if (-not $BackupBucket) { Log "ERROR: Set -BackupBucket or `$env:BACKUP_BUCKET"; exit 1 }

if (-not (Get-Command tar.exe -ErrorAction SilentlyContinue)) {
    Log "ERROR: tar.exe not found. It ships with Windows 10 1803+/11/Server 2019+; if it's missing, install bsdtar or 7-Zip and adjust the archive step below."
    exit 1
}
if (-not (Get-Command rclone -ErrorAction SilentlyContinue)) {
    Log "ERROR: rclone not found on PATH. Install it (winget install Rclone.Rclone) and configure a remote first."
    exit 1
}

# ---- Prevent overlapping runs (e.g. yesterday's task still running
# when Task Scheduler fires again) from corrupting each other's
# WorkDir files or doubling up on upload/prune. An exclusively-opened
# file handle acts like flock: a second run can't open it and fails
# fast instead of racing the first.
$lockStream = $null
try {
    $lockStream = [System.IO.File]::Open($LockFile, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
} catch {
    Log "ERROR: another backup-files.ps1 run appears to be in progress (lock: $LockFile). Exiting."
    exit 1
}

$archivePath  = $null
$manifestPath = $null

try {
    if (-not (Test-Path -LiteralPath $StorageRoot -PathType Container)) {
        Log "ERROR: STORAGE_ROOT '$StorageRoot' does not exist or is not a directory."
        exit 1
    }

    $timestamp    = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")
    $archiveName  = "geosurvey-files-$timestamp.tar.gz"
    $manifestName = "geosurvey-files-$timestamp.sha256"
    $archivePath  = Join-Path $WorkDir $archiveName
    $manifestPath = Join-Path $WorkDir $manifestName

    Log "Starting backup of $StorageRoot"

    # ---- Guard against filling the host disk while staging the
    # archive. Rough guard (compares free space to StorageRoot's
    # current size, not the compressed archive size), same caveat as
    # the bash version.
    $storageBytes = (Get-ChildItem -LiteralPath $StorageRoot -Recurse -File -Force -ErrorAction SilentlyContinue |
        Measure-Object -Property Length -Sum).Sum
    if (-not $storageBytes) { $storageBytes = 0 }

    $workDriveRoot = (Get-Item -LiteralPath $WorkDir).PSDrive.Name
    $freeBytes = (Get-PSDrive -Name $workDriveRoot).Free
    $minFreeBytes = [int64]$MinFreeMB * 1MB

    if ($freeBytes -lt ($storageBytes + $minFreeBytes)) {
        Log "ERROR: insufficient free space on drive ${workDriveRoot}: for $WorkDir (have $freeBytes bytes, want at least $($storageBytes + $minFreeBytes) bytes to safely stage the archive). Aborting before writing anything."
        exit 1
    }

    # ---- Manifest BEFORE archiving: a per-file SHA-256 list lets a
    # future restore verify individual files, not just "the archive
    # extracted without error."
    Log "Computing SHA-256 manifest..."
    $rootFull = (Resolve-Path -LiteralPath $StorageRoot).Path.TrimEnd('\')
    $files = Get-ChildItem -LiteralPath $StorageRoot -Recurse -File -Force | Sort-Object FullName

    $manifestLines = foreach ($f in $files) {
        $hash = (Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash.ToLower()
        $relPath = $f.FullName.Substring($rootFull.Length).TrimStart('\') -replace '\\', '/'
        "$hash  ./$relPath"
    }
    Set-Content -LiteralPath $manifestPath -Value $manifestLines -Encoding ascii

    $fileCount = $files.Count
    if ($fileCount -eq 0) {
        Log "WARNING: STORAGE_ROOT contains zero files. Proceeding with an empty archive -- verify this is expected (e.g. brand-new environment), not a mounted-empty-volume bug."
    }
    Log "Manifest covers $fileCount files."

    Log "Building archive..."
    $parentDir = Split-Path -Path $rootFull -Parent
    $leafName  = Split-Path -Path $rootFull -Leaf
    Push-Location $parentDir
    try {
        & tar.exe -czf $archivePath $leafName
        if ($LASTEXITCODE -ne 0) { throw "tar.exe failed with exit code $LASTEXITCODE" }
    } finally {
        Pop-Location
    }
    $archiveBytes = (Get-Item -LiteralPath $archivePath).Length
    Log "Archive built: $archiveName ($archiveBytes bytes)"

    # ---- Upload (swap this block if you're not using rclone) ----
    Log "Uploading archive + manifest to $BackupBucket..."
    & rclone copy $archivePath "$BackupBucket/" --checksum
    if ($LASTEXITCODE -ne 0) { throw "rclone copy of archive failed (exit $LASTEXITCODE)" }
    & rclone copy $manifestPath "$BackupBucket/" --checksum
    if ($LASTEXITCODE -ne 0) { throw "rclone copy of manifest failed (exit $LASTEXITCODE)" }
    # --------------------------------------------------------------
    Log "Upload complete."

    # ---- Retention: prune archives older than RetainDaily days ----
    Log "Pruning archives older than $RetainDaily days from $BackupBucket..."
    $cutoff = (Get-Date).ToUniversalTime().AddDays(-$RetainDaily)

    $lsOutput = & rclone lsf "$BackupBucket/" --format "tp"
    foreach ($line in $lsOutput) {
        $parts = $line -split ';', 2
        if ($parts.Count -lt 2) { continue }
        $mtimeRaw = $parts[0]
        $name     = $parts[1]

        if ($name -notmatch '^geosurvey-files-.*\.(tar\.gz|sha256)$') { continue }

        try {
            $fileDate = [DateTime]::Parse($mtimeRaw, [System.Globalization.CultureInfo]::InvariantCulture).ToUniversalTime()
        } catch {
            continue
        }

        if ($fileDate -lt $cutoff) {
            Log "Deleting old backup: $name"
            & rclone deletefile "$BackupBucket/$name"
            if ($LASTEXITCODE -ne 0) { Log "WARNING: could not delete $name" }
        }
    }

    Log "SUCCESS: backup $archiveName ($fileCount files, $archiveBytes bytes) completed."
    exit 0
} catch {
    Log "ERROR: $($_.Exception.Message)"
    exit 1
} finally {
    if ($archivePath  -and (Test-Path -LiteralPath $archivePath))  { Remove-Item -LiteralPath $archivePath  -Force -ErrorAction SilentlyContinue }
    if ($manifestPath -and (Test-Path -LiteralPath $manifestPath)) { Remove-Item -LiteralPath $manifestPath -Force -ErrorAction SilentlyContinue }
    if ($lockStream) { $lockStream.Close() }
}