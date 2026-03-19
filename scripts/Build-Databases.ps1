<#
.SYNOPSIS
    Build D365FO Knowledge Base and Cross-Reference SQLite databases.

.DESCRIPTION
    Orchestrator script that completely rebuilds both MCP databases:
    1. KB database - parses XML metadata from Microsoft + ISV package directories
    2. XRef database - extracts cross-reference data from Visual Studio's LocalDB

    Both databases are built from scratch (existing files are deleted first).

.PARAMETER MsPackagesPath
    Path to Microsoft packages. Default: %LOCALAPPDATA%\Microsoft\Dynamics365\10.0.2263.202\PackagesLocalDirectory

.PARAMETER IsvMetadataPath
    Path to custom/ISV model metadata. Default: C:\Workspace\DEV\Metadata

.PARAMETER OutputDir
    Output directory for SQLite databases. Default: %USERPROFILE%\.claude

.PARAMETER XrefServer
    SQL Server instance for XRef data. Default: (LocalDB)\MSSQLLocalDB

.PARAMETER XrefDatabase
    XRef database name. Default: XRef_tbg-dev3651002263172

.PARAMETER KbOnly
    Only rebuild the KB database (skip XRef).

.PARAMETER XrefOnly
    Only rebuild the XRef database (skip KB).

.EXAMPLE
    .\Build-Databases.ps1
    .\Build-Databases.ps1 -KbOnly
    .\Build-Databases.ps1 -MsPackagesPath "D:\AnotherPath\PackagesLocalDirectory" -IsvMetadataPath "D:\MyModels"
    .\Build-Databases.ps1 -XrefOnly -XrefDatabase "XRef_myenv"
#>
[CmdletBinding()]
param(
    [string]$MsPackagesPath = (Join-Path $env:LOCALAPPDATA 'Microsoft\Dynamics365\10.0.2263.202\PackagesLocalDirectory'),
    [string]$IsvMetadataPath = 'C:\Workspace\DEV\Metadata',
    [string]$OutputDir = (Join-Path $env:USERPROFILE '.claude'),
    [string]$XrefServer = '(LocalDB)\MSSQLLocalDB',
    [string]$XrefDatabase = 'XRef_tbg-dev3651002263172',
    [switch]$KbOnly,
    [switch]$XrefOnly
)

$ErrorActionPreference = 'Stop'
$scriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Definition
$projectDir = Split-Path -Parent $scriptDir

Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "  D365FO MCP Services - Database Builder" -ForegroundColor Cyan
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host ""

# --- Validate prerequisites ---
$nodeVersion = node --version 2>$null
if (-not $nodeVersion) {
    Write-Error "Node.js not found. Install Node.js 20+ first."
    return
}
Write-Host "  Node.js: $nodeVersion" -ForegroundColor Green

# Validate source directories
$sourcePaths = @()
if (Test-Path $MsPackagesPath) {
    $sourcePaths += $MsPackagesPath
    Write-Host "  [OK] Microsoft packages: $MsPackagesPath" -ForegroundColor Green
} else {
    Write-Warning "Microsoft packages not found: $MsPackagesPath"
}

if (Test-Path $IsvMetadataPath) {
    $sourcePaths += $IsvMetadataPath
    Write-Host "  [OK] ISV/Custom metadata: $IsvMetadataPath" -ForegroundColor Green
} else {
    Write-Warning "ISV/Custom metadata not found: $IsvMetadataPath"
}

if ($sourcePaths.Count -eq 0 -and -not $XrefOnly) {
    Write-Error "No valid source directories found. Cannot build KB database."
    return
}

# Ensure output directory exists
if (-not (Test-Path $OutputDir)) {
    New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
}
Write-Host "  Output dir: $OutputDir" -ForegroundColor Green
Write-Host ""

$startTime = Get-Date
$steps = @()

