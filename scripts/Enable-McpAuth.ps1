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
  Client ID (GUID) of the MCP app registration: sp-tis-d-d365fokb-mcp,
  appId 54b1261c-352d-4772-b83a-001e529bd117 — created by Aaron via
  Ticket#202607102005643 (2026-07), configured by
  scripts/Configure-McpAppRegistration.ps1. (Supersedes the earlier
  sp-tis-p-D365metadata-mcp / 5e8bc645-… registration, now retired.)

.PARAMETER AppIdUri
  Application ID URI exposed by that registration. Both this and the raw
  client ID are accepted as token audiences (Entra v2 can emit either).

.EXAMPLE
  .\scripts\Enable-McpAuth.ps1 -ApiAppId 54b1261c-352d-4772-b83a-001e529bd117
#>
param(
  [Parameter(Mandatory = $true)] [string]$ApiAppId,
  [string]$AppIdUri       = 'api://trelleborg.onmicrosoft.com/sp-tis-d-d365fokb-mcp',
  [string]$Subscription   = 'TIS.D365FO',
  [string]$ResourceGroup  = 'tis-d-mcpd365fo-rg',
  [string]$App            = 'tis-d-mcpd365fo-func',
  [string]$TenantId       = '0f861177-7722-4f06-8db9-3384e5321a9f',
  [switch]$KeepRequireAuthOff   # skip the REQUIRE_AUTH cleanup (staged cutover)
)

$ErrorActionPreference = 'Stop'

# Pin the Azure subscription (never trust the CLI default — see Common-AzContext.ps1)
. "$PSScriptRoot\Common-AzContext.ps1"
$null = Ensure-AzContext -Subscription $Subscription

Write-Host "== 1/4 Configuring Microsoft identity provider (audiences: $AppIdUri + $ApiAppId)" -ForegroundColor Cyan
# A never-configured app reports auth config version v1 (classic); the authV2
# command group refuses to touch it until the one-time format upgrade.
$cfgVer = az webapp auth config-version show --subscription $Subscription -g $ResourceGroup -n $App -o tsv
if ($cfgVer -ne 'v2') {
  Write-Host "   auth config version is '$cfgVer' — upgrading to v2"
  az webapp auth config-version upgrade --subscription $Subscription -g $ResourceGroup -n $App | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Auth config-version upgrade to v2 failed.' }
}
# az's --allowed-audiences accepts only ONE value on current CLI versions
# (a second value fails with "unrecognized arguments"), but Entra v2 can emit
# either the App ID URI or the client ID as `aud` — so set the provider with
# one audience, then merge the full list into authsettingsV2 via ARM directly.
az webapp auth microsoft update --subscription $Subscription -g $ResourceGroup -n $App `
  --client-id $ApiAppId `
  --issuer "https://login.microsoftonline.com/$TenantId/v2.0" `
  --allowed-audiences $AppIdUri `
  --yes | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Identity provider configuration failed.' }

$subId = az account show --subscription $Subscription --query id -o tsv
if ($LASTEXITCODE -ne 0) { throw "Cannot resolve subscription id for '$Subscription'." }
$authUrl = "https://management.azure.com/subscriptions/$subId/resourceGroups/$ResourceGroup/providers/Microsoft.Web/sites/$App/config/authsettingsV2?api-version=2022-03-01"
$auth = az rest --method GET --url $authUrl -o json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'Reading authsettingsV2 failed.' }
$validation = $auth.properties.identityProviders.azureActiveDirectory.validation
$merged = @(@($validation.allowedAudiences) + @($AppIdUri, $ApiAppId) | Where-Object { $_ } | Select-Object -Unique)
$validation | Add-Member -NotePropertyName allowedAudiences -NotePropertyValue $merged -Force
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) "authv2-$([guid]::NewGuid()).json"
$auth | ConvertTo-Json -Depth 20 | Set-Content -Path $tmp -Encoding utf8NoBOM
try {
  az rest --method PUT --url $authUrl --headers 'Content-Type=application/json' --body "@$tmp" --output none
  if ($LASTEXITCODE -ne 0) { throw 'Writing merged allowedAudiences failed.' }
} finally {
  Remove-Item $tmp -Force -ErrorAction SilentlyContinue
}
Write-Host "   allowedAudiences: $($merged -join ', ')"

