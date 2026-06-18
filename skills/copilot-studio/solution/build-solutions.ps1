<#
.SYNOPSIS
  Builds two importable Power Platform (Dataverse) unmanaged solution zips for Copilot Studio:
    1. D365FO-MCP-Connectors  — the 4 MCP custom connectors (import FIRST)
    2. D365FO-Governance-Agent — the agent (bot + Custom GPT instructions, all 17 skill workflows baked in)

.DESCRIPTION
  Self-contained: regenerates every solution file from scratch into .\build\ then zips to .\dist\.
  Inputs it reads:
    - ..\connectors\*.swagger.json   (the 4 MCP connector OpenAPI 2.0 definitions)
    - .\AGENT-INSTRUCTIONS.md        (the baked system instructions -> Custom GPT YAML)

  IMPORTANT — read IMPORT-README.md first. The connector solution uses the standard,
  well-established structure. The agent (bot/botcomponent) serialization is best-effort:
  the bot RootComponent type and customizations.xml wrappers are reconstructed from the
  Dataverse column model (no public XSD). If the agent zip is rejected on import, use the
  guaranteed fallback in IMPORT-README.md (create agent in UI + paste AGENT-INSTRUCTIONS.md).

.NOTES
  Zips are written with files at the ROOT of the archive (no top-level folder), as the
  Dataverse import engine requires.
#>

[CmdletBinding()]
param(
    [string]$Host_       = "tis-d-mcpd365fo-func.azurewebsites.net",  # dev MCP host
    [string]$Prefix      = "tisd",                                    # publisher customization prefix
    [string]$PublisherUniqueName = "trelleborgtisd",
    [string]$PublisherName       = "Trelleborg TIS D365",
    [string]$Version     = "1.0.0.0",
    [bool]$IncludeAgent = $true  # build the agent solution (real-export bots/ + botcomponents/ layout)
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.IO.Compression.FileSystem

$Root        = $PSScriptRoot
$ConnectorsSrc = Join-Path $Root "..\connectors"
$InstructionsFile = Join-Path $Root "AGENT-INSTRUCTIONS.md"
$BuildRoot   = Join-Path $Root "build"
$DistRoot    = Join-Path $Root "dist"

# Clean
foreach ($d in @($BuildRoot, $DistRoot)) {
    if (Test-Path $d) { Remove-Item $d -Recurse -Force }
    New-Item -ItemType Directory -Path $d -Force | Out-Null
}

# ---- helpers --------------------------------------------------------------

function XmlEscape([string]$s) {
    return $s.Replace('&','&amp;').Replace('<','&lt;').Replace('>','&gt;')
}

# Deterministic GUID from a string (MD5 -> 16 bytes -> GUID), so re-runs are stable
# and the RootComponent id always matches the <Connector> connectorid.
function GuidFromString([string]$s) {
    $md5 = [System.Security.Cryptography.MD5]::Create()
    try {
        $bytes = $md5.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($s))
        return ([guid]::new($bytes)).ToString()
    } finally { $md5.Dispose() }
}

function Write-Utf8([string]$path, [string]$content) {
    $dir = Split-Path $path -Parent
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    # UTF-8 WITHOUT BOM (Dataverse import dislikes a BOM on these files)
    $enc = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($path, $content, $enc)
}

function ContentTypesXml {
@'
<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="xml" ContentType="text/xml" />
  <Default Extension="json" ContentType="application/json" />
  <Default Extension="png" ContentType="image/png" />
  <Default Extension="gif" ContentType="image/gif" />
</Types>
'@
}

function PublisherBlock {
@"
    <Publisher>
      <UniqueName>$PublisherUniqueName</UniqueName>
      <LocalizedNames>
        <LocalizedName description="$PublisherName" languagecode="1033" />
      </LocalizedNames>
      <Descriptions />
      <EMailAddress xsi:nil="true" />
      <SupportingWebsiteUrl xsi:nil="true" />
      <CustomizationPrefix>$Prefix</CustomizationPrefix>
      <CustomizationOptionValuePrefix>10000</CustomizationOptionValuePrefix>
      <Addresses />
    </Publisher>
"@
}

function ZipDir([string]$srcDir, [string]$zipPath) {
    if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
    # includeBaseDirectory = $false -> files land at the zip root (required by Dataverse)
    [System.IO.Compression.ZipFile]::CreateFromDirectory(
        $srcDir, $zipPath,
        [System.IO.Compression.CompressionLevel]::Optimal, $false)
}

