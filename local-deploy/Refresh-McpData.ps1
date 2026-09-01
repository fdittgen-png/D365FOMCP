<#
.SYNOPSIS
    Refresh the local MCP XRef + KB databases for the models that were just compiled.

.DESCRIPTION
    The worker behind the post-compile trigger. Called (detached) by the MSBuild
    hook in Directory.Build.targets after a successful X++ project build, and
    usable by hand.

    Three behaviours matter more than the refresh itself:

      COALESCE   Building a solution fires the hook once per project. Each call
                 appends its model to a queue file and only the first one does
                 work, after a short debounce - so five projects produce one
                 refresh covering all five models.

      SERIALISE  A global mutex guarantees one writer. Two concurrent runs would
                 fight over the same 3.5 GB SQLite file.

      NEVER BLOCK  The hook launches this hidden and does not wait. If this
                 script ever runs synchronously inside MSBuild, Visual Studio
                 appears to hang for two minutes after every build, and the
                 hook gets deleted by whoever hits that first.

    The cross-reference database is resolved from the ACTIVE XPP configuration
    (HKCU:\...\AX7\Development\Configurations\CurrentMetadataConfig), never from
    .env. Six XRef_* databases from earlier platform versions sit in LocalDB and
    all look equally plausible; .env currently names one that is two versions old.

.PARAMETER Model
    Models to refresh, e.g. iExtension. Comes from $(Model) in the .rnrproj.

.PARAMETER NoWait
    Queue the model and return immediately without becoming the worker. Used by
    the MSBuild hook path; the detached worker is started separately.

.PARAMETER DebounceSeconds
    How long the worker waits for sibling projects before draining the queue.
    Default 20.

.PARAMETER SkipKb / .PARAMETER SkipXref
    Refresh only one of the two databases.

.PARAMETER Isv
    Also rescan the sealed-ISV models. OFF by default - those are vendor
    binaries that change on an ISV upgrade, not on an X++ compile. The weekly
    full pass is where this belongs.

.PARAMETER Force
    Ignore the per-module fingerprint and refresh even if nothing changed.

