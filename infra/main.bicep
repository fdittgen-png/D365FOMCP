// ═══════════════════════════════════════════════════════════
//  D365FO MCP Services — Azure Infrastructure
//  Trelleborg Naming Convention v3.0
// ═══════════════════════════════════════════════════════════

targetScope = 'subscription'

@description('Environment code (d=dev, p=prod)')
@allowed(['d', 'p'])
param env string = 'p'

param location string = 'westeurope'
param workload string = 'mcpd365fo'
param prefix string = 'tis'

@description('Entra ID admin login name for SQL Server')
param entraAdminLogin string = 'florian.dittgen@trelleborg.com'

@description('Entra ID admin Object ID for SQL Server')
param entraAdminSid string = '9495865f-c1c7-459f-87a6-4e9d8a20fb28'

// ─── Naming ─────────────────────────────────────────────
var rgName    = '${prefix}-${env}-${workload}-rg'
var funcName  = '${prefix}-${env}-${workload}-func'
var aspName   = '${prefix}-${env}-${workload}-asp'
var stName    = '${prefix}${env}${workload}st'        // slug format (max 24 chars)
var kvName    = '${prefix}-${env}-${workload}-kv'
var appiName  = '${prefix}-${env}-${workload}-appi'
var logName   = '${prefix}-${env}-${workload}-log'
var sqlName   = '${prefix}-${env}-${workload}-sql'
var sqlDbName = '${prefix}-${env}-${workload}-sqldb'

var tags = {
  Owner: 'TIS'
  Environment: env == 'p' ? 'Production' : 'Development'
  Workload: workload
  CostCenter: 'IT-Services'
  ManagedBy: 'Florian Dittgen'
}

// ─── Resource Group ─────────────────────────────────────
resource rg 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: rgName
  location: location
  tags: tags
}

// ─── Monitoring ─────────────────────────────────────────
module monitoring 'modules/monitoring.bicep' = {
  scope: rg
  name: 'monitoring'
  params: {
    location: location
    logName: logName
    appiName: appiName
    tags: tags
  }
}

// ─── SQL Database ───────────────────────────────────────
module sql 'modules/sqlDatabase.bicep' = {
  scope: rg
  name: 'sqlDatabase'
  params: {
    location: location
    sqlServerName: sqlName
    sqlDbName: sqlDbName
    entraAdminLogin: entraAdminLogin
    entraAdminSid: entraAdminSid
    tags: tags
  }
}

// ─── Function App ───────────────────────────────────────
module func 'modules/functionApp.bicep' = {
  scope: rg
  name: 'functionApp'
  params: {
    location: location
    funcName: funcName
    aspName: aspName
    stName: stName
    kvName: kvName
    appiConnectionString: monitoring.outputs.appiConnectionString
    sqlServerFqdn: sql.outputs.sqlServerFqdn
    sqlDbName: sqlDbName
    tags: tags
  }
}

// ─── Outputs ────────────────────────────────────────────
output resourceGroupName string = rg.name
output functionAppUrl string = func.outputs.functionAppUrl
output sqlServerFqdn string = sql.outputs.sqlServerFqdn
