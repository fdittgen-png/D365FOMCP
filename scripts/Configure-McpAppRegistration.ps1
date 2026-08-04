<#
.SYNOPSIS
  Owner-run script: fully configure the sp-tis-d-d365fokb-mcp app registration
  Aaron created via Ticket#202607102005643, plus the group/role/assignment
  steps he made self-service by granting ownership.

.DESCRIPTION
  Aaron created (2026-07) three bare objects and made Florian OWNER of all of
  them — app registration sp-tis-d-d365fokb-mcp, its Enterprise app, and the
  security group D365FO-MCP-Users. "Created, not configured." This script
  closes the whole gap in one idempotent run:

  On the app registration (Graph PATCH, merge-based):
    - Application ID URI api://trelleborg.onmicrosoft.com/sp-tis-d-d365fokb-mcp
      (tenant policy rejects bare api://<name> URIs — verified-domain form)
    - requested access token version 2 (v2 issuer, required by Easy Auth config)
    - delegated scope user_impersonation (admins AND users may consent)
    - app role "MCP Access" value Mcp.Access (Users/Groups)
    - public client flows + redirect URIs
      https://claude.ai/api/mcp/auth_callback and http://localhost
    - declared API permissions: its own user_impersonation + Graph
      openid/profile/offline_access/User.Read (one consent covers everything a
      sign-in requests; offline_access = refresh tokens for MCP clients)

  On the directory objects (owner privileges suffice):
    - add Florian to D365FO-MCP-Users
    - assign the group to the Mcp.Access role on the Enterprise app
    - Enterprise app: Assignment required = Yes

  NOT done here: tenant-wide admin consent — per Karl-Johan it's optional UX
  (skips the one-time Accept dialog) and needs a Global Admin. Test a sign-in
  first; only if "Need admin approval" appears, message a Global Admin with
  the ticket ID and the app link printed at the end.

.NOTES
  az ad * / az rest call Microsoft Graph — CA demands step-up MFA, so run from
  a session prepared with:
    az login --tenant 0f861177-7722-4f06-8db9-3384e5321a9f --scope https://graph.microsoft.com/.default

.EXAMPLE
  .\scripts\Configure-McpAppRegistration.ps1
#>
param(
  [string]$ApiAppId       = '54b1261c-352d-4772-b83a-001e529bd117',  # sp-tis-d-d365fokb-mcp
  [string]$TenantId       = '0f861177-7722-4f06-8db9-3384e5321a9f',
  [string]$AppIdUri       = 'api://trelleborg.onmicrosoft.com/sp-tis-d-d365fokb-mcp',
  [string]$GroupId        = '371b144a-234f-4df3-b99a-980a4f6eee4c',  # D365FO-MCP-Users
  [string]$FirstMemberOid = '9495865f-c1c7-459f-87a6-4e9d8a20fb28',  # Florian Dittgen
  [string]$RoleValue      = 'Mcp.Access'
)

$ErrorActionPreference = 'Stop'
$graph = 'https://graph.microsoft.com/v1.0'

$GraphAppId  = '00000003-0000-0000-c000-000000000000'
$GraphScopes = [ordered]@{
  'openid'         = '37f7f235-527c-4136-accd-4a02d197296e'
  'profile'        = '14dad69e-099b-42c9-810b-d002981feec1'
  'offline_access' = '7427e0e9-2fba-42fe-b0c0-848c9e6a8182'
  'User.Read'      = 'e1fe6dd8-ba31-4d61-89e7-88639da4683d'
}
$RedirectUris = @('https://claude.ai/api/mcp/auth_callback', 'http://localhost')

# az.cmd mangles embedded quotes in inline JSON on Windows — pass bodies via temp file.
function Invoke-GraphWrite([string]$Method, [string]$Url, [object]$Body) {
  $tmp = Join-Path ([System.IO.Path]::GetTempPath()) "mcp-entra-body-$([guid]::NewGuid()).json"
  ($Body | ConvertTo-Json -Compress -Depth 10) | Set-Content -Path $tmp -Encoding utf8NoBOM
  try {
    az rest --method $Method --url $Url --headers 'Content-Type=application/json' --body "@$tmp" --output none
    if ($LASTEXITCODE -ne 0) { throw "$Method $Url failed." }
  } finally {
    Remove-Item $tmp -Force -ErrorAction SilentlyContinue
  }
}

Write-Host '== 0/5 Resolving directory objects' -ForegroundColor Cyan
$app = az ad app show --id $ApiAppId -o json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw "Cannot read app registration $ApiAppId. If the error mentions multi-factor authentication: az login --tenant $TenantId --scope https://graph.microsoft.com/.default" }
$sp = az ad sp show --id $ApiAppId -o json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw "Cannot read the Enterprise app for $ApiAppId." }
$grp = az ad group show --group $GroupId -o json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw "Cannot read the security group $GroupId." }
Write-Host "   app registration: $($app.displayName) (object id $($app.id))"
Write-Host "   enterprise app:   object id $($sp.id)"
Write-Host "   security group:   $($grp.displayName) ($($grp.id))"
if ($grp.displayName -ne 'D365FO-MCP-Users') { Write-Warning "Group display name is '$($grp.displayName)', expected D365FO-MCP-Users — check the -GroupId." }

Write-Host '== 1/5 Configuring the app registration (URI, token v2, scope, role, public client, permissions)' -ForegroundColor Cyan

