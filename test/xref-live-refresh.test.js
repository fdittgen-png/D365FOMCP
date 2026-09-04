/**
 * XREF_LIVE (#129): the local-server refresh launcher — config resolution from
 * the active XPP configuration, module selection, and the detached spawn — with
 * every machine-touching dependency injected.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import {
  parseRegQueryValue, readActiveXrefConfig, selectLiveModules, startLiveRefresh, XREF_CONFIG_REG_KEY,
} from '../src/local/xref-live-refresh.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const REG_OUT = `
HKEY_CURRENT_USER\\SOFTWARE\\Microsoft\\Dynamics\\AX7\\Development\\Configurations
    CurrentMetadataConfig    REG_SZ    C:\\Users\\dev\\Documents\\Visual Studio Dynamics 365\\DynamicsDevConfig.xppconfig
`;

test('parseRegQueryValue extracts the .xppconfig path (spaces included) and null on garbage', () => {
  assert.equal(parseRegQueryValue(REG_OUT), 'C:\\Users\\dev\\Documents\\Visual Studio Dynamics 365\\DynamicsDevConfig.xppconfig');
  assert.equal(parseRegQueryValue('ERROR: The system was unable to find the specified registry key or value.'), null);
  assert.equal(parseRegQueryValue(''), null);
});

test('readActiveXrefConfig reads database + server from the active configuration, never from .env', () => {
  const cfg = readActiveXrefConfig({
    execSync: (cmd) => { assert.ok(cmd.includes(XREF_CONFIG_REG_KEY)); return REG_OUT; },
    existsSync: () => true,
    readFileSync: () => JSON.stringify({ CrossReferencesDatabaseName: 'XRef_tis-d365fo-dev-021002263202', CrossReferencesDbServerName: '(LocalDB)\\MSSQLLocalDB', ModelStoreFolder: 'C:\\Workspace\\MAIN\\Metadata' }),
  });
  assert.equal(cfg.database, 'XRef_tis-d365fo-dev-021002263202');
  assert.equal(cfg.server, '(LocalDB)\\MSSQLLocalDB');
  assert.equal(cfg.modelStore, 'C:\\Workspace\\MAIN\\Metadata');
});

test('readActiveXrefConfig returns null when the key, the file or the database name is missing', () => {
  assert.equal(readActiveXrefConfig({ execSync: () => { throw new Error('no key'); } }), null);
  assert.equal(readActiveXrefConfig({ execSync: () => REG_OUT, existsSync: () => false }), null);
  assert.equal(readActiveXrefConfig({ execSync: () => REG_OUT, existsSync: () => true, readFileSync: () => JSON.stringify({ ModelStoreFolder: 'x' }) }), null);
  assert.equal(readActiveXrefConfig({ execSync: () => REG_OUT, existsSync: () => true, readFileSync: () => 'not json' }), null);
});

test('selectLiveModules prefers the delta-tracked modules, falls back to custom-origin models, else []', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE model_versions (model_name TEXT, module_id TEXT, display_name TEXT, publisher TEXT, layer TEXT, origin TEXT, version TEXT, source_path TEXT);
           INSERT INTO model_versions VALUES ('iExtension','iExtension',NULL,'Trelleborg','ISV','custom','1.0.0.0',NULL);
           INSERT INTO model_versions VALUES ('HISOL','HISOL',NULL,'Trelleborg','ISV','custom','1.0.0.0',NULL);
           INSERT INTO model_versions VALUES ('Foundation','ApplicationSuite',NULL,'Microsoft','SYS','microsoft','10.0',NULL);
           INSERT INTO model_versions VALUES ('Lasernet','Lasernet',NULL,'Formpipe','ISV','isv','7.2',NULL);`);
  assert.deepEqual(selectLiveModules(db), ['HISOL', 'iExtension'], 'custom only, sorted');
  db.exec(`CREATE TABLE xref_module_sync (module TEXT PRIMARY KEY, fingerprint TEXT); INSERT INTO xref_module_sync VALUES ('iExtension','abc');`);
  assert.deepEqual(selectLiveModules(db), ['iExtension'], 'delta-tracked modules win');
  const empty = new Database(':memory:');
  assert.deepEqual(selectLiveModules(empty), []);
});

test('startLiveRefresh is inert without XREF_LIVE=1 and explains every non-start', () => {
  const spawn = () => { throw new Error('must not spawn'); };
  assert.equal(startLiveRefresh({ env: {}, spawn }).started, false);
  const noCfg = startLiveRefresh({ env: { XREF_LIVE: '1' }, spawn, readConfig: () => null });
  assert.equal(noCfg.started, false);
  assert.match(noCfg.reason, /CurrentMetadataConfig/);
  const noModules = startLiveRefresh({ env: { XREF_LIVE: '1' }, spawn, readConfig: () => ({ database: 'X', server: 'S' }), selectModules: () => [] });
  assert.equal(noModules.started, false);
  assert.match(noModules.reason, /XREF_LIVE_MODULES/);
});

test('startLiveRefresh launches update-xref-module.js detached with the active database, server and sqlite path', () => {
  const calls = [];
  const spawn = (bin, args, opts) => { calls.push({ bin, args, opts }); return { pid: 4242, unref() { calls.push('unref'); } }; };
  const logs = [];
  const r = startLiveRefresh({
    env: { XREF_LIVE: '1' }, dbPath: 'C:\\x\\d365fo_xref.sqlite', spawn, log: (m) => logs.push(m),
    readConfig: () => ({ database: 'XRef_live', server: '(LocalDB)\\MSSQLLocalDB' }),
    selectModules: () => ['iExtension', 'HISOL'],
    nodeBin: 'node.exe', repoRoot: 'C:\\repo',
  });
  assert.equal(r.started, true);
  assert.equal(r.pid, 4242);
  assert.deepEqual(r.modules, ['iExtension', 'HISOL']);
  assert.equal(calls[0].bin, 'node.exe');
  assert.ok(calls[0].args[0].endsWith('update-xref-module.js'));
  assert.deepEqual(calls[0].args.slice(1), ['iExtension', 'HISOL', '--database=XRef_live', '--server=(LocalDB)\\MSSQLLocalDB', '--db=C:\\x\\d365fo_xref.sqlite']);
  assert.equal(calls[0].opts.detached, true);
  assert.equal(calls[0].opts.stdio, 'ignore', 'stdout is the MCP transport — the child must never write to it');
  assert.equal(calls[1], 'unref');
  assert.match(logs[0], /XREF_LIVE: refreshing iExtension, HISOL/);
});

test('XREF_LIVE_MODULES overrides the automatic module selection', () => {
  const spawn = () => ({ pid: 1, unref() {} });
  const r = startLiveRefresh({ env: { XREF_LIVE: '1', XREF_LIVE_MODULES: 'OnlyThis, AndThat' }, spawn, readConfig: () => ({ database: 'D', server: 'S' }), selectModules: () => ['ignored'] });
  assert.deepEqual(r.modules, ['OnlyThis', 'AndThat']);
});
