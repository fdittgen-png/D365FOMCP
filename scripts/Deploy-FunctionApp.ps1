<#
.SYNOPSIS
    Deploy application code to the Azure Function App.

.DESCRIPTION
    Packages the project code and deploys it to the Azure Function App
    using zip deployment. Uploads SQLite databases to the Function App's
    persistent /home/data/ filesystem via Kudu VFS API.

    The deployment includes:
    - host.json (Azure Functions runtime configuration)
    - package.json + node_modules with Linux better-sqlite3 binary
    - src/ (application source code)
    - SQLite databases uploaded to /home/data/ via Kudu

.PARAMETER Environment
    'd' or 'p'. Default: d

.PARAMETER SkipNpmInstall
    Skip npm install --production (use existing node_modules).

.PARAMETER SkipDbUpload
    Skip uploading SQLite databases to the Function App.

.PARAMETER KbDbPath
    Path to KB SQLite database. Default: %USERPROFILE%\.claude\d365fo_kb.sqlite

.PARAMETER XrefDbPath
    Path to XRef SQLite database. Default: %USERPROFILE%\.claude\d365fo_xref.sqlite

.EXAMPLE
    .\Deploy-FunctionApp.ps1 -Environment d
    .\Deploy-FunctionApp.ps1 -Environment d -SkipDbUpload
#>
[CmdletBinding()]
param(
    [ValidateSet('d', 'p')]
    [string]$Environment = 'd',

    [switch]$SkipNpmInstall,
    [switch]$SkipDbUpload,

    [string]$KbDbPath,
    [string]$XrefDbPath
)

$ErrorActionPreference = 'Stop'
$prefix   = 'tis'
$workload = 'mcpd365fo'
$rg       = "$prefix-$Environment-$workload-rg"
$funcName = "$prefix-$Environment-$workload-func"

$scriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Definition
$projectDir = Split-Path -Parent $scriptDir
$deployDir  = Join-Path $projectDir '.deploy'
$zipPath    = Join-Path $projectDir '.deploy.zip'

# Default database paths
if (-not $KbDbPath)   { $KbDbPath   = Join-Path $env:USERPROFILE '.claude\d365fo_kb.sqlite' }
if (-not $XrefDbPath) { $XrefDbPath = Join-Path $env:USERPROFILE '.claude\d365fo_xref.sqlite' }

Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "  D365FO MCP Services - Function App Deployment" -ForegroundColor Cyan
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "  Function App: $funcName"
Write-Host "  Resource Group: $rg"
Write-Host ""

# --- Verify Function App exists --------------------------
$funcApp = az functionapp show --resource-group $rg --name $funcName 2>$null | ConvertFrom-Json
if (-not $funcApp) {
    Write-Error "Function App '$funcName' not found. Run Deploy-Infrastructure.ps1 first."
    return
}
Write-Host "  [OK] Function App exists: $($funcApp.defaultHostName)" -ForegroundColor Green

# --- Upload SQLite databases ----------------------------
if (-not $SkipDbUpload) {
    Write-Host "`n--- Uploading SQLite databases to /home/data/ ---" -ForegroundColor Yellow

    # Verify databases exist
    if (-not (Test-Path $KbDbPath)) {
        Write-Error "KB database not found: $KbDbPath. Run 'npm run build:kb' first."
        return
    }
    if (-not (Test-Path $XrefDbPath)) {
        Write-Error "XRef database not found: $XrefDbPath. Run 'npm run build:xref' first."
        return
    }

    $kbSize = [math]::Round((Get-Item $KbDbPath).Length / 1MB)
    $xrefSize = [math]::Round((Get-Item $XrefDbPath).Length / 1MB)
    Write-Host "  KB database:   $kbSize MB" -ForegroundColor DarkGray
    Write-Host "  XRef database: $xrefSize MB" -ForegroundColor DarkGray

    # Get Kudu publishing credentials
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
    Write-Host "  [OK] /home/data/ directory ready." -ForegroundColor Green

    # Upload KB database
    Write-Host "  Uploading KB database ($kbSize MB)..." -ForegroundColor Yellow
    Invoke-RestMethod -Uri "$kuduBase/api/vfs/data/d365fo_kb.sqlite" -Method PUT `
        -Headers @{ Authorization = "Basic $kuduAuth"; 'If-Match' = '*' } `
        -InFile $KbDbPath -ContentType 'application/octet-stream'
    Write-Host "  [OK] KB database uploaded." -ForegroundColor Green

    # Upload XRef database
    Write-Host "  Uploading XRef database ($xrefSize MB) - this may take several minutes..." -ForegroundColor Yellow
    Invoke-RestMethod -Uri "$kuduBase/api/vfs/data/d365fo_xref.sqlite" -Method PUT `
        -Headers @{ Authorization = "Basic $kuduAuth"; 'If-Match' = '*' } `
        -InFile $XrefDbPath -ContentType 'application/octet-stream'
    Write-Host "  [OK] XRef database uploaded." -ForegroundColor Green
} else {
    Write-Host "`n  [SKIP] Database upload skipped." -ForegroundColor DarkGray
}

