<#
.SYNOPSIS
  Add anonymous paths to the Easy Auth excludedPaths list of the MCP Function App.

.DESCRIPTION
  Non-destructive merge: reads the live authsettingsV2, unions the requested
  paths with whatever is already excluded, writes back. Use after adding a new
  anonymous route (e.g. the server icon /api/icon.png referenced from every
  MCP server's initialize → serverInfo.icons). Enable-McpAuth.ps1 carries the
  full list for a from-scratch cutover; this script is the incremental path.

  Requires an active (PIM-activated) Owner/Contributor on the resource group.

.EXAMPLE
  .\scripts\Update-McpAuthExcludedPaths.ps1
  .\scripts\Update-McpAuthExcludedPaths.ps1 -Paths '/favicon.ico','/api/other'
#>
param(
  [string[]]$Paths          = @('/api/icon.png', '/api/icon-512.png', '/favicon.ico', '/favicon.png'),
  [string]$Subscription     = 'TIS.D365FO',
  [string]$ResourceGroup    = 'tis-d-mcpd365fo-rg',
  [string]$App              = 'tis-d-mcpd365fo-func'
)
$ErrorActionPreference = 'Stop'

# Pin the Azure subscription (never trust the CLI default — see Common-AzContext.ps1)
. "$PSScriptRoot\Common-AzContext.ps1"
$null = Ensure-AzContext -Subscription $Subscription

$subId = az account show --subscription $Subscription --query id -o tsv
if ($LASTEXITCODE -ne 0) { throw "Cannot resolve subscription id for '$Subscription'." }
$authUrl = "https://management.azure.com/subscriptions/$subId/resourceGroups/$ResourceGroup/providers/Microsoft.Web/sites/$App/config/authsettingsV2?api-version=2022-03-01"

$auth = az rest --method GET --url $authUrl -o json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'Reading authsettingsV2 failed (PIM role not active?).' }

$current = @($auth.properties.globalValidation.excludedPaths)
$merged  = @($current + $Paths | Where-Object { $_ } | Select-Object -Unique)
if ($merged.Count -eq $current.Count) {
  Write-Host "excludedPaths already contain: $($Paths -join ', ') — nothing to do." -ForegroundColor Green
  exit 0
}

$auth.properties.globalValidation | Add-Member -NotePropertyName excludedPaths -NotePropertyValue $merged -Force
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) "authv2-$([guid]::NewGuid()).json"
$auth | ConvertTo-Json -Depth 20 | Set-Content -Path $tmp -Encoding utf8NoBOM
try {
  az rest --method PUT --url $authUrl --headers 'Content-Type=application/json' --body "@$tmp" --output none
  if ($LASTEXITCODE -ne 0) { throw 'Writing excludedPaths failed.' }
} finally {
  Remove-Item $tmp -Force -ErrorAction SilentlyContinue
}
Write-Host "excludedPaths now: $($merged -join ', ')" -ForegroundColor Green

$base = "https://$App.azurewebsites.net"
$code = try { (Invoke-WebRequest -Uri "$base/api/icon.png" -UseBasicParsing -SkipHttpErrorCheck).StatusCode } catch { 'n/a' }
Write-Host "GET $base/api/icon.png → $code (200 expected once the code deploy is live)"
