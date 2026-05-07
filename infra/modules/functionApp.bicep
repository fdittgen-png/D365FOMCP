param location string
param funcName string
param aspName string
param stName string
param appiConnectionString string
param tags object

// ─── Storage Account ────────────────────────────────────
resource storageAccount 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: stName
  location: location
  tags: tags
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
  properties: {
    supportsHttpsTrafficOnly: true
    minimumTlsVersion: 'TLS1_2'
  }
}

// ─── Blob Services + Snapshot Container (issue #37) ─────
// Holds dated copies of d365fo_*.sqlite produced by successful builds.
// Used for rollback when a bad build is deployed (snapshot preservation,
// not disaster recovery — the source databases can always be rebuilt).
resource blobServices 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storageAccount
  name: 'default'
  properties: {}
}

resource snapshotContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobServices
  name: 'mcpsec-snapshots'
  properties: {
    publicAccess: 'None'
  }
}

// ─── Lifecycle Policy ───────────────────────────────────
// Calendar-based retention: delete snapshot blobs older than 90 days.
// "Last 5 snapshots" semantics from issue #37 are achieved by build cadence —
// a weekly build produces ~12 snapshots in 90 days, so the last 5 are always
// available. Backup-Databases.ps1 also prunes to keep the 5 most recent.
resource lifecyclePolicy 'Microsoft.Storage/storageAccounts/managementPolicies@2023-05-01' = {
  parent: storageAccount
  name: 'default'
  properties: {
    policy: {
      rules: [
        {
          name: 'expire-old-snapshots'
          enabled: true
          type: 'Lifecycle'
          definition: {
            filters: {
              blobTypes: [ 'blockBlob' ]
              prefixMatch: [ 'mcpsec-snapshots/' ]
            }
            actions: {
              baseBlob: {
                delete: { daysAfterModificationGreaterThan: 90 }
              }
            }
          }
        }
      ]
    }
  }
}

// ─── App Service Plan (Premium V3) ──────────────────────
resource appServicePlan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: aspName
  location: location
  tags: tags
  sku: {
    name: 'P0v3'
    tier: 'PremiumV3'
    size: 'P0v3'
    family: 'Pv3'
    capacity: 1
  }
  kind: 'linux'
  properties: {
    reserved: true
  }
}

// ─── Function App ───────────────────────────────────────
resource functionApp 'Microsoft.Web/sites@2023-12-01' = {
  name: funcName
  location: location
  tags: tags
  kind: 'functionapp,linux'
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    serverFarmId: appServicePlan.id
    httpsOnly: true
    siteConfig: {
      linuxFxVersion: 'NODE|20'
      appSettings: [
        {
          name: 'AzureWebJobsStorage'
          value: 'DefaultEndpointsProtocol=https;AccountName=${stName};EndpointSuffix=${environment().suffixes.storage};AccountKey=${storageAccount.listKeys().keys[0].value}'
        }
        {
          name: 'FUNCTIONS_EXTENSION_VERSION'
          value: '~4'
        }
        {
          name: 'FUNCTIONS_WORKER_RUNTIME'
          value: 'node'
        }
        {
          name: 'APPLICATIONINSIGHTS_CONNECTION_STRING'
          value: appiConnectionString
        }
        {
          name: 'KB_DB_PATH'
          value: '/home/data/d365fo_kb.sqlite'
        }
        {
          name: 'XREF_DB_PATH'
          value: '/home/data/d365fo_xref.sqlite'
        }
      ]
      alwaysOn: true
      minTlsVersion: '1.2'
      ftpsState: 'Disabled'
    }
  }
}

output functionAppUrl string = 'https://${functionApp.properties.defaultHostName}'
output functionAppPrincipalId string = functionApp.identity.principalId
