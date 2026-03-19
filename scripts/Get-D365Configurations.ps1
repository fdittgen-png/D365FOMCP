<#
.SYNOPSIS
    Export all D365FO local XPP configurations to XML.

.DESCRIPTION
    Reads all configurations from the "Manage local XPP configurations" dialog
    and outputs them as XML.

    Sources:
    - JSON config files in %LOCALAPPDATA%\Microsoft\Dynamics365\XPPConfig\
    - Registry key HKCU:\SOFTWARE\Microsoft\Dynamics\AX7\Development\Configurations
      (identifies the active configuration)
    - DynamicsDevConfig.xml (legacy default config)

    Exported fields per configuration:
    - Name, ApplicationVersion, IsCurrent
    - Description
    - CrossReferencesDbServerName, CrossReferencesDatabaseName
    - ModelStoreFolder (custom metadata)
    - FrameworkDirectory (Microsoft packages)
    - ReferencePackagesPaths
    - BusinessDatabaseName, DatabaseServer

.PARAMETER OutputPath
    Path for the XML output file. If omitted, outputs to console.

.EXAMPLE
    .\Get-D365Configurations.ps1
    .\Get-D365Configurations.ps1 -OutputPath C:\temp\d365-configs.xml

.NOTES
    Config location: %LOCALAPPDATA%\Microsoft\Dynamics365\XPPConfig\
    Registry: HKCU:\SOFTWARE\Microsoft\Dynamics\AX7\Development\Configurations
#>
[CmdletBinding()]
param(
    [string]$OutputPath
)

$ErrorActionPreference = 'Stop'

# ─── Locate config sources ───────────────────────────────────────────────────
$xppConfigDir = Join-Path $env:LOCALAPPDATA 'Microsoft\Dynamics365\XPPConfig'
$regPath      = 'HKCU:\SOFTWARE\Microsoft\Dynamics\AX7\Development\Configurations'

if (-not (Test-Path $xppConfigDir)) {
    Write-Error "XPP config directory not found: $xppConfigDir`nIs Dynamics 365 Finance & Operations development tools installed?"
    return
}

Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "  D365FO Configuration Export" -ForegroundColor Cyan
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "  Config dir: $xppConfigDir"

# ─── Get current (active) configuration from registry ─────────────────────────
$currentConfigPath = $null
$currentConfigName = $null
$currentConfigVersion = $null

if (Test-Path $regPath) {
    $regProps = Get-ItemProperty -Path $regPath -ErrorAction SilentlyContinue
    if ($regProps.CurrentMetadataConfig) {
        $currentConfigPath = $regProps.CurrentMetadataConfig
        # Extract name and version from filename: "tis-d365fo-dev-02___10.0.2263.202.json"
        $fileName = [System.IO.Path]::GetFileNameWithoutExtension($currentConfigPath)
        if ($fileName -match '^(.+?)___(.+)$') {
            $currentConfigName    = $Matches[1]
            $currentConfigVersion = $Matches[2]
        }
    }
}

Write-Host "  Active:     $currentConfigName ($currentConfigVersion)"
Write-Host ""

# ─── Collect all JSON config files ────────────────────────────────────────────
$jsonFiles = Get-ChildItem -Path $xppConfigDir -Filter '*.json' -File -ErrorAction SilentlyContinue

# ─── Also collect folder-based configs (directories with ___) ─────────────────
$configDirs = Get-ChildItem -Path $xppConfigDir -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '___' }

# ─── Build unified config list ────────────────────────────────────────────────
$configs = @()

