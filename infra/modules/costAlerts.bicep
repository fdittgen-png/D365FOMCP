// ═══════════════════════════════════════════════════════════
//  Cost controls — storage-account budget alert
//  Scope: resourceGroup (the workload RG only)
//
//  Tracks accrued cost for the Microsoft.Storage resource
//  type inside this RG and fires email notifications at
//  80 % and 100 % of the monthly threshold.
// ═══════════════════════════════════════════════════════════

targetScope = 'resourceGroup'

@description('Monthly budget for the storage account, in the subscription billing currency. Default 50 covers the expected steady-state DB + ZIP staging usage with comfortable headroom.')
@minValue(1)
param monthlyBudgetAmount int = 50

@description('Email addresses to notify when the budget threshold is crossed. Must contain at least one address — the Microsoft.Consumption/budgets API rejects an empty list at RG scope. Provide via parameter file or deploy-time override; never hardcode.')
@minLength(1)
param contactEmails array

@description('Budget name. Must be unique within the resource group.')
param budgetName string

@description('Budget start date (UTC, must be the first of a month). Defaults to the first of the current month at deploy time.')
param startDate string = '${utcNow('yyyy-MM')}-01T00:00:00Z'

// ─── Storage-account budget ─────────────────────────────
// Filter narrows the cost view to Microsoft.Storage so the
// alert tracks blob/table/queue/file spend only — not the
// Function App, App Service Plan, Log Analytics, or App
// Insights line items in the same RG.
resource storageBudget 'Microsoft.Consumption/budgets@2023-05-01' = {
  name: budgetName
  properties: {
    amount: monthlyBudgetAmount
    category: 'Cost'
    timeGrain: 'Monthly'
    timePeriod: {
      startDate: startDate
    }
    filter: {
      dimensions: {
        name: 'ResourceType'
        operator: 'In'
        values: [
          'microsoft.storage/storageaccounts'
        ]
      }
    }
    notifications: {
      Actual_GreaterThan_80_Percent: {
        enabled: true
        operator: 'GreaterThan'
        threshold: 80
        thresholdType: 'Actual'
        contactEmails: contactEmails
        contactRoles: []
        contactGroups: []
      }
      Actual_GreaterThan_100_Percent: {
        enabled: true
        operator: 'GreaterThanOrEqualTo'
        threshold: 100
        thresholdType: 'Actual'
        contactEmails: contactEmails
        contactRoles: []
        contactGroups: []
      }
    }
  }
}

output budgetName string = storageBudget.name
output budgetAmount int = monthlyBudgetAmount
