<#
.SYNOPSIS
    Upload SQLite databases to Azure Function App and restart the service.

.DESCRIPTION
    Simple deployment script that:
    1. Uploads d365fo_kb.sqlite and d365fo_xref.sqlite to /home/data/ via Kudu VFS API
    2. Restarts the Function App so the MCP services pick up the new databases

    Use Update-Databases.ps1 to rebuild the databases first.

.PARAMETER Environment
    'd' (development) or 'p' (production). Default: d

.PARAMETER KbDbPath
    Path to KB SQLite database. Default: %USERPROFILE%\.claude\d365fo_kb.sqlite

.PARAMETER XrefDbPath
    Path to XRef SQLite database. Default: %USERPROFILE%\.claude\d365fo_xref.sqlite

.PARAMETER KbOnly
    Only upload the KB database.

.PARAMETER XrefOnly
    Only upload the XRef database.

.PARAMETER SkipRestart
    Skip the Function App restart after upload.

.EXAMPLE
    .\Deploy-Databases.ps1 -Environment d
    .\Deploy-Databases.ps1 -Environment p -KbOnly
    .\Deploy-Databases.ps1 -Environment d -KbDbPath "C:\output\d365fo_kb.sqlite"

.NOTES
    Requires Azure CLI (az) and an active login.
    Run 'az login' first if not authenticated.
#>
[CmdletBinding()]
param(
    [ValidateSet('d', 'p')]
    [string]$Environment = 'd',

    [string]$KbDbPath,
    [string]$XrefDbPath,
    [string]$SecDbPath,

    [switch]$KbOnly,
    [switch]$XrefOnly,
    [switch]$SecOnly,
    [switch]$SkipRestart
)

$ErrorActionPreference = 'Stop'
$prefix   = 'tis'
$workload = 'mcpd365fo'
$rg       = "$prefix-$Environment-$workload-rg"
$funcName = "$prefix-$Environment-$workload-func"

# Default database paths
if (-not $KbDbPath)   { $KbDbPath   = Join-Path $env:USERPROFILE '.claude\d365fo_kb.sqlite' }
if (-not $XrefDbPath) { $XrefDbPath = Join-Path $env:USERPROFILE '.claude\d365fo_xref.sqlite' }
if (-not $SecDbPath)  { $SecDbPath  = Join-Path $env:USERPROFILE '.claude\d365fo_sec.sqlite' }

Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "  D365FO MCP Services - Database Deployment" -ForegroundColor Cyan
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "  Function App: $funcName"
Write-Host "  Resource Group: $rg"
Write-Host "  Environment: $(if ($Environment -eq 'p') { 'Production' } else { 'Development' })"
Write-Host ""

# ─── Azure CLI auth check ────────────────────────────────────────────────────
$account = az account show 2>$null | ConvertFrom-Json
if (-not $account) {
    Write-Host "Not logged in. Running az login..." -ForegroundColor Yellow
    az login
    $account = az account show | ConvertFrom-Json
}
Write-Host "  Account: $($account.user.name)" -ForegroundColor Green

# ─── Verify Function App exists ───────────────────────────────────────────────
$funcApp = az functionapp show --resource-group $rg --name $funcName 2>$null | ConvertFrom-Json
if (-not $funcApp) {
    Write-Error "Function App '$funcName' not found. Run Deploy-Infrastructure.ps1 first."
    return
}
Write-Host "  [OK] Function App: $($funcApp.defaultHostName)" -ForegroundColor Green

# ─── Verify database files ────────────────────────────────────────────────────
$uploads = @()

if (-not $XrefOnly -and -not $SecOnly) {
    if (-not (Test-Path $KbDbPath)) {
        Write-Error "KB database not found: $KbDbPath`nRun Update-Databases.ps1 first."
        return
    }
    $kbSize = [math]::Round((Get-Item $KbDbPath).Length / 1MB)
    Write-Host "  KB database:   $kbSize MB  ($KbDbPath)" -ForegroundColor DarkGray
    $uploads += @{ Name = 'KB'; LocalPath = $KbDbPath; RemoteName = 'd365fo_kb.sqlite'; SizeMB = $kbSize }
}