# Process JSON configs (these have full metadata)
foreach ($file in $jsonFiles) {
    $baseName = [System.IO.Path]::GetFileNameWithoutExtension($file.Name)
    $configName = $null
    $appVersion = $null

    if ($baseName -match '^(.+?)___(.+)$') {
        $configName = $Matches[1]
        $appVersion = $Matches[2]
    } else {
        $configName = $baseName
    }

    try {
        $json = Get-Content $file.FullName -Raw | ConvertFrom-Json
    } catch {
        Write-Warning "Failed to parse $($file.Name): $($_.Exception.Message)"
        continue
    }

    $isCurrent = ($file.FullName -eq $currentConfigPath)

    $configs += [PSCustomObject]@{
        Source                      = 'JSON'
        FilePath                    = $file.FullName
        Name                        = $configName
        ApplicationVersion          = $appVersion
        IsCurrent                   = $isCurrent
        Description                 = $json.Description
        CrossReferencesDbServerName = $json.CrossReferencesDbServerName
        CrossReferencesDatabaseName = $json.CrossReferencesDatabaseName
        ModelStoreFolder            = $json.ModelStoreFolder
        FrameworkDirectory          = $json.FrameworkDirectory
        ReferencePackagesPaths      = ($json.ReferencePackagesPaths -join ';')
        DatabaseServer              = $json.DatabaseServer
        BusinessDatabaseName        = $json.BusinessDatabaseName
        RuntimePackagesDirectory    = $json.RuntimePackagesDirectory
        LastModified                = $file.LastWriteTime
    }
}

# Process folder-based configs (older format — no JSON, just MDF files)
foreach ($dir in $configDirs) {
    # Skip if we already have a matching JSON config
    $matchingJson = $jsonFiles | Where-Object {
        [System.IO.Path]::GetFileNameWithoutExtension($_.Name) -eq $dir.Name
    }
    if ($matchingJson) { continue }

    $configName = $null
    $appVersion = $null
    if ($dir.Name -match '^(.+?)___(.+)$') {
        $configName = $Matches[1]
        $appVersion = $Matches[2]
    } else {
        $configName = $dir.Name
    }

    # Check for MDF files (XRef database)
    $mdfFiles = @(Get-ChildItem -Path $dir.FullName -Filter '*.mdf' -ErrorAction SilentlyContinue)
    $xrefDbName = if ($mdfFiles.Count -gt 0) { [System.IO.Path]::GetFileNameWithoutExtension($mdfFiles[0].Name) } else { $null }

    # Infer PackagesLocalDirectory from version
    $inferredPkgDir = $null
    if ($appVersion) {
        $inferredPkgDir = Join-Path $env:LOCALAPPDATA "Microsoft\Dynamics365\$appVersion\PackagesLocalDirectory"
        if (-not (Test-Path $inferredPkgDir)) { $inferredPkgDir = "(not found) $inferredPkgDir" }
    }

    $configs += [PSCustomObject]@{
        Source                      = 'Folder'
        FilePath                    = $dir.FullName
        Name                        = $configName
        ApplicationVersion          = $appVersion
        IsCurrent                   = $false
        Description                 = $null
        CrossReferencesDbServerName = '(LocalDB)\MSSQLLocalDB'
        CrossReferencesDatabaseName = $xrefDbName
        ModelStoreFolder            = $null
        FrameworkDirectory          = $inferredPkgDir
        ReferencePackagesPaths      = $inferredPkgDir
        DatabaseServer              = $null
        BusinessDatabaseName        = $null
        RuntimePackagesDirectory    = $null
        LastModified                = $dir.LastWriteTime
    }
}

# ─── Also include the legacy DynamicsDevConfig.xml if it exists ───────────────
if (Test-Path $regPath) {
    $regProps = Get-ItemProperty -Path $regPath -ErrorAction SilentlyContinue
    if ($regProps.DefaultConfig -and (Test-Path $regProps.DefaultConfig)) {
        try {
            [xml]$devConfig = Get-Content $regProps.DefaultConfig -Raw
            # The XML uses a namespace — access the root element directly
            $dc = $devConfig.DocumentElement

            $configs += [PSCustomObject]@{
                Source                      = 'DynamicsDevConfig.xml'
                FilePath                    = $regProps.DefaultConfig
                Name                        = 'DefaultConfig'
                ApplicationVersion          = $null
                IsCurrent                   = ($regProps.CurrentConfig -eq 'DefaultConfig')
                Description                 = 'Legacy DynamicsDevConfig.xml (cloud/onebox)'
                CrossReferencesDbServerName = $dc.CrossReferencesDbServerName
                CrossReferencesDatabaseName = $dc.CrossReferencesDatabaseName
                ModelStoreFolder            = $null
                FrameworkDirectory          = $null
                ReferencePackagesPaths      = $null
                DatabaseServer              = $dc.DatabaseServer
                BusinessDatabaseName        = $dc.BusinessDatabaseName
                RuntimePackagesDirectory    = $null
                LastModified                = (Get-Item $regProps.DefaultConfig).LastWriteTime
            }
        } catch {
            Write-Warning "Failed to parse DynamicsDevConfig.xml: $($_.Exception.Message)"
        }
    }
}

