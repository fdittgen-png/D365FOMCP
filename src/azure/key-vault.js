/**
 * Key Vault secret accessor (issue #88).
 *
 * One place in the codebase reads secrets, so there is one place to audit.
 * Everything else asks for a secret *by name* and never sees where it came
 * from.
 *
 * Credential chain is `DefaultAzureCredential`, deliberately: in the Function
 * App that resolves to the system-assigned managed identity (granted
 * "Key Vault Secrets User" at vault scope by `infra/main.bicep`), and on a
 * developer machine it resolves to `az login` / environment credentials. Same
 * code path both places — no `if (process.env.AZURE_FUNCTIONS_ENVIRONMENT)`
 * branching, which is the usual way this kind of module grows a bug that only
 * appears in production.
 *
 * Rules this module enforces:
 *   - a secret value is never logged, never returned in an error, never
 *     serialised into an MCP response (callers get `KeyVaultError`, whose
 *     message is safe to surface as an `errorResult` hint);
 *   - values are cached in-process with a TTL so a per-request vault
 *     round-trip is not on the hot path of a tool call;
 *   - when no vault is configured, the dev-only environment fallback is used
 *     and the caller can see that it was (`lastSource`), so "it works on my
 *     machine" is diagnosable.
 */

/** Thrown for every failure. `stage` says how far we got; the message is
 *  deliberately free of any secret material and safe to show a caller. */
export class KeyVaultError extends Error {
  /** @param {'not-configured'|'credential'|'fetch'|'empty'} stage */
  constructor(stage, message) {
    super(message);
    this.name = 'KeyVaultError';
    this.stage = stage;
  }
}

const DEFAULT_TTL_SECONDS = 3600;

/** name → { value, expiresAt, source } */
const cache = new Map();

/** Diagnostics only: which resolution path served the last successful read.
 *  Contains no secret material. */
let lastSource = null;

function ttlMs() {
  const raw = Number(process.env.KEY_VAULT_SECRET_TTL_SECONDS);
  const seconds = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TTL_SECONDS;
  return seconds * 1000;
}

/** Dev-only fallback: `CUSTOM_FIELDS_CLIENT_SECRET_<KEY>`, upper-cased with
 *  non-alphanumerics collapsed to `_`. Only consulted when no vault is
 *  configured — a configured vault is never silently bypassed, because that
 *  would let a stale local env var shadow the real secret. */
function envFallbackName(secretName) {
  return `CUSTOM_FIELDS_CLIENT_SECRET_${String(secretName).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
}

/**
 * Vault client, created lazily so importing this module costs nothing and a
 * missing dependency cannot break service start-up.
 * @returns {Promise<import('@azure/keyvault-secrets').SecretClient>}
 */
async function getClient(vaultName) {
  const [{ DefaultAzureCredential }, { SecretClient }] = await Promise.all([
    import('@azure/identity'),
    import('@azure/keyvault-secrets'),
  ]);
  const url = process.env.KEY_VAULT_URI || `https://${vaultName}.vault.azure.net`;
  return new SecretClient(url, new DefaultAzureCredential());
}

/**
 * Read one secret by name.
 *
 * @param {string} secretName Vault secret name (e.g. `d365-cf-lade-uat-client-secret`).
 * @param {{ refresh?: boolean }} [opts]
 * @returns {Promise<string>} the secret value — treat as tainted: never log it.
 * @throws {KeyVaultError}
 */
export async function getSecret(secretName, opts = {}) {
  const name = String(secretName ?? '').trim();
  if (!name) throw new KeyVaultError('not-configured', 'No secret name given.');

  if (!opts.refresh) {
    const hit = cache.get(name);
    if (hit && hit.expiresAt > Date.now()) {
      lastSource = hit.source;
      return hit.value;
    }
  }

  const vaultName = (process.env.KEY_VAULT_NAME || '').trim();

  if (!vaultName) {
    // No vault configured: local development.
    const envName = envFallbackName(name);
    const value = process.env[envName];
    if (value) {
      cache.set(name, { value, expiresAt: Date.now() + ttlMs(), source: `env:${envName}` });
      lastSource = `env:${envName}`;
      return value;
    }
    throw new KeyVaultError(
      'not-configured',
      `No Key Vault configured (KEY_VAULT_NAME unset) and no local fallback ${envName}. ` +
      'Run scripts/Set-D365CustomFieldsSource.ps1, or set the fallback for local development.',
    );
  }

  let client;
  try {
    client = await getClient(vaultName);
  } catch (err) {
    console.error('key-vault: client construction failed', err);
    throw new KeyVaultError('credential', `Could not obtain credentials for vault ${vaultName}.`);
  }

  let secret;
  try {
    secret = await client.getSecret(name);
  } catch (err) {
    // The SDK error can carry the request URL and response body — log it
    // server-side only. `statusCode` alone is safe to pass to the caller.
    console.error(`key-vault: getSecret(${name}) failed`, err);
    const status = err?.statusCode ? ` (HTTP ${err.statusCode})` : '';
    throw new KeyVaultError('fetch', `Could not read secret ${name} from vault ${vaultName}${status}.`);
  }

  if (!secret?.value) {
    throw new KeyVaultError('empty', `Secret ${name} exists in vault ${vaultName} but has no value.`);
  }

  cache.set(name, { value: secret.value, expiresAt: Date.now() + ttlMs(), source: `vault:${vaultName}` });
  lastSource = `vault:${vaultName}`;
  return secret.value;
}

/** Diagnostics for the sources tool: how secrets are being resolved, how many
 *  are cached, and where the last one came from. Never a secret value. */
export function getSecretCacheState() {
  const vaultName = (process.env.KEY_VAULT_NAME || '').trim();
  return {
    vault_configured: Boolean(vaultName),
    vault_name: vaultName || null,
    cached_secret_count: cache.size,
    last_source: lastSource,
    ttl_seconds: ttlMs() / 1000,
  };
}

/** Test seam / rotation hook. */
export function clearSecretCache() {
  cache.clear();
  lastSource = null;
}
