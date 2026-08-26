<#
.SYNOPSIS
    Upload SQLite database snapshots to Azure Blob Storage for rollback.

.DESCRIPTION
    Snapshot-preservation backup (issue #37). After a successful build, this
    script copies the resulting d365fo_*.sqlite files to the
    'mcpsec-snapshots' container in the Function App's storage account, with a
    dated blob name (e.g. 'd365fo_sec_2026-05-06.sqlite').

    Retention is enforced two ways:
      1. Bicep lifecycle policy deletes snapshot blobs older than 90 days
         (calendar-based — the platform cannot count blobs).
      2. This script also prunes per-database to keep the most recent
         -KeepCount snapshots (default 5), giving fast turnover regardless
         of build cadence.

    The databases themselves are not authoritative — they are rebuilt from
    source. These snapshots exist so a bad build that has been deployed can
    be rolled back to the previous known-good state without re-running the
    full build pipeline.

.PARAMETER Environment
    'd' (development) or 'p' (production). Default: d.

.PARAMETER KbDbPath
    Path to KB SQLite database. Default: %USERPROFILE%\.claude\d365fo_kb.sqlite

.PARAMETER XrefDbPath
    Path to XRef SQLite database. Default: %USERPROFILE%\.claude\d365fo_xref.sqlite

.PARAMETER SecDbPath
    Path to Security SQLite database. Default: %USERPROFILE%\.claude\d365fo_sec.sqlite

.PARAMETER KbOnly
    Only snapshot the KB database.

.PARAMETER XrefOnly
    Only snapshot the XRef database.

.PARAMETER SecOnly
    Only snapshot the Security database.

.PARAMETER KeepCount
    Number of most-recent snapshots to retain per database. Default: 5.

.PARAMETER ContainerName
    Snapshot container name. Default: 'mcpsec-snapshots'.

.EXAMPLE
    .\Backup-Databases.ps1 -Environment d
    .\Backup-Databases.ps1 -Environment p -SecOnly
    .\Backup-Databases.ps1 -Environment d -KeepCount 10

.NOTES
    Requires Azure CLI (az) and an active login.
    Run 'az login' first if not authenticated.

    Restore: see docs/Operations.md ("Database snapshots & restore").
#>
[CmdletBinding()]
param(
    [string]$Subscription = 'TIS.D365FO',   # Azure subscription owning the MCP resource group
    [ValidateSet('d', 'p')]
    [string]$Environment = 'd',

    [string]$KbDbPath,
    [string]$XrefDbPath,
    [string]$SecDbPath,

    [switch]$KbOnly,
    [switch]$XrefOnly,
    [switch]$SecOnly,

    [int]$KeepCount = 5,

    [string]$ContainerName = 'mcpsec-snapshots'
)

$ErrorActionPreference = 'Stop'
$prefix   = 'tis'
$workload = 'mcpd365fo'
$rg       = "$prefix-$Environment-$workload-rg"
$stName   = "$prefix$Environment${workload}st"

# Default database paths
if (-not $KbDbPath)   { $KbDbPath   = Join-Path $env:USERPROFILE '.claude\d365fo_kb.sqlite' }
if (-not $XrefDbPath) { $XrefDbPath = Join-Path $env:USERPROFILE '.claude\d365fo_xref.sqlite' }
if (-not $SecDbPath)  { $SecDbPath  = Join-Path $env:USERPROFILE '.claude\d365fo_sec.sqlite' }

Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "  D365FO MCP Services - Snapshot Backup" -ForegroundColor Cyan
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "  Storage Account: $stName"
Write-Host "  Container:       $ContainerName"
Write-Host "  Resource Group:  $rg"
Write-Host "  Environment:     $(if ($Environment -eq 'p') { 'Production' } else { 'Development' })"
Write-Host "  Retention:       last $KeepCount per database (lifecycle: 90 days)"
Write-Host ""

# ─── Azure CLI auth check ────────────────────────────────────────────────────
. "$PSScriptRoot\Common-AzContext.ps1"
$account = Ensure-AzContext -Subscription $Subscription

# ─── Verify storage account exists ────────────────────────────────────────────
$st = az storage account show --resource-group $rg --name $stName 2>$null | ConvertFrom-Json
if (-not $st) {
    Write-Error "Storage account '$stName' not found in '$rg'. Run Deploy-Infrastructure.ps1 first."
    return
}
Write-Host "  [OK] Storage account: $stName" -ForegroundColor Green

# ─── Build the candidate set ──────────────────────────────────────────────────
$candidates = @()
$includeAll = -not ($KbOnly -or $XrefOnly -or $SecOnly)

if ($KbOnly -or $includeAll) {
    $candidates += @{ Name = 'KB';   LocalPath = $KbDbPath;   BaseName = 'd365fo_kb' }
}
if ($XrefOnly -or $includeAll) {
    $candidates += @{ Name = 'XRef'; LocalPath = $XrefDbPath; BaseName = 'd365fo_xref' }
}
if ($SecOnly -or $includeAll) {
    $candidates += @{ Name = 'Sec';  LocalPath = $SecDbPath;  BaseName = 'd365fo_sec' }
}

# ─── Filter to existing files ─────────────────────────────────────────────────
$uploads = @()
foreach ($c in $candidates) {
    if (Test-Path $c.LocalPath) {
        $sizeMB = [math]::Round((Get-Item $c.LocalPath).Length / 1MB)
        Write-Host "  $($c.Name) database: $sizeMB MB  ($($c.LocalPath))" -ForegroundColor DarkGray
        $uploads += @{
            Name      = $c.Name
            LocalPath = $c.LocalPath
            BaseName  = $c.BaseName
            SizeMB    = $sizeMB
        }
    } else {
        Write-Host "  $($c.Name) database: (not found, skipping) — $($c.LocalPath)" -ForegroundColor DarkYellow
    }
}

if ($uploads.Count -eq 0) {
    Write-Warning "No database files found to snapshot. Nothing to do."
    return
}

Write-Host ""

# ─── Ensure container exists (idempotent) ────────────────────────────────────
# Container is created by Bicep, but tolerate manual / pre-Bicep environments.
$exists = az storage container exists `
    --account-name $stName `
    --name $ContainerName `
    --auth-mode login `
    --query exists -o tsv 2>$null
if ($exists -ne 'true') {
    Write-Host "Container '$ContainerName' missing — creating..." -ForegroundColor Yellow
    az storage container create `
        --account-name $stName `
        --name $ContainerName `
        --auth-mode login `
        --output none
}

# ─── Snapshot each database ───────────────────────────────────────────────────
$startTime = Get-Date
$dateStamp = Get-Date -Format 'yyyy-MM-dd-HHmmss'
$steps = @()

foreach ($u in $uploads) {
    $blobName = "$($u.BaseName)_${dateStamp}.sqlite"
    Write-Host "Uploading snapshot: $blobName ($($u.SizeMB) MB)..." -ForegroundColor Yellow
    $uploadStart = Get-Date

    try {
        az storage blob upload `
            --account-name $stName `
            --container-name $ContainerName `
            --name $blobName `
            --file $u.LocalPath `
            --auth-mode login `
            --overwrite false `
            --output none 2>&1 | Out-Null

        if ($LASTEXITCODE -ne 0) {
            throw "az storage blob upload exited with code $LASTEXITCODE"
        }

        $elapsed = ((Get-Date) - $uploadStart).ToString('mm\:ss')
        Write-Host "  [OK] $($u.Name) snapshot uploaded in $elapsed" -ForegroundColor Green
        $steps += @{ Step = "$($u.Name) Snapshot"; Status = 'OK'; Detail = $blobName }
    } catch {
        Write-Warning "$($u.Name) snapshot failed: $($_.Exception.Message)"
        $steps += @{ Step = "$($u.Name) Snapshot"; Status = 'FAILED'; Detail = $_.Exception.Message }
        continue
    }

    # ─── Prune older snapshots for this DB to keep $KeepCount most recent ────
    try {
        $blobsJson = az storage blob list `
            --account-name $stName `
            --container-name $ContainerName `
            --prefix "$($u.BaseName)_" `
            --auth-mode login `
            --query "[].{name:name,modified:properties.lastModified}" `
            -o json 2>$null

        $blobs = @($blobsJson | ConvertFrom-Json) |
            Where-Object { $_.name -like "$($u.BaseName)_*.sqlite" } |
            Sort-Object -Property modified -Descending

        if ($blobs.Count -gt $KeepCount) {
            $stale = $blobs | Select-Object -Skip $KeepCount
            foreach ($b in $stale) {
                Write-Host "  Pruning $($b.name)..." -ForegroundColor DarkGray
                az storage blob delete `
                    --account-name $stName `
                    --container-name $ContainerName `
                    --name $b.name `
                    --auth-mode login `
                    --output none 2>&1 | Out-Null
            }
            Write-Host "  [OK] Pruned $($stale.Count) old snapshot(s) for $($u.Name)" -ForegroundColor Green
        } else {
            Write-Host "  Retained all $($blobs.Count) snapshot(s) for $($u.Name) (limit $KeepCount)" -ForegroundColor DarkGray
        }
    } catch {
        # Pruning failure is non-fatal — lifecycle policy will catch it eventually
        Write-Warning "$($u.Name) prune step failed (non-fatal): $($_.Exception.Message)"
    }
}

# ─── Summary ──────────────────────────────────────────────────────────────────
$elapsed = ((Get-Date) - $startTime).ToString('mm\:ss')
$allOk = ($steps | Where-Object { $_.Status -eq 'FAILED' }).Count -eq 0
$summaryColor = if ($allOk) { 'Green' } else { 'Yellow' }

Write-Host ""
Write-Host "================================================================" -ForegroundColor $summaryColor
Write-Host "  SNAPSHOT BACKUP COMPLETE ($elapsed)" -ForegroundColor $summaryColor
Write-Host "================================================================" -ForegroundColor $summaryColor
foreach ($step in $steps) {
    $color = switch ($step.Status) { 'OK' { 'Green' } 'FAILED' { 'Red' } default { 'DarkGray' } }
    $detail = if ($step.Detail) { " — $($step.Detail)" } else { '' }
    Write-Host "  [$($step.Status)] $($step.Step)$detail" -ForegroundColor $color
}
Write-Host "================================================================" -ForegroundColor $summaryColor

if (-not $allOk) {
    exit 1
}
