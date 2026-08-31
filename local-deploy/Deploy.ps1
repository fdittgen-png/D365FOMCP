<#
.SYNOPSIS
    D365FO MCP Services — single-script deployment to any Azure resource group.

.DESCRIPTION
    Replaces the multi-script flow in scripts/Deploy-* with one orchestrator
    that:
      1. Validates Azure auth + resolves resource group / function app names
      2. (optional) Provisions infra via Bicep (main-rg.bicep)
      3. Packages source + node_modules with the Linux better-sqlite3 binary
      4. Deploys code via zip-deploy
      5. Uploads SQLite databases to /home/data/ via Kudu VFS — in parallel
      6. Assigns Function App managed identity to Key Vault Secrets User
         (needed by the live custom-field reader - issues #87-#91)
      7. Health-checks every endpoint in parallel

    Efficiency vs the originals:
      * Auto-discovers Function App from the RG (no hardcoded names)
      * Skips npm install when package-lock.json hash matches the cached deploy
      * Parallel DB uploads + parallel health checks via ThreadJob
      * No explicit stop/start (zip-deploy already triggers a restart)
      * Single Kudu credential fetch shared across all uploads

.PARAMETER ResourceGroup
    Target resource group. Default: tis-d-mcpd365fo-rg (the historical dev RG).
    The script discovers the Function App inside this RG; pass any RG name and
    the deployment follows it.

.PARAMETER Environment
    'd' (development) or 'p' (production). Default: derived from RG name's
    `-d-` / `-p-` infix; falls back to 'd'. Used when -DeployInfra rebuilds the
    Bicep template (which still uses the prefix-env-workload naming convention).

.PARAMETER FunctionAppName
    Override the Function App name. Default: auto-discovered from the RG.
    If multiple Function Apps exist in the RG, you must specify which one.

.PARAMETER Workload
    Workload token used by the Bicep template (default: mcpd365fo). Only used
    with -DeployInfra. Change it if you need to deploy under a different name
    so the storage-account name doesn't collide globally.

.PARAMETER DeployInfra
    Run the Bicep template before deploying code. Required for first-time
    provisioning of an empty RG. NOT needed for code-only refreshes.

.PARAMETER BudgetEmails
    Required when -DeployInfra is set. Recipients for the storage-account
    budget alert at 80 % / 100 %. Pass as a single comma-separated string.

.PARAMETER SkipCode
    Don't package or deploy application code.

.PARAMETER SkipDb
    Don't upload SQLite databases. Useful for pure-code refreshes.

    NOTE: the sealed-ISV tools (d365_isv_*, xref_isv_*) ship with the CODE, but
    their data lives in the isv_* tables INSIDE the KB and XRef .sqlite files.
    A -SkipDb deploy therefore leaves those tools live but dormant: they answer
    "no sealed-ISV data scanned", which is correct but reads like "this
    environment has no ISVs". The script says so explicitly when you use it.

.PARAMETER RefreshIsv
    Re-scan the sealed ISV models into the LOCAL KB/XRef databases before
    uploading (runs build/isv-scan.js, ~7 s). Requires ISV_SCAN_PATHS or a
    customization root in KB_PACKAGES_PATHS. Use when the ISV metadata on disk
    has changed since the databases were last built. Ignored with -SkipDb,
    since nothing would be uploaded.

.PARAMETER Databases
    Which databases to upload. Subset of {'kb','xref','sec'}. Default: all
    three (whichever local files exist).

.PARAMETER SkipRoles
    Don't (re)assign the Key Vault Secrets User role. Skip on subsequent
    deploys where the assignment is already in place.

.PARAMETER SkipValidation
    Don't run health checks at the end. Use when you want a fast push and
    will validate manually.

.PARAMETER KbDbPath
    Override path to d365fo_kb.sqlite. Default: %USERPROFILE%\.claude\d365fo_kb.sqlite

.PARAMETER XrefDbPath
    Override path to d365fo_xref.sqlite. Default: %USERPROFILE%\.claude\d365fo_xref.sqlite

.PARAMETER SecDbPath
    Override path to d365fo_sec.sqlite. Default: %USERPROFILE%\.claude\d365fo_sec.sqlite

.EXAMPLE
    # Full default deploy to dev RG (auto-discover function app)
    .\Deploy.ps1

.EXAMPLE
    # Push code only — no DB upload, no role re-assign, no health checks
    .\Deploy.ps1 -SkipDb -SkipRoles -SkipValidation

.EXAMPLE
    # Custom RG, only the security database
    .\Deploy.ps1 -ResourceGroup my-mcp-rg -SkipCode -Databases sec

.EXAMPLE
    # First-time provisioning into an empty RG
    .\Deploy.ps1 -ResourceGroup my-new-rg -DeployInfra `
                 -BudgetEmails 'florian.dittgen@trelleborg.com'

.NOTES
    Author: Florian Dittgen — local working copy, not git-tracked.
    Run from the repository root or from local-deploy/.
#>
[CmdletBinding()]
param(
    [string]$Subscription = 'TIS.D365FO',   # Azure subscription owning the MCP resource group
    [string]$ResourceGroup = 'tis-d-mcpd365fo-rg',
    [ValidateSet('d', 'p', '')]
    [string]$Environment = '',
    [string]$FunctionAppName = '',
    [string]$Workload = 'mcpd365fo',
    [string]$Prefix = 'tis',

    [switch]$DeployInfra,
    [string[]]$BudgetEmails,

    [switch]$SkipCode,
    [switch]$SkipDb,
    [switch]$SkipRoles,
    [switch]$SkipValidation,

    [ValidateSet('kb', 'xref', 'sec')]
    [string[]]$Databases = @('kb', 'xref', 'sec'),

    [string]$KbDbPath,
    [string]$XrefDbPath,
    [string]$SecDbPath,

    [switch]$RefreshIsv,

    # Enable Key Vault purge protection when -DeployInfra runs. IRREVERSIBLE:
    # it cannot be turned off, the vault cannot be deleted before its retention
    # expires, and the NAME cannot be reused until the soft-deleted copy is
    # recovered. Off by default so a routine deploy never flips it - the
    # existing tis-d-mcpd365fo-kv has it off.
    [switch]$PurgeProtection
)

$ErrorActionPreference = 'Stop'
$startTime = Get-Date
$steps = [System.Collections.Generic.List[hashtable]]::new()

# The phase currently executing. A bare PowerShell error names neither the
# phase nor the line, which is what made the 2026-08-31 summary crash opaque.
$script:CurrentPhase = '(startup)'

function Write-Section($title) {
    $script:CurrentPhase = $title
    Write-Host ''
    Write-Host '────────────────────────────────────────────────────────────────' -ForegroundColor DarkCyan
    Write-Host "  $title" -ForegroundColor Cyan
    Write-Host '────────────────────────────────────────────────────────────────' -ForegroundColor DarkCyan
}

function Add-Step($name, $status) { $steps.Add(@{ Step = $name; Status = $status }) | Out-Null }

# Sealed-ISV content of a KB/XRef .sqlite (issue #75). The ISV tools ship with
# the code, but their data lives in isv_* tables inside these files — so the
# deploy has to report the two independently or a code-only push looks like it
# delivered ISV support when it delivered an empty shell.
function Get-IsvStatus($dbPath, $kind) {
    $helper = Join-Path $scriptDir 'isv-status.cjs'
    if (-not (Test-Path $helper)) { return $null }
    try {
        $json = & node $helper $dbPath $kind 2>$null
        if (-not $json) { return $null }
        return ($json | ConvertFrom-Json)
    } catch { return $null }
}

# One-line human summary of a Get-IsvStatus result.
function Format-IsvStatus($st) {
    if ($null -eq $st)      { return 'unknown (status helper unavailable)' }
    if (-not $st.present) {
        switch ($st.reason) {
            'no-isv-tables'  { return 'NO isv_* tables (built before the ISV scan, or ISV_SCAN_PATHS unset)' }
            'file-not-found' { return 'database file not found' }
            default          { return "unavailable ($($st.reason))" }
        }
    }
    $parts = foreach ($k in $st.counts.PSObject.Properties.Name) {
        '{0} {1}' -f ('{0:N0}' -f $st.counts.$k), $k
    }
    return ('{0} sealed model(s): {1}   [scanned {2}]' -f $st.models, ($parts -join ', '), $st.scanned_at)
}

# ─── Project layout ─────────────────────────────────────────────────────────
$scriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Definition
$projectDir = Split-Path -Parent $scriptDir
if (-not (Test-Path (Join-Path $projectDir 'package.json'))) {
    # Allow running from project root too
    $projectDir = (Get-Location).Path
}
$infraDir   = Join-Path $projectDir 'infra'
$deployDir  = Join-Path $projectDir '.deploy'
$zipPath    = Join-Path $projectDir '.deploy.zip'
$lockHashFile = Join-Path $scriptDir '.npm-cache-hash'

# --- Failure diagnostics ---------------------------------------------------
# Why this exists: on 2026-08-31 a fully successful deploy ended with the bare
# line "Deploy.ps1: The property 'Count' cannot be found on this object." — no
# line number, no phase, no stack, and no indication that everything had in
# fact worked. A deployment script that cannot say WHERE it failed is worse
# than one that fails loudly, because the operator cannot tell a cosmetic
# summary bug from a half-finished upload.

$script:LogFile = Join-Path $scriptDir ('logs\deploy-{0}.log' -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
try {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $script:LogFile) | Out-Null
    Start-Transcript -Path $script:LogFile -Force | Out-Null
    $script:TranscriptOn = $true
} catch {
    # Transcript is a convenience, never a prerequisite.
    $script:TranscriptOn = $false
    Write-Host "  [WARN] Could not start transcript: $($_.Exception.Message)" -ForegroundColor Yellow
}

function Stop-DeployTranscript {
    if ($script:TranscriptOn) {
        try { Stop-Transcript | Out-Null } catch { }
        $script:TranscriptOn = $false
    }
}

function Write-FatalError($errorRecord) {
    $inv = $errorRecord.InvocationInfo
    Write-Host ''
    Write-Host '════════════════════════════════════════════════════════════════' -ForegroundColor Red
    Write-Host '  DEPLOYMENT FAILED' -ForegroundColor Red
    Write-Host '════════════════════════════════════════════════════════════════' -ForegroundColor Red
    Write-Host "  Phase        : $script:CurrentPhase" -ForegroundColor Red
    Write-Host "  Exception    : $($errorRecord.Exception.GetType().FullName)" -ForegroundColor Red
    Write-Host "  Message      : $($errorRecord.Exception.Message)" -ForegroundColor Red
    Write-Host "  Error ID     : $($errorRecord.FullyQualifiedErrorId)" -ForegroundColor DarkGray
    Write-Host "  Category     : $($errorRecord.CategoryInfo.Category) / $($errorRecord.CategoryInfo.Reason)" -ForegroundColor DarkGray
    if ($inv) {
        Write-Host "  Location     : $($inv.ScriptName):$($inv.ScriptLineNumber) char $($inv.OffsetInLine)" -ForegroundColor Red
        if ($inv.Line) {
            Write-Host "  Failing line : $($inv.Line.Trim())" -ForegroundColor Yellow
        }
    }
    if ($errorRecord.Exception.InnerException) {
        Write-Host "  Inner        : $($errorRecord.Exception.InnerException.Message)" -ForegroundColor DarkGray
    }
    if ($errorRecord.ScriptStackTrace) {
        Write-Host '  Stack:' -ForegroundColor DarkGray
        foreach ($line in ($errorRecord.ScriptStackTrace -split "`n")) {
            Write-Host "    $($line.TrimEnd())" -ForegroundColor DarkGray
        }
    }

    # The steps completed so far are the difference between "cosmetic bug after
    # a good deploy" and "died halfway through the upload". Always show them.
    if ($steps -and $steps.Count -gt 0) {
        Write-Host ''
        Write-Host '  Completed before the failure:' -ForegroundColor Cyan
        foreach ($s in $steps) {
            $sc = switch ($s.Status) { 'OK' { 'Green' } 'FAILED' { 'Red' } 'WARNING' { 'Yellow' } default { 'DarkGray' } }
            Write-Host ("    [{0,-7}] {1}" -f $s.Status, $s.Step) -ForegroundColor $sc
        }
    } else {
        Write-Host '  No steps completed — the failure happened during setup.' -ForegroundColor Yellow
    }

    Write-Host ''
    Write-Host "  Full log: $script:LogFile" -ForegroundColor Cyan
    Write-Host '════════════════════════════════════════════════════════════════' -ForegroundColor Red
    Stop-DeployTranscript
}

