<#
.SYNOPSIS
    Weekly: full KB + XRef rebuild, then publish to the Azure Function App.

.DESCRIPTION
    The other half of the post-compile design. Refresh-McpData.ps1 keeps the
    LOCAL databases current after every compile; this script keeps the SHARED
    Azure copy current on a schedule, and is the run that makes the local
    databases CORRECT again.

    Why a full rebuild and not an accumulation of deltas:

      * mergeCustomKb() is ADDITIVE. It upserts and never deletes, so an object
        a developer removed from a model lingers in the KB and every delta
        compounds the drift. Only a full rebuild reconciles it.
      * The ISV tables are refreshed here rather than per compile. Sealed models
        are vendor binaries - they change when Lasernet or AMC Banking is
        upgraded, not when someone compiles iExtension.
      * A 3.5 GB upload per compile is indefensible; per week is fine.

    Composes the scripts that already exist rather than re-implementing them:
    Rebuild-Provenance.ps1 for the builds, Deploy.ps1 for the snapshot + upload.

    Security is deliberately out of scope - it is fed by a DMF export on its own
    cadence (see docs/Sec-DMF-Export-Runbook.md).

.PARAMETER SkipRebuild
    Publish whatever is on disk. Use after a rebuild you already ran by hand.

.PARAMETER SkipPublish
    Rebuild locally only - no Azure calls, no credentials needed.

.PARAMETER Environment
    'd' or 'p'. Passed through to Deploy.ps1. Default: Deploy.ps1's own default.

.EXAMPLE
    .\Publish-McpDataWeekly.ps1
    .\Publish-McpDataWeekly.ps1 -SkipRebuild          # upload only
    .\Publish-McpDataWeekly.ps1 -SkipPublish          # rebuild only

.NOTES
    SCHEDULING. Register as a Windows scheduled task, e.g.:

      $a = New-ScheduledTaskAction -Execute 'powershell.exe' `
             -Argument '-NoProfile -ExecutionPolicy Bypass -File "C:\working\MCP\local-deploy\Publish-McpDataWeekly.ps1"'
      $t = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At 3am
      Register-ScheduledTask -TaskName 'D365FO MCP weekly publish' -Action $a -Trigger $t `
             -Description 'Full KB+XRef rebuild and Azure publish'

    CONDITIONAL ACCESS. The Azure half can hit an acrs=p1 step-up challenge that
    an unattended task cannot answer. It is the ROLE ASSIGNMENT step that
    normally triggers it, which is why -SkipRoles is passed below. If a
    scheduled run still fails on AADSTS claims, run the publish half
    interactively and leave the rebuild on the schedule (-SkipPublish).
#>
[CmdletBinding()]
param(
    [switch]$SkipRebuild,
    [switch]$SkipPublish,
    [ValidateSet('d', 'p', '')]
    [string]$Environment = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repo   = Split-Path $PSScriptRoot -Parent
$logDir = Join-Path $env:LOCALAPPDATA 'D365FO-MCP\logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logFile = Join-Path $logDir ("weekly-{0}.log" -f (Get-Date -Format 'yyyy-MM'))

function Write-Log {
    param([string]$Message, [string]$Level = 'INFO')
    $line = "{0} [{1}] {2}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Level, $Message
    Add-Content -LiteralPath $logFile -Value $line -Encoding utf8
    if ($Level -eq 'ERROR') { Write-Host $line -ForegroundColor Red }
    elseif ($Level -eq 'WARN') { Write-Host $line -ForegroundColor Yellow }
    else { Write-Host $line -ForegroundColor Cyan }
}

$started = Get-Date
Write-Log "=== Weekly publish start ==="

# One writer at a time: a compile-triggered delta must not run against a
# database this script is rebuilding underneath it.
$mutex = [System.Threading.Mutex]::new($false, 'Global\D365FO-MCP-Refresh')
$owned = $false
try { $owned = $mutex.WaitOne([TimeSpan]::FromMinutes(10)) }
catch [System.Threading.AbandonedMutexException] { $owned = $true }
if (-not $owned) {
    Write-Log 'A refresh has held the lock for 10 minutes; aborting rather than racing it.' 'ERROR'
    exit 1
}

try {
    # ── 1. Rebuild locally ───────────────────────────────────────────────────
    if (-not $SkipRebuild) {
        if (-not $env:ISV_SCAN_PATHS) {
            Write-Log 'ISV_SCAN_PATHS is not set — the isv_* tables will NOT be refreshed by this run. Set it in .env to include the sealed-ISV models.' 'WARN'
        }

        $rebuild = Join-Path $PSScriptRoot 'Rebuild-Provenance.ps1'
        if (-not (Test-Path $rebuild)) { throw "Rebuild-Provenance.ps1 not found next to this script." }

        Write-Log 'Rebuilding KB + XRef (Security is out of scope — it is fed by a DMF export)...'
        & $rebuild -SkipSec
        if ($LASTEXITCODE -ne 0) { throw "Rebuild-Provenance.ps1 exited $LASTEXITCODE." }

        # The XRef builder recreates the file, so xref_module_sync is gone with
        # it. That is correct: the next compile-triggered delta finds no stored
        # fingerprint and re-syncs once. Said out loud because a fingerprint
        # table that silently vanishes is exactly the kind of thing that looks
        # like a bug six months from now.
        Write-Log 'Rebuild complete. Per-module fingerprints reset with the new XRef file (expected).'
    }
    else {
        Write-Log 'Rebuild skipped — publishing whatever is on disk.'
    }

    # ── 2. Publish to Azure ──────────────────────────────────────────────────
    if (-not $SkipPublish) {
        $deploy = Join-Path $PSScriptRoot 'Deploy.ps1'
        if (-not (Test-Path $deploy)) { throw "Deploy.ps1 not found next to this script." }

        # -SkipCode: this is a DATA publish. Code ships on its own cadence.
        # -SkipRoles: role assignment is the usual Conditional Access step-up
        #             trigger and an unattended task cannot answer one.
        $deployArgs = @('-SkipCode', '-SkipRoles', '-Databases', 'kb', 'xref')
        if ($Environment) { $deployArgs += @('-Environment', $Environment) }

        Write-Log "Publishing: Deploy.ps1 $($deployArgs -join ' ')"
        & $deploy @deployArgs
        if ($LASTEXITCODE -ne 0) { throw "Deploy.ps1 exited $LASTEXITCODE." }
        Write-Log 'Publish complete.'
    }
    else {
        Write-Log 'Publish skipped — local rebuild only.'
    }

    Write-Log ("=== Weekly publish complete in {0:n1} min ===" -f ((Get-Date) - $started).TotalMinutes)
}
catch {
    Write-Log "Weekly publish FAILED: $($_.Exception.Message)" 'ERROR'
    if ($_.Exception.Message -match 'AADSTS|claims|Conditional') {
        Write-Log 'This looks like a Conditional Access step-up. Run the publish half interactively: .\Publish-McpDataWeekly.ps1 -SkipRebuild' 'WARN'
    }
    exit 1
}
finally {
    if ($owned) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
