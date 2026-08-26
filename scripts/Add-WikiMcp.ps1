<#
.SYNOPSIS
    Add a new wiki to the D365FO MCP Services platform.

.DESCRIPTION
    One-command provisioning of a new blob-backed wiki MCP:
      1. Validates the wiki name (slug format)
      2. Appends a new entry to config/wikis.json
      3. Creates the blob container in the storage account
      4. Optionally uploads a seed index.md so the wiki is reachable
         immediately (even before the ingest pipeline runs)
      5. Optionally redeploys the Function App to activate the new route
      6. Prints the endpoint URL for the new MCP

    After this script completes, the new wiki is reachable at
    https://tis-{env}-mcpd365fo-func.azurewebsites.net/api/wiki-mcp/<Name>.

    To remove a wiki, delete the entry from config/wikis.json and redeploy
    (the blob container and its contents are not touched — decide separately
    whether to delete them).

.PARAMETER Name
    Wiki slug — used in the route and the MCP server name. Lowercase, 1–63
    chars, alphanumeric and hyphens only, must start with an alphanumeric
    character.

.PARAMETER Title
    Human-readable title shown to the LLM and in the catalog. Any string.

.PARAMETER Description
    One or two sentences describing what the wiki contains and when to use
    it. This string is the MCP server description — the LLM reads it when
    deciding whether the wiki is relevant to a user's question.

.PARAMETER Container
    Storage container name. Defaults to 'wiki-<Name>'. Must conform to
    Azure Blob Storage container naming rules (3–63 chars, lowercase,
    alphanumeric, hyphens).

.PARAMETER PagesPrefix
    Blob-name prefix under which page markdown files live. Default: ''.
    Example: 'tickets/' means the wiki only lists blobs matching
    'tickets/*.md'. The index blob (usually 'index.md') is always at the
    container root.

.PARAMETER IndexBlob
    Name of the index blob. Default: 'index.md'.

.PARAMETER SeedIndex
    Upload a minimal index.md (title + description + "no pages yet" note)
    so the wiki responds to wiki_index calls from the moment it's created.

.PARAMETER Redeploy
    Run Deploy-FunctionApp.ps1 after updating the registry so the new route
    is live immediately.

.PARAMETER Environment
    'd' (dev) or 'p' (prod). Default: 'd'.

.EXAMPLE
    # Minimal — adds the entry, creates the container, does not seed or redeploy
    .\Add-WikiMcp.ps1 -Name kb-policies `
                      -Title 'IT Policies KB' `
                      -Description 'Trelleborg IT policies, security requirements, and operational procedures.'

.EXAMPLE
    # Full provision — seed + redeploy in one go
    .\Add-WikiMcp.ps1 -Name runbooks `
                      -Title 'Operations Runbooks' `
                      -Description 'Runbooks for common operational tasks across D365 and supporting platforms.' `
                      -PagesPrefix 'runbooks/' `
                      -SeedIndex -Redeploy -Environment p
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[a-z0-9][a-z0-9-]{0,62}$')]
    [string]$Name,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$Title,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$Description,

    [string]$Container,

    [string]$PagesPrefix = '',

    [string]$IndexBlob = 'index.md',

    [switch]$SeedIndex,

    [switch]$Redeploy,

    [ValidateSet('d', 'p')]
    [string]$Environment = 'd',
    [string]$Subscription = 'TIS.D365FO'   # Azure subscription owning the MCP resource group
)

$ErrorActionPreference = 'Stop'

# Pin the Azure subscription (never trust the CLI default — see Common-AzContext.ps1)
. "$PSScriptRoot\Common-AzContext.ps1"
$null = Ensure-AzContext -Subscription $Subscription

$prefix     = 'tis'
$workload   = 'mcpd365fo'
$rg         = "$prefix-$Environment-$workload-rg"
$funcName   = "$prefix-$Environment-$workload-func"
$stName     = "$prefix$Environment${workload}st"   # no hyphens in storage account names

$configPath = Join-Path $PSScriptRoot '..\config\wikis.json'

Write-Host '================================================================' -ForegroundColor Cyan
Write-Host '  Add Wiki MCP' -ForegroundColor Cyan
Write-Host '================================================================' -ForegroundColor Cyan
Write-Host "  Name:        $Name"
Write-Host "  Title:       $Title"
Write-Host "  Environment: $Environment   (rg=$rg, func=$funcName, st=$stName)"

# ─── STEP 1: Compute container name ────────────────────────────────
if (-not $Container) {
    $Container = "wiki-$Name"
}
if ($Container -notmatch '^[a-z0-9][a-z0-9-]{2,62}$') {
    throw "Container name '$Container' is invalid. Azure requires 3–63 lowercase alphanumeric/hyphen chars starting with a letter or number."
}
Write-Host "  Container:   $Container"
Write-Host "  PagesPrefix: '$PagesPrefix'"
Write-Host "  IndexBlob:   $IndexBlob"

