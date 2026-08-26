<#
.SYNOPSIS
    Full deployment pipeline for D365FO MCP Services.

.DESCRIPTION
    Master orchestrator that runs the complete post-deployment pipeline:
      1. Set-RoleAssignments — RBAC roles for Function App
      2. Deploy-FunctionApp  — Package code + SQLite databases and deploy

    Each step can also be run independently via its own script.

.PARAMETER Environment
    'd' (development) or 'p' (production). Default: d

.PARAMETER SkipRoles
    Skip role assignment step.

.PARAMETER SkipFunctionApp
    Skip Function App deployment step.

.EXAMPLE
    .\Deploy-McpD365foData.ps1 -Environment d
    .\Deploy-McpD365foData.ps1 -Environment d -SkipRoles
#>
[CmdletBinding()]
param(
    [string]$Subscription = 'TIS.D365FO',   # Azure subscription owning the MCP resource group
    [ValidateSet('d', 'p')]
    [string]$Environment = 'd',

    [switch]$SkipRoles,
    [switch]$SkipFunctionApp
)

$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition

Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "  D365FO MCP Services — Full Deployment Pipeline" -ForegroundColor Cyan
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "  Environment: $Environment"
Write-Host ""

# ─── Azure auth check ────────────────────────────────────
. "$PSScriptRoot\Common-AzContext.ps1"
$account = Ensure-AzContext -Subscription $Subscription
Write-Host ""

$startTime = Get-Date
$steps = @()

# ─── Step 1: Role Assignments ────────────────────────────
if (-not $SkipRoles) {
    Write-Host ""
    Write-Host "╔══════════════════════════════════════════════════════════╗" -ForegroundColor Yellow
    Write-Host "║  STEP 1/2: Role Assignments                             ║" -ForegroundColor Yellow
    Write-Host "╚══════════════════════════════════════════════════════════╝" -ForegroundColor Yellow
    try {
        & (Join-Path $scriptDir 'Set-RoleAssignments.ps1') -Environment $Environment
        $steps += @{ Step = 'Role Assignments'; Status = 'OK' }
    } catch {
        Write-Warning "Role assignments failed: $($_.Exception.Message)"
        $steps += @{ Step = 'Role Assignments'; Status = 'FAILED' }
    }
} else {
    $steps += @{ Step = 'Role Assignments'; Status = 'SKIPPED' }
}

# ─── Step 2: Function App ────────────────────────────────
if (-not $SkipFunctionApp) {
    Write-Host ""
    Write-Host "╔══════════════════════════════════════════════════════════╗" -ForegroundColor Yellow
    Write-Host "║  STEP 2/2: Function App Deployment                      ║" -ForegroundColor Yellow
    Write-Host "╚══════════════════════════════════════════════════════════╝" -ForegroundColor Yellow
    try {
        & (Join-Path $scriptDir 'Deploy-FunctionApp.ps1') -Environment $Environment
        $steps += @{ Step = 'Function App'; Status = 'OK' }
    } catch {
        Write-Warning "Function App deployment failed: $($_.Exception.Message)"
        $steps += @{ Step = 'Function App'; Status = 'FAILED' }
    }
} else {
    $steps += @{ Step = 'Function App'; Status = 'SKIPPED' }
}

# ─── Summary ─────────────────────────────────────────────
$elapsed = ((Get-Date) - $startTime).ToString('hh\:mm\:ss')
$allOk = ($steps | Where-Object { $_.Status -eq 'FAILED' }).Count -eq 0

Write-Host ""
$summaryColor = 'Yellow'
if ($allOk) { $summaryColor = 'Green' }
Write-Host "================================================================" -ForegroundColor $summaryColor
Write-Host "  DEPLOYMENT PIPELINE COMPLETE ($elapsed)" -ForegroundColor $summaryColor
Write-Host "================================================================" -ForegroundColor $summaryColor
foreach ($step in $steps) {
    $color = switch ($step.Status) { 'OK' { 'Green' } 'FAILED' { 'Red' } default { 'DarkGray' } }
    Write-Host "  [$($step.Status)] $($step.Step)" -ForegroundColor $color
}
Write-Host "================================================================" -ForegroundColor $summaryColor