# Script-scope trap: catches any terminating error anywhere below, including
# those promoted by $ErrorActionPreference = 'Stop'.
trap {
    Write-FatalError $_
    exit 1
}


# Default DB paths
if (-not $KbDbPath)   { $KbDbPath   = Join-Path $env:USERPROFILE '.claude\d365fo_kb.sqlite' }
if (-not $XrefDbPath) { $XrefDbPath = Join-Path $env:USERPROFILE '.claude\d365fo_xref.sqlite' }
if (-not $SecDbPath)  { $SecDbPath  = Join-Path $env:USERPROFILE '.claude\d365fo_sec.sqlite' }

# Derive Environment from RG name when not explicit
if (-not $Environment) {
    if     ($ResourceGroup -match '-d-') { $Environment = 'd' }
    elseif ($ResourceGroup -match '-p-') { $Environment = 'p' }
    else                                  { $Environment = 'd' }
}

Write-Host ''
Write-Host '════════════════════════════════════════════════════════════════' -ForegroundColor Cyan
Write-Host '  D365FO MCP Services — Deployment' -ForegroundColor Cyan
Write-Host '════════════════════════════════════════════════════════════════' -ForegroundColor Cyan
Write-Host "  Resource Group:  $ResourceGroup"
Write-Host "  Environment:     $Environment"
Write-Host "  Project root:    $projectDir"