.EXAMPLE
    .\Refresh-McpData.ps1 -Model iExtension
    .\Refresh-McpData.ps1 -Model iExtension,HISOL -Force
    .\Refresh-McpData.ps1 -Model iExtension -SkipKb        # cross-references only
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string[]]$Model,
    [switch]$NoWait,
    [int]$DebounceSeconds = 20,
    [switch]$SkipKb,
    [switch]$SkipXref,
    [switch]$Isv,
    [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repo    = Split-Path $PSScriptRoot -Parent
$stateDir = Join-Path $env:LOCALAPPDATA 'D365FO-MCP'
$logDir   = Join-Path $stateDir 'logs'
$queue    = Join-Path $stateDir 'refresh-queue.txt'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$logFile = Join-Path $logDir ("refresh-{0}.log" -f (Get-Date -Format 'yyyy-MM'))
function Write-Log {
    param([string]$Message, [string]$Level = 'INFO')
    $line = "{0} [{1}] {2}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Level, $Message
    Add-Content -LiteralPath $logFile -Value $line -Encoding utf8
    if ($Level -eq 'ERROR') { Write-Host $line -ForegroundColor Red }
    elseif ($Level -eq 'WARN') { Write-Host $line -ForegroundColor Yellow }
    else { Write-Host $line }
}

# ── Queue the models ─────────────────────────────────────────────────────────
# Append-only and retried: several MSBuild processes can hit this at once.
foreach ($m in $Model) {
    for ($i = 0; $i -lt 20; $i++) {
        try { Add-Content -LiteralPath $queue -Value $m -Encoding utf8 -ErrorAction Stop; break }
        catch { Start-Sleep -Milliseconds 50 }
    }
}
if ($NoWait) { return }

# ── Become the single worker, or leave it to whoever already is ──────────────
$mutex = [System.Threading.Mutex]::new($false, 'Global\D365FO-MCP-Refresh')
$owned = $false
try { $owned = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $owned = $true }
if (-not $owned) {
    Write-Log "Another refresh is already running; models queued and left to it: $($Model -join ', ')"
    return
}

try {
    if ($DebounceSeconds -gt 0) { Start-Sleep -Seconds $DebounceSeconds }

    # Drain: take the union of everything queued while we waited.
    $pending = @()
    if (Test-Path $queue) {
        $pending = @(Get-Content -LiteralPath $queue -ErrorAction SilentlyContinue |
                     Where-Object { $_ -and $_.Trim() } | ForEach-Object { $_.Trim() } | Sort-Object -Unique)
        Remove-Item -LiteralPath $queue -Force -ErrorAction SilentlyContinue
    }
    if (-not $pending -or $pending.Count -eq 0) { $pending = @($Model | Sort-Object -Unique) }

    Write-Log "=== Refresh start: $($pending -join ', ') ==="

    # ── Resolve the ACTIVE configuration ─────────────────────────────────────
    $regPath = 'HKCU:\SOFTWARE\Microsoft\Dynamics\AX7\Development\Configurations'
    $cfgPath = (Get-ItemProperty -Path $regPath -ErrorAction SilentlyContinue).CurrentMetadataConfig
    if (-not $cfgPath -or -not (Test-Path $cfgPath)) {
        throw "No active XPP configuration (CurrentMetadataConfig under $regPath). Open Visual Studio > Dynamics 365 > Manage local XPP configurations and select one."
    }
    $cfg = Get-Content -LiteralPath $cfgPath -Raw | ConvertFrom-Json
    $xrefDb     = $cfg.CrossReferencesDatabaseName
    $xrefServer = $cfg.CrossReferencesDbServerName
    $modelStore = $cfg.ModelStoreFolder
    if (-not $xrefDb)     { throw "Active configuration $cfgPath names no CrossReferencesDatabaseName." }
    if (-not $modelStore) { throw "Active configuration $cfgPath names no ModelStoreFolder." }
    Write-Log "Config: $(Split-Path $cfgPath -Leaf) | xref=$xrefDb | modelStore=$modelStore"

    $kbDb   = if ($env:KB_DB_PATH)   { $env:KB_DB_PATH }   else { Join-Path $env:USERPROFILE '.claude\d365fo_kb.sqlite' }
    $xrefOut = if ($env:XREF_DB_PATH) { $env:XREF_DB_PATH } else { Join-Path $env:USERPROFILE '.claude\d365fo_xref.sqlite' }

    $failed = @()

    # ── XRef delta ───────────────────────────────────────────────────────────
    if (-not $SkipXref) {
        $args = @('build/update-xref-module.js') + $pending +
                @("--database=$xrefDb", "--server=$xrefServer", "--db=$xrefOut")
        if ($Force) { $args += '--force' }
        Write-Log "xref: node $($args -join ' ')"
        $out = & node @args 2>&1
        $out | ForEach-Object { Write-Log "  xref| $_" }
        if ($LASTEXITCODE -ne 0) { $failed += 'xref'; Write-Log "xref delta FAILED (exit $LASTEXITCODE)" 'ERROR' }
    }

    # ── KB delta ─────────────────────────────────────────────────────────────
    if (-not $SkipKb) {
        $args = @('build/update-kb-model.js') + $pending +
                @("--model-store=$modelStore", "--kb=$kbDb")
        if ($Isv) { $args += '--isv' }
        Write-Log "kb: node $($args -join ' ')"
        $out = & node @args 2>&1
        $out | ForEach-Object { Write-Log "  kb| $_" }
        if ($LASTEXITCODE -ne 0) { $failed += 'kb'; Write-Log "kb delta FAILED (exit $LASTEXITCODE)" 'ERROR' }
    }

    if ($failed.Count -gt 0) {
        Write-Log "=== Refresh finished WITH FAILURES: $($failed -join ', ') ===" 'ERROR'
        exit 1
    }
    Write-Log "=== Refresh complete ==="
}
catch {
    Write-Log "Refresh aborted: $($_.Exception.Message)" 'ERROR'
    exit 1
}
finally {
    if ($owned) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