# --- Create host.json if missing -------------------------
$hostJsonPath = Join-Path $projectDir 'host.json'
if (-not (Test-Path $hostJsonPath)) {
    Write-Host "`nCreating default host.json..." -ForegroundColor Yellow
    $hostJsonContent = @{
        version = '2.0'
        extensionBundle = @{
            id      = 'Microsoft.Azure.Functions.ExtensionBundle'
            version = '[4.*, 5.0.0' + ')'
        }
        logging = @{
            applicationInsights = @{
                samplingSettings = @{
                    isEnabled = $true
                    excludedTypes = 'Request'
                }
            }
        }
    }
    $hostJsonContent | ConvertTo-Json -Depth 4 | Set-Content $hostJsonPath -Encoding utf8
    Write-Host "  [OK] host.json created." -ForegroundColor Green
}

# --- Prepare deployment package (code + node_modules) ----
Write-Host "`nPreparing deployment package..." -ForegroundColor Yellow

# Clean previous deploy artifacts
if (Test-Path $deployDir) { Remove-Item $deployDir -Recurse -Force }
if (Test-Path $zipPath)   { Remove-Item $zipPath -Force }
New-Item -ItemType Directory -Path $deployDir -Force | Out-Null

# Copy required files
$filesToCopy = @('host.json', 'package.json', 'package-lock.json')
foreach ($file in $filesToCopy) {
    $src = Join-Path $projectDir $file
    if (Test-Path $src) {
        Copy-Item $src (Join-Path $deployDir $file)
    }
}

# Copy Azure source code (exclude local-only stdio servers)
$azureDir = Join-Path $projectDir 'src\azure'
$funcDir  = Join-Path $projectDir 'src\functions'
if (Test-Path $azureDir) {
    New-Item -ItemType Directory -Path (Join-Path $deployDir 'src\azure') -Force | Out-Null
    Copy-Item "$azureDir\*" (Join-Path $deployDir 'src\azure') -Recurse
}
if (Test-Path $funcDir) {
    New-Item -ItemType Directory -Path (Join-Path $deployDir 'src\functions') -Force | Out-Null
    Copy-Item "$funcDir\*" (Join-Path $deployDir 'src\functions') -Recurse
}

# Copy www/ directory (test UIs for Task Recorder etc.)
$wwwDir = Join-Path $projectDir 'www'
if (Test-Path $wwwDir) {
    New-Item -ItemType Directory -Path (Join-Path $deployDir 'www') -Force | Out-Null
    Copy-Item "$wwwDir\*" (Join-Path $deployDir 'www') -Recurse
    Write-Host "  [OK] www/ directory copied." -ForegroundColor Green
}

# npm install + cross-install Linux better-sqlite3 binary
if (-not $SkipNpmInstall) {
    Write-Host "  Running npm install --production..." -ForegroundColor Yellow
    Push-Location $deployDir
    try {
        $npmOutput = npm install --omit=dev 2>&1
        if ($LASTEXITCODE -ne 0) {
            Write-Error "npm install failed."
            return
        }
        Write-Host "  [OK] Dependencies installed." -ForegroundColor Green

        # Cross-install Linux prebuild for better-sqlite3
        Write-Host "  Downloading Linux prebuild for better-sqlite3..." -ForegroundColor Yellow
        Push-Location (Join-Path $deployDir 'node_modules\better-sqlite3')
        $prebuildOutput = npx --yes prebuild-install --platform linux --arch x64 --target 20.20.0 --runtime node 2>&1
        Pop-Location
        Write-Host "  [OK] Linux binary installed." -ForegroundColor Green
    } finally {
        Pop-Location
    }
} else {
    # Copy existing node_modules
    $nmDir = Join-Path $projectDir 'node_modules'
    if (Test-Path $nmDir) {
        Write-Host "  Copying node_modules..." -ForegroundColor Yellow
        Copy-Item $nmDir (Join-Path $deployDir 'node_modules') -Recurse
    }
}