# ─── Azure auth ─────────────────────────────────────────────────────────────
. "$PSScriptRoot\..\scripts\Common-AzContext.ps1"
$account = Ensure-AzContext -Subscription $Subscription

# ─── Resolve RG ─────────────────────────────────────────────────────────────
$rg = az group show --name $ResourceGroup 2>$null | ConvertFrom-Json
if (-not $rg) {
    # The RG must pre-exist: `az deployment group create` (used by -DeployInfra)
    # targets an existing RG and does not create one. Create it once, then re-run.
    $createHint = "Create it first with:  az group create --name $ResourceGroup --location <region>"
    if ($DeployInfra) {
        throw "Resource group '$ResourceGroup' not found. $createHint  Then re-run with -DeployInfra to provision the resources inside it."
    }
    throw "Resource group '$ResourceGroup' not found, or you lack access to it. $createHint (and pass -DeployInfra to provision resources)."
}
Write-Host "  RG location:     $($rg.location)" -ForegroundColor Green

# ─── Phase 1: Infrastructure (optional) ─────────────────────────────────────
if ($DeployInfra) {
    Write-Section 'Phase 1: Infrastructure (Bicep)'
    if (@($BudgetEmails).Count -eq 0) {
        throw '-BudgetEmails is required when -DeployInfra is set (storage budget alert recipients).'
    }
    $templateFile = Join-Path $infraDir 'main-rg.bicep'
    if (-not (Test-Path $templateFile)) {
        throw "Bicep template not found: $templateFile"
    }

    # main-rg.bicep declares CUSTOM_FIELDS_SOURCES as an empty placeholder (the
    # secret-free registry of D365 environments the live custom-field reader may
    # query, written post-deploy by scripts/Set-D365CustomFieldsSource.ps1).
    # A template deploy would blank it and silently disable every configured
    # environment, so capture it and put it back afterwards.
    $script:PreservedCustomFieldSources = $null
    $preFuncName = if ($FunctionAppName) { $FunctionAppName } else { "$Prefix-$Environment-$Workload-func" }
    $existingSources = az functionapp config appsettings list `
        --resource-group $ResourceGroup --name $preFuncName `
        --query "[?name=='CUSTOM_FIELDS_SOURCES'].value | [0]" -o tsv 2>$null
    if ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace($existingSources)) {
        $script:PreservedCustomFieldSources = $existingSources
        $srcCount = try { @($existingSources | ConvertFrom-Json).Count } catch { '?' }
        Write-Host "  Preserving CUSTOM_FIELDS_SOURCES ($srcCount source(s)) across the template deploy" -ForegroundColor DarkGray
    }

    # The vault may already exist and predate this template (tis-d-mcpd365fo-kv
    # was created 2026-03-17 with purge protection OFF and 7-day retention).
    # Report what the deploy would CHANGE; never flip the one-way switch silently.
    $kvPreName = "$Prefix-$Environment-$Workload-kv"
    $kvPre = az keyvault show --name $kvPreName --resource-group $ResourceGroup -o json 2>$null | ConvertFrom-Json
    if ($kvPre) {
        $kvPurge = [bool]$kvPre.properties.enablePurgeProtection
        $kvRet   = [int]$kvPre.properties.softDeleteRetentionInDays
        Write-Host "  Key Vault '$kvPreName' exists (RBAC: $([bool]$kvPre.properties.enableRbacAuthorization), purge protection: $kvPurge, retention: $kvRet d)" -ForegroundColor DarkGray
        if ($kvRet -lt 90) {
            Write-Host "  [!] Retention will be raised $kvRet d -> 90 d. Allowed, but it can never be lowered again." -ForegroundColor Yellow
        }
        if ($PurgeProtection -and -not $kvPurge) {
            Write-Warning "  -PurgeProtection enables purge protection on '$kvPreName' PERMANENTLY (cannot be undone; blocks deletion and name reuse)."
        }
    }
    $deploymentName = "mcpd365fo-$Environment-$(Get-Date -Format 'yyyyMMddHHmmss')"

    # Write a Bicep parameter file rather than fight PowerShell ↔ az CLI quoting
    # for arrays. JSON-array params via --parameters key="[\"a\"]" are fragile;
    # a parameter file is unambiguous.
    $paramsFile = Join-Path $env:TEMP "mcpd365fo-bicep-params-$([guid]::NewGuid().ToString('N')).json"
    $paramsObj = [ordered]@{
        '$schema'      = 'https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#'
        contentVersion = '1.0.0.0'
        parameters     = [ordered]@{
            env                = @{ value = $Environment }
            workload           = @{ value = $Workload }
            prefix             = @{ value = $Prefix }
            budgetContactEmails = @{ value = @($BudgetEmails) }
            enablePurgeProtection = @{ value = [bool]$PurgeProtection }
        }
    }
    $paramsObj | ConvertTo-Json -Depth 5 | Set-Content -Path $paramsFile -Encoding UTF8
    Write-Host "  Parameter file: $paramsFile" -ForegroundColor DarkGray

    Write-Host "  Deploying $templateFile (this takes 3-5 min)..." -ForegroundColor Yellow
    $bicepResult = az deployment group create `
        --resource-group $ResourceGroup `
        --name $deploymentName `
        --template-file $templateFile `
        --parameters "@$paramsFile" `
        --output json 2>&1
    Remove-Item $paramsFile -Force -ErrorAction SilentlyContinue
    if ($LASTEXITCODE -ne 0) { throw "Bicep deployment failed:`n$bicepResult" }
    $bicepOut = ($bicepResult | ConvertFrom-Json).properties.outputs
    Write-Host "  [OK] Function App URL: $($bicepOut.functionAppUrl.value)" -ForegroundColor Green

    # Restore the registry only if the template actually blanked it: never
    # clobber a value someone set between the capture above and now.
    if ($script:PreservedCustomFieldSources) {
        $nowSources = az functionapp config appsettings list `
            --resource-group $ResourceGroup --name $preFuncName `
            --query "[?name=='CUSTOM_FIELDS_SOURCES'].value | [0]" -o tsv 2>$null
        if ([string]::IsNullOrWhiteSpace($nowSources)) {
            $null = az functionapp config appsettings set `
                --resource-group $ResourceGroup --name $preFuncName `
                --settings "CUSTOM_FIELDS_SOURCES=$script:PreservedCustomFieldSources" --output none 2>&1
            if ($LASTEXITCODE -eq 0) {
                Write-Host '  [OK] CUSTOM_FIELDS_SOURCES restored' -ForegroundColor Green
            } else {
                Write-Warning '  Could not restore CUSTOM_FIELDS_SOURCES - re-run Set-D365CustomFieldsSource.ps1 per environment.'
                Write-Warning "  Preserved value (secret-free): $script:PreservedCustomFieldSources"
            }
        }
    }
    Add-Step 'Bicep' 'OK'
} else {
    Add-Step 'Bicep' 'SKIPPED'
}

