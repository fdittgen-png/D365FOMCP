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

// ─── Naming ─────────────────────────────────────────────
var funcName  = '${prefix}-${env}-${workload}-func'
var aspName   = '${prefix}-${env}-${workload}-asp'
var stName    = '${prefix}${env}${workload}st'
var kvName    = '${prefix}-${env}-${workload}-kv'
var appiName  = '${prefix}-${env}-${workload}-appi'
var logName   = '${prefix}-${env}-${workload}-log'

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

// ─── Outputs ────────────────────────────────────────────
output functionAppUrl string = func.outputs.functionAppUrl
