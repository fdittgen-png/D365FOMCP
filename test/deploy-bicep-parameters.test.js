/**
 * Deploy-script ↔ Bicep parameter contract (issue: -DeployInfra broke on main).
 *
 * The deploy scripts pass a parameter block to `infra/main-rg.bicep`. If a
 * script passes a parameter the template does not declare, ARM rejects the
 * whole deployment with `InvalidTemplate` — and nothing catches it until
 * someone actually runs `-DeployInfra`, which is rare enough that it stayed
 * broken on main.
 *
 * That is exactly what happened with `enablePurgeProtection`: the parameter was
 * added to `modules/keyVault.bicep` and passed by both deploy scripts, but
 * never declared in the parent template or forwarded to the module. The switch
 * was therefore both fatal (ARM error) and inert (never reached the vault).
 *
 * These are static-source tests — they parse the .ps1 and .bicep files as text
 * rather than invoking Azure, so they run everywhere in milliseconds.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

/** The template both deploy scripts target. */
const TEMPLATE = join(ROOT, 'infra', 'main-rg.bicep');

/** Deploy scripts that build a `--parameters` block for that template. */
const DEPLOY_SCRIPTS = [
  join(ROOT, 'local-deploy', 'Deploy.ps1'),
  join(ROOT, 'scripts', 'Deploy-Infrastructure.ps1'),
];

/** Top-level `param <name> <type>` declarations in a .bicep file. */
function declaredParams(bicepText) {
  return new Set(
    [...bicepText.matchAll(/^param\s+([A-Za-z_][A-Za-z0-9_]*)\s/gm)].map(m => m[1])
  );
}

/**
 * Parameter names a PowerShell deploy script passes to the template.
 *
 * The two scripts use different shapes and both must be covered:
 *
 *   local-deploy/Deploy.ps1        a parameter-file hashtable —
 *                                  `name = @{ value = ... }`
 *   scripts/Deploy-Infrastructure  CLI pairs —
 *                                  `'--parameters', 'name=value'`
 *
 * Matching only the first shape is what let this bug through the first time, so
 * the test asserts each parser found something rather than trusting an empty
 * result to mean "nothing passed".
 */
function passedParams(psText) {
  const names = new Set();

  // Shape 1: parameter-file hashtable entries.
  for (const m of psText.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*@\{\s*value\s*=/gm)) {
    names.add(m[1]);
  }

  // Shape 2: `--parameters name=…` CLI pairs, including the
  // `('name=' + $json)` concatenation used for array parameters.
  for (const line of psText.split(/\r?\n/)) {
    if (!line.includes('--parameters')) continue;
    for (const m of line.matchAll(/['"(]\s*([A-Za-z_][A-Za-z0-9_]*)=/g)) {
      names.add(m[1]);
    }
  }
  return names;
}

test('main-rg.bicep declares every parameter the deploy scripts pass', () => {
  const declared = declaredParams(readFileSync(TEMPLATE, 'utf8'));
  assert.ok(declared.size > 0, 'no params parsed from main-rg.bicep — parser is wrong');

  for (const script of DEPLOY_SCRIPTS) {
    if (!existsSync(script)) continue; // scripts/ variant may be retired
    const passed = passedParams(readFileSync(script, 'utf8'));
    assert.ok(passed.size > 0, `no parameters parsed from ${script} — parser is wrong`);

    const undeclared = [...passed].filter(p => !declared.has(p));
    assert.deepEqual(undeclared, [],
      `${script} passes parameter(s) main-rg.bicep does not declare: ${undeclared.join(', ')}. `
      + 'ARM rejects the whole deployment with InvalidTemplate.');
  }
});

test('a parameter that reaches the Key Vault module is actually forwarded to it', () => {
  const text = readFileSync(TEMPLATE, 'utf8');
  const declared = declaredParams(text);
  assert.ok(declared.has('enablePurgeProtection'),
    'main-rg.bicep must declare enablePurgeProtection — both deploy scripts pass it');

  // Isolate the keyVault module block and check the parameter is threaded in.
  const start = text.indexOf("module keyVault 'modules/keyVault.bicep'");
  assert.ok(start >= 0, 'keyVault module invocation not found');
  const block = text.slice(start, text.indexOf('\n}', start));
  assert.match(block, /enablePurgeProtection:\s*enablePurgeProtection/,
    'declared but not forwarded — the switch would be silently inert');
});

test('purge protection defaults to false everywhere it is declared', () => {
  // It is a one-way switch on a live vault: on by default is a foot-gun, and
  // tis-d-mcpd365fo-kv has it off today. Any template that defaults it to true
  // would flip it permanently on the next routine -DeployInfra.
  for (const rel of ['infra/main-rg.bicep', 'infra/main.bicep', 'infra/modules/keyVault.bicep']) {
    const p = join(ROOT, rel);
    if (!existsSync(p)) continue;
    const text = readFileSync(p, 'utf8');
    const m = /^param\s+enablePurgeProtection\s+bool\s*=\s*(\w+)/m.exec(text);
    if (!m) continue;
    assert.equal(m[1], 'false',
      `${rel} defaults enablePurgeProtection to ${m[1]} — it is irreversible on an existing vault`);
  }
});

test('the Key Vault module never hard-codes purge protection', () => {
  const p = join(ROOT, 'infra', 'modules', 'keyVault.bicep');
  if (!existsSync(p)) return;
  const text = readFileSync(p, 'utf8');
  assert.doesNotMatch(text, /enablePurgeProtection:\s*(true|false)\b/,
    'enablePurgeProtection must come from the parameter, never a literal — '
    + 'a hard-coded true permanently enables it on an existing vault');
});