# ─── Discover Function App ──────────────────────────────────────────────────
Write-Section 'Discovering Function App'
if (-not $FunctionAppName) {
    $apps = @(az functionapp list --resource-group $ResourceGroup --query '[].name' -o json 2>$null | ConvertFrom-Json)
    $apps = @($apps)   # normalise: a single match is not an array, none is $null

    if ($apps.Count -eq 0) {
        throw "No Function App found in resource group '$ResourceGroup'. Pass -DeployInfra or -FunctionAppName."
    }
    if ($apps.Count -gt 1) {
        # Prefer one that matches the conventional naming
        $preferred = $apps | Where-Object { $_ -like "*$Workload*" -and $_ -like "*$Environment*" } | Select-Object -First 1
        if ($preferred) { $FunctionAppName = $preferred }
        else {
            Write-Host "  Multiple Function Apps found in RG; pass -FunctionAppName to pick one:" -ForegroundColor Yellow
            $apps | ForEach-Object { Write-Host "    - $_" -ForegroundColor DarkGray }
            throw 'Ambiguous Function App.'
        }
    } else {
        $FunctionAppName = $apps[0]
    }
}
$funcApp = az functionapp show --resource-group $ResourceGroup --name $FunctionAppName 2>$null | ConvertFrom-Json
if (-not $funcApp) { throw "Function App '$FunctionAppName' not accessible." }
$funcUrl = "https://$($funcApp.defaultHostName)"
Write-Host "  Function App:    $FunctionAppName" -ForegroundColor Green
Write-Host "  URL:             $funcUrl" -ForegroundColor Green