if (-not $KbOnly -and -not $SecOnly) {
    if (-not (Test-Path $XrefDbPath)) {
        Write-Error "XRef database not found: $XrefDbPath`nRun Update-Databases.ps1 first."
        return
    }
    $xrefSize = [math]::Round((Get-Item $XrefDbPath).Length / 1MB)
    Write-Host "  XRef database: $xrefSize MB  ($XrefDbPath)" -ForegroundColor DarkGray
    $uploads += @{ Name = 'XRef'; LocalPath = $XrefDbPath; RemoteName = 'd365fo_xref.sqlite'; SizeMB = $xrefSize }
}

if ($SecOnly -or (-not $KbOnly -and -not $XrefOnly)) {
    if (Test-Path $SecDbPath) {
        $secSize = [math]::Round((Get-Item $SecDbPath).Length / 1MB)
        Write-Host "  Sec database:  $secSize MB  ($SecDbPath)" -ForegroundColor DarkGray
        $uploads += @{ Name = 'Sec'; LocalPath = $SecDbPath; RemoteName = 'd365fo_sec.sqlite'; SizeMB = $secSize }
    } elseif ($SecOnly) {
        Write-Error "Security database not found: $SecDbPath`nRun build-sec.js first."
        return
    } else {
        Write-Host "  Sec database:  (not found — skipping)" -ForegroundColor DarkGray
    }
}

Write-Host ""

# ─── Get Kudu publishing credentials ─────────────────────────────────────────
Write-Host "Getting Kudu credentials..." -ForegroundColor DarkGray
$creds = az functionapp deployment list-publishing-credentials `
    --resource-group $rg --name $funcName `
    --query "{user:publishingUserName, pass:publishingPassword}" -o json 2>$null | ConvertFrom-Json
$kuduUser = $creds.user
$kuduPass = $creds.pass
$kuduBase = "https://$funcName.scm.azurewebsites.net"
$kuduAuth = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("${kuduUser}:${kuduPass}"))

# Create /home/data/ directory
try {
    Invoke-RestMethod -Uri "$kuduBase/api/vfs/data/" -Method PUT `
        -Headers @{ Authorization = "Basic $kuduAuth" } `
        -ContentType 'application/json' -ErrorAction SilentlyContinue
} catch {} # Ignore if directory already exists

# ─── Upload databases ─────────────────────────────────────────────────────────
$startTime = Get-Date
$steps = @()

foreach ($upload in $uploads) {
    Write-Host "Uploading $($upload.Name) database ($($upload.SizeMB) MB)..." -ForegroundColor Yellow
    $uploadStart = Get-Date

    try {
        Invoke-RestMethod -Uri "$kuduBase/api/vfs/data/$($upload.RemoteName)" -Method PUT `
            -Headers @{ Authorization = "Basic $kuduAuth"; 'If-Match' = '*' } `
            -InFile $upload.LocalPath -ContentType 'application/octet-stream'

        $uploadElapsed = ((Get-Date) - $uploadStart).ToString('mm\:ss')
        Write-Host "  [OK] $($upload.Name) uploaded in $uploadElapsed" -ForegroundColor Green
        $steps += @{ Step = "$($upload.Name) Upload"; Status = 'OK' }
    } catch {
        Write-Warning "$($upload.Name) upload failed: $($_.Exception.Message)"
        $steps += @{ Step = "$($upload.Name) Upload"; Status = 'FAILED' }
    }
}

