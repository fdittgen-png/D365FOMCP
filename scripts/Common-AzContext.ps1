# Common-AzContext.ps1 — shared Azure CLI context guard for every script in this repo.
#
# Dot-source it, then call Ensure-AzContext. It:
#   1. logs in (az login) if there is no cached account,
#   2. FORCES the active subscription to TIS.D365FO (the subscription that owns
#      tis-d-mcpd365fo-rg) — never trusts whatever `az account show` happens to return,
#   3. fails loudly if the subscription cannot be selected.
#
# Why: 2026-08-26 a deploy failed with "Resource group 'tis-d-mcpd365fo-rg' not found"
# because the CLI default had drifted to TIS.BIandReporting. Every script that talks to
# Azure must go through this guard so that can't happen again.
#
# Usage:
#   . "$PSScriptRoot\Common-AzContext.ps1"
#   $account = Ensure-AzContext                       # default TIS.D365FO
#   $account = Ensure-AzContext -Subscription $Subscription   # when the script exposes a param
#
# Override for a different tenant/subscription: pass -Subscription (name or GUID) or set
# $env:MCP_AZ_SUBSCRIPTION.

Set-StrictMode -Version Latest

$script:McpDefaultSubscription = 'TIS.D365FO'

function Ensure-AzContext {
    [CmdletBinding()]
    param(
        # Subscription name or id. Precedence: parameter > $env:MCP_AZ_SUBSCRIPTION > TIS.D365FO
        [string]$Subscription,
        [switch]$Quiet
    )

    if (-not $Subscription) { $Subscription = $env:MCP_AZ_SUBSCRIPTION }
    if (-not $Subscription) { $Subscription = $script:McpDefaultSubscription }

    if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
        throw 'Azure CLI (az) not found on PATH. Install: https://aka.ms/installazurecli'
    }

    $account = az account show 2>$null | ConvertFrom-Json
    if (-not $account) {
        if (-not $Quiet) { Write-Host 'Not logged in. Running az login...' -ForegroundColor Yellow }
        az login | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'az login failed.' }
    }

    # Always pin the subscription — the CLI default drifts between projects.
    az account set --subscription $Subscription 2>$null
    if ($LASTEXITCODE -ne 0) {
        $avail = (az account list --query '[].name' -o tsv 2>$null) -join ', '
        throw "Cannot select Azure subscription '$Subscription'. Available for $($account.user.name): $avail. " +
              "Run 'az login' (or 'az login --tenant <tenantId>') and retry, or pass -Subscription."
    }

    $account = az account show | ConvertFrom-Json
    $matches = ($account.name -eq $Subscription) -or ($account.id -eq $Subscription)
    if (-not $matches) {
        throw "Active subscription is '$($account.name)' ($($account.id)) but '$Subscription' was requested."
    }

    if (-not $Quiet) {
        Write-Host "  Account:         $($account.user.name)" -ForegroundColor Green
        Write-Host "  Subscription:    $($account.name) ($($account.id))" -ForegroundColor Green
    }
    return $account
}