# ─── Phase 2: Code package + deploy ─────────────────────────────────────────
if (-not $SkipCode) {
    Write-Section 'Phase 2: Code package + deploy'

    if (Test-Path $deployDir) { Remove-Item $deployDir -Recurse -Force }
    if (Test-Path $zipPath)   { Remove-Item $zipPath   -Force }
    New-Item -ItemType Directory -Path $deployDir -Force | Out-Null

    # Top-level files
    foreach ($f in @('host.json', 'package.json', 'package-lock.json')) {
        $src = Join-Path $projectDir $f
        if (Test-Path $src) { Copy-Item $src (Join-Path $deployDir $f) -Force }
    }
    # Top-level src/ files (e.g. src/constants.js — imported by src/azure/* via ../constants.js)
    $srcDir = Join-Path $projectDir 'src'
    if (Test-Path $srcDir) {
        $destSrcDir = Join-Path $deployDir 'src'
        New-Item -ItemType Directory -Path $destSrcDir -Force | Out-Null
        Get-ChildItem -Path $srcDir -File | ForEach-Object {
            Copy-Item $_.FullName (Join-Path $destSrcDir $_.Name) -Force
        }
    }
    # Source tree (only Azure-targeted folders)
    foreach ($sub in @('src\azure', 'src\functions', 'www', 'config', 'build', 'assets')) {
        $src = Join-Path $projectDir $sub
        if (Test-Path $src) {
            $dest = Join-Path $deployDir $sub
            New-Item -ItemType Directory -Path $dest -Force | Out-Null
            # robocopy is much faster than Copy-Item for many small files
            $null = robocopy $src $dest /E /NFL /NDL /NJH /NJS /NP /NS /NC
        }
    }
    Write-Host '  [OK] Source files staged.' -ForegroundColor Green

    # Smart npm install: skip if package-lock.json hash matches the cached one
    $lockPath = Join-Path $deployDir 'package-lock.json'
    $cacheDir = Join-Path $scriptDir '.npm-cache'
    $currentHash = (Get-FileHash $lockPath -Algorithm SHA256).Hash
    $cacheValid = $false
    if ((Test-Path $lockHashFile) -and (Test-Path $cacheDir)) {
        $cachedHash = Get-Content $lockHashFile -Raw -ErrorAction SilentlyContinue
        if ($cachedHash.Trim() -eq $currentHash) { $cacheValid = $true }
    }

    if ($cacheValid) {
        Write-Host '  [OK] node_modules cache hit — copying from .npm-cache' -ForegroundColor Green
        $null = robocopy $cacheDir (Join-Path $deployDir 'node_modules') /E /NFL /NDL /NJH /NJS /NP /NS /NC
    } else {
        Write-Host '  Running npm install (cache miss or first run)...' -ForegroundColor Yellow
        Push-Location $deployDir
        try {
            $npmOut = cmd /c 'npm install --omit=dev 2>&1'
            if ($LASTEXITCODE -ne 0) {
                Write-Host $npmOut -ForegroundColor Red
                throw "npm install failed (exit $LASTEXITCODE)"
            }
            # Linux prebuild for better-sqlite3
            Push-Location (Join-Path $deployDir 'node_modules\better-sqlite3')
            $pbOut = cmd /c 'npx --yes prebuild-install --platform linux --arch x64 --target 20.20.0 --runtime node 2>&1'
            if ($LASTEXITCODE -ne 0) {
                Write-Host $pbOut -ForegroundColor Red
                throw "prebuild-install failed (exit $LASTEXITCODE)"
            }
            Pop-Location
        } finally {
            Pop-Location
        }
        Write-Host '  [OK] npm install + Linux prebuild complete.' -ForegroundColor Green

        # Refresh cache
        if (Test-Path $cacheDir) { Remove-Item $cacheDir -Recurse -Force }
        $null = robocopy (Join-Path $deployDir 'node_modules') $cacheDir /E /NFL /NDL /NJH /NJS /NP /NS /NC
        Set-Content -Path $lockHashFile -Value $currentHash -Encoding ASCII -NoNewline
        Write-Host '  [OK] node_modules cached.' -ForegroundColor DarkGray
    }

    # Disable remote build (Linux binary already in the package)
    $null = cmd /c "az functionapp config appsettings set --resource-group $ResourceGroup --name $FunctionAppName --settings SCM_DO_BUILD_DURING_DEPLOYMENT=false --output none 2>&1"

    Write-Host '  Zipping...' -ForegroundColor DarkGray
    Push-Location $deployDir
    try { Compress-Archive -Path (Get-ChildItem -Path . -Force) -DestinationPath $zipPath -Force }
    finally { Pop-Location }
    $zipSize = [math]::Round((Get-Item $zipPath).Length / 1MB, 1)
    Write-Host "  [OK] Package: $zipSize MB" -ForegroundColor Green

    Write-Host '  Deploying zip with --clean true (wipes wwwroot before extract)...' -ForegroundColor Yellow
    $deployOut = cmd /c "az functionapp deploy --resource-group $ResourceGroup --name $FunctionAppName --src-path ""$zipPath"" --type zip --clean true --restart true --output none 2>&1"
    if ($LASTEXITCODE -ne 0) {
        $real = $deployOut | Where-Object { $_ -notmatch '^WARNING:' }
        if ($real) {
            Write-Host ($real -join "`n") -ForegroundColor Red
            throw 'Code deployment failed.'
        }
    }
    Write-Host '  [OK] Code deployed.' -ForegroundColor Green
    Add-Step 'Code' 'OK'

    Remove-Item $deployDir -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item $zipPath   -Force -ErrorAction SilentlyContinue
} else {
    Add-Step 'Code' 'SKIPPED'
}

# --- Sealed-ISV preflight -------------------------------------------------
# Report ISV content BEFORE anything is uploaded, so the operator sees what the
# databases actually carry rather than inferring it from a successful deploy.
# The ISV TOOLS ship with the code; the ISV DATA lives in isv_* tables inside
# the KB and XRef .sqlite files. Those are two independent deliverables and the
# deploy has to say so, or a code-only push looks like it delivered ISV support
# when it delivered an empty shell.
Write-Section 'Sealed-ISV data (issue #75)'

