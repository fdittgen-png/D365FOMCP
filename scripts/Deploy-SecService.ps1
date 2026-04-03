<#
.SYNOPSIS
    Deploy the Security MCP service: updated code + security database.

.DESCRIPTION
    1. Packages the application code (all MCP endpoints + www/ assets)
    2. Deploys it to the Azure Function App via zip deployment
    3. Uploads the d365fo_sec.sqlite database to /home/data/
    4. Restarts the Function App and validates all endpoints with retry

    IMPORTANT: This deploys the FULL application code (KB, XRef, Sec,
    Task Recorder) - not just the security endpoint. The Function App
    runs all services from a single deployment package.

.PARAMETER Environment
    'd' (development) or 'p' (production). Default: d

.PARAMETER SecDbPath
    Path to security SQLite database. Default: %USERPROFILE%\.claude\d365fo_sec.sqlite

.PARAMETER SkipCodeDeploy
    Skip code deployment (only upload database).

.PARAMETER SkipDbUpload
    Skip database upload (only deploy code).

.PARAMETER SkipValidation
    Skip the restart + health check step.

.EXAMPLE
    .\Deploy-SecService.ps1 -Environment d
    .\Deploy-SecService.ps1 -Environment d -SkipCodeDeploy
    .\Deploy-SecService.ps1 -Environment d -SkipDbUpload -SkipValidation
#>
[CmdletBinding()]
param(
    [ValidateSet('d', 'p')]
    [string]$Environment = 'd',

    [string]$SecDbPath,
    [switch]$SkipCodeDeploy,
    [switch]$SkipDbUpload,
    [switch]$SkipValidation
)

# Use 'Continue' to prevent az CLI / npm stderr warnings from becoming terminating errors.
# We check $LASTEXITCODE explicitly after each external command instead.
$ErrorActionPreference = 'Continue'
$prefix   = 'tis'
$workload = 'mcpd365fo'
$rg       = "$prefix-$Environment-$workload-rg"
$funcName = "$prefix-$Environment-$workload-func"

$scriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Definition
$projectDir = Split-Path -Parent $scriptDir
$deployDir  = Join-Path $projectDir '.deploy-sec'
$zipPath    = Join-Path $projectDir '.deploy-sec.zip'

if (-not $SecDbPath) { $SecDbPath = Join-Path $env:USERPROFILE '.claude\d365fo_sec.sqlite' }

Write-Host '================================================================' -ForegroundColor Cyan
Write-Host '  D365FO Security MCP Service Deployment' -ForegroundColor Cyan
Write-Host '================================================================' -ForegroundColor Cyan
Write-Host "  Function App:  $funcName"
Write-Host "  Resource Group: $rg"
Write-Host "  Environment:   $(if ($Environment -eq 'p') { 'Production' } else { 'Development' })"
Write-Host ''

$startTime = Get-Date
$steps = @()

# --- Azure auth check ----------------------------------------------
$account = az account show 2>$null | ConvertFrom-Json
if (-not $account) {
    Write-Host 'Not logged in. Running az login...' -ForegroundColor Yellow
    az login
    $account = az account show | ConvertFrom-Json
}
Write-Host "  Account: $($account.user.name)" -ForegroundColor Green

# --- Verify Function App exists -------------------------------------
$funcApp = az functionapp show --resource-group $rg --name $funcName 2>$null | ConvertFrom-Json
if (-not $funcApp) {
    Write-Error "Function App '$funcName' not found."
    return
}
$funcUrl = "https://$($funcApp.defaultHostName)"
Write-Host "  Function App: $funcUrl" -ForegroundColor Green
Write-Host ''

# --- Pre-flight checks ---------------------------------------------
$hostJsonPath = Join-Path $projectDir 'host.json'
if (-not (Test-Path $hostJsonPath)) {
    Write-Error "host.json not found in project root. Run Deploy-FunctionApp.ps1 first or create host.json."
    return
}

# www/ is loaded at startup by d365taskrecorder - missing it crashes the entire Function App
$wwwDir = Join-Path $projectDir 'www'
if (-not (Test-Path (Join-Path $wwwDir 'taskrecorder.html'))) {
    Write-Warning "www/taskrecorder.html not found - the Function App will fail to start without it."
}

