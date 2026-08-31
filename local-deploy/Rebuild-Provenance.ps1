<#
.SYNOPSIS
  Rebuild all three local MCP databases (KB, Sec, XRef) so they carry model
  build provenance (model_versions table, commits 2bae0a0 + 27a534f).

.DESCRIPTION
  Prepared 2026-08-13. Everything below was verified against this box:
    - Platform target:  10.0.2645.90 (10.0.2527.130 in the old .env no longer
                        exists; .env has been updated accordingly)
    - KB/Sec AOT roots: PackagesLocalDirectory 10.0.2645.90
                        + C:\Workspace\MAIN\Metadata (full custom-metadata root
                        per the production XPP configuration of 2026-08-13:
                        iExtension, HISOL, Lasernet, AMC Banking, Experlogix, ...)
                        (retargeted 2026-08-14 from the DEV roots)
    - XRef source:      LocalDB XRef_tis-d365fo-dev-02100264590
                        (6.09M names / 27.9M refs, verified populated)
    - Sec DMF input:    %USERPROFILE%\.claude\sec-dmf-new (export of 2026-06-10,
                        the complete package incl. 207 MB Permissions file).
                        Role/duty/privilege definitions come fresh from AOT;
                        user/role assignments are as of 2026-06-10.

  Approx. durations: KB ~10 min, Sec ~5-10 min, XRef ~30-60 min (27.9M refs).
  Local stdio MCP servers must be restarted afterwards to see the new DBs.
  Azure upload is a separate step (.\local-deploy\Deploy.ps1) — run it
  interactively (CA step-up can block agent-driven runs).

.EXAMPLE
  .\local-deploy\Rebuild-Provenance.ps1                 # all three
  .\local-deploy\Rebuild-Provenance.ps1 -SkipXref       # quick pass: KB + Sec
  .\local-deploy\Rebuild-Provenance.ps1 -VerifyOnly     # just re-run the checks
#>
param(
  [switch]$SkipKb,
  [switch]$SkipSec,
  [switch]$SkipXref,
  [switch]$VerifyOnly
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
Set-Location $repo

$pkgRoots  = "C:\Users\florian.dittgen\AppData\Local\Microsoft\Dynamics365\10.0.2645.90\PackagesLocalDirectory,C:\Workspace\MAIN\Metadata"
$dmfDir    = Join-Path $env:USERPROFILE ".claude\sec-dmf-new"
$kbDb      = Join-Path $env:USERPROFILE ".claude\d365fo_kb.sqlite"
$secDb     = Join-Path $env:USERPROFILE ".claude\d365fo_sec.sqlite"
$xrefDb    = Join-Path $env:USERPROFILE ".claude\d365fo_xref.sqlite"

function Step($name, [scriptblock]$body) {
  Write-Host "`n=== $name ===" -ForegroundColor Cyan
  $sw = [Diagnostics.Stopwatch]::StartNew()
  & $body
  Write-Host "=== $name done in $([int]$sw.Elapsed.TotalSeconds)s ===" -ForegroundColor Cyan
}

# ── Preflight ────────────────────────────────────────────────────────────────
Step "Preflight" {
  foreach ($p in $pkgRoots -split ',') {
    if (-not (Test-Path $p)) { throw "AOT root missing: $p" }
  }
  if (-not (Test-Path (Join-Path $dmfDir "System Security Role.xml"))) {
    throw "DMF input incomplete: $dmfDir"
  }
  $free = (Get-PSDrive C).Free / 1GB
  if ($free -lt 12) { throw ("Only {0:N1} GB free on C: - XRef build needs ~8 GB headroom" -f $free) }
  # .env sanity: the builds read XREF_DATABASE / KB_PACKAGES_PATHS from .env
  $envFile = Get-Content (Join-Path $repo ".env") -Raw
  if ($envFile -notmatch '02100264590') { throw ".env does not target XRef_tis-d365fo-dev-02100264590 - was it reverted?" }
  if ($envFile -notmatch '10\.0\.2645\.90') { throw ".env does not target platform 10.0.2645.90 - was it reverted?" }
  Write-Host ("OK - sources present, {0:N0} GB free" -f $free)
}

if (-not $VerifyOnly) {
  if (-not $SkipKb) {
    Step "KB rebuild (~10 min)" {
      npm run build:kb
      if ($LASTEXITCODE -ne 0) { throw "KB build failed (exit $LASTEXITCODE)" }
    }
  }
  if (-not $SkipSec) {
    Step "Sec rebuild (AOT + DMF 2026-06-10)" {
      node --env-file-if-exists=.env build/build-sec.js $pkgRoots $dmfDir
      if ($LASTEXITCODE -ne 0) { throw "Sec build failed (exit $LASTEXITCODE)" }
      Write-Host "Check the data-quality PASS/WARN block above: dutyPrivileges should be ~25k (NOT millions), 'labels resolved' should PASS (label-fix rebuild)."
    }
  }
  if (-not $SkipXref) {
    Step "XRef rebuild (~30-60 min, 27.9M refs)" {
      npm run build:xref
      if ($LASTEXITCODE -ne 0) { throw "XRef build failed (exit $LASTEXITCODE)" }
    }
  }
}

# ── Verify provenance landed in every DB ─────────────────────────────────────
Step "Verify model_versions" {
  $dbs = @{}
  if (-not $SkipKb)   { $dbs.kb = $kbDb }
  if (-not $SkipSec)  { $dbs.sec = $secDb }
  if (-not $SkipXref) { $dbs.xref = $xrefDb }
  if ($VerifyOnly) { $dbs = @{ kb = $kbDb; sec = $secDb; xref = $xrefDb } }
  $env:VERIFY_DBS = ($dbs | ConvertTo-Json -Compress)
  node (Join-Path $PSScriptRoot "verify-model-versions.cjs")
  if ($LASTEXITCODE -ne 0) { throw "Provenance verification FAILED - see output above" }
  Write-Host "All rebuilt databases carry model_versions." -ForegroundColor Green
}

Write-Host @"

Next steps:
  1. Restart the local stdio MCP servers (reload MCP connections in Claude)
     and check d365_list_modules / sec_stats / xref_list_modules show versions.
  2. Azure upload (run INTERACTIVELY - CA step-up blocks agents):
       .\local-deploy\Deploy.ps1 -SkipCode
     then verify via direct HTTP POST against the Function App, NOT via the
     local stdio MCP tools (they read the local DBs - known verification trap).
"@ -ForegroundColor Yellow