if ($RefreshIsv -and -not $SkipDb) {
    $isvRoots = if ($env:ISV_SCAN_PATHS) { $env:ISV_SCAN_PATHS } else { '(from KB_PACKAGES_PATHS)' }
    Write-Host "  Re-scanning sealed ISV models into the local databases  [$isvRoots]" -ForegroundColor Yellow
    try {
        & node (Join-Path $projectDir 'build\isv-scan.js') --kb $KbDbPath --xref $XrefDbPath 2>&1 |
            Select-Object -Last 6 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
        Add-Step 'ISV rescan' 'OK'
    } catch {
        # Never fatal: the databases remain valid, just possibly stale.
        Write-Host "  [WARN] ISV rescan failed: $($_.Exception.Message)" -ForegroundColor Yellow
        Add-Step 'ISV rescan' 'WARNING'
    }
} elseif ($RefreshIsv -and $SkipDb) {
    Write-Host '  [SKIP] -RefreshIsv ignored: -SkipDb means nothing would be uploaded.' -ForegroundColor DarkGray
}

$isvKb   = Get-IsvStatus $KbDbPath   'kb'
$isvXref = Get-IsvStatus $XrefDbPath 'xref'
Write-Host "  Local KB   : $(Format-IsvStatus $isvKb)"
Write-Host "  Local XRef : $(Format-IsvStatus $isvXref)"

$isvLocalOk = ($isvKb -and $isvKb.present) -or ($isvXref -and $isvXref.present)

if ($SkipDb) {
    Write-Host ''
    Write-Host '  [!] -SkipDb: the ISV TOOLS deploy, the ISV DATA does not.' -ForegroundColor Yellow
    Write-Host '      d365_isv_list_models / d365_isv_lookup / d365_isv_extension_points /' -ForegroundColor Yellow
    Write-Host '      xref_isv_find_usages will answer "no sealed-ISV data scanned" until the' -ForegroundColor Yellow
    Write-Host '      KB and XRef databases are uploaded - their isv_* tables live inside those' -ForegroundColor Yellow
    Write-Host '      files. Same for include_isv on xref_find_references, which returns null.' -ForegroundColor Yellow
    if ($isvLocalOk) {
        Write-Host ''
        Write-Host '      To ship the ISV data (uploads KB + XRef):' -ForegroundColor Cyan
        Write-Host '        .\local-deploy\Deploy.ps1 -SkipRoles -Databases kb,xref' -ForegroundColor Cyan
    } else {
        Write-Host ''
        Write-Host '      The local databases carry no ISV data either. Build it first:' -ForegroundColor Cyan
        Write-Host '        $env:ISV_SCAN_PATHS = "C:\Workspace\MAIN\Metadata"' -ForegroundColor Cyan
        Write-Host "        node build\isv-scan.js --kb `"$KbDbPath`" --xref `"$XrefDbPath`"" -ForegroundColor Cyan
    }
    Add-Step 'ISV data' 'SKIPPED'
} elseif ($isvLocalOk) {
    Add-Step 'ISV data' 'OK'
} else {
    Write-Host ''
    Write-Host '  [!] Uploading databases that contain NO ISV data - the ISV tools will stay' -ForegroundColor Yellow
    Write-Host '      dormant. Re-run with -RefreshIsv (needs ISV_SCAN_PATHS) to populate them.' -ForegroundColor Yellow
    Add-Step 'ISV data' 'WARNING'
}

# ─── Phase 3: Database upload (parallel) ────────────────────────────────────
if (-not $SkipDb) {
    Write-Section 'Phase 3: SQLite database upload (parallel)'

    # Cache Kudu credentials once for all uploads
    $credsJson = cmd /c "az functionapp deployment list-publishing-credentials --resource-group $ResourceGroup --name $FunctionAppName --query ""{user:publishingUserName, pass:publishingPassword}"" -o json 2>nul"
    $creds = $credsJson | ConvertFrom-Json
    $kuduBase = "https://$FunctionAppName.scm.azurewebsites.net"
    $kuduAuth = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("$($creds.user):$($creds.pass)"))

    # Ensure /home/data/ exists (idempotent — Kudu returns 201/409)
    try {
        Invoke-RestMethod -Uri "$kuduBase/api/vfs/data/" -Method PUT `
            -Headers @{ Authorization = "Basic $kuduAuth" } `
            -ContentType 'application/json' -ErrorAction SilentlyContinue
    } catch { }

    $uploadPlan = @()
    if ('kb'   -in $Databases -and (Test-Path $KbDbPath))   { $uploadPlan += @{ Name='KB';   Local=$KbDbPath;   Remote='d365fo_kb.sqlite'   } }
    if ('xref' -in $Databases -and (Test-Path $XrefDbPath)) { $uploadPlan += @{ Name='XRef'; Local=$XrefDbPath; Remote='d365fo_xref.sqlite' } }
    if ('sec'  -in $Databases -and (Test-Path $SecDbPath))  { $uploadPlan += @{ Name='Sec';  Local=$SecDbPath;  Remote='d365fo_sec.sqlite'  } }

    if (-not $uploadPlan) {
        Write-Host '  [SKIP] No databases to upload (none found at requested paths).' -ForegroundColor DarkGray
        Add-Step 'DB upload' 'SKIPPED'
    } else {
        # ThreadJob keeps the same process-wide auth + faster than Start-Job
        if (-not (Get-Module -ListAvailable -Name ThreadJob)) {
            Import-Module Microsoft.PowerShell.ThreadJob -ErrorAction SilentlyContinue
        }
        $jobs = foreach ($u in $uploadPlan) {
            $sizeMb = [math]::Round((Get-Item $u.Local).Length / 1MB, 1)
            Write-Host "  → $($u.Name) ($sizeMb MB) → /home/data/$($u.Remote)" -ForegroundColor Yellow
            Start-ThreadJob -Name "upload-$($u.Name)" -ArgumentList $kuduBase, $kuduAuth, $u.Local, $u.Remote -ScriptBlock {
                param($base, $auth, $localPath, $remoteName)
                $start = Get-Date
                Invoke-RestMethod -Uri "$base/api/vfs/data/$remoteName" -Method PUT `
                    -Headers @{ Authorization = "Basic $auth"; 'If-Match' = '*' } `
                    -InFile $localPath -ContentType 'application/octet-stream'

                # Integrity check: a dropped/truncated PUT can still return success
                # and leave a partial or 0-byte file (this is what silently broke
                # the xref DB for ~2 months). Verify the remote byte count matches
                # the local file before declaring the upload OK.
                $localLen = (Get-Item $localPath).Length
                $listing  = Invoke-RestMethod -Uri "$base/api/vfs/data/" -Headers @{ Authorization = "Basic $auth" }
                $remote   = $listing | Where-Object { $_.name -eq $remoteName }
                if (-not $remote) {
                    throw "integrity check failed: $remoteName not present after upload"
                }
                $remoteLen = [int64]$remote.size
                if ($remoteLen -ne $localLen) {
                    throw "integrity check failed: size mismatch (local $localLen vs remote $remoteLen bytes) — upload truncated"
                }
                "$(((Get-Date) - $start).ToString('mm\:ss')) — verified $([math]::Round($remoteLen / 1MB, 1)) MB"
            }
        }
        Wait-Job -Job $jobs | Out-Null
        foreach ($j in $jobs) {
            $name = $j.Name -replace '^upload-', ''
            try {
                $elapsed = Receive-Job -Job $j -ErrorAction Stop
                Write-Host "  [OK] $name uploaded in $elapsed" -ForegroundColor Green
                Add-Step "DB:$name" 'OK'
            } catch {
                Write-Warning "$name upload FAILED: $($_.Exception.Message)"
                Add-Step "DB:$name" 'FAILED'
            }
            Remove-Job -Job $j -Force
        }
    }
} else {
    Add-Step 'DB upload' 'SKIPPED'
}