# ===================================================================
#  Step 1: Deploy application code
# ===================================================================
if (-not $SkipCodeDeploy) {
    Write-Host '-- Step 1: Deploy application code --' -ForegroundColor Yellow

    # Clean
    if (Test-Path $deployDir) { Remove-Item $deployDir -Recurse -Force }
    if (Test-Path $zipPath)   { Remove-Item $zipPath -Force }
    New-Item -ItemType Directory -Path $deployDir -Force | Out-Null

    # Copy runtime files
    foreach ($f in @('host.json', 'package.json', 'package-lock.json')) {
        $src = Join-Path $projectDir $f
        if (Test-Path $src) { Copy-Item $src (Join-Path $deployDir $f) }
    }

    # Copy Azure source (not local stdio servers)
    foreach ($subdir in @('src\azure', 'src\functions')) {
        $src = Join-Path $projectDir $subdir
        if (Test-Path $src) {
            $dest = Join-Path $deployDir $subdir
            New-Item -ItemType Directory -Path $dest -Force | Out-Null
            Copy-Item "$src\*" $dest -Recurse
        }
    }

    # Copy www/ - required at startup by d365taskrecorder (reads taskrecorder.html at import time)
    if (Test-Path $wwwDir) {
        $wwwDest = Join-Path $deployDir 'www'
        New-Item -ItemType Directory -Path $wwwDest -Force | Out-Null
        Copy-Item "$wwwDir\*" $wwwDest -Recurse
        Write-Host '  [OK] www/ directory included' -ForegroundColor Green
    }

    # npm install
    Write-Host '  Running npm install...' -ForegroundColor DarkGray
    Push-Location $deployDir
    try {
        npm install --omit=dev 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'npm install failed' }
        Write-Host '  [OK] Dependencies installed' -ForegroundColor Green

        # Linux prebuild for better-sqlite3 (Azure runs Linux)
        Write-Host '  Installing Linux binary for better-sqlite3...' -ForegroundColor DarkGray
        Push-Location (Join-Path $deployDir 'node_modules\better-sqlite3')
        npx --yes prebuild-install --platform linux --arch x64 --target 20.20.0 --runtime node 2>&1 | Out-Null
        Pop-Location
        Write-Host '  [OK] Linux binary installed' -ForegroundColor Green
    } finally {
        Pop-Location
    }

    # Disable remote build (we ship pre-built Linux binaries)
    az functionapp config appsettings set --resource-group $rg --name $funcName `
        --settings SCM_DO_BUILD_DURING_DEPLOYMENT=false --output none 2>&1 | Out-Null

    # Create zip
    Write-Host '  Creating deployment package...' -ForegroundColor DarkGray
    Push-Location $deployDir
    try {
        Compress-Archive -Path (Get-ChildItem -Path . -Force) -DestinationPath $zipPath -Force
    } finally {
        Pop-Location
    }
    $zipSize = [math]::Round((Get-Item $zipPath).Length / 1MB, 1)
    Write-Host "  [OK] Package: $zipSize MB" -ForegroundColor Green

    # Deploy
    Write-Host '  Deploying to Azure...' -ForegroundColor Yellow
    az functionapp deployment source config-zip `
        --resource-group $rg --name $funcName --src $zipPath --output none 2>&1 | Out-Null

    if ($LASTEXITCODE -ne 0) {
        Write-Warning 'Code deployment may have failed - check Azure Portal'
        $steps += @{ Step = 'Code Deploy'; Status = 'WARNING' }
    } else {
        Write-Host '  [OK] Code deployed' -ForegroundColor Green
        $steps += @{ Step = 'Code Deploy'; Status = 'OK' }
    }

    # Clean up
    Remove-Item $deployDir -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item $zipPath -Force -ErrorAction SilentlyContinue
} else {
    Write-Host '-- Step 1: Code deployment SKIPPED --' -ForegroundColor DarkGray
    $steps += @{ Step = 'Code Deploy'; Status = 'SKIPPED' }
}

# ===================================================================
#  Step 2: Upload security database
# ===================================================================
if (-not $SkipDbUpload) {
    Write-Host ''
    Write-Host '-- Step 2: Upload security database --' -ForegroundColor Yellow

    if (-not (Test-Path $SecDbPath)) {
        Write-Error "Security database not found: $SecDbPath`nRun 'npm run build:sec' first."
        return
    }

    $secSize = [math]::Round((Get-Item $SecDbPath).Length / 1MB)
    Write-Host "  Database: $secSize MB ($SecDbPath)" -ForegroundColor DarkGray

    # Get Kudu credentials
    $creds = az functionapp deployment list-publishing-credentials `
        --resource-group $rg --name $funcName `
        --query '{user:publishingUserName, pass:publishingPassword}' -o json 2>$null | ConvertFrom-Json
    $kuduBase = "https://$funcName.scm.azurewebsites.net"
    $kuduAuth = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("$($creds.user):$($creds.pass)"))

    # Create /home/data/ directory
    try {
        Invoke-RestMethod -Uri "$kuduBase/api/vfs/data/" -Method PUT `
            -Headers @{ Authorization = "Basic $kuduAuth" } `
            -ContentType 'application/json' -ErrorAction SilentlyContinue
    } catch {}

    # Upload
    Write-Host "  Uploading d365fo_sec.sqlite ($secSize MB)..." -ForegroundColor Yellow
    $uploadStart = Get-Date
    try {
        Invoke-RestMethod -Uri "$kuduBase/api/vfs/data/d365fo_sec.sqlite" -Method PUT `
            -Headers @{ Authorization = "Basic $kuduAuth"; 'If-Match' = '*' } `
            -InFile $SecDbPath -ContentType 'application/octet-stream'

        $uploadTime = ((Get-Date) - $uploadStart).ToString('mm\:ss')
        Write-Host "  [OK] Security database uploaded in $uploadTime" -ForegroundColor Green
        $steps += @{ Step = 'Sec DB Upload'; Status = 'OK' }
    } catch {
        Write-Warning "Upload failed: $($_.Exception.Message)"
        $steps += @{ Step = 'Sec DB Upload'; Status = 'FAILED' }
    }
} else {
    Write-Host ''
    Write-Host '-- Step 2: Database upload SKIPPED --' -ForegroundColor DarkGray
    $steps += @{ Step = 'Sec DB Upload'; Status = 'SKIPPED' }
}

