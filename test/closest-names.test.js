/**
 * Exact-name recovery (#115 item 3): `closestNames(db, name, kind, limit)`.
 *
 * One helper serves the three snapshot shapes — KB (flat `<kind>_name`
 * columns), XRef (`names.path`, object = last segment of `/<Type>/<Name>`) and
 * Sec (roles / duties / privileges / users). The fixtures below mirror the DDL
 * of build/build-kb.js, build/build-xref-db.js and src/azure/sec-builder.js —
 * the same tables the tool tests build in memory.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { closestNames, levenshtein, notFoundResult, CLOSEST_NAME_KINDS } from '../src/azure/shared.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

let kb, xref, sec;
before(() => {
  kb = new Database(':memory:');
  kb.exec(`
    CREATE TABLE tables (table_name TEXT PRIMARY KEY, module_id TEXT);
    CREATE TABLE classes (class_name TEXT PRIMARY KEY, module_id TEXT);
    CREATE TABLE enums (enum_name TEXT PRIMARY KEY, module_id TEXT);
    CREATE TABLE edts (edt_name TEXT PRIMARY KEY, base_type TEXT);
    CREATE TABLE forms (form_name TEXT PRIMARY KEY, module_id TEXT);
    CREATE TABLE data_entities (entity_name TEXT PRIMARY KEY, module_id TEXT);
    CREATE TABLE menu_items (menu_item_name TEXT, menu_item_type TEXT, PRIMARY KEY (menu_item_name, menu_item_type));
    INSERT INTO tables VALUES ('CustTable','ApplicationSuite'),('SalesTable','ApplicationSuite'),('SalesLine','ApplicationSuite'),
      ('SalesParameters','ApplicationSuite'),('VendTable','ApplicationSuite'),('InventTable','ApplicationSuite'),('TBG_SalesExtra','iExtension');
    INSERT INTO classes VALUES ('SalesFormLetter','ApplicationSuite'),('SalesTableType','ApplicationSuite'),('CustVendCheque','ApplicationSuite');
    INSERT INTO enums VALUES ('SalesStatus','ApplicationSuite'),('SalesType','ApplicationSuite'),('NoYes','ApplicationPlatform');
    INSERT INTO edts VALUES ('CustAccount','String'),('SalesId','String');
    INSERT INTO forms VALUES ('SalesTable','ApplicationSuite'),('CustTable','ApplicationSuite'),('SalesTableListPage','ApplicationSuite');
    INSERT INTO data_entities VALUES ('SalesOrderHeaderV2Entity','ApplicationSuite'),('CustCustomerV3Entity','ApplicationSuite');
    INSERT INTO menu_items VALUES ('SalesTable','Display'),('SalesTableListPage','Display'),('CustTable','Display');
  `);

  xref = new Database(':memory:');
  xref.exec(`
    CREATE TABLE names (id INTEGER PRIMARY KEY, path TEXT NOT NULL, provider_id INTEGER NOT NULL, module_id INTEGER NOT NULL);
    INSERT INTO names VALUES (1,'/Tables/CustTable',1,1),(2,'/Tables/CustTable/Fields/AccountNum',1,1),(3,'/Tables/SalesTable',1,1),
      (4,'/Tables/SalesLine',1,1),(5,'/Classes/SalesFormLetter',1,1),(6,'/Classes/SalesFormLetter/Methods/run',1,1),
      (7,'/Forms/SalesTable',1,1),(8,'/Enums/SalesStatus',1,1),(9,'/DataEntityViews/SalesOrderHeaderV2Entity',1,1),
      (10,'/Tables/VendTable',1,1),(11,'/Edts/CustAccount',1,1);
  `);

  sec = new Database(':memory:');
  sec.exec(`
    CREATE TABLE roles (role_id TEXT PRIMARY KEY, role_name TEXT NOT NULL, module_id TEXT, label TEXT);
    CREATE TABLE duties (duty_id TEXT PRIMARY KEY, duty_name TEXT, module_id TEXT);
    CREATE TABLE privileges (privilege_name TEXT PRIMARY KEY, module_id TEXT, label TEXT);
    CREATE TABLE users (user_id TEXT PRIMARY KEY, person_name TEXT, enabled INTEGER);
    INSERT INTO roles VALUES ('r1','AccountsReceivableClerk','AS',NULL),('r2','AccountsReceivableManager','AS',NULL),('r3','SalesManager','AS',NULL);
    INSERT INTO duties VALUES ('d1','CustCustomerMaintain','AS'),('d2','CustCustomerInquire','AS');
    INSERT INTO privileges VALUES ('CustTableMaintain','AS',NULL),('CustTableView','AS',NULL),('SalesTableMaintain','AS',NULL);
    INSERT INTO users VALUES ('jdoe','J. Doe',1),('jsmith','J. Smith',1);
  `);
});
after(() => { for (const d of [kb, xref, sec]) { try { d.close(); } catch { /* closed */ } } });

