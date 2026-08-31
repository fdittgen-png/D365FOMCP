<#
.SYNOPSIS
    Deploy D365FO MCP infrastructure to Azure.

.DESCRIPTION
    Deploys the Bicep template (main-rg.bicep) to an existing resource group.
    Creates: Log Analytics, App Insights, Storage Account, App Service Plan
    (EP1), Function App, and — since issue #88 — the Key Vault plus the
    "Key Vault Secrets User" role assignment for the Function App's
    system-assigned identity.

    Two things this script does beyond `az deployment group create`:

      * PRESERVES the CUSTOM_FIELDS_SOURCES app setting. The template declares
        it as an empty placeholder (a secret-free registry of D365 environments
        the live custom-field reader may query, written post-deploy by
        Set-D365CustomFieldsSource.ps1). A plain template deploy would blank it
        and silently disable every configured environment. The value is read
        before the deploy and restored afterwards if the template cleared it.

      * VERIFIES the Key Vault landed and that the role assignment actually
        exists. RBAC assignment failures are the common half-success here: the
        deployment reports success, and every secret read fails at runtime with
        a 403 that looks like a code bug.

.PARAMETER BudgetContactEmails
    Recipients for the storage budget alert. The template requires it and has
    no default; without this parameter (or a parameter file carrying it) the
    Azure CLI prompts interactively.

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

    [string]$ResourceGroup,

    [string[]]$BudgetContactEmails,

    # Skip the post-deploy Key Vault / role-assignment verification. The deploy
    # itself is unaffected; only the checks are skipped.
    [switch]$SkipVaultCheck
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

# ─── Preserve settings the template would blank ──────────
# CUSTOM_FIELDS_SOURCES is set post-deploy by Set-D365CustomFieldsSource.ps1
# and declared as '' in Bicep, so a template deploy wipes it. Capture it now.
$funcName = "$prefix-$Environment-$workload-func"
$kvName   = "$prefix-$Environment-$workload-kv"
$preservedSources = $null
$funcExists = az functionapp show --name $funcName --resource-group $ResourceGroup --query name -o tsv 2>$null
if ($LASTEXITCODE -eq 0 -and $funcExists) {
    $preservedSources = az functionapp config appsettings list `
        --name $funcName --resource-group $ResourceGroup `
        --query "[?name=='CUSTOM_FIELDS_SOURCES'].value | [0]" -o tsv 2>$null
    if (-not [string]::IsNullOrWhiteSpace($preservedSources)) {
        $count = try { (@($preservedSources | ConvertFrom-Json)).Count } catch { '?' }
        Write-Host "  [..] Preserving CUSTOM_FIELDS_SOURCES ($count source(s)) across the deploy" -ForegroundColor DarkGray
    } else {
        $preservedSources = $null
    }
}

# ─── Key Vault name pre-flight ───────────────────────────
# Purge protection is ON, so a vault deleted earlier still holds its name in
# the soft-deleted state and the deployment fails with a name conflict that
# does not say so. Check first and give the actual instruction.
$deletedVault = az keyvault list-deleted --query "[?name=='$kvName'].name | [0]" -o tsv 2>$null
if ($deletedVault) {
    Write-Host ""
    Write-Warning "Key Vault '$kvName' exists in the SOFT-DELETED state."
    Write-Warning "Purge protection prevents reusing the name until it is recovered:"
    Write-Warning "  az keyvault recover --name $kvName"
    Write-Warning "Recover it (recommended - the secrets come back) and re-run, or the deployment will fail."
    return
}

# ─── Deploy ──────────────────────────────────────────────
Write-Host "`nDeploying infrastructure (this may take 3-5 minutes)..." -ForegroundColor Yellow
$deploymentName = "mcpd365fo-$Environment-$(Get-Date -Format 'yyyyMMddHHmmss')"

$deployArgs = @(
    '--resource-group', $ResourceGroup
    '--name', $deploymentName
    '--template-file', $templateFile
    '--parameters', "env=$Environment"
)
if ($BudgetContactEmails) {
    # Bicep array parameter on the CLI: JSON-encode the value.
    $deployArgs += @('--parameters', ('budgetContactEmails=' + ($BudgetContactEmails | ConvertTo-Json -Compress)))
}

$result = az deployment group create @deployArgs --output json 2>&1