# ===================================================================
#  Step 3: Restart and validate
# ===================================================================
if (-not $SkipValidation) {
    Write-Host ''
    Write-Host '-- Step 3: Restart and validate --' -ForegroundColor Yellow

    # Stop then start for a clean cold start (avoids restart-loop issues)
    az functionapp stop --resource-group $rg --name $funcName --output none 2>&1 | Out-Null
    Start-Sleep -Seconds 3
    az functionapp start --resource-group $rg --name $funcName --output none 2>&1 | Out-Null
    Write-Host '  Function App restarted. Waiting for cold start...' -ForegroundColor DarkGray
    Start-Sleep -Seconds 30

    # Health check helper with retry (cold start can take 30-60s on Consumption plan)
    function Test-Endpoint {
        param([string]$Url, [string]$Label, [int]$Retries = 3, [int]$DelaySec = 10)
        for ($i = 1; $i -le $Retries; $i++) {
            try {
                $resp = Invoke-WebRequest -Uri $Url -Method GET -TimeoutSec 30 -UseBasicParsing
                if ($resp.StatusCode -eq 200) {
                    Write-Host "  [OK] $Label" -ForegroundColor Green
                    return 'OK'
                }
            } catch {
                if ($i -lt $Retries) {
                    Write-Host "  [..] $Label - retry $i/$Retries in ${DelaySec}s..." -ForegroundColor DarkGray
                    Start-Sleep -Seconds $DelaySec
                }
            }
        }
        Write-Warning "$Label failed after $Retries attempts"
        return 'FAILED'
    }

    # Validate MCP endpoints (first call warms up the Function App)
    foreach ($svc in @('d365kb', 'd365xref', 'd365sec')) {
        $status = Test-Endpoint -Url "$funcUrl/api/$svc" -Label "$svc health"
        $steps += @{ Step = "$svc health"; Status = $status }
    }

    # Validate upload pages
    foreach ($page in @('d365sec/upload', 'd365taskrecorder/upload')) {
        $status = Test-Endpoint -Url "$funcUrl/api/$page" -Label "$page page"
        $steps += @{ Step = "$page page"; Status = $status }
    }
} else {
    Write-Host ''
    Write-Host '-- Step 3: Validation SKIPPED --' -ForegroundColor DarkGray
    $steps += @{ Step = 'Validation'; Status = 'SKIPPED' }
}

# ===================================================================
#  Summary
# ===================================================================
$elapsed = ((Get-Date) - $startTime).ToString('mm\:ss')
$failCount = ($steps | Where-Object { $_.Status -eq 'FAILED' }).Count
$color = if ($failCount -eq 0) { 'Green' } else { 'Yellow' }

Write-Host ''
Write-Host '================================================================' -ForegroundColor $color
Write-Host "  DEPLOYMENT COMPLETE ($elapsed)" -ForegroundColor $color
Write-Host '================================================================' -ForegroundColor $color
foreach ($s in $steps) {
    $sc = switch ($s.Status) { 'OK' { 'Green' } 'FAILED' { 'Red' } 'WARNING' { 'Yellow' } default { 'DarkGray' } }
    Write-Host "  [$($s.Status)] $($s.Step)" -ForegroundColor $sc
}
Write-Host ''
Write-Host "  KB MCP:            $funcUrl/api/d365kb"
Write-Host "  XRef MCP:          $funcUrl/api/d365xref"
Write-Host "  Sec MCP:           $funcUrl/api/d365sec"
Write-Host "  Sec Upload:        $funcUrl/api/d365sec/upload"
Write-Host "  Task Recorder MCP: $funcUrl/api/d365taskrecorder"
Write-Host "  Task Recorder UI:  $funcUrl/api/d365taskrecorder/upload"
Write-Host '================================================================' -ForegroundColor $color
