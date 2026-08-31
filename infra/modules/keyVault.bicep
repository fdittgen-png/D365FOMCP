// ═══════════════════════════════════════════════════════════
//  Key Vault — secret store for the MCP services (issue #88)
//
//  `main.bicep` has computed `kvName` since the first version and passed it to
//  the Function App module, but the vault itself was never created — see the
//  comment in modules/functionApp.bicep next to OTRS_PASSWORD. This module
//  stands it up.
//
//  Deployed AFTER the Function App, because the role assignment needs the
//  app's system-assigned principal. The app never depends on this module in
//  return: its KEY_VAULT_NAME setting is the same computed string, so there is
//  no cycle. On a first deploy the app therefore exists briefly without a
//  vault; nothing reads a secret until a custom-field tool is called, and that
//  path fails with a typed error rather than a crash.
//
//  RBAC, not access policies: `enableRbacAuthorization: true`. The Function App
//  gets "Key Vault Secrets User" — get/list on secret VALUES, and nothing else.
//  It cannot write a secret; that is the operator's job, via
//  scripts/Set-D365CustomFieldsSource.ps1.
// ═══════════════════════════════════════════════════════════

param location string
param kvName string
param tags object

@description('System-assigned principal of the Function App, granted Key Vault Secrets User. Pass an empty string to create the vault without any role assignment.')
param functionAppPrincipalId string = ''

@description('Allow public network access to the vault. Kept as a parameter so moving to a private endpoint later is a parameter change, not a rewrite.')
@allowed(['Enabled', 'Disabled'])
param publicNetworkAccess string = 'Enabled'

@description('Soft-delete retention in days. 90 is the Azure maximum and the default for production secrets.')
@minValue(7)
@maxValue(90)
param softDeleteRetentionInDays int = 90

// Built-in role: Key Vault Secrets User — read secret values, nothing else.
// https://learn.microsoft.com/azure/role-based-access-control/built-in-roles
var keyVaultSecretsUserRoleId = '4633458b-17de-408a-b874-0445c86b69e6'

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: kvName
  location: location
  tags: tags
  properties: {
    sku: {
      family: 'A'
      name: 'standard'
    }
    tenantId: subscription().tenantId
    // RBAC only — no accessPolicies array to drift out of sync with role
    // assignments.
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: softDeleteRetentionInDays
    // Purge protection is irreversible once enabled. It is deliberate: a
    // deleted client secret should not be unrecoverable-by-accident, and the
    // deprovisioning path (Set-D365CustomFieldsSource.ps1 -Remove) requires an
    // explicit -DeleteSecret switch for exactly this reason.
    enablePurgeProtection: true
    publicNetworkAccess: publicNetworkAccess
    networkAcls: {
      bypass: 'AzureServices'
      defaultAction: 'Allow'
    }
  }
}

resource secretsUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(functionAppPrincipalId)) {
  // Deterministic name: re-deploying must update, never duplicate.
  name: guid(vault.id, functionAppPrincipalId, keyVaultSecretsUserRoleId)
  scope: vault
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsUserRoleId)
    principalId: functionAppPrincipalId
    // ServicePrincipal, not User: avoids the replication race where a freshly
    // created managed identity is not yet visible to the RBAC service.
    principalType: 'ServicePrincipal'
  }
}

output keyVaultName string = vault.name
output keyVaultUri string = vault.properties.vaultUri
output keyVaultId string = vault.id