# ─── Phase 4: Role assignments ──────────────────────────────────────────────
if (-not $SkipRoles) {
    Write-Section 'Phase 4: Role assignments (Function App MI → Key Vault Secrets User)'

    $identity = az functionapp identity show --resource-group $ResourceGroup --name $FunctionAppName 2>$null | ConvertFrom-Json
    if (-not $identity -or -not $identity.principalId) {
        Write-Warning '  Function App has no system-assigned managed identity. Enable it via Bicep, then re-run.'
        Add-Step 'Roles' 'SKIPPED'
    } else {
        $kvName = "$Prefix-$Environment-$Workload-kv"
        $kvId = az keyvault show --name $kvName --resource-group $ResourceGroup --query id -o tsv 2>$null
        if (-not $kvId) {
            # No KV in this RG — that's fine if the deploy doesn't use one
            Write-Host "  [SKIP] No Key Vault '$kvName' in RG; nothing to assign." -ForegroundColor DarkGray
            Add-Step 'Roles' 'SKIPPED'
        } else {
            $existing = az role assignment list --assignee $identity.principalId --role 'Key Vault Secrets User' --scope $kvId 2>$null | ConvertFrom-Json
            if (@($existing).Count -gt 0) {
                Write-Host '  [OK] Already assigned.' -ForegroundColor Green
                Add-Step 'Roles' 'OK'
            } else {
                $null = az role assignment create `
                    --assignee-object-id $identity.principalId `
                    --assignee-principal-type ServicePrincipal `
                    --role 'Key Vault Secrets User' `
                    --scope $kvId --output none 2>&1
                if ($LASTEXITCODE -eq 0) {
                    Write-Host '  [OK] Key Vault Secrets User assigned.' -ForegroundColor Green
                    Add-Step 'Roles' 'OK'
                } else {
                    Write-Warning '  Role assignment failed (need Owner or User Access Administrator).'
                    Add-Step 'Roles' 'FAILED'
                }
            }
        }
    }
} else {
    Add-Step 'Roles' 'SKIPPED'
}

# ─── Phase 5: Health checks (parallel) ──────────────────────────────────────
if (-not $SkipValidation) {
    Write-Section 'Phase 5: Health checks (parallel, with retry)'

    Write-Host '  Cold-start window: waiting 20s before first probe...' -ForegroundColor DarkGray
    Start-Sleep -Seconds 20

    # Post-OAuth-cutover expectations: every gated endpoint answers 401 at the
    # Easy Auth edge for anonymous probes (proves the gate is enforced);
    # /api/ping is the only anonymous path and proves the Functions host runs.
    $endpoints = @(
        @{ Label='ping (runtime alive)';     Path='api/ping';                   Expect=200 }
        @{ Label='d365kb';                   Path='api/d365kb';                 Expect=401 }
        @{ Label='d365xref';                 Path='api/d365xref';               Expect=401 }
        @{ Label='d365sec';                  Path='api/d365sec';                Expect=401 }
        @{ Label='d365taskrecorder';         Path='api/d365taskrecorder';       Expect=401 }
        @{ Label='d365sec/upload page';      Path='api/d365sec/upload';         Expect=401 }
        @{ Label='d365taskrecorder/upload';  Path='api/d365taskrecorder/upload'; Expect=401 }
        @{ Label='health (admin, gated)';    Path='api/health';                 Expect=401 }
    )

    $jobs = foreach ($e in $endpoints) {
        Start-ThreadJob -Name $e.Label -ArgumentList "$funcUrl/$($e.Path)", $e.Expect -ScriptBlock {
            param($url, $expect)
            for ($i = 1; $i -le 4; $i++) {
                try {
                    $resp = Invoke-WebRequest -Uri $url -Method GET -TimeoutSec 30 -UseBasicParsing -SkipHttpErrorCheck
                    if ($resp.StatusCode -eq $expect) { return @{ ok=$true; code=$resp.StatusCode; attempt=$i } }
                    if ($i -lt 4) { Start-Sleep -Seconds (5 * $i) }
                    else { return @{ ok=$false; code=$resp.StatusCode; err="got $($resp.StatusCode), expected $expect"; attempt=$i } }
                } catch {
                    if ($i -lt 4) { Start-Sleep -Seconds (5 * $i) }
                    else { return @{ ok=$false; code=0; err=$_.Exception.Message; attempt=$i } }
                }
            }
            return @{ ok=$false; code=0; err='exhausted retries'; attempt=4 }
        }
    }
    Wait-Job -Job $jobs | Out-Null
    foreach ($j in $jobs) {
        $r = Receive-Job -Job $j
        if ($r.ok) {
            Write-Host "  [OK] $($j.Name) (attempt $($r.attempt))" -ForegroundColor Green
            Add-Step "Health:$($j.Name)" 'OK'
        } else {
            Write-Warning "  [FAIL] $($j.Name) — $($r.err)"
            Add-Step "Health:$($j.Name)" 'FAILED'
        }
        Remove-Job -Job $j -Force
    }
} else {
    Add-Step 'Health' 'SKIPPED'
}

