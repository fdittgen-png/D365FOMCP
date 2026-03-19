<#
.SYNOPSIS
    Rebuild MCP databases from a D365FO XPP configuration.

.DESCRIPTION
    Reads the D365FO local XPP configurations, selects one by name,
    and rebuilds the KB and/or XRef SQLite databases using the paths
    and database references from that configuration.

    The configuration provides:
    - FrameworkDirectory → Microsoft packages (PackagesLocalDirectory)
    - ModelStoreFolder   → Custom/ISV metadata
    - CrossReferencesDbServerName → XRef SQL Server instance
    - CrossReferencesDatabaseName → XRef database name

    Output files are always named d365fo_kb.sqlite and d365fo_xref.sqlite
    in the output directory, ready for deployment.

.PARAMETER ConfigName
    Name of the D365FO configuration to use.
    If omitted, uses the current (active) configuration.
    Use -ListConfigs to see available names.

.PARAMETER OutputDir
    Output directory for SQLite databases. Default: %USERPROFILE%\.claude

.PARAMETER KbOnly
    Only rebuild the KB database (skip XRef).

.PARAMETER XrefOnly
    Only rebuild the XRef database (skip KB).

.PARAMETER ListConfigs
    List all available configurations and exit.

.EXAMPLE
    .\Update-Databases.ps1
    .\Update-Databases.ps1 -ConfigName "tis-d365fo-dev-02"
    .\Update-Databases.ps1 -ConfigName "tis-d365fo-dev-02" -KbOnly
    .\Update-Databases.ps1 -ListConfigs

.NOTES
    This script reads configurations from Get-D365Configurations.ps1
    and calls the build-kb.js / build-xref-db.js Node.js scripts.
#>
[CmdletBinding()]
param(
    [string]$ConfigName,
    [string]$OutputDir = (Join-Path $env:USERPROFILE '.claude'),
    [switch]$KbOnly,
    [switch]$XrefOnly,
    [switch]$ListConfigs
)

$ErrorActionPreference = 'Stop'
$scriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Definition
$projectDir = Split-Path -Parent $scriptDir

# ─── Read D365FO configurations ──────────────────────────────────────────────
$xppConfigDir = Join-Path $env:LOCALAPPDATA 'Microsoft\Dynamics365\XPPConfig'
$regPath      = 'HKCU:\SOFTWARE\Microsoft\Dynamics\AX7\Development\Configurations'

if (-not (Test-Path $xppConfigDir)) {
    Write-Error "XPP config directory not found: $xppConfigDir"
    return
}

# Get current config from registry
$currentConfigName = $null
$currentConfigVersion = $null
if (Test-Path $regPath) {
    $regProps = Get-ItemProperty -Path $regPath -ErrorAction SilentlyContinue
    if ($regProps.CurrentMetadataConfig) {
        $fileName = [System.IO.Path]::GetFileNameWithoutExtension($regProps.CurrentMetadataConfig)
        if ($fileName -match '^(.+?)___(.+)$') {
            $currentConfigName    = $Matches[1]
            $currentConfigVersion = $Matches[2]
        }
    }
}

# ─── Collect all configurations ───────────────────────────────────────────────
$configs = @()

# JSON configs (full metadata)
$jsonFiles = Get-ChildItem -Path $xppConfigDir -Filter '*.json' -File -ErrorAction SilentlyContinue
foreach ($file in $jsonFiles) {
    $baseName = [System.IO.Path]::GetFileNameWithoutExtension($file.Name)
    $cfgName = $null
    $appVersion = $null
    if ($baseName -match '^(.+?)___(.+)$') {
        $cfgName    = $Matches[1]
        $appVersion = $Matches[2]
    } else {
        $cfgName = $baseName
    }

    try {
        $json = Get-Content $file.FullName -Raw | ConvertFrom-Json
    } catch { continue }

    $isCurrent = ($cfgName -eq $currentConfigName -and $appVersion -eq $currentConfigVersion)

    $configs += [PSCustomObject]@{
        Name                        = $cfgName
        ApplicationVersion          = $appVersion
        IsCurrent                   = $isCurrent
        Source                      = 'JSON'
        CrossReferencesDbServerName = $json.CrossReferencesDbServerName
        CrossReferencesDatabaseName = $json.CrossReferencesDatabaseName
        ModelStoreFolder            = $json.ModelStoreFolder
        FrameworkDirectory          = $json.FrameworkDirectory
        ReferencePackagesPaths      = $json.ReferencePackagesPaths
    }
}

