<#
.SYNOPSIS
    Configure (or inspect / remove) a D365FO environment as a live custom-field
    source for the KB MCP service.

.DESCRIPTION
    Issue #91. UI custom fields (the `_Custom` suffix) live in a runtime table
    extension, so no build snapshot contains them and `d365_check_field_exists`
    used to answer a flat "does not exist" for a field that is real. The KB
    service can now resolve them live from an environment's OData `$metadata`.
    This script wires that up:

      1. validates the inputs locally, before touching Azure,
      2. writes the client secret to Key Vault (and nowhere else),
      3. merges the environment into the Function App's CUSTOM_FIELDS_SOURCES
         registry — secret-free, it only names the vault secret,
      4. proves the whole chain works: token, then a ranged GET of $metadata.

    The secret NEVER lands in the registry, in Bicep, in the repo, in this
    script's output, or in your shell history (it is a SecureString, converted
    in memory at the call site only).

    Prerequisite on the D365 side, which this script cannot do for you: the app
    registration must be listed under
        System administration > Setup > Microsoft Entra applications
    against a service account, or the environment answers 401. Reading
    `$metadata` needs nothing beyond that — and note that the service account
    determines OData *data* access, which this feature deliberately never uses:
    only entity and property names are read, never rows.

.PARAMETER Key
    Source key — the handle every tool call uses (`environment: "lade-uat"`).
    Lowercase slug: alphanumeric and hyphens, must start alphanumeric.

.PARAMETER Title
    Human-readable label shown in tool responses. Defaults to Key.

.PARAMETER Url
    Environment base URL, https, no trailing slash (stripped if present).

.PARAMETER TenantId
    Microsoft Entra tenant GUID.

.PARAMETER ClientId
    Application (client) ID GUID of the app registration.

.PARAMETER ClientSecret
    The client secret, as a SecureString. Prompted for if omitted when writing.

.PARAMETER SecretName
    Key Vault secret name. Default: d365-cf-<key>-client-secret.

.PARAMETER KeyVaultName
    Target vault. Default: <prefix>-<env>-<workload>-kv per the naming
    convention in infra/main.bicep.

.PARAMETER FunctionAppName
    Target Function App. Default: <prefix>-<env>-<workload>-func.

.PARAMETER ResourceGroup
    Target resource group. Default: <prefix>-<env>-<workload>-rg.

.PARAMETER EnvCode
    Environment code used to build the default names: d (dev, default) or p (prod).
    Derives $prefix-<env>-$workload-{kv,func,rg}.

.PARAMETER Default
    Mark this source the default for tool calls that omit `environment`. Clears
    the flag on every other source first, so exactly one default exists.

.PARAMETER List
    Show the configured sources (never a secret) and exit.

.PARAMETER Remove
    Remove the source from the registry. The vault secret is kept unless
    -DeleteSecret is also given.

.PARAMETER DeleteSecret
    With -Remove, also delete the vault secret. Separate on purpose: a deleted
    secret is only recoverable within the vault's soft-delete retention window
    (7 days on tis-d-mcpd365fo-kv), and not at all after a purge.

.PARAMETER Validate
    Test the chain (token + $metadata) without writing anything. Implied after
    a successful write.

.PARAMETER Force
    Proceed even when the Function App name does not match the expected naming
    convention, or when the URL looks like production.

.EXAMPLE
    # Configure LADE UAT, prompting for the secret, and validate
    pwsh .\scripts\Set-D365CustomFieldsSource.ps1 -Key lade-uat -Title 'LADE D365 UAT' `
        -Url https://ladeuat.sandbox.operations.dynamics.com `
        -TenantId <guid> -ClientId <guid> -Default

