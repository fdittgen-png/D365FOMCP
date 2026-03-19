<#
.SYNOPSIS
    Set up RBAC roles for D365FO MCP Function App.

.DESCRIPTION
    Post-deployment script that:
    1. Assigns 'Key Vault Secrets User' role to Function App managed identity

.PARAMETER Environment
    'd' or 'p'. Default: d

.EXAMPLE
    .\Set-RoleAssignments.ps1 -Environment d
#>
[CmdletBinding()]
param(
    [ValidateSet('d', 'p')]
    [string]$Environment = 'd'
)

$ErrorActionPreference = 'Stop'
$prefix   = 'tis'
$workload = 'mcpd365fo'
$rg       = "$prefix-$Environment-$workload-rg"
$funcName = "$prefix-$Environment-$workload-func"
$kvName   = "$prefix-$Environment-$workload-kv"

Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "  D365FO MCP Services — Role Assignments" -ForegroundColor Cyan
Write-Host "================================================================" -ForegroundColor Cyan

# ─── STEP 1: Get Function App managed identity ──────────
Write-Host "`nSTEP 1: Getting Function App managed identity..." -ForegroundColor Yellow
$identity = az functionapp identity show --resource-group $rg --name $funcName 2>$null | ConvertFrom-Json
if (-not $identity -or -not $identity.principalId) {
    Write-Error "Function App '$funcName' has no managed identity. Run Deploy-Infrastructure.ps1 first."
    return
}
$principalId = $identity.principalId
Write-Host "  Principal ID: $principalId" -ForegroundColor Green

# ─── STEP 2: Key Vault Secrets User role ─────────────────
Write-Host "`nSTEP 2: Assigning Key Vault Secrets User role..." -ForegroundColor Yellow
$kvId = az keyvault show --name $kvName --resource-group $rg --query id -o tsv 2>$null
if (-not $kvId) {
    Write-Error "Key Vault '$kvName' not found."
    return
}

$existing = az role assignment list --assignee $principalId --role "Key Vault Secrets User" --scope $kvId 2>$null | ConvertFrom-Json
if ($existing -and $existing.Count -gt 0) {
    Write-Host "  [SKIP] Role already assigned." -ForegroundColor DarkGray
} else {
    az role assignment create `
        --assignee-object-id $principalId `
        --assignee-principal-type ServicePrincipal `
        --role "Key Vault Secrets User" `
        --scope $kvId `
        --output none 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Host "  [OK] Key Vault Secrets User role assigned." -ForegroundColor Green
    } else {
        Write-Warning "Failed to assign role. You may need Owner or User Access Administrator permissions."
    }
}

Write-Host "`n================================================================" -ForegroundColor Green
Write-Host "  ROLE ASSIGNMENTS COMPLETE" -ForegroundColor Green
Write-Host "================================================================" -ForegroundColor Green
