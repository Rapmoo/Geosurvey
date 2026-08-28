<#
.SYNOPSIS
    Frequent (every 5-15 min, via Task Scheduler) disk-space check for
    STORAGE_ROOT's drive.

.DESCRIPTION
    Windows/PowerShell equivalent of scripts/monitor-disk-space.sh.
    Deliberately simple and dependency-free (just Get-PSDrive) so it
    works the same on a plain VM, a container with a mounted volume,
    or an on-prem box — no monitoring agent required, though this is
    meant to complement, not replace, a real metrics stack if you have
    one (Cloud Monitoring / CloudWatch / Prometheus).

    Two thresholds:
      WarningPct  (default 75) — posts a WARNING alert
      CriticalPct (default 90) — posts a CRITICAL alert AND exits 1,
                                   so this can also be wired into an
                                   uptime/health-check tool as a
                                   failing check, not just a
                                   notification.

        Disk check
            |
            v
    POST alert to GeoSurvey backend   (WARNING or CRITICAL, per threshold)
            |
            v
       backend validates + stores in Firestore ("systemAlerts")
            |
            v
       admin dashboard shows the alert

    Every check still logs to the console regardless of whether a
    POST happens/succeeds — see Log/Send-Alert below — so this remains
    useful purely via stdout/stderr (Windows Event Log via a forwarder,
    Cloud Logging, etc.) even with no backend configured at all.

    Authentication is a shared secret (MonitorKey), sent as
    the `X-Monitor-Key` header — this script has no Firebase user
    session, so it can't authenticate the way the frontend does; see
    middleware/verifyMonitorKey.js on the backend for the other
    half of this. If ApiUrl/MonitorKey aren't set, alerts
    are still logged to stdout/stderr but nothing is posted anywhere.

.PARAMETER StorageRoot
    Path to monitor. Falls back to $env:STORAGE_ROOT.

.PARAMETER WarningPct
    Warning threshold percent used. Default 75.

.PARAMETER CriticalPct
    Critical threshold percent used. Default 90.

.PARAMETER ApiUrl
    Full URL of the GeoSurvey backend's alert-ingest endpoint, e.g.
    "http://localhost:8080/api/system/alerts" or
    "https://api.geosurvey.example.com/api/system/alerts" — this is
    the complete endpoint, not just the backend's base URL. Falls
    back to $env:API_URL. WARNING and CRITICAL alerts are POSTed here
    as JSON with an `X-Monitor-Key` header.

.PARAMETER MonitorKey
    Shared secret configured on the backend as MONITOR_API_KEY.
    Falls back to $env:MONITOR_API_KEY. Never checked into
    source control — set it as a machine/service environment variable
    the same way STORAGE_ROOT etc. are set for the other scheduled
    tasks (see BACKUP_STRATEGY.md).

.EXAMPLE
    .\monitor-disk-space.ps1 `
      -StorageRoot "C:\GeoSurvey\storage" `
      -ApiUrl "http://localhost:8080/api/system/alerts" `
      -MonitorKey "secret-key"

.EXAMPLE
    $env:STORAGE_ROOT    = "C:\GeoSurvey\storage"
    $env:API_URL          = "https://api.geosurvey.example.com/api/system/alerts"
    $env:MONITOR_API_KEY = "<shared secret>"
    .\monitor-disk-space.ps1

.NOTES
    Exit codes: 0 = OK or warning. 1 = critical threshold breached.
    2 = STORAGE_ROOT doesn't exist. Designed to be run from Windows
    Task Scheduler every 5-15 minutes (see BACKUP_STRATEGY.md).
#>

[CmdletBinding()]
param(
    [string]$StorageRoot         = $env:STORAGE_ROOT,
    [int]   $WarningPct          = $(if ($env:WARNING_PCT) { [int]$env:WARNING_PCT } else { 75 }),
    [int]   $CriticalPct         = $(if ($env:CRITICAL_PCT) { [int]$env:CRITICAL_PCT } else { 90 }),
    [string]$ApiUrl              = $env:API_URL,
    [string]$MonitorKey          = $env:MONITOR_API_KEY
)

$ErrorActionPreference = "Stop"

function Log {
    param([string]$Message)
    $ts = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    Write-Output "[monitor-disk-space] $ts $Message"
}

if (-not $StorageRoot) { Log "ERROR: Set -StorageRoot or `$env:STORAGE_ROOT"; exit 2 }