# ─── Summary ────────────────────────────────────────────────────────────────
$elapsed = ((Get-Date) - $startTime).ToString('mm\:ss')
# @(...) forces an array. Without it a pipeline matching NOTHING yields $null,
# and $null.Count throws under Set-StrictMode (which the operator's profile
# enables) — so the script died precisely when the deployment had no failures.
$failed  = @($steps | Where-Object { $_.Status -eq 'FAILED' }).Count
$warned  = @($steps | Where-Object { $_.Status -eq 'WARNING' }).Count
$color   = if ($failed -eq 0) { 'Green' } else { 'Yellow' }

Write-Host ''
Write-Host '════════════════════════════════════════════════════════════════' -ForegroundColor $color
Write-Host "  DEPLOYMENT COMPLETE in $elapsed   ($failed failures, $warned warnings)" -ForegroundColor $color
Write-Host '════════════════════════════════════════════════════════════════' -ForegroundColor $color
foreach ($s in $steps) {
    $sc = switch ($s.Status) { 'OK' { 'Green' } 'FAILED' { 'Red' } 'WARNING' { 'Yellow' } default { 'DarkGray' } }
    Write-Host ("  [{0,-7}] {1}" -f $s.Status, $s.Step) -ForegroundColor $sc
}
Write-Host ''
Write-Host '  Endpoints:' -ForegroundColor Cyan
Write-Host "    KB MCP:           $funcUrl/api/d365kb"
Write-Host "    XRef MCP:         $funcUrl/api/d365xref"
Write-Host "    Sec MCP:          $funcUrl/api/d365sec"
Write-Host "    Sec upload page:  $funcUrl/api/d365sec/upload"
Write-Host "    TaskRecorder MCP: $funcUrl/api/d365taskrecorder"
Write-Host "    TaskRecorder UI:  $funcUrl/api/d365taskrecorder/upload"
Write-Host "    Health (admin):   $funcUrl/api/health"
Write-Host ''
Write-Host '  Sealed-ISV data:' -ForegroundColor Cyan
if ($SkipDb) {
    Write-Host '    DORMANT - tools deployed, data not uploaded (-SkipDb).' -ForegroundColor Yellow
    Write-Host '    Ship it with: .\local-deploy\Deploy.ps1 -SkipRoles -Databases kb,xref' -ForegroundColor DarkGray
} elseif ($isvLocalOk) {
    Write-Host "    LIVE - KB   : $(Format-IsvStatus $isvKb)" -ForegroundColor Green
    Write-Host "    LIVE - XRef : $(Format-IsvStatus $isvXref)" -ForegroundColor Green
    Write-Host '    Verify: call d365_isv_list_models on the deployed KB endpoint.' -ForegroundColor DarkGray
} else {
    Write-Host '    NONE - the uploaded databases contain no isv_* tables.' -ForegroundColor Yellow
}
Write-Host ''
Write-Host '  Live UI custom fields (d365_custom_fields):' -ForegroundColor Cyan
# Same failure mode as the sealed-ISV note above: the tool ships with the CODE,
# but it is inert until an environment is registered. Reporting "deployed"
# without reporting "dormant" is how an operator concludes it is broken.
$cfSources = az functionapp config appsettings list `
    --resource-group $ResourceGroup --name $FunctionAppName `
    --query "[?name=='CUSTOM_FIELDS_SOURCES'].value | [0]" -o tsv 2>$null
$cfKvName = az functionapp config appsettings list `
    --resource-group $ResourceGroup --name $FunctionAppName `
    --query "[?name=='KEY_VAULT_NAME'].value | [0]" -o tsv 2>$null
if ([string]::IsNullOrWhiteSpace($cfKvName)) {
    Write-Host '    DORMANT - KEY_VAULT_NAME is not set; run with -DeployInfra to apply the template.' -ForegroundColor Yellow
} elseif ([string]::IsNullOrWhiteSpace($cfSources)) {
    Write-Host '    DORMANT - no D365 environment registered. _Custom field checks return the' -ForegroundColor Yellow
    Write-Host '              field-class explanation instead of resolving the field.' -ForegroundColor Yellow
    Write-Host ('    Register one: .\scripts\Set-D365CustomFieldsSource.ps1 -Key <key> -Url https://<env> -TenantId <guid> -ClientId <guid> -Default -EnvCode ' + $Environment) -ForegroundColor DarkGray
} else {
    $cfKeys = try { (@($cfSources | ConvertFrom-Json) | ForEach-Object { $_.key }) -join ', ' } catch { '(unparseable JSON)' }
    Write-Host "    LIVE - environment(s): $cfKeys" -ForegroundColor Green
    Write-Host "    Verify: d365_custom_fields { table_name: 'SalesTable' }" -ForegroundColor DarkGray
}
Write-Host '════════════════════════════════════════════════════════════════' -ForegroundColor $color

Stop-DeployTranscript
Write-Host "  Log: $script:LogFile" -ForegroundColor DarkGray

if ($failed -gt 0) { exit 1 }