describe('levenshtein', () => {
  it('measures edits and exits early above max', () => {
    assert.equal(levenshtein('SalesTabel', 'SalesTable'), 2);
    assert.equal(levenshtein('a', 'a'), 0);
    assert.equal(levenshtein('', 'abc'), 3);
    assert.equal(levenshtein('kitten', 'sitting'), 3);
    assert.equal(levenshtein('kitten', 'sitting', 2), 3, 'max + 1 once the bound is exceeded');
  });
});

describe('closestNames — KB shape', () => {
  it('1. case-only match returns the exact spelling first', () => {
    assert.equal(closestNames(kb, 'custtable', 'table')[0], 'CustTable');
    assert.deepEqual(closestNames(kb, 'custtable', 'table', 1), ['CustTable']);
    assert.equal(closestNames(kb, 'SALESFORMLETTER', 'class')[0], 'SalesFormLetter');
  });

  it('2. prefix match', () => {
    const r = closestNames(kb, 'SalesP', 'table');
    assert.deepEqual(r, ['SalesParameters']);
  });

  it('3. contains match', () => {
    const r = closestNames(kb, 'Parameters', 'table');
    assert.deepEqual(r, ['SalesParameters']);
  });

  it('4. Levenshtein ≤ 2 recovers a typo (the #115 acceptance case)', () => {
    const r = closestNames(kb, 'SalesTabel', 'table');
    assert.ok(r.includes('SalesTable'), `SalesTabel → SalesTable, got ${JSON.stringify(r)}`);
    assert.equal(r[0], 'SalesTable', 'closest edit distance first');
  });

  it('respects limit and dedupes case-insensitively', () => {
    assert.equal(closestNames(kb, 'Sales', 'table', 2).length, 2);
    assert.equal(closestNames(kb, 'Sales', 'table').length, 3, 'default limit 3');
    const all = closestNames(kb, 'Sales', 'table', 10);
    assert.equal(new Set(all.map(s => s.toLowerCase())).size, all.length);
    assert.equal(closestNames(kb, 'Sales', 'table', 0).length, 3, 'defensive default on a bad limit');
  });

  it('serves every KB kind from its own table', () => {
    assert.deepEqual(closestNames(kb, 'salesstatus', 'enum'), ['SalesStatus']);
    assert.deepEqual(closestNames(kb, 'custaccount', 'edt'), ['CustAccount']);
    assert.deepEqual(closestNames(kb, 'SalesTableList', 'form'), ['SalesTableListPage']);
    assert.deepEqual(closestNames(kb, 'SalesOrderHeader', 'entity'), ['SalesOrderHeaderV2Entity']);
    assert.deepEqual(closestNames(kb, 'salestablelistpage', 'menu_item'), ['SalesTableListPage']);
  });

  it('object = any kind, tables first', () => {
    const r = closestNames(kb, 'SalesFormLetter', 'object');
    assert.deepEqual(r, ['SalesFormLetter']);
    const typo = closestNames(kb, 'SalesStatu', 'object');
    assert.ok(typo.includes('SalesStatus'));
  });

  it('LIKE wildcards in the caller name are escaped, not interpreted', () => {
    assert.deepEqual(closestNames(kb, '%', 'table'), []);
    assert.deepEqual(closestNames(kb, '_', 'table'), ['TBG_SalesExtra'], 'a lone underscore is a literal (escaped), not a one-char wildcard');
    assert.ok(closestNames(kb, 'TBG_Sales', 'table').includes('TBG_SalesExtra'));
  });

  it('is fast on the fixture (≤ 5 ms per call)', () => {
    closestNames(kb, 'SalesTabel', 'table'); // warm the statement cache
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) closestNames(kb, 'SalesTabel', 'object');
    const perCall = (performance.now() - t0) / 20;
    assert.ok(perCall <= 5, `closestNames took ${perCall.toFixed(2)} ms per call`);
  });
});