# ─── Restart Function App ─────────────────────────────────────────────────────
if (-not $SkipRestart) {
    Write-Host ""
    Write-Host "Restarting Function App..." -ForegroundColor Yellow
    try {
        az functionapp restart --resource-group $rg --name $funcName --output none 2>&1
        Write-Host "  [OK] Function App restarted" -ForegroundColor Green
        $steps += @{ Step = 'Restart'; Status = 'OK' }
    } catch {
        Write-Warning "Restart failed: $($_.Exception.Message)"
        $steps += @{ Step = 'Restart'; Status = 'FAILED' }
    }

    # Wait for cold start
    Write-Host "  Waiting 15s for cold start..." -ForegroundColor DarkGray
    Start-Sleep -Seconds 15

    # ─── Validate endpoints ───────────────────────────────────────────────────
    Write-Host ""
    Write-Host "Validating endpoints..." -ForegroundColor Yellow
    $funcUrl = "https://$($funcApp.defaultHostName)"

    if (-not $XrefOnly -and -not $SecOnly) {
        try {
            $kbHealth = Invoke-RestMethod -Uri "$funcUrl/api/d365kb" -Method GET -TimeoutSec 30
            Write-Host "  [OK] KB:   $($kbHealth.status)" -ForegroundColor Green
            $steps += @{ Step = 'KB Health Check'; Status = 'OK' }
        } catch {
            Write-Warning "KB health check failed: $($_.Exception.Message)"
            $steps += @{ Step = 'KB Health Check'; Status = 'FAILED' }
        }
    }

    if (-not $KbOnly -and -not $SecOnly) {
        try {
            $xrefHealth = Invoke-RestMethod -Uri "$funcUrl/api/d365xref" -Method GET -TimeoutSec 30
            Write-Host "  [OK] XRef: $($xrefHealth.status)" -ForegroundColor Green
            $steps += @{ Step = 'XRef Health Check'; Status = 'OK' }
        } catch {
            Write-Warning "XRef health check failed: $($_.Exception.Message)"
            $steps += @{ Step = 'XRef Health Check'; Status = 'FAILED' }
        }
    }

    if ($SecOnly -or (-not $KbOnly -and -not $XrefOnly)) {
        try {
            $secHealth = Invoke-RestMethod -Uri "$funcUrl/api/d365sec" -Method GET -TimeoutSec 30
            Write-Host "  [OK] Sec:  $($secHealth.status)" -ForegroundColor Green
            $steps += @{ Step = 'Sec Health Check'; Status = 'OK' }
        } catch {
            Write-Warning "Sec health check failed: $($_.Exception.Message)"
            $steps += @{ Step = 'Sec Health Check'; Status = 'FAILED' }
        }
    }
} else {
    Write-Host ""
    Write-Host "  [SKIP] Restart skipped. Remember to restart manually:" -ForegroundColor DarkGray
    Write-Host "    az functionapp restart --resource-group $rg --name $funcName" -ForegroundColor DarkGray
}

# ─── Summary ──────────────────────────────────────────────────────────────────
$elapsed = ((Get-Date) - $startTime).ToString('mm\:ss')
$allOk = ($steps | Where-Object { $_.Status -eq 'FAILED' }).Count -eq 0
$summaryColor = if ($allOk) { 'Green' } else { 'Yellow' }

Write-Host ""
Write-Host "================================================================" -ForegroundColor $summaryColor
Write-Host "  DATABASE DEPLOYMENT COMPLETE ($elapsed)" -ForegroundColor $summaryColor
Write-Host "================================================================" -ForegroundColor $summaryColor
foreach ($step in $steps) {
    $color = switch ($step.Status) { 'OK' { 'Green' } 'FAILED' { 'Red' } default { 'DarkGray' } }
    Write-Host "  [$($step.Status)] $($step.Step)" -ForegroundColor $color
}
$funcUrl = "https://$($funcApp.defaultHostName)"
Write-Host "  KB MCP:   $funcUrl/api/d365kb"
Write-Host "  XRef MCP: $funcUrl/api/d365xref"
Write-Host "  Sec MCP:  $funcUrl/api/d365sec"
Write-Host "================================================================" -ForegroundColor $summaryColor