# Folder-based configs
$configDirs = Get-ChildItem -Path $xppConfigDir -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '___' }
foreach ($dir in $configDirs) {
    # Skip if JSON already exists
    $matchingJson = $jsonFiles | Where-Object {
        [System.IO.Path]::GetFileNameWithoutExtension($_.Name) -eq $dir.Name
    }
    if ($matchingJson) { continue }

    $cfgName = $null
    $appVersion = $null
    if ($dir.Name -match '^(.+?)___(.+)$') {
        $cfgName    = $Matches[1]
        $appVersion = $Matches[2]
    } else {
        $cfgName = $dir.Name
    }

    $inferredPkgDir = $null
    if ($appVersion) {
        $inferredPkgDir = Join-Path $env:LOCALAPPDATA "Microsoft\Dynamics365\$appVersion\PackagesLocalDirectory"
    }

    # Try to find XRef DB name from MDF files
    $mdfFiles = @(Get-ChildItem -Path $dir.FullName -Filter '*.mdf' -ErrorAction SilentlyContinue)
    $xrefDbName = $(if ($mdfFiles.Count -gt 0) { [System.IO.Path]::GetFileNameWithoutExtension($mdfFiles[0].Name) } else { $null })

    $configs += [PSCustomObject]@{
        Name                        = $cfgName
        ApplicationVersion          = $appVersion
        IsCurrent                   = $false
        Source                      = 'Folder'
        CrossReferencesDbServerName = '(LocalDB)\MSSQLLocalDB'
        CrossReferencesDatabaseName = $xrefDbName
        ModelStoreFolder            = $null
        FrameworkDirectory          = $inferredPkgDir
        ReferencePackagesPaths      = @($inferredPkgDir)
    }
}

# Sort: current first, then name + version
$configs = $configs | Sort-Object -Property @{Expression={-not $_.IsCurrent}}, Name, ApplicationVersion

# ─── List mode ────────────────────────────────────────────────────────────────
if ($ListConfigs) {
    Write-Host "================================================================" -ForegroundColor Cyan
    Write-Host "  Available D365FO Configurations" -ForegroundColor Cyan
    Write-Host "================================================================" -ForegroundColor Cyan
    Write-Host ""
    foreach ($cfg in $configs) {
        $marker    = $(if ($cfg.IsCurrent) { 'CURRENT' } else { '       ' })
        $color     = $(if ($cfg.IsCurrent) { 'Green' } else { 'Gray' })
        $pkgExists = $(if ($cfg.FrameworkDirectory -and (Test-Path $cfg.FrameworkDirectory)) { 'OK' } else { 'MISSING' })
        $xrefInfo  = $(if ($cfg.CrossReferencesDatabaseName) { $cfg.CrossReferencesDatabaseName } else { '(none)' })
        Write-Host "  [$marker] $($cfg.Name)  v$($cfg.ApplicationVersion)  Packages:$pkgExists  XRef:$xrefInfo" -ForegroundColor $color
    }
    Write-Host ""
    Write-Host "Usage: .\Update-Databases.ps1 -ConfigName ""<name>""" -ForegroundColor Yellow
    return
}

# ─── Select configuration ────────────────────────────────────────────────────
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "  D365FO MCP Services - Database Update" -ForegroundColor Cyan
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host ""

$selected = $null

if ($ConfigName) {
    # Find by name - pick the latest version if multiple exist
    $found = @($configs | Where-Object { $_.Name -eq $ConfigName })
    if ($found.Count -eq 0) {
        Write-Error "Configuration '$ConfigName' not found. Use -ListConfigs to see available configurations."
        return
    }
    # Prefer the current one, otherwise the latest version
    $selected = $found | Where-Object { $_.IsCurrent } | Select-Object -First 1
    if (-not $selected) {
        $selected = $found | Sort-Object ApplicationVersion -Descending | Select-Object -First 1
    }
} else {
    # Use current configuration
    $selected = $configs | Where-Object { $_.IsCurrent } | Select-Object -First 1
    if (-not $selected) {
        Write-Error "No current configuration found. Specify one with -ConfigName. Use -ListConfigs to see options."
        return
    }
}

Write-Host "  Configuration: $($selected.Name)" -ForegroundColor Green
Write-Host "  Version:       $($selected.ApplicationVersion)" -ForegroundColor Green
Write-Host "  Source:        $($selected.Source)" -ForegroundColor Green
Write-Host ""

