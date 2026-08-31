// ═══════════════════════════════════════════════════════════
//  D365FO MCP Services — Azure Infrastructure (RG-scoped)
//  Deploy into an existing resource group
// ═══════════════════════════════════════════════════════════

targetScope = 'resourceGroup'

@description('Environment code (d=dev, p=prod)')
@allowed(['d', 'p'])
param env string = 'd'

param location string = resourceGroup().location
param workload string = 'mcpd365fo'
param prefix string = 'tis'

@description('Monthly cost ceiling (subscription billing currency, typically EUR for westeurope) used by the storage-account budget alert. Default 50 covers steady-state usage; raise only if usage patterns change.')
@minValue(1)
param monthlyBudgetAmount int = 50

@description('Recipients for the storage-account budget alert email at 80 % and 100 % thresholds. Required at deploy time — do not commit real addresses to the repo. Pass via parameter file or `--parameters` override.')
@minLength(1)
param budgetContactEmails array

@description('Enable Key Vault purge protection. IRREVERSIBLE: once on it cannot be turned off, the vault cannot be deleted before its soft-delete retention expires, and its name cannot be reused until the soft-deleted copy is recovered or expires. Defaults to FALSE so a routine -DeployInfra against an EXISTING vault never flips a one-way switch; both deploy scripts pre-flight the live vault before passing true. tis-d-mcpd365fo-kv has it off today.')
param enablePurgeProtection bool = false

// ─── Naming ─────────────────────────────────────────────
var funcName  = '${prefix}-${env}-${workload}-func'
var aspName   = '${prefix}-${env}-${workload}-asp'
var stName    = '${prefix}${env}${workload}st'
var appiName  = '${prefix}-${env}-${workload}-appi'
var kvName    = '${prefix}-${env}-${workload}-kv'
var logName   = '${prefix}-${env}-${workload}-log'
var budgetName = '${prefix}-${env}-${workload}-storage-budget'

var tags = {
  Owner: 'TIS'
  Environment: env == 'p' ? 'Production' : 'Development'
  Workload: workload
  CostCenter: 'IT-Services'
  ManagedBy: 'Florian Dittgen'
}

// ─── Monitoring ─────────────────────────────────────────
module monitoring 'modules/monitoring.bicep' = {
  name: 'monitoring'
  params: {
    location: location
    logName: logName
    appiName: appiName
    tags: tags
  }
}

// ─── Function App ───────────────────────────────────────
module func 'modules/functionApp.bicep' = {
  name: 'functionApp'
  params: {
    location: location
    funcName: funcName
    aspName: aspName
    stName: stName
    kvName: kvName
    appiConnectionString: monitoring.outputs.appiConnectionString
    tags: tags
  }
}

// ─── Key Vault ──────────────────────────────────────────
// Deployed after the Function App: the role assignment needs its
// system-assigned principal. The app does not depend on this module in return
// (its KEY_VAULT_NAME setting is the same computed `kvName` string), so there
// is no cycle. Issue #88.
module keyVault 'modules/keyVault.bicep' = {
  name: 'keyVault'
  params: {
    enablePurgeProtection: enablePurgeProtection
    location: location
    kvName: kvName
    functionAppPrincipalId: func.outputs.functionAppPrincipalId
    tags: tags
  }
}

// ─── Cost Alerts ────────────────────────────────────────
module costAlerts 'modules/costAlerts.bicep' = {
  name: 'costAlerts'
  params: {
    budgetName: budgetName
    monthlyBudgetAmount: monthlyBudgetAmount
    contactEmails: budgetContactEmails
  }
}

// ─── Outputs ────────────────────────────────────────────
output functionAppUrl string = func.outputs.functionAppUrl
output keyVaultName string = keyVault.outputs.keyVaultName
output keyVaultUri string = keyVault.outputs.keyVaultUri
output storageBudgetName string = costAlerts.outputs.budgetName
output storageBudgetAmount int = costAlerts.outputs.budgetAmount