Write-Host '== 2/4 Enabling Easy Auth (Return401; ping + OAuth proxy excluded)' -ForegroundColor Cyan
# Excluded (anonymous) paths — NO brackets, '[...]' is stored as a literal path:
#  - /api/ping                    anonymous liveness probe (src/functions/d365ping.js)
#  - /.well-known/*               OAuth discovery (RFC 9728 PRM + RFC 8414 ASM), served
#                                 by src/functions/oauth-proxy.js
#  - /api/oauth/*                 authorize/token/register proxy to Entra (strips the
#                                 RFC 8707 `resource` param — AADSTS9010010 fix)
# /api/health is NOT excluded: it is the admin dashboard backend and its code
# fail-closes behind Easy Auth (decideAdminAccess) anyway.
#
# `--excluded-paths` (like --allowed-audiences) accepts only ONE value on
# current az versions — set one here, then write the full list via ARM below.
az webapp auth update --subscription $Subscription -g $ResourceGroup -n $App `
  --enabled true `
  --unauthenticated-client-action Return401 `
  --excluded-paths '/api/ping' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Easy Auth enable failed.' }

$excluded = @(
  '/api/ping',
  '/api/icon.png',       # server icon referenced from initialize.serverInfo.icons (src/functions/d365icon.js)
  '/api/icon-512.png',
  '/favicon.ico',
  '/favicon.png',
  '/.well-known/oauth-protected-resource',
  '/.well-known/oauth-protected-resource/*',
  '/.well-known/oauth-authorization-server',
  '/.well-known/oauth-authorization-server/*',
  '/.well-known/openid-configuration',
  '/api/oauth/authorize',
  '/api/oauth/token',
  '/api/oauth/register'
)
$auth = az rest --method GET --url $authUrl -o json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'Reading authsettingsV2 for excludedPaths failed.' }
$auth.properties.globalValidation | Add-Member -NotePropertyName excludedPaths -NotePropertyValue $excluded -Force
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) "authv2-$([guid]::NewGuid()).json"
$auth | ConvertTo-Json -Depth 20 | Set-Content -Path $tmp -Encoding utf8NoBOM
try {
  az rest --method PUT --url $authUrl --headers 'Content-Type=application/json' --body "@$tmp" --output none
  if ($LASTEXITCODE -ne 0) { throw 'Writing excludedPaths failed.' }
} finally {
  Remove-Item $tmp -Force -ErrorAction SilentlyContinue
}
Write-Host "   excludedPaths: $($excluded -join ', ')"

Write-Host '== 2b/4 Removing WEBSITE_AUTH_PRM_DEFAULT_WITH_SCOPES (in-app PRM replaces it)' -ForegroundColor Cyan
# While this setting exists, Easy Auth serves its own protected-resource
# metadata pointing clients DIRECTLY at Entra — which dead-ends at
# AADSTS9010010 for MCP clients that send the RFC 8707 `resource` parameter.
# src/functions/oauth-proxy.js serves the replacement document, whose
# authorization_servers points at the in-app OAuth proxy instead.
az functionapp config appsettings delete --subscription $Subscription -g $ResourceGroup -n $App `
  --setting-names WEBSITE_AUTH_PRM_DEFAULT_WITH_SCOPES | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'WEBSITE_AUTH_PRM_DEFAULT_WITH_SCOPES cleanup failed.' }

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
# (Auth-settings changes can take ~1 min to reach the workers; re-run this
# block or the probes by hand if the first attempt still shows old behavior.)
$mcp = try { (Invoke-WebRequest -Uri "$base/api/d365kb" -Method POST -Body '{}' -ContentType 'application/json' -SkipHttpErrorCheck).StatusCode } catch { $_.Exception.Response.StatusCode.value__ }
# Liveness probe must stay open.
$ping = try { (Invoke-WebRequest -Uri "$base/api/ping" -SkipHttpErrorCheck).StatusCode } catch { $_.Exception.Response.StatusCode.value__ }
# OAuth proxy: PRM must be served by OUR function (authorization_servers = this app,
# not login.microsoftonline.com), and /authorize must 302 to Entra.
$prm = try { Invoke-WebRequest -Uri "$base/.well-known/oauth-protected-resource/api/d365kb" -SkipHttpErrorCheck } catch { $null }
$prmOk = $prm -and $prm.StatusCode -eq 200 -and ($prm.Content | ConvertFrom-Json).authorization_servers -contains $base
$authz = try { (Invoke-WebRequest -Uri "$base/api/oauth/authorize?response_type=code" -MaximumRedirection 0 -SkipHttpErrorCheck).StatusCode } catch { $_.Exception.Response.StatusCode.value__ }

Write-Host "   anonymous POST /api/d365kb                        -> $mcp (expect 401)"
Write-Host "   GET /api/ping                                     -> $ping (expect 200)"
Write-Host "   GET /.well-known/oauth-protected-resource/api/d365kb -> in-app PRM: $prmOk (expect True)"
Write-Host "   GET /api/oauth/authorize                          -> $authz (expect 302)"
if ($mcp -ne 401) { Write-Warning 'MCP endpoint did not return 401 for anonymous callers — check the auth config (propagation can lag ~1 min).' }
if ($ping -ne 200) { Write-Warning '/api/ping is not reachable anonymously — deploy probes will fail (is d365ping.js deployed?).' }
if (-not $prmOk) { Write-Warning 'PRM is not the in-app document — is oauth-proxy.js deployed, the path excluded, and WEBSITE_AUTH_PRM_DEFAULT_WITH_SCOPES removed?' }
if ($authz -ne 302) { Write-Warning '/api/oauth/authorize did not redirect — is oauth-proxy.js deployed and the path excluded from Easy Auth?' }

Write-Host ''
Write-Host 'Next: member smoke test —' -ForegroundColor Cyan
Write-Host "  az account get-access-token --resource $AppIdUri --query accessToken -o tsv"
Write-Host "  curl -H 'Authorization: Bearer <token>' -H 'Content-Type: application/json' \"
Write-Host "       -d '{""jsonrpc"":""2.0"",""id"":1,""method"":""tools/list""}' $base/api/d365kb"
