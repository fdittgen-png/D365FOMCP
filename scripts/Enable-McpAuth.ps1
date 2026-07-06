<#
.SYNOPSIS
  Cutover script: enable Entra Easy Auth on the D365FO MCP Function App.

.DESCRIPTION
  Runs Part B of docs/MCP-Entra-Auth-Setup.md once the directory admin has
  created the app registration (Part A). Configures App Service Authentication
  (Easy Auth) with Return401 for MCP bearer-token clients, keeps /api/health
  open for deploy probes, and removes the temporary REQUIRE_AUTH=false app
  setting so the in-code role gate (src/azure/mcp-auth.js) enforces.

  Safe to re-run (idempotent az calls). Requires an az session with
  Contributor/Owner on the Function App. If the tenant's Conditional Access
  demands step-up MFA for ARM writes, run interactively.

.PARAMETER ApiAppId
  Client ID (GUID) of the MCP app registration (sp-tis-d-mcpd365fo-mcp).

.PARAMETER AppIdUri
  Application ID URI exposed by that registration. Both this and the raw
  client ID are accepted as token audiences (Entra v2 can emit either).

.EXAMPLE
  .\scripts\Enable-McpAuth.ps1 -ApiAppId 00000000-0000-0000-0000-000000000000
#>
param(
  [Parameter(Mandatory = $true)] [string]$ApiAppId,
  [string]$AppIdUri       = 'api://sp-tis-d-mcpd365fo-mcp',
  [string]$Subscription   = 'TIS.D365FO',
  [string]$ResourceGroup  = 'tis-d-mcpd365fo-rg',
  [string]$App            = 'tis-d-mcpd365fo-func',
  [string]$TenantId       = '0f861177-7722-4f06-8db9-3384e5321a9f',
  [switch]$KeepRequireAuthOff   # skip the REQUIRE_AUTH cleanup (staged cutover)
)

$ErrorActionPreference = 'Stop'

Write-Host "== 1/4 Configuring Microsoft identity provider (audience: $AppIdUri)" -ForegroundColor Cyan
az webapp auth microsoft update --subscription $Subscription -g $ResourceGroup -n $App `
  --client-id $ApiAppId `
  --issuer "https://login.microsoftonline.com/$TenantId/v2.0" `
  --allowed-audiences $AppIdUri $ApiAppId `
  --yes | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Identity provider configuration failed.' }

Write-Host '== 2/4 Enabling Easy Auth (Return401, /api/health excluded)' -ForegroundColor Cyan
az webapp auth update --subscription $Subscription -g $ResourceGroup -n $App `
  --enabled true `
  --unauthenticated-client-action Return401 `
  --excluded-paths '[/api/health]' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Easy Auth enable failed.' }

if (-not $KeepRequireAuthOff) {
  Write-Host '== 3/4 Removing temporary REQUIRE_AUTH=false app setting (fail-closed again)' -ForegroundColor Cyan
  az functionapp config appsettings delete --subscription $Subscription -g $ResourceGroup -n $App `
    --setting-names REQUIRE_AUTH | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'App setting cleanup failed.' }
} else {
  Write-Host '== 3/4 Skipped REQUIRE_AUTH cleanup (-KeepRequireAuthOff)' -ForegroundColor Yellow
}

Write-Host '== 4/4 Verifying' -ForegroundColor Cyan
$base = "https://$App.azurewebsites.net"

# Anonymous MCP call must now be rejected at the platform edge.
$mcp = try { (Invoke-WebRequest -Uri "$base/api/d365kb" -Method POST -Body '{}' -ContentType 'application/json' -SkipHttpErrorCheck).StatusCode } catch { $_.Exception.Response.StatusCode.value__ }
# Health probe must stay open.
$health = try { (Invoke-WebRequest -Uri "$base/api/health" -SkipHttpErrorCheck).StatusCode } catch { $_.Exception.Response.StatusCode.value__ }

Write-Host "   anonymous POST /api/d365kb -> $mcp (expect 401)"
Write-Host "   GET /api/health            -> $health (expect 200)"
if ($mcp -ne 401) { Write-Warning 'MCP endpoint did not return 401 for anonymous callers — check the auth config.' }
if ($health -ne 200) { Write-Warning '/api/health is no longer reachable — deploy probes will fail.' }

Write-Host ''
Write-Host 'Next: member smoke test —' -ForegroundColor Cyan
Write-Host "  az account get-access-token --resource $AppIdUri --query accessToken -o tsv"
Write-Host "  curl -H 'Authorization: Bearer <token>' -H 'Content-Type: application/json' \"
Write-Host "       -d '{""jsonrpc"":""2.0"",""id"":1,""method"":""tools/list""}' $base/api/d365kb"
