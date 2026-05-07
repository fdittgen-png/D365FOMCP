<#
.SYNOPSIS
    Generate a D365 F&O DMF data package containing SystemSegregationOfDutiesRuleEntity records
    from a Trelleborg-style SoD matrix CSV.

.DESCRIPTION
    Two modes:

    Mode A (RECOMMENDED) -- read a TRELLEBORG SoD MATRIX CSV (the multi-section grid where rows
    are tasks, columns are tasks, and cells contain X / High / Low / blank) and generate the DMF zip:

      .\New-SodRulesPackage.ps1 -MatrixCsv "C:\path\to\matrix.csv"

    Mode B -- read a flat rules CSV (one row per rule) and generate the DMF zip:

      .\New-SodRulesPackage.ps1 -RulesCsv "C:\path\to\rules.csv"

    For Mode A, the script:
      1. Parses the matrix into sections (P2P, O2C, R2R, etc.)
      2. For each (row, column) cell with severity High or Low, creates a rule
      3. Looks up the actual D365 duty IDs by querying the MCP sec service via HTTPS
         (the script uses friendly duty names from the matrix's "Duty/Privilege" column)
      4. Generates Manifest.xml + PackageHeader.xml + SystemSegregationOfDutiesRuleEntity.xml
      5. Zips the result

    Output: a DMF package zip ready to upload to:
      - D365 F&O Data Management -> Import -> Upload package
      - The MCP /api/d365sec/upload endpoint (when SoD support is added to the builder)

.PARAMETER MatrixCsv
    Path to the 2D matrix CSV (Trelleborg format). Mutually exclusive with -RulesCsv.

.PARAMETER RulesCsv
    Path to a flat rules CSV with columns:
        name, first_duty_id, first_duty_name, second_duty_id, second_duty_name, severity, risk, mitigation, valid_from, valid_to

.PARAMETER OutputZip
    Output zip path. Default: %USERPROFILE%\Downloads\sod-rules-package.zip

.PARAMETER McpEndpoint
    MCP sec service URL for duty lookup. Default: https://tis-d-mcpd365fo-func.azurewebsites.net/api/d365sec
    Set to empty string to skip lookup (rules will use the friendly name as the duty ID).

.PARAMETER PackageName
    DMF package name. Default: SoDRulesImport

.PARAMETER SkipDutyLookup
    Skip MCP duty ID lookup; use the friendly duty name as the identifier directly.
    Useful for offline runs or when you don't trust the matching.

.EXAMPLE
    .\New-SodRulesPackage.ps1 -MatrixCsv "C:\Users\me\Downloads\Security roles assignment_XXXX(SOD matrix).csv"

.EXAMPLE
    .\New-SodRulesPackage.ps1 -RulesCsv .\sample-sod-rules.csv -OutputZip C:\temp\sod.zip

.NOTES
    For matrix mode, the duty lookup queries the live MCP sec service to find the actual duty_id
    that corresponds to a friendly duty name like "Maintain vendor master". The lookup uses
    case-insensitive LIKE matching against duties.duty_name. If multiple duties match, the first
    one (alphabetical) is used and a warning is printed. If no duty matches, the rule is skipped
    and logged as unresolved.
#>
[CmdletBinding(DefaultParameterSetName='Matrix')]
param(
    [Parameter(ParameterSetName='Matrix', Mandatory=$true)]
    [string]$MatrixCsv,

    [Parameter(ParameterSetName='Rules', Mandatory=$true)]
    [string]$RulesCsv,

    [string]$OutputZip = (Join-Path $env:USERPROFILE 'Downloads\sod-rules-package.zip'),

    [string]$McpEndpoint = 'https://tis-d-mcpd365fo-func.azurewebsites.net/api/d365sec',

    [string]$PackageName = 'SoDRulesImport',

    [switch]$SkipDutyLookup
)

$ErrorActionPreference = 'Stop'

# ── Helpers ─────────────────────────────────────────────────────────────────

function Escape-Xml([string]$s) {
    if ($null -eq $s) { return '' }
    return ([string]$s).Replace('&', '&amp;').Replace('<', '&lt;').Replace('>', '&gt;').Replace('"', '&quot;').Replace("'", '&apos;')
}

# Cache for MCP duty lookups (avoid hammering the service)
$script:DutyCache = @{}

function Get-DutyIdFromMcp([string]$friendlyName, [string]$endpoint) {
    if ([string]::IsNullOrWhiteSpace($friendlyName)) { return $null }
    $key = $friendlyName.Trim().ToLower()
    if ($script:DutyCache.ContainsKey($key)) { return $script:DutyCache[$key] }

    # Strip alternatives ("or", "+") and "/Privilege" suffix -- keep the first duty name
    $clean = $friendlyName -replace '\s*\+\s*', ' or ' -replace '\s+or\s+', "`n"
    $cleanName = ($clean -split "`n" | Select-Object -First 1).Trim()
    $dutyOnly = ($cleanName -split '/' | Select-Object -First 1).Trim()
    if ([string]::IsNullOrWhiteSpace($dutyOnly)) {
        $script:DutyCache[$key] = $null
        return $null
    }
    $likePattern = '%' + ($dutyOnly -replace "'", "''") + '%'

    $sql = "SELECT duty_id, duty_name FROM duties WHERE duty_name LIKE '$likePattern' COLLATE NOCASE ORDER BY duty_name LIMIT 5"
    $body = @{
        jsonrpc = '2.0'
        id = 1
        method = 'tools/call'
        params = @{
            name = 'sec_raw_sql'
            arguments = @{ sql = $sql }
        }
    } | ConvertTo-Json -Depth 6 -Compress

    try {
        $resp = Invoke-RestMethod -Uri $endpoint -Method Post -Body $body `
            -ContentType 'application/json' `
            -Headers @{ 'Accept' = 'application/json, text/event-stream' } `
            -TimeoutSec 30
        $text = [string]$resp.result.content[0].text
        if ([string]::IsNullOrWhiteSpace($text) -or $text -like '*No results*') {
            $script:DutyCache[$key] = $null
            return $null
        }
        # Parse the markdown table — collect data rows (skip header and separator lines)
        $allLines = $text -split "`r?`n"
        $dataRows = @()
        foreach ($l in $allLines) {
            $trimmed = $l.Trim()
            if (-not $trimmed.StartsWith('|')) { continue }
            if ($trimmed -like '*duty_id*duty_name*') { continue }   # header
            if ($trimmed -like '*---*') { continue }                  # separator
            $dataRows += $trimmed
        }
        if ($dataRows.Count -eq 0) {
            $script:DutyCache[$key] = $null
            return $null
        }
        # Parse the first data row: split by | and take cells 1 and 2
        $parts = $dataRows[0].Split('|')
        $dutyId = if ($parts.Count -ge 2) { $parts[1].Trim() } else { '' }
        $dutyName = if ($parts.Count -ge 3) { $parts[2].Trim() } else { '' }
        if ([string]::IsNullOrWhiteSpace($dutyId)) {
            $script:DutyCache[$key] = $null
            return $null
        }
        $result = [PSCustomObject]@{ id = $dutyId; name = $dutyName; matchCount = $dataRows.Count }
        $script:DutyCache[$key] = $result
        return $result
    } catch {
        Write-Warning "MCP lookup failed for '$dutyOnly': $($_.Exception.Message)"
        $script:DutyCache[$key] = $null
        return $null
    }
}

# ── Parse the matrix CSV into a list of rule rows ───────────────────────────

function Parse-CsvLine([string]$line) {
    return [regex]::Matches($line, '(?<=^|,)("(?:[^"]|"")*"|[^,]*)') | ForEach-Object {
        $v = $_.Value
        if ($v.StartsWith('"') -and $v.EndsWith('"')) {
            $v = $v.Substring(1, $v.Length - 2).Replace('""', '"')
        }
        $v
    }
}

function ConvertFrom-SodMatrix([string]$csvPath, [string]$endpoint, [bool]$skipLookup) {
    if (-not (Test-Path $csvPath)) { throw "Matrix CSV not found: $csvPath" }

    Write-Host "Parsing matrix CSV: $csvPath" -ForegroundColor Yellow
    $lines = Get-Content $csvPath -Encoding UTF8

    # ── Pass 1: split file into sections ───────────────────────────────────
    # A section starts with a header row containing "Duty name/Privilege name" in column 3.
    # Data rows follow until a blank line or the next header.
    $sections = @()
    $currentSection = $null

    for ($i = 0; $i -lt $lines.Count; $i++) {
        $line = $lines[$i]
        if ([string]::IsNullOrWhiteSpace($line)) {
            if ($currentSection) { $sections += $currentSection; $currentSection = $null }
            continue
        }
        $cells = Parse-CsvLine $line

        if ($cells.Count -ge 4 -and $cells[3] -match 'Duty\s*name.*Privilege\s*name') {
            # Section header — start a new section
            if ($currentSection) { $sections += $currentSection }
            $currentSection = @{
                name        = if ($cells[1]) { $cells[1] } else { 'Unknown' }
                headerCells = @($cells)  # column N from index 4 = task at column N
                rows        = @()         # data rows in order: row M = task at index M (matches column M+4 in header)
            }
            continue
        }

        if ($currentSection -and $cells.Count -ge 5 -and ($cells[1] -match '^\d+$')) {
            $currentSection.rows += , @($cells)
        }
    }
    if ($currentSection) { $sections += $currentSection }

    foreach ($s in $sections) {
        Write-Host "  Section $($s.name): $($s.rows.Count) data rows, $($s.headerCells.Count - 4) columns" -ForegroundColor DarkGray
    }

    # ── Pass 2: extract conflict rules using INDEX-based column→row mapping ─
    $rules = New-Object System.Collections.ArrayList
    $unresolved = New-Object System.Collections.ArrayList

    foreach ($s in $sections) {
        for ($r = 0; $r -lt $s.rows.Count; $r++) {
            $rowCells = $s.rows[$r]
            $rowTaskName = $rowCells[2]
            $rowDutyPriv = $rowCells[3]

            for ($j = 4; $j -lt $rowCells.Count -and $j -lt $s.headerCells.Count; $j++) {
                $cell = $rowCells[$j].Trim()
                if ($cell -eq '' -or $cell -eq 'X') { continue }
                if ($cell -notmatch '^(High|Medium|Low)$') { continue }

                # Index-based: column $j corresponds to data row at index ($j - 4)
                $colIdx = $j - 4
                if ($colIdx -lt $s.rows.Count) {
                    $colRow = $s.rows[$colIdx]
                    $colTaskName = $colRow[2]
                    $colDutyPriv = $colRow[3]
                } else {
                    # Fallback: use the column header directly
                    $colTaskName = $s.headerCells[$j].Trim()
                    $colDutyPriv = $colTaskName
                }

                $rule = [PSCustomObject]@{
                    name             = "$($s.name) - $rowTaskName vs $colTaskName"
                    section          = $s.name
                    first_task_name  = $rowTaskName
                    first_duty_priv  = $rowDutyPriv
                    first_duty_id    = $null
                    first_duty_name  = $rowDutyPriv
                    second_task_name = $colTaskName
                    second_duty_priv = $colDutyPriv
                    second_duty_id   = $null
                    second_duty_name = $colDutyPriv
                    severity         = $cell
                    risk             = "$rowTaskName conflicts with $colTaskName"
                    mitigation       = 'Define separate person/user'
                    valid_from       = ''
                    valid_to         = ''
                }
                [void]$rules.Add($rule)
            }
        }
    }

    Write-Host "  Parsed $($rules.Count) raw conflict rules" -ForegroundColor Green

    # ── Look up duty IDs ───────────────────────────────────────────────────
    if (-not $skipLookup) {
        Write-Host "Looking up duty IDs from MCP service..." -ForegroundColor Yellow
        $resolved = 0
        $multiMatch = 0
        foreach ($rule in $rules) {
            $first = Get-DutyIdFromMcp $rule.first_duty_priv $endpoint
            $second = Get-DutyIdFromMcp $rule.second_duty_priv $endpoint
            if ($first) {
                $rule.first_duty_id = $first.id
                $rule.first_duty_name = $first.name
                if ($first.matchCount -gt 1) { $multiMatch++ }
            } else {
                [void]$unresolved.Add("$($rule.first_duty_priv) (row task: $($rule.first_task_name))")
            }
            if ($second) {
                $rule.second_duty_id = $second.id
                $rule.second_duty_name = $second.name
                if ($second.matchCount -gt 1) { $multiMatch++ }
            } else {
                [void]$unresolved.Add("$($rule.second_duty_priv) (col task: $($rule.second_task_name))")
            }
            if ($first -and $second) { $resolved++ }
        }
        Write-Host "  Resolved: $resolved/$($rules.Count) rules (both duties found)" -ForegroundColor Green
        if ($multiMatch -gt 0) { Write-Host "  Multi-match warnings: $multiMatch (took first alphabetical)" -ForegroundColor Yellow }
        if ($unresolved.Count -gt 0) {
            Write-Host "  Unresolved duty names ($($unresolved.Count) unique):" -ForegroundColor Red
            $unresolved | Select-Object -Unique | ForEach-Object { Write-Host "    - $_" -ForegroundColor Red }
        }
    } else {
        Write-Host "Skipping duty ID lookup (-SkipDutyLookup). Using friendly names as IDs." -ForegroundColor Yellow
        foreach ($rule in $rules) {
            $rule.first_duty_id = $rule.first_duty_priv
            $rule.second_duty_id = $rule.second_duty_priv
        }
    }

    return $rules
}

# ── Build the DMF package zip ────────────────────────────────────────────────

function New-SodPackage([object[]]$rules, [string]$outputZip, [string]$packageName) {
    $workDir = Join-Path $env:TEMP "sod-package-$(Get-Random)"
    New-Item -ItemType Directory -Path $workDir -Force | Out-Null

    try {
        Write-Host "Generating entity XML..." -ForegroundColor Yellow

        $entityFile = Join-Path $workDir 'SystemSegregationOfDutiesRuleEntity.xml'
        $sb = [System.Text.StringBuilder]::new()
        [void]$sb.Append('<?xml version="1.0" encoding="utf-8"?><Document>')

        $defaultValidFrom = (Get-Date).ToString('yyyy-MM-ddTHH:mm:ss')
        $defaultValidTo   = '2099-12-31T00:00:00'

        $generated = 0
        $skipped = 0
        foreach ($r in $rules) {
            if ([string]::IsNullOrWhiteSpace($r.first_duty_id) -or [string]::IsNullOrWhiteSpace($r.second_duty_id)) {
                $skipped++; continue
            }
            if ([string]::IsNullOrWhiteSpace($r.severity)) { $skipped++; continue }

            $vf = if ([string]::IsNullOrWhiteSpace($r.valid_from)) { $defaultValidFrom } else { $r.valid_from }
            $vt = if ([string]::IsNullOrWhiteSpace($r.valid_to))   { $defaultValidTo   } else { $r.valid_to }

            [void]$sb.Append('<SYSTEMSEGREGATIONOFDUTIESRULEENTITY>')
            [void]$sb.Append("<VALIDFROM>$(Escape-Xml $vf)</VALIDFROM>")
            [void]$sb.Append("<VALIDTO>$(Escape-Xml $vt)</VALIDTO>")
            [void]$sb.Append("<NAME>$(Escape-Xml $r.name)</NAME>")
            [void]$sb.Append("<FIRSTSECURITYDUTYIDENTIFIER>$(Escape-Xml $r.first_duty_id)</FIRSTSECURITYDUTYIDENTIFIER>")
            [void]$sb.Append("<FIRSTSECURITYDUTYNAME>$(Escape-Xml $r.first_duty_name)</FIRSTSECURITYDUTYNAME>")
            [void]$sb.Append("<MITIGATION>$(Escape-Xml $r.mitigation)</MITIGATION>")
            [void]$sb.Append("<RISK>$(Escape-Xml $r.risk)</RISK>")
            [void]$sb.Append("<SECONDSECURITYDUTYIDENTIFIER>$(Escape-Xml $r.second_duty_id)</SECONDSECURITYDUTYIDENTIFIER>")
            [void]$sb.Append("<SECONDSECURITYDUTYNAME>$(Escape-Xml $r.second_duty_name)</SECONDSECURITYDUTYNAME>")
            [void]$sb.Append("<SEVERITY>$(Escape-Xml $r.severity)</SEVERITY>")
            [void]$sb.Append('</SYSTEMSEGREGATIONOFDUTIESRULEENTITY>')
            $generated++
        }
        [void]$sb.Append('</Document>')
        [System.IO.File]::WriteAllText($entityFile, $sb.ToString(), [System.Text.Encoding]::UTF8)

        Write-Host "  Generated: $generated rules" -ForegroundColor Green
        if ($skipped -gt 0) { Write-Host "  Skipped:   $skipped (missing duty IDs or severity)" -ForegroundColor Yellow }

        # Manifest.xml
        $manifestXml = @"
<?xml version="1.0" encoding="utf-8"?>
<DataManagementSchema>
  <ProjectName>$packageName</ProjectName>
  <Description>Segregation of Duties rules import</Description>
  <CreatedBy>SoDRulesPackageGenerator</CreatedBy>
  <PackageVersion>1.0</PackageVersion>
  <DataProject>
    <Entity>
      <Name>SystemSegregationOfDutiesRuleEntity</Name>
      <DataSource>SystemSegregationOfDutiesRuleEntity.xml</DataSource>
      <ExecutionUnit>1</ExecutionUnit>
      <Level>1</Level>
      <Sequence>1</Sequence>
      <Mode>Import</Mode>
      <Format>XML-Element</Format>
      <ImportTo>true</ImportTo>
      <ExportFrom>false</ExportFrom>
      <RefreshType>Incremental</RefreshType>
      <SkipStaging>No</SkipStaging>
    </Entity>
  </DataProject>
</DataManagementSchema>
"@
        [System.IO.File]::WriteAllText((Join-Path $workDir 'Manifest.xml'), $manifestXml, [System.Text.Encoding]::UTF8)

        # PackageHeader.xml
        $packageHeaderXml = @"
<?xml version="1.0" encoding="utf-8"?>
<DataManagementPackageHeader>
  <Name>$packageName</Name>
  <Description>Segregation of Duties rules generated by New-SodRulesPackage.ps1</Description>
  <Version>1.0</Version>
  <CreatedDateTime>$((Get-Date).ToString('yyyy-MM-ddTHH:mm:ss'))</CreatedDateTime>
  <RuntimeIDPrefix>$([guid]::NewGuid().ToString())</RuntimeIDPrefix>
</DataManagementPackageHeader>
"@
        [System.IO.File]::WriteAllText((Join-Path $workDir 'PackageHeader.xml'), $packageHeaderXml, [System.Text.Encoding]::UTF8)

        # Zip
        Write-Host "Creating zip..." -ForegroundColor Yellow
        if (Test-Path $outputZip) { Remove-Item $outputZip -Force }
        Compress-Archive -Path "$workDir\*" -DestinationPath $outputZip -CompressionLevel Optimal

        return @{ generated = $generated; skipped = $skipped }
    } finally {
        if (Test-Path $workDir) { Remove-Item $workDir -Recurse -Force }
    }
}

# ── Main ────────────────────────────────────────────────────────────────────

Write-Host '================================================================' -ForegroundColor Cyan
Write-Host '  D365FO SoD Rules Package Generator' -ForegroundColor Cyan
Write-Host '================================================================' -ForegroundColor Cyan
Write-Host "  Output:    $OutputZip"
Write-Host "  MCP:       $McpEndpoint"
Write-Host ''

$rules = $null
if ($PSCmdlet.ParameterSetName -eq 'Matrix') {
    Write-Host "  Source:    Matrix CSV -- $MatrixCsv"
    Write-Host ''
    $rules = ConvertFrom-SodMatrix -csvPath $MatrixCsv -endpoint $McpEndpoint -skipLookup:$SkipDutyLookup
} else {
    Write-Host "  Source:    Rules CSV -- $RulesCsv"
    Write-Host ''
    if (-not (Test-Path $RulesCsv)) { Write-Error "Rules CSV not found: $RulesCsv"; return }
    $rules = Import-Csv -Path $RulesCsv
}

if (-not $rules -or $rules.Count -eq 0) {
    Write-Error "No rules to generate."
    return
}

$result = New-SodPackage -rules $rules -outputZip $OutputZip -packageName $PackageName
$zipSize = (Get-Item $OutputZip).Length

Write-Host ''
Write-Host '================================================================' -ForegroundColor Green
Write-Host '  SoD Package Generated' -ForegroundColor Green
Write-Host '================================================================' -ForegroundColor Green
Write-Host "  Output:    $OutputZip"
Write-Host "  Size:      $([math]::Round($zipSize / 1KB, 1)) KB"
Write-Host "  Rules:     $($result.generated) generated, $($result.skipped) skipped"
Write-Host ''
Write-Host '  Upload to D365 F&O:' -ForegroundColor Cyan
Write-Host '    Workspaces -> Data management -> Import -> Upload package'
Write-Host ''