# The 4 MCP services. operationId InvokeServer + mcp-streamable protocol come from the swaggers.
# NOTE: <displayname> (disp) is validated as the connector name on import and must match
# ^[A-Za-z0-9][A-Za-z0-9_-]*$ — no spaces, parens, or (empirically) hyphens for MCP connectors.
# Keep it a bare alphanumeric token; the descriptive text goes in <description> (free text, OK).
$services = @(
    @{ key="d365kb";          disp="D365KB";          path="/api/d365kb";          title="D365 KB (Metadata)";          swagger="d365kb.swagger.json" },
    @{ key="d365xref";        disp="D365XRef";        path="/api/d365xref";        title="D365 XRef (Cross-reference)"; swagger="d365xref.swagger.json" },
    @{ key="d365sec";         disp="D365Security";    path="/api/d365sec";         title="D365 Security";               swagger="d365sec.swagger.json" },
    @{ key="d365taskrecorder";disp="D365TaskRecorder";path="/api/d365taskrecorder";title="D365 Task Recorder";          swagger="d365taskrecorder.swagger.json" }
)

# ==========================================================================
#  SOLUTION 1 — CONNECTORS
# ==========================================================================
Write-Host "Building connectors solution..." -ForegroundColor Cyan
$connBuild = Join-Path $BuildRoot "connectors"
New-Item -ItemType Directory -Path $connBuild -Force | Out-Null

Write-Utf8 (Join-Path $connBuild "[Content_Types].xml") (ContentTypesXml)

# Per real exported solutions (e.g. microsoft/iom-provider-shopify): each custom connector
# needs BOTH a <RootComponent type="372" id="{guid}" schemaName="..."> in solution.xml AND a
# matching <Connector> node in customizations.xml, with files in a SINGULAR Connector/ folder
# named <name>_openapidefinition.json (the swagger) + <name>_connectionparameters.json.
$connRootComponents = ""
$connectorNodes = ""
foreach ($s in $services) {
    $schema = "$($Prefix)_$($s.key)"
    $guid   = GuidFromString $schema    # stable; matches on both sides

    $connRootComponents += "      <RootComponent type=`"372`" id=`"{$guid}`" schemaName=`"$schema`" behavior=`"0`" />`n"

    # swagger -> <name>_openapidefinition.json ; anonymous connector -> empty connection params
    $swaggerSrc = Join-Path $ConnectorsSrc $s.swagger
    if (-not (Test-Path $swaggerSrc)) { throw "Missing swagger: $swaggerSrc" }
    $swaggerObj = (Get-Content $swaggerSrc -Raw) | ConvertFrom-Json
    # The connector NAME is validated from info.title against ^[A-Za-z0-9][A-Za-z0-9_-]*$.
    # MCP/agentic registration rejects hyphens here (and any space/paren), so use a bare
    # alphanumeric token (the service key). The friendly label lives in <displayname>.
    $swaggerObj.info.title = $s.key
    $swaggerOut = $swaggerObj | ConvertTo-Json -Depth 50
    $connFolder = Join-Path $connBuild "Connector"
    Write-Utf8 (Join-Path $connFolder "$($schema)_openapidefinition.json") $swaggerOut
    Write-Utf8 (Join-Path $connFolder "$($schema)_connectionparameters.json") "{}"

    $desc = XmlEscape $s.title
    $connectorNodes += @"
    <Connector>
      <connectorid>$guid</connectorid>
      <description>$desc MCP (streamable) connector.</description>
      <displayname>$($s.disp)</displayname>
      <iconbrandcolor>#1F3864</iconbrandcolor>
      <name>$schema</name>
      <connectortype>1</connectortype>
      <openapidefinition>/Connector/$($schema)_openapidefinition.json</openapidefinition>
      <connectionparameters>/Connector/$($schema)_connectionparameters.json</connectionparameters>
    </Connector>

"@
}

$connSolutionXml = @"
<?xml version="1.0" encoding="utf-8"?>
<ImportExportXml version="9.2.25000.000" SolutionPackageVersion="9.2" languagecode="1033" generatedBy="CrmLive" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <SolutionManifest>
    <UniqueName>D365FOMCPConnectors</UniqueName>
    <LocalizedNames>
      <LocalizedName description="D365FO MCP Connectors" languagecode="1033" />
    </LocalizedNames>
    <Descriptions>
      <Description description="MCP (streamable) custom connectors for the four D365FO governance services: KB, XRef, Security, Task Recorder." languagecode="1033" />
    </Descriptions>
    <Version>$Version</Version>
    <Managed>0</Managed>
$(PublisherBlock)
    <RootComponents>