# Disable remote build (we ship pre-built Linux binaries)
$env:MSYS_NO_PATHCONV = 1
az functionapp config appsettings set --resource-group $rg --name $funcName `
    --settings SCM_DO_BUILD_DURING_DEPLOYMENT=false --output none 2>&1

# Create zip
Write-Host "  Creating zip package..." -ForegroundColor Yellow
Push-Location $deployDir
try {
    Compress-Archive -Path (Get-ChildItem -Path . -Force) -DestinationPath $zipPath -Force
} finally {
    Pop-Location
}

$zipSize = [math]::Round((Get-Item $zipPath).Length / 1MB, 1)
Write-Host "  [OK] Package created: $zipSize MB" -ForegroundColor Green

# --- Deploy code -----------------------------------------
Write-Host "`nDeploying to Azure Function App..." -ForegroundColor Yellow

$deployOutput = az functionapp deployment source config-zip `
    --resource-group $rg `
    --name $funcName `
    --src $zipPath `
    --output none 2>&1

# az CLI warnings go to stderr; check actual exit code, not stderr
if ($LASTEXITCODE -ne 0) {
    $errors = $deployOutput | Where-Object { $_ -notmatch '^WARNING:' }
    if ($errors) {
        Write-Error "Deployment failed: $errors"
        return
    }
}

# --- Clean up --------------------------------------------
Remove-Item $deployDir -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item $zipPath -Force -ErrorAction SilentlyContinue

# --- Restart and validate --------------------------------
$funcUrl = "https://$($funcApp.defaultHostName)"

# Stop then start for a clean cold start (avoids restart-loop issues)
Write-Host "`nRestarting Function App..." -ForegroundColor Yellow
az functionapp stop --resource-group $rg --name $funcName --output none 2>&1
Start-Sleep -Seconds 3
az functionapp start --resource-group $rg --name $funcName --output none 2>&1
Write-Host "  Waiting for cold start..." -ForegroundColor DarkGray
Start-Sleep -Seconds 30

# Health check with retry (cold start can take 30-60s)
function Test-Endpoint {
    param([string]$Url, [string]$Label, [int]$Retries = 3, [int]$DelaySec = 10)
    for ($i = 1; $i -le $Retries; $i++) {
        try {
            $resp = Invoke-WebRequest -Uri $Url -Method GET -TimeoutSec 30 -UseBasicParsing
            if ($resp.StatusCode -eq 200) {
                Write-Host "  [OK] $Label" -ForegroundColor Green
                return
            }
        } catch {
            if ($i -lt $Retries) {
                Write-Host "  [..] $Label - retry $i/$Retries in ${DelaySec}s..." -ForegroundColor DarkGray
                Start-Sleep -Seconds $DelaySec
            }
        }
    }
    Write-Warning "$Label failed after $Retries attempts"
}

Write-Host ""
foreach ($svc in @('d365kb', 'd365xref', 'd365sec')) {
    Test-Endpoint -Url "$funcUrl/api/$svc" -Label "$svc health"
}
foreach ($page in @('d365sec/upload', 'd365taskrecorder/upload')) {
    Test-Endpoint -Url "$funcUrl/api/$page" -Label "$page page"
}

Write-Host ""
Write-Host "================================================================" -ForegroundColor Green
Write-Host "  FUNCTION APP DEPLOYMENT COMPLETE" -ForegroundColor Green
Write-Host "================================================================" -ForegroundColor Green
Write-Host "  KB MCP:            $funcUrl/api/d365kb"
Write-Host "  XRef MCP:          $funcUrl/api/d365xref"
Write-Host "  Sec MCP:           $funcUrl/api/d365sec"
Write-Host "  Sec Upload:        $funcUrl/api/d365sec/upload"
Write-Host "  Task Recorder MCP: $funcUrl/api/d365taskrecorder"
Write-Host "  Task Recorder UI:  $funcUrl/api/d365taskrecorder/upload"
Write-Host "  Data:              /home/data/ (persistent storage)"
Write-Host "================================================================" -ForegroundColor Green