# Reuse existing IDs when re-running; mint new ones only on first run.
$existingScope = @($app.api.oauth2PermissionScopes | Where-Object { $_.value -eq 'user_impersonation' })
$scopeId = if ($existingScope) { $existingScope[0].id } else { [guid]::NewGuid().Guid }
$existingRole = @($app.appRoles | Where-Object { $_.value -eq $RoleValue })
$roleId = if ($existingRole) { $existingRole[0].id } else { [guid]::NewGuid().Guid }

$scopes = @($app.api.oauth2PermissionScopes | Where-Object { $_.value -ne 'user_impersonation' }) + @(
  [ordered]@{
    id                      = $scopeId
    value                   = 'user_impersonation'
    type                    = 'User'   # admins AND users may consent
    isEnabled               = $true
    adminConsentDisplayName = 'Access D365FO MCP as the signed-in user'
    adminConsentDescription = 'Allows the app to call the D365FO MCP services on behalf of the signed-in user.'
    userConsentDisplayName  = 'Access D365FO MCP as the signed-in user'
    userConsentDescription  = 'Allows the app to call the D365FO MCP services on your behalf.'
  }
)
$roles = @($app.appRoles | Where-Object { $_.value -ne $RoleValue }) + @(
  [ordered]@{
    id                 = $roleId
    value              = $RoleValue
    displayName        = 'MCP Access'
    description        = 'Grants access to the D365FO MCP services.'
    allowedMemberTypes = @('User')     # Users/Groups
    isEnabled          = $true
  }
)
$redirects = @(@($app.publicClient.redirectUris) + $RedirectUris | Where-Object { $_ } | Select-Object -Unique)
$uris      = @(@($app.identifierUris) + $AppIdUri | Where-Object { $_ } | Select-Object -Unique)
$rra       = @(
  [ordered]@{ resourceAppId = $ApiAppId;   resourceAccess = @(@{ id = $scopeId; type = 'Scope' }) }
  [ordered]@{ resourceAppId = $GraphAppId; resourceAccess = @($GraphScopes.Values | ForEach-Object { @{ id = $_; type = 'Scope' } }) }
)

Invoke-GraphWrite -Method PATCH -Url "$graph/applications/$($app.id)" -Body ([ordered]@{
  identifierUris         = $uris
  api                    = [ordered]@{
    requestedAccessTokenVersion = 2
    oauth2PermissionScopes      = $scopes
  }
  appRoles               = $roles
  isFallbackPublicClient = $true
  publicClient           = @{ redirectUris = $redirects }
  requiredResourceAccess = $rra
})
Write-Host "   PATCHed. scope user_impersonation = $scopeId, role $RoleValue = $roleId"

Write-Host '== 2/5 Group membership' -ForegroundColor Cyan
$isMember = az ad group member check --group $GroupId --member-id $FirstMemberOid --query value -o tsv
if ($isMember -eq 'true') {
  Write-Host "   member ${FirstMemberOid}: already in group"
} else {
  az ad group member add --group $GroupId --member-id $FirstMemberOid --output none
  if ($LASTEXITCODE -ne 0) { throw 'Adding the first member failed.' }
  Write-Host "   member ${FirstMemberOid}: ADDED"
}

Write-Host "== 3/5 Assigning group to the '$RoleValue' app role on the Enterprise app" -ForegroundColor Cyan
$assigned = az rest --method GET --url "$graph/servicePrincipals/$($sp.id)/appRoleAssignedTo?`$top=999" -o json | ConvertFrom-Json
$already = @($assigned.value | Where-Object { $_.principalId -eq $GroupId -and $_.appRoleId -eq $roleId })
if ($already) {
  Write-Host '   assignment already exists'
} else {
  Invoke-GraphWrite -Method POST -Url "$graph/groups/$GroupId/appRoleAssignments" -Body @{
    principalId = $GroupId
    resourceId  = $sp.id
    appRoleId   = $roleId
  }
  Write-Host '   assignment CREATED'
}

Write-Host '== 4/5 Enterprise app: Assignment required = Yes' -ForegroundColor Cyan
if ($sp.appRoleAssignmentRequired) {
  Write-Host '   already set'
} else {
  Invoke-GraphWrite -Method PATCH -Url "$graph/servicePrincipals/$($sp.id)" -Body @{ appRoleAssignmentRequired = $true }
  Write-Host '   SET'
}

Write-Host '== 5/5 Verifying' -ForegroundColor Cyan
az ad app show --id $ApiAppId --query '{displayName:displayName, identifierUris:identifierUris, tokenVersion:api.requestedAccessTokenVersion, scopes:api.oauth2PermissionScopes[].value, roles:appRoles[].value, publicClient:isFallbackPublicClient, redirects:publicClient.redirectUris, declaredPermissions:requiredResourceAccess}' -o json
az ad sp show --id $ApiAppId --query '{assignmentRequired:appRoleAssignmentRequired}' -o json

Write-Host ''
Write-Host 'Done. Next steps:' -ForegroundColor Yellow
Write-Host "  1. Sign-in smoke test (fresh token; you were just added to the group):"
Write-Host "       az account get-access-token --scope '$AppIdUri/user_impersonation' --query accessToken -o tsv"
Write-Host '     If Entra shows "Need admin approval", ask a Global Admin (via Aaron, quote'
Write-Host '     Ticket#202607102005643) to open App registrations -> sp-tis-d-d365fokb-mcp ->'
Write-Host '     API permissions -> "Grant admin consent for Trelleborg AB". Per Karl-Johan this'
Write-Host '     is likely unnecessary — a one-time user consent dialog is expected instead.'
Write-Host "  2. Easy Auth cutover:"
Write-Host "       .\scripts\Enable-McpAuth.ps1 -ApiAppId $ApiAppId"