$connRootComponents    </RootComponents>
    <MissingDependencies />
  </SolutionManifest>
</ImportExportXml>
"@
Write-Utf8 (Join-Path $connBuild "solution.xml") $connSolutionXml

# customizations.xml DEFINES each connector (sibling order: ...CustomControls, EntityDataProviders,
# Connectors, Languages — matching a real export). Without these <Connector> nodes the import fails
# with "Cannot add a Root Component ... of type 372 because it is not in the target system".
Write-Utf8 (Join-Path $connBuild "customizations.xml") @"
<?xml version="1.0" encoding="utf-8"?>
<ImportExportXml xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <Entities />
  <Roles />
  <Workflows />
  <FieldSecurityProfiles />
  <Templates />
  <EntityMaps />
  <EntityRelationships />
  <OrganizationSettings />
  <optionsets />
  <CustomControls />
  <EntityDataProviders />
  <Connectors>
$connectorNodes  </Connectors>
  <Languages>
    <Language>1033</Language>
  </Languages>
</ImportExportXml>
"@

$connZip = Join-Path $DistRoot "D365FO-MCP-Connectors_$($Version.Replace('.','_')).zip"
ZipDir $connBuild $connZip
Write-Host "  -> $connZip" -ForegroundColor Green

# ==========================================================================
#  SOLUTION 2 — AGENT  (modern Copilot Studio export layout)
#  The bot is NOT in customizations.xml. It lives in bots/<schema>/bot.xml +
#  configuration.json, and each botcomponent in botcomponents/<schema>/ as
#  botcomponent.xml + a payload file named `data`. schemaname is an ATTRIBUTE.
#  RootComponents is empty (minimal single-agent export). Templated from a real
#  2026 export (darsoohoo/intake-bot). See IMPORT-README.md.
# ==========================================================================
if ($IncludeAgent) {
Write-Host "Building agent solution (real-export layout: bots/ + botcomponents/)..." -ForegroundColor Cyan
$agentBuild  = Join-Path $BuildRoot "agent"
$botSchema   = "$($Prefix)_D365FOGovernanceAgent"
$gptSchema   = "$botSchema.gpt.default"
$topicSchema = "$botSchema.topic.ConversationStart"
New-Item -ItemType Directory -Path $agentBuild -Force | Out-Null

# instructions: strip the markdown header above the first '---' rule
$rawInstr = Get-Content $InstructionsFile -Raw
$marker = "`n---`n"
$idx = $rawInstr.IndexOf($marker)
if ($idx -ge 0) { $instr = $rawInstr.Substring($idx + $marker.Length).Trim() } else { $instr = $rawInstr.Trim() }
# YAML literal block scalar, 2-space indent (for the Custom GPT `data` file)
$instrYaml = ($instr -split "`r?`n" | ForEach-Object { if ($_ -eq "") { "" } else { "  $_" } }) -join "`n"

# --- [Content_Types].xml: Default xml/json + an Override for every extensionless `data` part ---
Write-Utf8 (Join-Path $agentBuild "[Content_Types].xml") @"
<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="xml" ContentType="application/octet-stream" />
  <Default Extension="json" ContentType="application/octet-stream" />
  <Override PartName="/botcomponents/$gptSchema/data" ContentType="application/octet-stream" />
  <Override PartName="/botcomponents/$topicSchema/data" ContentType="application/octet-stream" />
</Types>
"@

# --- solution.xml: RootComponents EMPTY (the bots/ + botcomponents/ folders are the content source) ---
Write-Utf8 (Join-Path $agentBuild "solution.xml") @"
<?xml version="1.0" encoding="utf-8"?>
<ImportExportXml version="9.2.25000.000" SolutionPackageVersion="9.2" languagecode="1033" generatedBy="CrmLive" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <SolutionManifest>
    <UniqueName>D365FOGovernanceAgent</UniqueName>
    <LocalizedNames>
      <LocalizedName description="D365FO Governance Agent" languagecode="1033" />
    </LocalizedNames>
    <Descriptions>
      <Description description="Copilot Studio agent for D365FO governance with skill workflows baked into the instructions." languagecode="1033" />
    </Descriptions>
    <Version>$Version</Version>
    <Managed>0</Managed>
$(PublisherBlock)
    <RootComponents />
    <MissingDependencies />
  </SolutionManifest>
</ImportExportXml>
"@

# --- customizations.xml: minimal (the bot is deliberately NOT here) ---
Write-Utf8 (Join-Path $agentBuild "customizations.xml") @'
<?xml version="1.0" encoding="utf-8"?>
<ImportExportXml xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <Entities />
  <Roles />
  <Workflows />
  <FieldSecurityProfiles />
  <Templates />
  <EntityMaps />
  <EntityRelationships />
  <OrganizationSettings />
  <optionsets />
  <CustomControls />
  <Languages>
    <Language>1033</Language>
  </Languages>
</ImportExportXml>
'@

# --- bots/<bot>/bot.xml  (schemaname is an ATTRIBUTE — this is what the failed import was missing) ---
Write-Utf8 (Join-Path $agentBuild "bots\$botSchema\bot.xml") @"
<bot schemaname="$botSchema">
  <authenticationmode>2</authenticationmode>
  <authenticationtrigger>1</authenticationtrigger>
  <iscustomizable>0</iscustomizable>
  <language>1033</language>
  <name>D365FO Governance Assistant</name>
  <runtimeprovider>0</runtimeprovider>
  <template>default-2.1.0</template>
  <timezoneruleversionnumber>4</timezoneruleversionnumber>
</bot>
"@

# --- bots/<bot>/configuration.json  (built as an object so $instr is safely JSON-escaped) ---
$config = [ordered]@{
  '$kind'            = 'BotConfiguration'
  settings           = [ordered]@{ GenerativeActionsEnabled = $true }
  isAgentConnectable = $true
  gPTSettings        = [ordered]@{ '$kind' = 'GPTSettings'; defaultSchemaName = $gptSchema }
  aISettings         = [ordered]@{ '$kind' = 'AISettings'; useModelKnowledge = $true; isFileAnalysisEnabled = $true; isSemanticSearchEnabled = $true; optInUseLatestModels = $false }
  recognizer         = [ordered]@{ '$kind' = 'GenerativeAIRecognizer' }
  agentSettings      = [ordered]@{ '$kind' = 'AgentSettings'; instructions = [ordered]@{ '$kind' = 'Instructions'; segments = @( [ordered]@{ '$kind' = 'StaticSegment'; value = $instr } ) } }
}
Write-Utf8 (Join-Path $agentBuild "bots\$botSchema\configuration.json") ($config | ConvertTo-Json -Depth 20)

# --- botcomponents/<gpt>/  : the Custom GPT (componenttype 15) + its instructions YAML ---
Write-Utf8 (Join-Path $agentBuild "botcomponents\$gptSchema\botcomponent.xml") @"
<botcomponent schemaname="$gptSchema">
  <componenttype>15</componenttype>
  <iscustomizable>0</iscustomizable>
  <name>D365FO Governance Assistant</name>
  <parentbotid>
    <schemaname>$botSchema</schemaname>
  </parentbotid>
  <statecode>0</statecode>
  <statuscode>1</statuscode>
</botcomponent>
"@
Write-Utf8 (Join-Path $agentBuild "botcomponents\$gptSchema\data") @"
kind: GptComponentMetadata
instructions: |-
$instrYaml
"@

# --- botcomponents/<topic>/ : the ConversationStart system topic (componenttype 9), verbatim shape ---
Write-Utf8 (Join-Path $agentBuild "botcomponents\$topicSchema\botcomponent.xml") @"
<botcomponent schemaname="$topicSchema">
  <componenttype>9</componenttype>
  <description>This system topic triggers when the agent receives an Activity indicating the beginning of a new conversation.</description>
  <iscustomizable>0</iscustomizable>
  <name>Conversation Start</name>
  <parentbotid>
    <schemaname>$botSchema</schemaname>
  </parentbotid>
  <statecode>0</statecode>
  <statuscode>1</statuscode>
</botcomponent>
"@
Write-Utf8 (Join-Path $agentBuild "botcomponents\$topicSchema\data") @'
kind: AdaptiveDialog
beginDialog:
  kind: OnConversationStart
  id: main
  actions:
    - kind: SendActivity
      id: sendMessage_welcome
      activity:
        text:
          - Hello, I'm the D365FO Governance Assistant. Ask me about D365FO metadata, X++ cross-references, security, or Task Recorder.
'@

$agentZip = Join-Path $DistRoot "D365FO-Governance-Agent_$($Version.Replace('.','_')).zip"
ZipDir $agentBuild $agentZip
Write-Host "  -> $agentZip" -ForegroundColor Green
}

Write-Host ""
Write-Host "Done. Import the connectors solution, then create the agent (see IMPORT-README.md)." -ForegroundColor Yellow
Write-Host "Dist:" -ForegroundColor Yellow
Get-ChildItem $DistRoot | ForEach-Object { Write-Host "  $($_.Name)  ($([math]::Round($_.Length/1KB,1)) KB)" }