# --- Build KB Database ---
if (-not $XrefOnly) {
    Write-Host "" -ForegroundColor Yellow
    Write-Host "  STEP 1: Knowledge Base Database" -ForegroundColor Yellow
    Write-Host "  ================================" -ForegroundColor Yellow

    $kbOutput = Join-Path $OutputDir 'd365fo_kb.sqlite'

    # Delete existing database for clean rebuild
    if (Test-Path $kbOutput) {
        Write-Host "  Deleting existing KB database..." -ForegroundColor DarkGray
        Remove-Item $kbOutput -Force
    }

    $combinedPaths = $sourcePaths -join ','
    $kbStart = Get-Date

    Write-Host "  Sources: $combinedPaths" -ForegroundColor DarkGray
    Write-Host "  Output:  $kbOutput" -ForegroundColor DarkGray
    Write-Host ""

    try {
        & node (Join-Path $projectDir 'build\build-kb.js') $combinedPaths $kbOutput
        if ($LASTEXITCODE -ne 0) {
            throw "KB build failed with exit code $LASTEXITCODE"
        }

        $kbElapsed = ((Get-Date) - $kbStart).ToString('hh\:mm\:ss')
        $kbSize = [math]::Round((Get-Item $kbOutput).Length / 1MB)
        Write-Host "  [OK] KB database built: $kbSize MB in $kbElapsed" -ForegroundColor Green
        $steps += @{ Step = 'KB Database'; Status = 'OK'; Detail = "$kbSize MB" }
    } catch {
        Write-Warning "KB build failed: $($_.Exception.Message)"
        $steps += @{ Step = 'KB Database'; Status = 'FAILED' }
    }
    Write-Host ""
}

# --- Build XRef Database ---
if (-not $KbOnly) {
    Write-Host "" -ForegroundColor Yellow
    Write-Host "  STEP 2: Cross-Reference Database" -ForegroundColor Yellow
    Write-Host "  =================================" -ForegroundColor Yellow

    $xrefOutput = Join-Path $OutputDir 'd365fo_xref.sqlite'

    # Delete existing database for clean rebuild
    if (Test-Path $xrefOutput) {
        Write-Host "  Deleting existing XRef database..." -ForegroundColor DarkGray
        Remove-Item $xrefOutput -Force
    }

    # Start LocalDB if needed
    Write-Host "  Starting LocalDB instance..." -ForegroundColor DarkGray
    SqlLocalDB start MSSQLLocalDB 2>$null | Out-Null

    $xrefStart = Get-Date

    Write-Host "  Server:   $XrefServer" -ForegroundColor DarkGray
    Write-Host "  Database: $XrefDatabase" -ForegroundColor DarkGray
    Write-Host "  Output:   $xrefOutput" -ForegroundColor DarkGray
    Write-Host ""

    try {
        & node --max-old-space-size=8192 (Join-Path $projectDir 'build\build-xref-db.js') $XrefServer $XrefDatabase $xrefOutput
        if ($LASTEXITCODE -ne 0) {
            throw "XRef build failed with exit code $LASTEXITCODE"
        }

        $xrefElapsed = ((Get-Date) - $xrefStart).ToString('hh\:mm\:ss')
        $xrefSize = [math]::Round((Get-Item $xrefOutput).Length / 1MB)
        Write-Host "  [OK] XRef database built: $xrefSize MB in $xrefElapsed" -ForegroundColor Green
        $steps += @{ Step = 'XRef Database'; Status = 'OK'; Detail = "$xrefSize MB" }
    } catch {
        Write-Warning "XRef build failed: $($_.Exception.Message)"
        $steps += @{ Step = 'XRef Database'; Status = 'FAILED' }
    }
    Write-Host ""
}

# --- Summary ---
$elapsed = ((Get-Date) - $startTime).ToString('hh\:mm\:ss')
$allOk = ($steps | Where-Object { $_.Status -eq 'FAILED' }).Count -eq 0

$summaryColor = if ($allOk) { 'Green' } else { 'Yellow' }
Write-Host "================================================================" -ForegroundColor $summaryColor
Write-Host "  DATABASE BUILD COMPLETE ($elapsed)" -ForegroundColor $summaryColor
Write-Host "================================================================" -ForegroundColor $summaryColor
foreach ($step in $steps) {
    $color = switch ($step.Status) { 'OK' { 'Green' } 'FAILED' { 'Red' } default { 'DarkGray' } }
    $detail = if ($step.Detail) { " ($($step.Detail))" } else { '' }
    Write-Host "  [$($step.Status)] $($step.Step)$detail" -ForegroundColor $color
}
Write-Host "================================================================" -ForegroundColor $summaryColor
