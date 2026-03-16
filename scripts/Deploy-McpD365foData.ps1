<#
.SYNOPSIS
    Deploy D365FO MCP data from local SQLite databases to Azure SQL.

.DESCRIPTION
    Exports data from local SQLite KB and XRef databases (built by build-kb.js
    and build-xref-db.js) and bulk-imports it into Azure SQL Database using bcp.

    Trelleborg naming: tis-{env}-mcpd365fo-sqldb

.PARAMETER Environment
    Target environment: 'd' (development) or 'p' (production).

.PARAMETER KbOnly
    Only deploy KB data (skip XRef).

.PARAMETER XrefOnly
    Only deploy XRef data (skip KB).

.PARAMETER SqlServer
    Override SQL server FQDN. Default: tis-{env}-mcpd365fo-sql.database.windows.net

.EXAMPLE
    .\Deploy-McpD365foData.ps1 -Environment p
    .\Deploy-McpD365foData.ps1 -Environment d -KbOnly
#>
[CmdletBinding()]
param(
    [ValidateSet('d', 'p')]
    [string]$Environment = 'p',

    [switch]$KbOnly,
    [switch]$XrefOnly,

    [string]$SqlServer,
    [string]$SqlDatabase
)

# ─── Configuration ───────────────────────────────────────
$prefix   = 'tis'
$workload = 'mcpd365fo'

if (-not $SqlServer)   { $SqlServer   = "$prefix-$Environment-$workload-sql.database.windows.net" }
if (-not $SqlDatabase) { $SqlDatabase = "$prefix-$Environment-$workload-sqldb" }

$kbSqlitePath   = Join-Path $env:USERPROFILE '.claude\d365fo_kb.sqlite'
$xrefSqlitePath = Join-Path $env:USERPROFILE '.claude\d365fo_xref.sqlite'

Write-Host "═══════════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host "  D365FO MCP Data Deployment" -ForegroundColor Cyan
Write-Host "═══════════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host "  Target: $SqlServer / $SqlDatabase"
Write-Host "  KB DB:  $kbSqlitePath"
Write-Host "  XRef DB: $xrefSqlitePath"
Write-Host ""

# ─── Prerequisite Checks ────────────────────────────────
if (-not $XrefOnly) {
    if (-not (Test-Path $kbSqlitePath)) {
        Write-Error "KB database not found: $kbSqlitePath. Run 'npm run build:kb' first."
        return
    }
    Write-Host "[OK] KB database found: $([math]::Round((Get-Item $kbSqlitePath).Length / 1MB)) MB" -ForegroundColor Green
}

if (-not $KbOnly) {
    if (-not (Test-Path $xrefSqlitePath)) {
        Write-Error "XRef database not found: $xrefSqlitePath. Run 'npm run build:xref' first."
        return
    }
    Write-Host "[OK] XRef database found: $([math]::Round((Get-Item $xrefSqlitePath).Length / 1MB)) MB" -ForegroundColor Green
}

# ─── Azure Login Check ──────────────────────────────────
Write-Host "`nSTEP 1: Checking Azure authentication..." -ForegroundColor Yellow
$account = az account show 2>$null | ConvertFrom-Json
if (-not $account) {
    Write-Host "Not logged in. Running az login..." -ForegroundColor Yellow
    az login
    $account = az account show | ConvertFrom-Json
}
Write-Host "  Logged in as: $($account.user.name)" -ForegroundColor Green
Write-Host "  Subscription: $($account.name)" -ForegroundColor Green

# ─── Deploy Data ─────────────────────────────────────────
# TODO: Implement SQLite export → CSV → bcp bulk import pipeline
#
# For each schema (kb, xref):
#   1. Export SQLite tables to TSV files using node script
#   2. Truncate Azure SQL target tables (within transaction)
#   3. bcp bulk insert from TSV files
#   4. Rebuild indexes
#   5. Verify row counts
#
# The export step requires a small Node.js helper that reads the SQLite
# database and writes TSV files. This avoids needing Python or sqlite3.exe.

Write-Host "`n[TODO] Data deployment pipeline not yet implemented." -ForegroundColor Yellow
Write-Host "  This script will be completed when Azure SQL resources are provisioned."
Write-Host "  For now, the local SQLite databases serve the MCP servers directly."

Write-Host "`n═══════════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host "  DONE" -ForegroundColor Cyan
Write-Host "═══════════════════════════════════════════════════════════" -ForegroundColor Cyan
