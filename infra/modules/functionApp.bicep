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

// ─── Blob services (parent for containers + management policies) ────────────
// Holds:
//   - mcpsec-snapshots: dated copies of d365fo_*.sqlite from successful builds
//     (issue #37 — snapshot preservation, not DR; source DBs can be rebuilt)
//   - mcpsec-uploads:   transient ZIPs from the d365sec upload pipeline,
//                       deleted in the async build's finally block
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

// ─── Lifecycle management ───────────────────────────────────────────────────
// Two rules:
//   1. DeleteOldSecUploads (P6-02) — purges orphan upload ZIPs older than 7 days
//      from `mcpsec-uploads/`. Cleanup-failure hygiene; ~20 GB/6mo projection.
//   2. expire-old-snapshots (issue #37) — purges build snapshots older than 90
//      days from `mcpsec-snapshots/`. Backup-Databases.ps1 also prunes to the
//      5 most recent; this is the calendar-based safety net.
// Policy evaluation runs once per 24h server-side; block blob only.
resource lifecyclePolicy 'Microsoft.Storage/storageAccounts/managementPolicies@2023-05-01' = {
  parent: storageAccount
  name: 'default'
  properties: {
    policy: {
      rules: [
        {
          name: 'DeleteOldSecUploads'
          enabled: true
          type: 'Lifecycle'
          definition: {
            actions: {
              baseBlob: {
                delete: {
                  daysAfterModificationGreaterThan: 7
                }
              }
            }
            filters: {
              blobTypes: [
                'blockBlob'
              ]
              prefixMatch: [
                'mcpsec-uploads/'
              ]
            }
          }
        }
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
        // ─── OTRS extractor (Function: otrs-extract) ──────────
        // The OTRS TicketSearch/TicketGet filters and endpoint URLs are
        // configuration, so they live here. Credentials follow the
        // "placeholder in Bicep, real value set post-deploy" pattern:
        // OTRS_PASSWORD is intentionally empty here — deploy, then run
        //   az functionapp config appsettings set \
        //     --name tis-p-mcpd365fo-func -g tis-p-mcpd365fo-rg \
        //     --settings OTRS_PASSWORD=<real-secret>
        // so the secret never lands in source control or Bicep output.
        // Future: replace these two entries with Key Vault references
        // once the kv module is instantiated (main.bicep declares the
        // kvName but the resource is not yet stood up).
        {
          name: 'OTRS_USERNAME'
          value: 'wstis'
        }
        {
          name: 'OTRS_PASSWORD'
          value: ''
        }
        {
          name: 'OTRS_SEARCH_URL'
          value: 'https://trelleborg.managed-otrs.com/otrs/nph-genericinterface.pl/Webservice/TIS_WS/TicketSearch'
        }
        {
          name: 'OTRS_GET_URL'
          value: 'https://trelleborg.managed-otrs.com/otrs/nph-genericinterface.pl/Webservice/TIS_WS/TicketGet'
        }
        {
          name: 'OTRS_SERVICE_ID'
          value: '798'
        }
        {
          name: 'OTRS_STATE'
          value: 'closed successful'
        }
        {
          name: 'OTRS_MIN_RESOLUTION_CHARS'
          value: '200'
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
