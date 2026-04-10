<#
.SYNOPSIS
    Extract D365 F&O AOT security XMLs from one or more source directories into a small zip
    that can be uploaded to the MCP security service via Flow B (AOT update).

.DESCRIPTION
    Walks each source directory looking for AxSecurityRole, AxSecurityDuty,
    AxSecurityPrivilege directories and en-US AxLabelFile entries. Copies them
    into a flat structure under <output>/AxSecurityRole/, <output>/AxSecurityDuty/,
    etc. Then zips the result.

    Supports multiple source paths so you can combine:
      - Microsoft standard models (PackagesLocalDirectory under AppData)
      - Customizations and ISVs (your dev workspace metadata)

    Filenames are namespaced with a per-source prefix to avoid collisions when the
    same model exists in multiple sources.

    The output zip is typically 50-150 MB and contains everything the MCP
    security builder needs to populate privileges, privilege_entry_points,
    and direct duty-privilege mappings.

.PARAMETER SourcePaths
    One or more source directories to walk. Defaults to:
      - The Trelleborg dev workspace metadata (C:\Workspace\DEV\Metadata)
      - The current user's PackagesLocalDirectory under AppData

    Pass as an array, e.g. -SourcePaths "C:\Workspace\DEV\Metadata","D:\AOSService\PackagesLocalDirectory"

.PARAMETER PackagesPath
    Legacy single-path parameter (for backwards compatibility). If supplied, replaces SourcePaths.

.PARAMETER OutputZip
    Output zip path (default: %USERPROFILE%\Downloads\d365fo-aot-security.zip)

.PARAMETER WorkDir
    Temp working directory (default: %TEMP%\d365fo-aot-extract)

.EXAMPLE
    .\Extract-AotSecurity.ps1
    # Uses both default paths (Workspace\DEV\Metadata + AppData PackagesLocalDirectory)

.EXAMPLE
    .\Extract-AotSecurity.ps1 -SourcePaths "C:\Workspace\DEV\Metadata","C:\Users\me\AppData\Local\Microsoft\Dynamics365\10.0.2263.202\PackagesLocalDirectory"

.EXAMPLE
    .\Extract-AotSecurity.ps1 -OutputZip "C:\temp\aot.zip"

.NOTES
    Run on a D365 F&O dev machine with read access to the source directories.
    Output zip can be uploaded via:
      - Web form at /api/d365sec/upload
      - PowerAutomate via POST /api/d365sec/upload/build { source_url }
      - curl PUT to a SAS URL from /api/d365sec/upload/sas
#>
[CmdletBinding()]
param(
    [string[]]$SourcePaths = @(
        'C:\Workspace\DEV\Metadata',
        (Join-Path $env:LOCALAPPDATA 'Microsoft\Dynamics365\10.0.2263.202\PackagesLocalDirectory')
    ),
    [string]$PackagesPath,
    [string]$OutputZip = (Join-Path $env:USERPROFILE 'Downloads\d365fo-aot-security.zip'),
    [string]$WorkDir = (Join-Path $env:TEMP 'd365fo-aot-extract')
)

$ErrorActionPreference = 'Stop'

# Backwards compatibility: -PackagesPath overrides -SourcePaths
if ($PackagesPath) {
    $SourcePaths = @($PackagesPath)
}

Write-Host '================================================================' -ForegroundColor Cyan
Write-Host '  D365FO AOT Security Extraction' -ForegroundColor Cyan
Write-Host '================================================================' -ForegroundColor Cyan
Write-Host '  Sources:'
foreach ($p in $SourcePaths) {
    $exists = if (Test-Path $p) { '[OK]   ' } else { '[MISS] ' }
    Write-Host "    $exists$p"
}
Write-Host "  Output:  $OutputZip"
Write-Host "  WorkDir: $WorkDir"
Write-Host ''

# Filter to existing paths only
$validPaths = @($SourcePaths | Where-Object { Test-Path $_ })
if ($validPaths.Count -eq 0) {
    Write-Error "No valid source directories found. Checked: $($SourcePaths -join ', ')"
    return
}

# Clean working directory
if (Test-Path $WorkDir) { Remove-Item $WorkDir -Recurse -Force }
New-Item -ItemType Directory -Path $WorkDir -Force | Out-Null

# Helper: derive a short prefix from a path so files from different sources don't collide
function Get-SourcePrefix([string]$path) {
    # Use a sanitized last segment of the path
    $name = (Split-Path $path -Leaf).ToLower()
    if ($name -eq 'metadata') { return 'custom' }
    if ($name -eq 'packageslocaldirectory') { return 'standard' }
    return ($name -replace '[^a-z0-9]', '').ToLower()
}

