<#
.SYNOPSIS
    Deploy D365FO MCP infrastructure to Azure.

.DESCRIPTION
    Deploys the Bicep template (main-rg.bicep) to an existing resource group.
    Creates: Log Analytics, App Insights, Storage Account,
    Key Vault, App Service Plan (EP1), and Function App.

.PARAMETER Environment
    'd' (development) or 'p' (production). Default: d

.PARAMETER ResourceGroup
    Target resource group name. Default: tis-{env}-mcpd365fo-rg

.EXAMPLE
    .\Deploy-Infrastructure.ps1 -Environment d
    .\Deploy-Infrastructure.ps1 -Environment p -ResourceGroup tis-p-mcpd365fo-rg
#>
[CmdletBinding()]
param(
    [string]$Subscription = 'TIS.D365FO',   # Azure subscription owning the MCP resource group
    [ValidateSet('d', 'p')]
    [string]$Environment = 'd',

    [string]$ResourceGroup
)

$ErrorActionPreference = 'Stop'
$prefix   = 'tis'
$workload = 'mcpd365fo'
if (-not $ResourceGroup) { $ResourceGroup = "$prefix-$Environment-$workload-rg" }

$scriptDir    = Split-Path -Parent $MyInvocation.MyCommand.Definition
$infraDir     = Join-Path (Split-Path -Parent $scriptDir) 'infra'
$templateFile = Join-Path $infraDir 'main-rg.bicep'

Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "  D365FO MCP Services — Infrastructure Deployment" -ForegroundColor Cyan
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "  Environment:    $Environment"
Write-Host "  Resource Group: $ResourceGroup"
Write-Host "  Template:       $templateFile"
Write-Host ""

# ─── Azure CLI auth check ────────────────────────────────
. "$PSScriptRoot\Common-AzContext.ps1"
$account = Ensure-AzContext -Subscription $Subscription

# ─── Verify resource group ───────────────────────────────
$rg = az group show --name $ResourceGroup 2>$null | ConvertFrom-Json
if (-not $rg) {
    Write-Error "Resource group '$ResourceGroup' not found. Create it first in the Azure portal."
    return
}
Write-Host "  [OK] Resource group exists in $($rg.location)" -ForegroundColor Green

# ─── Deploy ──────────────────────────────────────────────
Write-Host "`nDeploying infrastructure (this may take 3-5 minutes)..." -ForegroundColor Yellow
$deploymentName = "mcpd365fo-$Environment-$(Get-Date -Format 'yyyyMMddHHmmss')"

$result = az deployment group create `
    --resource-group $ResourceGroup `
    --name $deploymentName `
    --template-file $templateFile `
    --parameters env=$Environment `
    --output json 2>&1

if ($LASTEXITCODE -ne 0) {
    Write-Error "Deployment failed:`n$result"
    return
}

$deployment = $result | ConvertFrom-Json

Write-Host ""
Write-Host "================================================================" -ForegroundColor Green
Write-Host "  DEPLOYMENT SUCCEEDED" -ForegroundColor Green
Write-Host "================================================================" -ForegroundColor Green
Write-Host "  Function App: $($deployment.properties.outputs.functionAppUrl.value)"
Write-Host "================================================================" -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Yellow
Write-Host "  1. .\Set-RoleAssignments.ps1 -Environment $Environment"
Write-Host "  2. .\Deploy-FunctionApp.ps1 -Environment $Environment"
