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

// ─── Naming ─────────────────────────────────────────────
var funcName  = '${prefix}-${env}-${workload}-func'
var aspName   = '${prefix}-${env}-${workload}-asp'
var stName    = '${prefix}${env}${workload}st'
var appiName  = '${prefix}-${env}-${workload}-appi'
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
    appiConnectionString: monitoring.outputs.appiConnectionString
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
output storageBudgetName string = costAlerts.outputs.budgetName
output storageBudgetAmount int = costAlerts.outputs.budgetAmount
