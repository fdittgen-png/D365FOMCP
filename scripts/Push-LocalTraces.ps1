<#
.SYNOPSIS
  Upload the local trace file sinks to the ingest Function (ERP-Trace-Capture-TDD WI-13).

.DESCRIPTION
  The stdio MCP servers write Stream-1 call records to ~/.claude/mcp-trace/<service>.ndjson and
  never talk to the network; the plugin hook writes hook.ndjson AND posts live. This script posts
  every *.ndjson in the trace directory (probe.ndjson excluded) to POST <url>/trace/ingest in
  batches of 100, using the url/key of ~/.claude/claude-trace.config.json. The sink is idempotent
  by record id, so re-pushing hook.ndjson (records from before the sink existed) is safe.

  A file is renamed to <name>.<yyyyMMdd-HHmmss>.sent only when EVERY batch answered 200 or 207;
  on a 4xx/5xx or a network error the file stays and the script exits non-zero. Dead letters
  (207) are printed as id / reason / field so the producer defect can be found. Corrupt lines
  are skipped and counted, never sent.

.EXAMPLE
  pwsh -File scripts/Push-LocalTraces.ps1
  pwsh -File scripts/Push-LocalTraces.ps1 -DryRun
#>
[CmdletBinding()]
param(
    [string] $ConfigPath = (Join-Path $HOME '.claude\claude-trace.config.json'),
    [string] $TraceDir = (Join-Path $HOME '.claude\mcp-trace'),
    [int] $BatchSize = 100,
    [switch] $DryRun
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not (Test-Path $ConfigPath)) { Write-Error "No trace config at $ConfigPath (run the ClaudeTrace Deploy.ps1 once)"; exit 2 }
$cfg = Get-Content $ConfigPath -Raw | ConvertFrom-Json
if (-not $cfg.url -or -not $cfg.key) { Write-Error "Config $ConfigPath has no url/key"; exit 2 }
$route = if ($cfg.PSObject.Properties['ingest_route']) { $cfg.ingest_route } else { '/trace/ingest' }
$uri = "$($cfg.url.TrimEnd('/'))$route"

$files = @(Get-ChildItem -Path $TraceDir -Filter '*.ndjson' -File | Where-Object { $_.Name -ne 'probe.ndjson' })
if ($files.Count -eq 0) { Write-Host "Nothing to push in $TraceDir"; exit 0 }

$leftBehind = 0
foreach ($f in $files) {
    $lines = @(Get-Content $f.FullName -Encoding utf8 | Where-Object { $_.Trim() })
    $records = New-Object System.Collections.Generic.List[object]
    $corrupt = 0
    foreach ($l in $lines) {
        try { $records.Add(($l | ConvertFrom-Json -Depth 32)) } catch { $corrupt++ }
    }
    Write-Host ("{0}: {1} records ({2} corrupt lines skipped)" -f $f.Name, $records.Count, $corrupt)
    if ($records.Count -eq 0) { continue }
    if ($DryRun) { continue }

    $ok = $true; $accepted = 0; $dead = @()
    for ($i = 0; $i -lt $records.Count; $i += $BatchSize) {
        $end = [Math]::Min($i + $BatchSize, $records.Count) - 1
        $batch = @($records[$i..$end])
        $body = ConvertTo-Json -InputObject $batch -Depth 32 -Compress
        try {
            $res = Invoke-WebRequest -Method Post -Uri $uri -Headers @{ 'x-functions-key' = $cfg.key } `
                -ContentType 'application/json' -Body ([System.Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 60 -SkipHttpErrorCheck
        } catch {
            Write-Warning ("{0}: batch {1}: {2}" -f $f.Name, ($i / $BatchSize + 1), $_.Exception.Message); $ok = $false; break
        }
        if ($res.StatusCode -notin 200, 207) {
            Write-Warning ("{0}: batch {1}: HTTP {2} — file left in place" -f $f.Name, ($i / $BatchSize + 1), $res.StatusCode); $ok = $false; break
        }
        $j = $res.Content | ConvertFrom-Json
        $accepted += $j.accepted
        if ($j.dead_lettered) { $dead += @($j.dead_lettered) }
    }
    if ($ok) {
        $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
        $sent = "$($f.FullName).$stamp.sent"
        Rename-Item -Path $f.FullName -NewName (Split-Path $sent -Leaf)
        Write-Host ("{0}: accepted {1}, dead-lettered {2} -> {3}" -f $f.Name, $accepted, $dead.Count, (Split-Path $sent -Leaf))
        foreach ($d in $dead) { Write-Host ("  dead letter {0} {1} {2}" -f $d.id, $d.reason, $d.field) }
    } else { $leftBehind++ }
}
if ($leftBehind -gt 0) { exit 1 }
