<#
.SYNOPSIS
    Build the distributable skills package (zip) for the D365FO MCP services.

.DESCRIPTION
    Packages the plugin's skills into a single zip that a user can unpack into
    ~/.claude/skills (or a project's .claude/skills) without cloning the repo
    or installing the plugin marketplace.

    The zip layout is:

        d365fo-mcp-skills.zip
        ├── README.md            <- docs/KB-XRef-Usage-Guide.md (usage + install)
        ├── MANIFEST.json        <- version, build date, skill inventory
        ├── skills/              <- one folder per skill; copy these into ~/.claude/skills
        │   ├── d365fo-mcp-tooling/
        │   └── ...
        └── commands/            <- only with -IncludeCommands

    Every skill folder is validated before packing: SKILL.md must exist, carry
    YAML frontmatter, and its `name:` must equal the folder name — the same
    rules test/plugin.test.js enforces, so a broken skill never ships.

    Rebuild after changing any skill, and after `npm run gen:plugin-refs`
    (the generated references/*-tools.md live inside d365fo-mcp-tooling).

.PARAMETER SkillsPath
    Source skills folder. Default: plugin/d365fo-mcp/skills.

.PARAMETER OutFile
    Output zip path. Default: dist/d365fo-mcp-skills.zip.

.PARAMETER IncludeCommands
    Also pack plugin/d365fo-mcp/commands into commands/ inside the zip, for
    users who install skills manually but still want the slash commands
    (they go to ~/.claude/commands).

.EXAMPLE
    .\scripts\Build-SkillsPackage.ps1
    Builds dist/d365fo-mcp-skills.zip with the 8 skills.

.EXAMPLE
    .\scripts\Build-SkillsPackage.ps1 -IncludeCommands
    Same, plus the 19 slash commands.
#>
[CmdletBinding()]
param(
    [string] $SkillsPath = (Join-Path $PSScriptRoot '..\plugin\d365fo-mcp\skills'),
    [string] $OutFile    = (Join-Path $PSScriptRoot '..\dist\d365fo-mcp-skills.zip'),
    [switch] $IncludeCommands
)

$ErrorActionPreference = 'Stop'

$repoRoot     = Resolve-Path (Join-Path $PSScriptRoot '..')
$SkillsPath   = Resolve-Path $SkillsPath
$commandsPath = Join-Path $repoRoot 'plugin\d365fo-mcp\commands'
$guidePath    = Join-Path $repoRoot 'docs\KB-XRef-Usage-Guide.md'
$pluginJson   = Join-Path $repoRoot 'plugin\d365fo-mcp\.claude-plugin\plugin.json'

$version = (Get-Content $pluginJson -Raw | ConvertFrom-Json).version
if (-not $version) { throw "No version in $pluginJson" }

# --- validate every skill (same rules as test/plugin.test.js) -----------------
$skills = @()
foreach ($dir in Get-ChildItem -Path $SkillsPath -Directory | Sort-Object Name) {
    $skillMd = Join-Path $dir.FullName 'SKILL.md'
    if (-not (Test-Path $skillMd)) { throw "$($dir.Name): SKILL.md missing" }

    $text = Get-Content $skillMd -Raw
    if ($text -notmatch '(?s)^---\r?\n(.*?)\r?\n---') { throw "$($dir.Name)/SKILL.md: no YAML frontmatter" }
    $fm = $Matches[1]

    if ($fm -notmatch '(?m)^name:\s*(.+?)\s*$') { throw "$($dir.Name)/SKILL.md: no name in frontmatter" }
    $name = $Matches[1].Trim()
    if ($name -ne $dir.Name) { throw "$($dir.Name)/SKILL.md: frontmatter name '$name' != folder name" }

    if ($fm -notmatch '(?m)^description:\s*(.+?)\s*$') { throw "$($dir.Name)/SKILL.md: no description in frontmatter" }
    $description = $Matches[1].Trim()

    $files = Get-ChildItem -Path $dir.FullName -Recurse -File
    $skills += [pscustomobject]@{
        name        = $name
        description = $description
        files       = $files.Count
        bytes       = ($files | Measure-Object -Property Length -Sum).Sum
    }
}
if ($skills.Count -eq 0) { throw "No skills found in $SkillsPath" }

# --- stage -------------------------------------------------------------------
$stage = Join-Path ([System.IO.Path]::GetTempPath()) ("d365fo-skills-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage | Out-Null
try {
    Copy-Item -Path $SkillsPath -Destination (Join-Path $stage 'skills') -Recurse

    if (Test-Path $guidePath) {
        Copy-Item -Path $guidePath -Destination (Join-Path $stage 'README.md')
    } else {
        Write-Warning "docs/KB-XRef-Usage-Guide.md not found — packing without README.md"
    }

    if ($IncludeCommands) {
        if (-not (Test-Path $commandsPath)) { throw "commands folder not found: $commandsPath" }
        Copy-Item -Path $commandsPath -Destination (Join-Path $stage 'commands') -Recurse
    }

    [pscustomobject]@{
        package        = 'd365fo-mcp-skills'
        version        = $version
        built          = (Get-Date).ToString('yyyy-MM-dd')
        source         = 'https://github.com/fdittgen-png/D365FOMCP (plugin/d365fo-mcp)'
        install        = 'Copy skills/* into ~/.claude/skills (user-wide) or <project>/.claude/skills — see README.md'
        includesCommands = [bool]$IncludeCommands
        skills         = $skills
    } | ConvertTo-Json -Depth 5 | Set-Content -Path (Join-Path $stage 'MANIFEST.json') -Encoding utf8

    # --- pack ----------------------------------------------------------------
    $outDir = Split-Path -Parent $OutFile
    if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir -Force | Out-Null }
    if (Test-Path $OutFile) { Remove-Item $OutFile -Force }

    Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $OutFile -CompressionLevel Optimal
}
finally {
    Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
}

$zip = Get-Item $OutFile
Write-Host ""
Write-Host "Built $($zip.FullName)" -ForegroundColor Green
Write-Host ("  version : {0}" -f $version)
Write-Host ("  skills  : {0} ({1} files)" -f $skills.Count, ($skills | Measure-Object -Property files -Sum).Sum)
Write-Host ("  size    : {0:N0} KB" -f ($zip.Length / 1KB))
Write-Host ("  sha256  : {0}" -f (Get-FileHash $zip.FullName -Algorithm SHA256).Hash)
Write-Host ""
$skills | Format-Table name, files, @{ n = 'KB'; e = { '{0:N0}' -f ($_.bytes / 1KB) } } -AutoSize