# ─── Extract build parameters from config ─────────────────────────────────────
$msPackagesPath = $selected.FrameworkDirectory
$isvMetadataPath = $selected.ModelStoreFolder
$xrefServer = $selected.CrossReferencesDbServerName
$xrefDatabase = $selected.CrossReferencesDatabaseName

# Validate
$sourcePaths = @()

if ($msPackagesPath -and (Test-Path $msPackagesPath)) {
    $sourcePaths += $msPackagesPath
    Write-Host "  [OK] Microsoft packages: $msPackagesPath" -ForegroundColor Green
} elseif ($msPackagesPath) {
    Write-Warning "Microsoft packages not found: $msPackagesPath"
} else {
    Write-Warning "No FrameworkDirectory in configuration"
}

if ($isvMetadataPath -and (Test-Path $isvMetadataPath)) {
    $sourcePaths += $isvMetadataPath
    Write-Host "  [OK] Custom metadata:    $isvMetadataPath" -ForegroundColor Green
} elseif ($isvMetadataPath) {
    Write-Warning "Custom metadata not found: $isvMetadataPath"
}

if ($xrefServer) {
    Write-Host "  [OK] XRef server:        $xrefServer" -ForegroundColor Green
} else {
    Write-Warning "No CrossReferencesDbServerName in configuration"
}

if ($xrefDatabase) {
    Write-Host "  [OK] XRef database:      $xrefDatabase" -ForegroundColor Green
} else {
    Write-Warning "No CrossReferencesDatabaseName in configuration"
}

Write-Host "  Output dir:              $OutputDir"
Write-Host ""

# ─── Validate prerequisites ───────────────────────────────────────────────────
$nodeVersion = node --version 2>$null
if (-not $nodeVersion) {
    Write-Error "Node.js not found. Install Node.js 20+ first."
    return
}
Write-Host "  Node.js: $nodeVersion" -ForegroundColor Green

if (-not (Test-Path $OutputDir)) {
    New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
}

# Helper: stop local MCP server processes that hold SQLite file locks
function Stop-McpServers {
    param(
        [string]$Filter  # 'kb', 'xref', or empty for both
    )
    $mcpProcs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -match 'mcp-server' }

    if ($Filter -eq 'kb') {
        $mcpProcs = $mcpProcs | Where-Object { $_.CommandLine -match 'mcp-server-kb' }
    } elseif ($Filter -eq 'xref') {
        $mcpProcs = $mcpProcs | Where-Object { $_.CommandLine -match 'mcp-server-xref' }
    }

    if (-not $mcpProcs) { return }

    foreach ($proc in $mcpProcs) {
        Write-Host "  Stopping MCP server PID $($proc.ProcessId): $($proc.CommandLine)" -ForegroundColor Yellow
        Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
    }
    # Brief wait for file handles to release
    Start-Sleep -Seconds 2
    Write-Host "  [OK] MCP servers stopped." -ForegroundColor Green
}

# Helper: delete a database file, stopping MCP servers if locked
function Remove-DatabaseFile {
    param(
        [string]$FilePath,
        [string]$ServerFilter  # 'kb' or 'xref'
    )
    if (-not (Test-Path $FilePath)) { return $true }
    Write-Host "  Deleting existing $(Split-Path -Leaf $FilePath)..." -ForegroundColor DarkGray
    try {
        Remove-Item $FilePath -Force -ErrorAction Stop
        return $true
    } catch [System.IO.IOException] {
        Write-Host "  File is locked. Stopping local MCP servers..." -ForegroundColor Yellow
        Stop-McpServers -Filter $ServerFilter
        try {
            Remove-Item $FilePath -Force -ErrorAction Stop
            return $true
        } catch {
            Write-Error "Still locked: $($_.Exception.Message). Close all applications using this file and try again."
            return $false
        }
    }
}

$startTime = Get-Date
$steps = @()