# Targets: copy each into a flat <WorkDir>/<TypeName>/ folder
# The builder uses findAxDirs which walks up to 4 levels — having them at the root is fine.
$axTypes = @('AxSecurityRole', 'AxSecurityDuty', 'AxSecurityPrivilege')
$totalFiles = 0

foreach ($type in $axTypes) {
    Write-Host "Searching for $type/*.xml ..." -ForegroundColor Yellow
    $destDir = Join-Path $WorkDir $type
    New-Item -ItemType Directory -Path $destDir -Force | Out-Null

    $typeTotal = 0
    foreach ($basePath in $validPaths) {
        $prefix = Get-SourcePrefix $basePath
        # Find all directories named $type under this base path
        $sourceDirs = Get-ChildItem -Path $basePath -Recurse -Directory -Filter $type -ErrorAction SilentlyContinue
        if ($sourceDirs.Count -eq 0) { continue }

        $count = 0
        foreach ($sd in $sourceDirs) {
            $xmlFiles = Get-ChildItem -Path $sd.FullName -Filter '*.xml' -File -ErrorAction SilentlyContinue
            foreach ($xml in $xmlFiles) {
                # Namespace by source prefix + relative path to avoid collisions
                $relativePath = $xml.FullName.Substring($basePath.Length + 1).Replace('\', '_').Replace('/', '_')
                $destFile = Join-Path $destDir "${prefix}__${relativePath}"
                Copy-Item $xml.FullName $destFile -Force
                $count++
            }
        }
        Write-Host "  [$prefix] $($sourceDirs.Count) dirs, $count files" -ForegroundColor DarkGray
        $typeTotal += $count
    }
    Write-Host "  Total $type XML files: $typeTotal" -ForegroundColor Green
    $totalFiles += $typeTotal
}

# Copy en-US label files (needed for label resolution)
Write-Host "Searching for AxLabelFile/*en-US*.label.txt ..." -ForegroundColor Yellow
$labelDest = Join-Path $WorkDir 'AxLabelFile'
New-Item -ItemType Directory -Path $labelDest -Force | Out-Null

$labelTotal = 0
foreach ($basePath in $validPaths) {
    $prefix = Get-SourcePrefix $basePath
    $labelDirs = Get-ChildItem -Path $basePath -Recurse -Directory -Filter 'AxLabelFile' -ErrorAction SilentlyContinue
    if ($labelDirs.Count -eq 0) { continue }

    $count = 0
    foreach ($ld in $labelDirs) {
        $labelFiles = Get-ChildItem -Path $ld.FullName -Filter '*en-US*.label.txt' -File -ErrorAction SilentlyContinue
        foreach ($lf in $labelFiles) {
            $relativePath = $lf.FullName.Substring($basePath.Length + 1).Replace('\', '_').Replace('/', '_')
            $destFile = Join-Path $labelDest "${prefix}__${relativePath}"
            Copy-Item $lf.FullName $destFile -Force
            $count++
        }
    }
    Write-Host "  [$prefix] $($labelDirs.Count) dirs, $count label files" -ForegroundColor DarkGray
    $labelTotal += $count
}
Write-Host "  Total label files: $labelTotal" -ForegroundColor Green
$totalFiles += $labelTotal

# Calculate size
$workSize = (Get-ChildItem $WorkDir -Recurse -File | Measure-Object -Property Length -Sum).Sum
Write-Host ''
Write-Host "Total files: $totalFiles" -ForegroundColor Cyan
Write-Host "Total size: $([math]::Round($workSize / 1MB, 1)) MB" -ForegroundColor Cyan
Write-Host ''

# Create zip
Write-Host 'Creating zip...' -ForegroundColor Yellow
if (Test-Path $OutputZip) { Remove-Item $OutputZip -Force }
Compress-Archive -Path "$WorkDir\*" -DestinationPath $OutputZip -CompressionLevel Optimal

$zipSize = (Get-Item $OutputZip).Length
Write-Host ''
Write-Host '================================================================' -ForegroundColor Green
Write-Host '  Extraction complete' -ForegroundColor Green
Write-Host '================================================================' -ForegroundColor Green
Write-Host "  Output:    $OutputZip"
Write-Host "  Size:      $([math]::Round($zipSize / 1MB, 1)) MB"
Write-Host '  Contents:  AxSecurityRole/, AxSecurityDuty/, AxSecurityPrivilege/, AxLabelFile/'
Write-Host ''
Write-Host '  Upload to Azure via:' -ForegroundColor Cyan
Write-Host '    1. Web form: https://tis-d-mcpd365fo-func.azurewebsites.net/api/d365sec/upload'
Write-Host '    2. PowerAutomate: POST /api/d365sec/upload/build { "source_url": "<blob URL>" }'
Write-Host '    3. curl: see docs/PowerAutomate-SecDatabase-Update.md'
Write-Host ''

# Cleanup work dir
Remove-Item $WorkDir -Recurse -Force