if ($LASTEXITCODE -ne 0) {
    Write-Error "Deployment failed:`n$result"
    return
}

$deployment = $result | ConvertFrom-Json

# ─── Restore the preserved registry ──────────────────────
# Only when the template actually blanked it: never overwrite a value someone
# set between the capture above and now.
if ($preservedSources) {
    $now = az functionapp config appsettings list `
        --name $funcName --resource-group $ResourceGroup `
        --query "[?name=='CUSTOM_FIELDS_SOURCES'].value | [0]" -o tsv 2>$null
    if ([string]::IsNullOrWhiteSpace($now)) {
        az functionapp config appsettings set `
            --name $funcName --resource-group $ResourceGroup `
            --settings "CUSTOM_FIELDS_SOURCES=$preservedSources" --output none 2>$null
        if ($LASTEXITCODE -eq 0) {
            Write-Host "  [OK] CUSTOM_FIELDS_SOURCES restored after the template deploy" -ForegroundColor Green
        } else {
            Write-Warning "Could not restore CUSTOM_FIELDS_SOURCES. Re-run Set-D365CustomFieldsSource.ps1 for each environment."
            Write-Warning "Preserved value (secret-free, re-appliable by hand): $preservedSources"
        }
    } else {
        Write-Host "  [OK] CUSTOM_FIELDS_SOURCES survived the deploy unchanged" -ForegroundColor Green
    }
}

# ─── Verify the vault and the role assignment ────────────
# A missing role assignment is the dangerous half-success: the deployment
# reports OK and every secret read fails later with a 403 that reads like a
# code defect.
if (-not $SkipVaultCheck) {
    Write-Host "`n--- Key Vault ---" -ForegroundColor Yellow
    $vault = az keyvault show --name $kvName --resource-group $ResourceGroup -o json 2>$null | ConvertFrom-Json
    if (-not $vault) {
        Write-Warning "Key Vault '$kvName' not found after deployment. Live custom fields will not work (issues #87-#91)."
    } else {
        Write-Host "  [OK] $kvName  (RBAC: $($vault.properties.enableRbacAuthorization), purge protection: $($vault.properties.enablePurgeProtection))" -ForegroundColor Green

        $principalId = az functionapp identity show --name $funcName --resource-group $ResourceGroup `
            --query principalId -o tsv 2>$null
        if (-not $principalId) {
            Write-Warning "Function App has no system-assigned identity — the role assignment cannot exist."
        } else {
            $roleCount = az role assignment list --assignee $principalId --scope $vault.id `
                --query "length([?roleDefinitionName=='Key Vault Secrets User'])" -o tsv 2>$null
            if ($roleCount -and [int]$roleCount -gt 0) {
                Write-Host "  [OK] 'Key Vault Secrets User' granted to the Function App identity" -ForegroundColor Green
            } else {
                Write-Warning "'Key Vault Secrets User' is NOT assigned to $principalId on $kvName."
                Write-Warning "Secret reads will fail with 403. Grant it with:"
                Write-Warning "  az role assignment create --assignee $principalId --role 'Key Vault Secrets User' --scope $($vault.id)"
            }
        }
    }
}

Write-Host ""
Write-Host "================================================================" -ForegroundColor Green
Write-Host "  DEPLOYMENT SUCCEEDED" -ForegroundColor Green
Write-Host "================================================================" -ForegroundColor Green
Write-Host "  Function App: $($deployment.properties.outputs.functionAppUrl.value)"
if ($deployment.properties.outputs.PSObject.Properties['keyVaultUri']) {
    Write-Host "  Key Vault:    $($deployment.properties.outputs.keyVaultUri.value)"
}
Write-Host "================================================================" -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Yellow
Write-Host "  1. .\Set-RoleAssignments.ps1 -Environment $Environment"
Write-Host "  2. .\Deploy-FunctionApp.ps1 -Environment $Environment"
Write-Host "  3. (optional) live custom fields — one per D365 environment:" -ForegroundColor Yellow
Write-Host "     .\Set-D365CustomFieldsSource.ps1 -Key <key> -Url https://<env> -TenantId <guid> -ClientId <guid> -Default -EnvCode $Environment"
Write-Host "     Then: d365_custom_fields { table_name: 'SalesTable' }   (docs/Administration.md section 13)"