# ─── Build KB Database ────────────────────────────────────────────────────────
if (-not $XrefOnly) {
    if ($sourcePaths.Count -eq 0) {
        Write-Warning "No valid package directories found. Skipping KB build."
        $steps += @{ Step = 'KB Database'; Status = 'SKIPPED'; Detail = 'No source paths' }
    } else {
        Write-Host ""
        Write-Host "==========================================================" -ForegroundColor Yellow
        Write-Host "  KB Database Build" -ForegroundColor Yellow
        Write-Host "==========================================================" -ForegroundColor Yellow

        $kbOutput = Join-Path $OutputDir 'd365fo_kb.sqlite'

        if (-not (Remove-DatabaseFile $kbOutput 'kb')) {
            $steps += @{ Step = 'KB Database'; Status = 'FAILED'; Detail = 'File locked' }
            break
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
            $steps += @{ Step = 'KB Database'; Status = 'FAILED'; Detail = $_.Exception.Message }
        }
        Write-Host ""
    }
}

# ─── Build XRef Database ─────────────────────────────────────────────────────
if (-not $KbOnly) {
    if (-not $xrefServer -or -not $xrefDatabase) {
        Write-Warning "XRef server or database not configured. Skipping XRef build."
        $steps += @{ Step = 'XRef Database'; Status = 'SKIPPED'; Detail = 'No XRef config' }
    } else {
        Write-Host ""
        Write-Host "==========================================================" -ForegroundColor Yellow
        Write-Host "  XRef Database Build" -ForegroundColor Yellow
        Write-Host "==========================================================" -ForegroundColor Yellow

        $xrefOutput = Join-Path $OutputDir 'd365fo_xref.sqlite'

        if (-not (Remove-DatabaseFile $xrefOutput 'xref')) {
            $steps += @{ Step = 'XRef Database'; Status = 'FAILED'; Detail = 'File locked' }
            break
        }

        # Start LocalDB if needed
        if ($xrefServer -match 'LocalDB') {
            Write-Host "  Starting LocalDB instance..." -ForegroundColor DarkGray
            SqlLocalDB start MSSQLLocalDB 2>$null | Out-Null
        }

        $xrefStart = Get-Date

        Write-Host "  Server:   $xrefServer" -ForegroundColor DarkGray
        Write-Host "  Database: $xrefDatabase" -ForegroundColor DarkGray
        Write-Host "  Output:   $xrefOutput" -ForegroundColor DarkGray
        Write-Host ""

        try {
            & node --max-old-space-size=8192 (Join-Path $projectDir 'build\build-xref-db.js') $xrefServer $xrefDatabase $xrefOutput
            if ($LASTEXITCODE -ne 0) {
                throw "XRef build failed with exit code $LASTEXITCODE"
            }

            $xrefElapsed = ((Get-Date) - $xrefStart).ToString('hh\:mm\:ss')
            $xrefSize = [math]::Round((Get-Item $xrefOutput).Length / 1MB)
            Write-Host "  [OK] XRef database built: $xrefSize MB in $xrefElapsed" -ForegroundColor Green
            $steps += @{ Step = 'XRef Database'; Status = 'OK'; Detail = "$xrefSize MB" }
        } catch {
            Write-Warning "XRef build failed: $($_.Exception.Message)"
            $steps += @{ Step = 'XRef Database'; Status = 'FAILED'; Detail = $_.Exception.Message }
        }
        Write-Host ""
    }
}

# ─── Summary ──────────────────────────────────────────────────────────────────
$elapsed = ((Get-Date) - $startTime).ToString('hh\:mm\:ss')
$allOk = ($steps | Where-Object { $_.Status -eq 'FAILED' }).Count -eq 0

$summaryColor = $(if ($allOk) { 'Green' } else { 'Yellow' })
Write-Host "================================================================" -ForegroundColor $summaryColor
Write-Host "  DATABASE UPDATE COMPLETE ($elapsed)" -ForegroundColor $summaryColor
Write-Host "================================================================" -ForegroundColor $summaryColor
Write-Host "  Configuration: $($selected.Name) v$($selected.ApplicationVersion)"
foreach ($step in $steps) {
    $color = switch ($step.Status) { 'OK' { 'Green' } 'FAILED' { 'Red' } 'SKIPPED' { 'DarkGray' } default { 'Gray' } }
    $detail = $(if ($step.Detail) { " ($($step.Detail))" } else { '' })
    Write-Host "  [$($step.Status)] $($step.Step)$detail" -ForegroundColor $color
}
Write-Host "================================================================" -ForegroundColor $summaryColor
Write-Host ""

if ($allOk -and ($steps | Where-Object { $_.Status -eq 'OK' }).Count -gt 0) {
    Write-Host "Next step: deploy to Azure" -ForegroundColor Yellow
    Write-Host "  .\Deploy-Databases.ps1 -Environment d" -ForegroundColor Yellow
}