.EXAMPLE
    pwsh .\scripts\Set-D365CustomFieldsSource.ps1 -List
    pwsh .\scripts\Set-D365CustomFieldsSource.ps1 -Key lade-uat -Validate
    pwsh .\scripts\Set-D365CustomFieldsSource.ps1 -Key lade-uat -Remove -DeleteSecret
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'Medium', DefaultParameterSetName = 'Write')]
param(
    [Parameter(ParameterSetName = 'Write', Mandatory)]
    [Parameter(ParameterSetName = 'Remove', Mandatory)]
    [Parameter(ParameterSetName = 'Validate', Mandatory)]
    [ValidatePattern('^[a-z0-9][a-z0-9-]{0,62}$')]
    [string]$Key,

    [Parameter(ParameterSetName = 'Write')][string]$Title,
    [Parameter(ParameterSetName = 'Write')][string]$Url,
    [Parameter(ParameterSetName = 'Write')][string]$TenantId,
    [Parameter(ParameterSetName = 'Write')][string]$ClientId,
    [Parameter(ParameterSetName = 'Write')][securestring]$ClientSecret,
    [Parameter(ParameterSetName = 'Write')][switch]$Default,

    [Parameter(ParameterSetName = 'List', Mandatory)][switch]$List,
    [Parameter(ParameterSetName = 'Remove', Mandatory)][switch]$Remove,
    [Parameter(ParameterSetName = 'Remove')][switch]$DeleteSecret,
    [Parameter(ParameterSetName = 'Validate', Mandatory)][switch]$Validate,

    [string]$SecretName,
    [string]$KeyVaultName,
    [string]$FunctionAppName,
    [string]$ResourceGroup,
    # Defaults to 'd'. It used to default to 'p', which derived
    # tis-p-mcpd365fo-kv — a vault that does not exist (there is no
    # tis-p-mcpd365fo-rg in this subscription), so every unqualified run failed
    # on a DNS error AFTER prompting for and holding the secret. Defaulting an
    # unqualified run at production is also the wrong safety posture.
    [ValidateSet('d', 'p')][string]$EnvCode = 'd',
    [string]$Subscription,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($PSVersionTable.PSVersion.Major -lt 7) { throw 'Requires PowerShell 7 (pwsh).' }

. "$PSScriptRoot\Common-AzContext.ps1"

# ── naming convention (infra/main.bicep) ────────────────────────────────────
$prefix = 'tis'; $workload = 'mcpd365fo'
if (-not $KeyVaultName)    { $KeyVaultName    = "$prefix-$EnvCode-$workload-kv" }
if (-not $FunctionAppName) { $FunctionAppName = "$prefix-$EnvCode-$workload-func" }
if (-not $ResourceGroup)   { $ResourceGroup   = "$prefix-$EnvCode-$workload-rg" }
if (-not $SecretName -and $Key) { $SecretName = "d365-cf-$Key-client-secret" }

if ($FunctionAppName -notmatch "^$prefix-[dp]-$workload-func$" -and -not $Force) {
    throw "Function App name '$FunctionAppName' does not match the expected convention " +
          "'$prefix-<d|p>-$workload-func'. Pass -Force if this is intentional — a typo here would write " +
          'app settings onto an unrelated app.'
}

$APP_SETTING = 'CUSTOM_FIELDS_SOURCES'

# ── helpers ────────────────────────────────────────────────────────────────

function Get-Registry {
    $raw = az functionapp config appsettings list `
        --name $FunctionAppName --resource-group $ResourceGroup `
        --query "[?name=='$APP_SETTING'].value | [0]" -o tsv 2>$null
    if ($LASTEXITCODE -ne 0) {
        throw "Could not read app settings from $FunctionAppName in $ResourceGroup. Check the names and your access."
    }
    if ([string]::IsNullOrWhiteSpace($raw)) { return @() }
    try { return @($raw | ConvertFrom-Json) }
    catch { throw "$APP_SETTING on $FunctionAppName is not valid JSON. Fix or clear it before re-running." }
}

function Set-Registry([array]$Sources) {
    # Compact JSON: app settings are a single string value.
    $json = if ($Sources.Count -eq 0) { '[]' } else { $Sources | ConvertTo-Json -Compress -Depth 5 }
    if ($Sources.Count -eq 1) { $json = "[$($Sources[0] | ConvertTo-Json -Compress -Depth 5)]" }

    if (-not $PSCmdlet.ShouldProcess($FunctionAppName, "set $APP_SETTING ($($Sources.Count) source(s))")) {
        Write-Host "WhatIf: az functionapp config appsettings set --name $FunctionAppName --resource-group $ResourceGroup --settings $APP_SETTING=<json>" -ForegroundColor DarkGray
        Write-Host "WhatIf: json = $json" -ForegroundColor DarkGray
        return
    }
    az functionapp config appsettings set `
        --name $FunctionAppName --resource-group $ResourceGroup `
        --settings "$APP_SETTING=$json" --output none
    if ($LASTEXITCODE -ne 0) { throw "Failed to write $APP_SETTING to $FunctionAppName." }
    Write-Host "Registry updated on $FunctionAppName ($($Sources.Count) source(s))." -ForegroundColor Green
}

function Show-Sources([array]$Sources) {
    if ($Sources.Count -eq 0) { Write-Host 'No custom-field sources configured.' -ForegroundColor Yellow; return }
    $Sources |
        Select-Object @{n = 'Key'; e = { $_.key }},
                      @{n = 'Title'; e = { $_.title }},
                      @{n = 'Url'; e = { $_.url }},
                      @{n = 'SecretName'; e = { $_.secretName }},
                      @{n = 'Default'; e = { [bool]$_.default }} |
        Format-Table -AutoSize | Out-String -Width 200 | Write-Host
}

<# Prove the chain: token, then $metadata. Reads at most a few KB of the
   document — it is tens of MB and we only need to know it is reachable and is
   EDMX. Never prints the token, the secret, or a response body. #>
function Test-Source([hashtable]$Source, [securestring]$Secret) {
    Write-Host "Validating $($Source.key) ..." -ForegroundColor Cyan

    $plain = [System.Net.NetworkCredential]::new('', $Secret).Password
    try {
        $body = @{
            grant_type    = 'client_credentials'
            client_id     = $Source.clientId
            client_secret = $plain
            scope         = "$($Source.url)/.default"
        }
        try {
            $tok = Invoke-RestMethod -Method Post -TimeoutSec 60 `
                -Uri "https://login.microsoftonline.com/$($Source.tenantId)/oauth2/v2.0/token" `
                -ContentType 'application/x-www-form-urlencoded' -Body $body
        } catch {
            $status = $_.Exception.Response.StatusCode.value__
            Write-Host "  FAILED at stage: token (HTTP $status)" -ForegroundColor Red
            Write-Host '  Check the client secret, and that the app registration is listed under' -ForegroundColor Red
            Write-Host '  System administration > Setup > Microsoft Entra applications.' -ForegroundColor Red
            return $false
        }
        if (-not $tok.access_token) { Write-Host '  FAILED at stage: token (no access_token)' -ForegroundColor Red; return $false }
        Write-Host '  token: OK' -ForegroundColor Green
    } finally {
        $plain = $null
        [System.GC]::Collect()
    }

    try {
        # Range request keeps this to the first few KB of a very large document.
        $res = Invoke-WebRequest -Method Get -TimeoutSec 120 `
            -Uri "$($Source.url)/data/`$metadata" `
            -Headers @{ Authorization = "Bearer $($tok.access_token)"; Accept = 'application/xml'; Range = 'bytes=0-4095' } `
            -SkipHttpErrorCheck
    } catch {
        Write-Host "  FAILED at stage: metadata (request error)" -ForegroundColor Red
        return $false
    }
    if ($res.StatusCode -ge 400) {
        Write-Host "  FAILED at stage: metadata (HTTP $($res.StatusCode))" -ForegroundColor Red
        Write-Host '  The service account behind the app registration may not have access.' -ForegroundColor Red
        return $false
    }

    $head = [string]$res.Content
    if ($head -notmatch 'Edmx') {
        Write-Host '  FAILED at stage: parse (response is not EDMX)' -ForegroundColor Red
        return $false
    }
    $version = if ($head -match 'Edmx\s+Version="([^"]+)"') { $Matches[1] } else { 'unknown' }
    Write-Host "  metadata: OK (EDMX $version)" -ForegroundColor Green
    Write-Host "Validation OK for $($Source.key)." -ForegroundColor Green
    return $true
}

# ── go ─────────────────────────────────────────────────────────────────────
$null = Ensure-AzContext -Subscription $Subscription

switch ($PSCmdlet.ParameterSetName) {

    'List' {
        Show-Sources (Get-Registry)
        Write-Host "Vault: $KeyVaultName   Function App: $FunctionAppName   RG: $ResourceGroup" -ForegroundColor DarkGray
        Write-Host 'Secrets are stored in Key Vault; only their names appear above.' -ForegroundColor DarkGray
    }

    'Remove' {
        $sources = @(Get-Registry)
        $hit = $sources | Where-Object { $_.key -eq $Key }
        if (-not $hit) { Write-Host "No source '$Key' in the registry." -ForegroundColor Yellow }
        else {
            Set-Registry @($sources | Where-Object { $_.key -ne $Key })
        }
        if ($DeleteSecret) {
            $name = if ($hit -and $hit.secretName) { $hit.secretName } else { $SecretName }
            if ($PSCmdlet.ShouldProcess("$KeyVaultName/$name", 'delete secret (recoverable only within the soft-delete retention window)')) {
                az keyvault secret delete --vault-name $KeyVaultName --name $name --output none
                if ($LASTEXITCODE -ne 0) { Write-Warning "Could not delete secret $name from $KeyVaultName." }
                else { Write-Host "Secret $name deleted (soft-delete)." -ForegroundColor Green }
            }
        } else {
            Write-Host 'Vault secret kept. Re-run with -DeleteSecret to remove it too.' -ForegroundColor DarkGray
        }
    }

    'Validate' {
        $sources = @(Get-Registry)
        $hit = $sources | Where-Object { $_.key -eq $Key }
        if (-not $hit) { throw "No source '$Key' in the registry. Configure it first, or check -List." }

        $secretValue = az keyvault secret show --vault-name $KeyVaultName --name $hit.secretName `
            --query value -o tsv 2>$null
        if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrEmpty($secretValue)) {
            throw "Could not read secret '$($hit.secretName)' from $KeyVaultName. Check the vault name and your role assignment."
        }
        $secure = ConvertTo-SecureString $secretValue -AsPlainText -Force
        $secretValue = $null
        $ok = Test-Source @{
            key = $hit.key; url = $hit.url; tenantId = $hit.tenantId; clientId = $hit.clientId
        } $secure
        if (-not $ok) { exit 1 }
    }

    'Write' {
        foreach ($p in 'Url', 'TenantId', 'ClientId') {
            if (-not (Get-Variable $p -ValueOnly)) { throw "-$p is required when configuring a source." }
        }
        $Url = $Url.TrimEnd('/')
        if ($Url -notmatch '^https://') { throw "-Url must be https: '$Url'." }
        foreach ($p in 'TenantId', 'ClientId') {
            $v = Get-Variable $p -ValueOnly
            if ($v -notmatch '^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$') { throw "-$p must be a GUID: '$v'." }
        }
        if (-not $Title) { $Title = $Key }

        # Reading $metadata is harmless, but the credential stored here can read
        # that environment's OData. Pointing it at production should be a
        # conscious act, not a copy-paste.
        if ($Url -notmatch 'sandbox|uat|test|dev' -and -not $Force) {
            Write-Warning "'$Url' does not look like a sandbox. The secret stored for it can read that environment's OData."
            $answer = Read-Host 'Type the environment key again to confirm'
            if ($answer -ne $Key) { throw 'Confirmation did not match — aborted.' }
        }

        # Prove the vault is there and writable BEFORE asking for a secret.
        # Failing afterwards wastes the secret the operator just typed and
        # reports the cause as a DNS error, which reads like a network fault
        # rather than "you targeted the wrong environment".
        # Probe the DATA plane, not the control plane. `az keyvault show` is a
        # control-plane read that Owner already satisfies, so it passes for a
        # caller who still cannot write a secret — a false all-clear. Listing
        # secrets needs a Secrets role, which is the thing actually required.
        $vaultProbe = az keyvault secret list --vault-name $KeyVaultName --maxresults 1 --query "[].name" -o tsv 2>&1
        if ($LASTEXITCODE -ne 0) {
            $probeText = ($vaultProbe | Out-String)
            if ($probeText -match 'ResourceNotFound|was not found|getaddrinfo') {
                throw ("Key Vault '$KeyVaultName' does not exist. It was derived from -EnvCode '$EnvCode' " +
                       "(vault/app/RG = $prefix-$EnvCode-$workload-*). Pass -EnvCode d for the dev environment, " +
                       "or -KeyVaultName to name the vault directly. Nothing was written and no secret was read.")
            }
            if ($probeText -match 'Forbidden|does not have secrets|not authorized') {
                throw ("No data-plane access to Key Vault '$KeyVaultName'. Writing a secret needs the " +
                       "**Key Vault Secrets Officer** role ON THE VAULT — Owner on the resource group is not " +
                       "enough for an RBAC vault, because Owner grants the control plane only. Grant it in " +
                       "Portal > the vault > Access control (IAM), then re-run. Nothing was written and no " +
                       "secret was read.")
            }
            throw ("Could not reach Key Vault '$KeyVaultName'. az said: " +
                   (($probeText -split "`n" | Where-Object { $_.Trim() } | Select-Object -First 1) -replace '\s+', ' '))
        }
        Write-Host "  Vault $KeyVaultName reachable." -ForegroundColor DarkGray

        if (-not $ClientSecret) { $ClientSecret = Read-Host -AsSecureString "Client secret for $ClientId" }
        if (-not $ClientSecret -or $ClientSecret.Length -eq 0) { throw 'A client secret is required.' }

        # 1. secret → vault, first: a registry entry pointing at a missing
        #    secret is a worse state than no entry at all.
        if ($PSCmdlet.ShouldProcess("$KeyVaultName/$SecretName", 'set secret')) {
            $plain = [System.Net.NetworkCredential]::new('', $ClientSecret).Password
            try {
                az keyvault secret set --vault-name $KeyVaultName --name $SecretName `
                    --value $plain --output none
                if ($LASTEXITCODE -ne 0) { throw "Failed to write secret $SecretName to $KeyVaultName." }
            } finally {
                $plain = $null
                [System.GC]::Collect()
            }
            Write-Host "Secret $SecretName written to $KeyVaultName." -ForegroundColor Green
        } else {
            Write-Host "WhatIf: az keyvault secret set --vault-name $KeyVaultName --name $SecretName --value <secret>" -ForegroundColor DarkGray
        }

        # 2. merge into the registry by key — update in place, never duplicate.
        $sources = @(Get-Registry) | Where-Object { $_.key -ne $Key }
        if ($Default) { foreach ($s in $sources) { if ($s.PSObject.Properties['default']) { $s.default = $false } } }

        $entry = [ordered]@{
            key        = $Key
            title      = $Title
            url        = $Url
            tenantId   = $TenantId
            clientId   = $ClientId
            secretName = $SecretName
        }
        if ($Default) { $entry.default = $true }

        Set-Registry @(@($sources) + [pscustomobject]$entry)

        # 3. prove it works end to end.
        $ok = Test-Source @{ key = $Key; url = $Url; tenantId = $TenantId; clientId = $ClientId } $ClientSecret
        if (-not $ok) {
            Write-Warning 'The source is configured but validation failed — fix the cause and re-run with -Validate.'
            exit 1
        }

        Write-Host ''
        Write-Host "Done. Try it:  d365_custom_fields { table_name: 'SalesTable', environment: '$Key' }" -ForegroundColor Cyan
        Write-Host 'Note: app-setting changes restart the Function App; the first call after that is a cold start.' -ForegroundColor DarkGray
    }
}