# Sort: current first, then by name + version
$configs = $configs | Sort-Object -Property @{Expression={-not $_.IsCurrent}}, Name, ApplicationVersion

# ─── Display summary ──────────────────────────────────────────────────────────
foreach ($cfg in $configs) {
    $marker = if ($cfg.IsCurrent) { 'CURRENT' } else { '       ' }
    $color  = if ($cfg.IsCurrent) { 'Green' } else { 'Gray' }
    Write-Host "  [$marker] $($cfg.Name)  v$($cfg.ApplicationVersion)  ($($cfg.Source))" -ForegroundColor $color
}
Write-Host ""

# ─── Build XML ────────────────────────────────────────────────────────────────
$xml = [System.Xml.XmlDocument]::new()
$xml.AppendChild($xml.CreateXmlDeclaration('1.0', 'utf-8', $null)) | Out-Null

$root = $xml.CreateElement('D365Configurations')
$root.SetAttribute('ExportDate', (Get-Date -Format 'yyyy-MM-ddTHH:mm:ss'))
$root.SetAttribute('MachineName', $env:COMPUTERNAME)
$root.SetAttribute('UserName', $env:USERNAME)
$root.SetAttribute('ConfigDirectory', $xppConfigDir)
$root.SetAttribute('TotalConfigurations', $configs.Count)
$xml.AppendChild($root) | Out-Null

foreach ($cfg in $configs) {
    $el = $xml.CreateElement('Configuration')
    $el.SetAttribute('Name', $(if ($cfg.Name) { $cfg.Name } else { '' }))
    $el.SetAttribute('ApplicationVersion', $(if ($cfg.ApplicationVersion) { $cfg.ApplicationVersion } else { '' }))
    $el.SetAttribute('IsCurrent', $cfg.IsCurrent.ToString().ToLower())
    $el.SetAttribute('Source', $(if ($cfg.Source) { $cfg.Source } else { '' }))
    $el.SetAttribute('LastModified', $(if ($cfg.LastModified) { $cfg.LastModified.ToString('yyyy-MM-ddTHH:mm:ss') } else { '' }))

    # Add child elements for non-null fields
    $fieldMap = [ordered]@{
        Description                 = $cfg.Description
        CrossReferencesDbServerName = $cfg.CrossReferencesDbServerName
        CrossReferencesDatabaseName = $cfg.CrossReferencesDatabaseName
        ModelStoreFolder            = $cfg.ModelStoreFolder
        FrameworkDirectory          = $cfg.FrameworkDirectory
        ReferencePackagesPaths      = $cfg.ReferencePackagesPaths
        DatabaseServer              = $cfg.DatabaseServer
        BusinessDatabaseName        = $cfg.BusinessDatabaseName
        RuntimePackagesDirectory    = $cfg.RuntimePackagesDirectory
        FilePath                    = $cfg.FilePath
    }

    foreach ($key in $fieldMap.Keys) {
        $val = $fieldMap[$key]
        if ($null -ne $val -and $val -ne '') {
            $child = $xml.CreateElement($key)
            $child.InnerText = [string]$val
            $el.AppendChild($child) | Out-Null
        }
    }

    $root.AppendChild($el) | Out-Null
}

# ─── Output ───────────────────────────────────────────────────────────────────
$settings = [System.Xml.XmlWriterSettings]::new()
$settings.Indent = $true
$settings.IndentChars = '  '
$settings.Encoding = [System.Text.UTF8Encoding]::new($false)

if ($OutputPath) {
    $writer = [System.Xml.XmlWriter]::Create($OutputPath, $settings)
    $xml.WriteTo($writer)
    $writer.Close()
    Write-Host "XML exported to: $OutputPath" -ForegroundColor Green
} else {
    $sw = [System.IO.StringWriter]::new()
    $writer = [System.Xml.XmlWriter]::Create($sw, $settings)
    $xml.WriteTo($writer)
    $writer.Close()
    Write-Output $sw.ToString()
}

Write-Host ""
Write-Host "Found $($configs.Count) configuration(s)." -ForegroundColor Cyan