describe('closestNames — XRef shape (names.path)', () => {
  it('resolves the last path segment under the kind prefix', () => {
    assert.deepEqual(closestNames(xref, 'custtable', 'table'), ['CustTable']);
    assert.deepEqual(closestNames(xref, 'SalesTabel', 'table'), ['SalesTable']);
    assert.deepEqual(closestNames(xref, 'SalesForm', 'class'), ['SalesFormLetter']);
    assert.deepEqual(closestNames(xref, 'salesstatus', 'enum'), ['SalesStatus']);
    assert.deepEqual(closestNames(xref, 'SalesOrder', 'entity'), ['SalesOrderHeaderV2Entity']);
    assert.deepEqual(closestNames(xref, 'salestable', 'form'), ['SalesTable']);
    assert.deepEqual(closestNames(xref, 'custaccount', 'edt'), ['CustAccount']);
  });

  it('never returns a sub-node (field, method) as an object name', () => {
    const r = closestNames(xref, 'Account', 'table', 10);
    assert.ok(!r.includes('AccountNum'), JSON.stringify(r));
    assert.ok(!closestNames(xref, 'run', 'object', 10).includes('run'));
  });

  it('object = any top-level type', () => {
    assert.deepEqual(closestNames(xref, 'salesformletter', 'object'), ['SalesFormLetter']);
    assert.ok(closestNames(xref, 'Sales', 'object', 10).length >= 4);
  });

  it('kinds without an XRef path prefix return []', () => {
    assert.deepEqual(closestNames(xref, 'Sales', 'role'), []);
  });
});

describe('closestNames — Sec shape', () => {
  it('roles / duties / privileges / users', () => {
    assert.deepEqual(closestNames(sec, 'accountsreceivableclerk', 'role'), ['AccountsReceivableClerk']);
    assert.deepEqual(closestNames(sec, 'AccountsReceivable', 'role'), ['AccountsReceivableClerk', 'AccountsReceivableManager']);
    assert.deepEqual(closestNames(sec, 'CustCustomerMaintan', 'duty'), ['CustCustomerMaintain']);
    assert.deepEqual(closestNames(sec, 'custtableview', 'privilege'), ['CustTableView']);
    assert.deepEqual(closestNames(sec, 'JDOE', 'user'), ['jdoe']);
  });

  it('a KB kind on the Sec database returns [] (no such table), never throws', () => {
    assert.deepEqual(closestNames(sec, 'CustTable', 'table'), []);
  });
});

describe('closestNames — never throws', () => {
  it('unknown kind, empty name, missing db, closed db → []', () => {
    assert.deepEqual(closestNames(kb, 'CustTable', 'nope'), []);
    assert.deepEqual(closestNames(kb, '', 'table'), []);
    assert.deepEqual(closestNames(kb, '   ', 'table'), []);
    assert.deepEqual(closestNames(null, 'CustTable', 'table'), []);
    assert.deepEqual(closestNames({}, 'CustTable', 'table'), []);
    const closed = new Database(':memory:'); closed.close();
    assert.deepEqual(closestNames(closed, 'CustTable', 'table'), []);
    assert.deepEqual(closestNames({ prepare() { throw new Error('boom'); } }, 'CustTable', 'table'), []);
  });

  it('exports the kind list the tools may pass', () => {
    assert.deepEqual([...CLOSEST_NAME_KINDS].sort(), ['class', 'duty', 'edt', 'entity', 'enum', 'form', 'menu_item', 'object', 'privilege', 'role', 'table', 'user']);
  });
});

describe('notFoundResult uses closestNames when the caller passes no suggestions', () => {
  it('fills "Did you mean" from db + kind', () => {
    const r = notFoundResult('Table', 'SalesTabel', [], { db: kb, kind: 'table' });
    assert.equal(r.isError, true);
    assert.equal(r._meta.kind, 'not-found');
    assert.ok(!('structuredContent' in r));
    assert.match(r.content[0].text, /\*\*Did you mean:\*\*\n- `SalesTable`/);
  });

  it('caller suggestions stay first and are not overridden', () => {
    const r = notFoundResult('Table', 'SalesTabel', ['Custom'], { db: kb, kind: 'table' });
    assert.match(r.content[0].text, /Did you mean:\*\*\n- `Custom`\n?$/);
    assert.ok(!r.content[0].text.includes('SalesTable'));
  });
});