# ─── STEP 2: Load & validate config/wikis.json ─────────────────────
Write-Host "`nSTEP 1: Loading $configPath..." -ForegroundColor Yellow
if (Test-Path $configPath) {
    try {
        $rawJson = Get-Content -Path $configPath -Raw
        $wikis = if ([string]::IsNullOrWhiteSpace($rawJson)) {
            @()
        } else {
            @(ConvertFrom-Json -InputObject $rawJson)
        }
    } catch {
        throw "Could not parse $configPath as JSON: $($_.Exception.Message)"
    }
} else {
    Write-Host "  File does not exist — will create it." -ForegroundColor DarkGray
    $configDir = Split-Path -Parent $configPath
    if (-not (Test-Path $configDir)) { New-Item -ItemType Directory -Path $configDir | Out-Null }
    $wikis = @()
}

$existing = $wikis | Where-Object { $_.name -eq $Name }
if ($existing) {
    throw "Wiki '$Name' already exists in $configPath. Remove it first or pick a different -Name."
}

# ─── STEP 3: Append the new entry and save ─────────────────────────
Write-Host "`nSTEP 2: Appending new wiki entry..." -ForegroundColor Yellow
$newEntry = [pscustomobject]@{
    name        = $Name
    title       = $Title
    description = $Description
    container   = $Container
    indexBlob   = $IndexBlob
    pagesPrefix = $PagesPrefix
}
$wikis = @($wikis) + $newEntry
$wikis | ConvertTo-Json -Depth 5 | Set-Content -Path $configPath -Encoding UTF8
Write-Host "  Wrote $($wikis.Count) entry/entries to $configPath" -ForegroundColor Green

# ─── STEP 4: Resolve storage account key ───────────────────────────
Write-Host "`nSTEP 3: Resolving storage account key..." -ForegroundColor Yellow
$keyJson = az storage account keys list --account-name $stName --resource-group $rg --query '[0].value' -o tsv 2>$null
if ([string]::IsNullOrWhiteSpace($keyJson)) {
    throw "Could not read storage-account key for '$stName'. Ensure your Azure CLI is signed in and has 'Storage Account Key Operator Service Role' or owner/contributor on the resource group."
}
$stKey = $keyJson.Trim()
Write-Host "  Key resolved (length=$($stKey.Length))" -ForegroundColor Green

# ─── STEP 5: Create the blob container ─────────────────────────────
Write-Host "`nSTEP 4: Creating blob container '$Container'..." -ForegroundColor Yellow
$createResult = az storage container create `
    --account-name $stName `
    --account-key  $stKey `
    --name $Container `
    --output json 2>&1
if ($LASTEXITCODE -ne 0) {
    throw "az storage container create failed: $createResult"
}
Write-Host "  Container ready" -ForegroundColor Green

# ─── STEP 6: Optionally upload a seed index.md ─────────────────────
if ($SeedIndex) {
    Write-Host "`nSTEP 5: Uploading seed $IndexBlob..." -ForegroundColor Yellow
    $tempFile = [System.IO.Path]::GetTempFileName()
    try {
        $seed = @"
---
title: $Title
wiki: $Name
created: $(Get-Date -Format 'yyyy-MM-ddTHH:mm:ssZ' -AsUTC)
---

# $Title

_$Description_

## Pages

*(No pages yet — add markdown files under ``$Container/$PagesPrefix`` and re-run
the ingest pipeline, or upload pages manually.)*
"@
        Set-Content -Path $tempFile -Value $seed -Encoding UTF8

        $uploadResult = az storage blob upload `
            --account-name $stName `
            --account-key  $stKey `
            --container-name $Container `
            --name $IndexBlob `
            --file $tempFile `
            --overwrite `
            --output json 2>&1
        if ($LASTEXITCODE -ne 0) {
            throw "az storage blob upload failed: $uploadResult"
        }
        Write-Host "  Seed index uploaded to $Container/$IndexBlob" -ForegroundColor Green
    } finally {
        Remove-Item -Path $tempFile -ErrorAction SilentlyContinue
    }
} else {
    Write-Host "`nSTEP 5: Skipping seed index (pass -SeedIndex to upload a placeholder)" -ForegroundColor DarkGray
}

# ─── STEP 7: Optionally redeploy the Function App ──────────────────
if ($Redeploy) {
    Write-Host "`nSTEP 6: Redeploying Function App..." -ForegroundColor Yellow
    $deployScript = Join-Path $PSScriptRoot 'Deploy-FunctionApp.ps1'
    & $deployScript -Environment $Environment -SkipDbUpload
    if ($LASTEXITCODE -ne 0) {
        throw "Deploy-FunctionApp.ps1 failed with exit code $LASTEXITCODE."
    }
} else {
    Write-Host "`nSTEP 6: Skipping redeploy (pass -Redeploy to activate the route immediately)" -ForegroundColor DarkGray
}

# ─── Summary ───────────────────────────────────────────────────────
$endpoint = "https://$funcName.azurewebsites.net/api/wiki-mcp/$Name"
Write-Host "`n================================================================" -ForegroundColor Cyan
Write-Host '  Wiki added' -ForegroundColor Green
Write-Host '================================================================' -ForegroundColor Cyan
Write-Host "  Endpoint:   $endpoint"
Write-Host "  Container:  $Container  (account $stName)"
Write-Host "  Registry:   $configPath"
if (-not $Redeploy) {
    Write-Host ''
    Write-Host '  The registry is updated but the Function App has not been redeployed.' -ForegroundColor Yellow
    Write-Host "  Run:  .\Deploy-FunctionApp.ps1 -Environment $Environment -SkipDbUpload" -ForegroundColor Yellow
}
Write-Host ''