if (-not (Test-Path -LiteralPath $StorageRoot -PathType Container)) {
    Log "ERROR: STORAGE_ROOT '$StorageRoot' does not exist."
    exit 2
}

# Resolve the drive STORAGE_ROOT lives on (works for a local drive
# letter; for a UNC path/mapped network share, Get-PSDrive on the
# mapped drive letter still works the same way).
$resolvedRoot = (Resolve-Path -LiteralPath $StorageRoot).Path
$driveLetter  = (Get-Item -LiteralPath $resolvedRoot).PSDrive.Name

$drive = Get-PSDrive -Name $driveLetter -ErrorAction SilentlyContinue
if (-not $drive) {
    Log "ERROR: could not resolve drive '${driveLetter}:' for $StorageRoot."
    exit 2
}

$usedBytes  = $drive.Used
$freeBytes  = $drive.Free
$totalBytes = $usedBytes + $freeBytes

if ($totalBytes -le 0) {
    Log "ERROR: could not determine disk size for drive ${driveLetter}:."
    exit 2
}

$pct     = [math]::Round(($usedBytes / $totalBytes) * 100)
$usedGB  = [math]::Round($usedBytes  / 1GB, 1)
$freeGB  = [math]::Round($freeBytes  / 1GB, 1)
$totalGB = [math]::Round($totalBytes / 1GB, 1)

Log "Disk usage for ${StorageRoot} (drive ${driveLetter}:): ${pct}% used (${usedGB}GB used / ${freeGB}GB free / ${totalGB}GB total)"

function Send-Alert {
    param([string]$Severity, [string]$Message)

    # Console logging always happens, POST-or-not — this line alone is
    # what makes the script useful even with no backend configured at
    # all (log-based alerting on stdout/stderr).
    Log "ALERT [$Severity]: $Message"

    if (-not $ApiUrl -or -not $MonitorKey) {
        Log "WARNING: ApiUrl/MonitorKey not set -- alert logged locally only, nothing posted to GeoSurvey."
        return
    }

    # ISO 8601 UTC, e.g. 2026-07-24T05:35:00.000Z -- matches what
    # services/systemAlertService.js's validateAlertPayload expects
    # for "timestamp" (must parse via Date.parse on the Node side).
    $timestamp = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")

    $payload = @{
        type          = "DISK_USAGE"
        severity      = $Severity
        message       = $Message
        storageRoot   = $StorageRoot
        usagePercent  = $pct
        freeSpaceGB   = $freeGB
        totalSpaceGB  = $totalGB
        timestamp     = $timestamp
        source        = $env:COMPUTERNAME
    } | ConvertTo-Json -Compress

    try {
        Invoke-RestMethod -Uri $ApiUrl -Method Post `
            -ContentType "application/json" `
            -Headers @{ "X-Monitor-Key" = $MonitorKey } `
            -Body $payload | Out-Null
        Log "Alert posted to $ApiUrl"
    } catch {
        # Non-fatal by design: a down/unreachable backend shouldn't stop
        # this script from still exiting 1 on CRITICAL, which is what
        # keeps this usable as a Task Scheduler "on failure" trigger
        # even if the internal notification path itself is broken.
        Log "WARNING: failed to POST alert to $ApiUrl ($($_.Exception.Message))"
    }
}

if ($pct -ge $CriticalPct) {
    Send-Alert "CRITICAL" "Storage at ${pct}% (${freeGB}GB free of ${totalGB}GB) on ${StorageRoot} -- uploads may start failing soon. Provision more space or clean up now."
    exit 1
} elseif ($pct -ge $WarningPct) {
    Send-Alert "WARNING" "Storage at ${pct}% (${freeGB}GB free of ${totalGB}GB) on ${StorageRoot} -- plan for more space soon."
}

exit 0