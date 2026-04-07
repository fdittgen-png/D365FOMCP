/**
 * build-xref-db.js
 * Extracts D365FO cross-reference data from LocalDB (SQL Server) into a SQLite database.
 * Uses better-sqlite3 (native, file-based) to avoid memory limits with large databases.
 *
 * Usage:
 *   node --max-old-space-size=8192 build-xref-db.js [serverInstance] [databaseName] [outputPath]
 *
 * Defaults:
 *   serverInstance = (LocalDB)\MSSQLLocalDB
 *   databaseName   = (required) set via XREF_DATABASE env var or CLI argument
 *   outputPath     = %USERPROFILE%\.claude\d365fo_xref.sqlite
 */

import { join } from 'path';
import { existsSync, unlinkSync, statSync } from 'fs';
import { execSync } from 'child_process';
import { createRequire } from 'module';
import sql from 'mssql';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

// ── Configuration ──────────────────────────────────────────────────────────────

const DEFAULT_INSTANCE = String.raw`(LocalDB)\MSSQLLocalDB`;
const DEFAULT_DATABASE = process.env.XREF_DATABASE || '';
const DEFAULT_OUTPUT = join(process.env.USERPROFILE || process.env.HOME || '.', '.claude', 'd365fo_xref.sqlite');

const serverInstance = process.argv[2] || DEFAULT_INSTANCE;
const database = process.argv[3] || DEFAULT_DATABASE;
const outputPath = process.argv[4] || DEFAULT_OUTPUT;

if (!database) {
  console.error('ERROR: No database name provided.');
  console.error('Set the XREF_DATABASE environment variable or pass it as the second CLI argument.');
  console.error('Usage: node build-xref-db.js [serverInstance] <databaseName> [outputPath]');
  process.exit(1);
}

// ── Kind enum mapping ──────────────────────────────────────────────────────────

const KIND_MAP = {
  1: 'Call',
  2: 'Read',
  3: 'Implements',
  4: 'Extends',
  6: 'Delegate',
  7: 'Attribute',
  9: 'Tag',
  10: 'Override',
};

// ── SQLite Schema ──────────────────────────────────────────────────────────────

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS names (
    id INTEGER PRIMARY KEY,
    path TEXT NOT NULL,
    provider_id INTEGER NOT NULL,
    module_id INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS modules (
    id INTEGER PRIMARY KEY,
    module TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS providers (
    id INTEGER PRIMARY KEY,
    provider TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS refs (
    source_id INTEGER NOT NULL,
    target_id INTEGER NOT NULL,
    kind INTEGER NOT NULL,
    line INTEGER,
    col INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS kind_map (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS xref_metadata (
    key TEXT PRIMARY KEY,
    value TEXT
  )`,
];

const INDEX_STATEMENTS = [
  `CREATE INDEX IF NOT EXISTS idx_names_path ON names(path)`,
  `CREATE INDEX IF NOT EXISTS idx_names_module ON names(module_id)`,
  `CREATE INDEX IF NOT EXISTS idx_refs_source ON refs(source_id)`,
  `CREATE INDEX IF NOT EXISTS idx_refs_target ON refs(target_id)`,
  `CREATE INDEX IF NOT EXISTS idx_refs_kind ON refs(kind)`,
  `CREATE INDEX IF NOT EXISTS idx_refs_source_kind ON refs(source_id, kind)`,
  `CREATE INDEX IF NOT EXISTS idx_refs_target_kind ON refs(target_id, kind)`,
  `CREATE INDEX IF NOT EXISTS idx_modules_module ON modules(module)`,
];

// ── Helpers ────────────────────────────────────────────────────────────────────

function log(msg) {
  process.stdout.write(`[${new Date().toISOString().slice(11, 19)}] ${msg}\n`);
}

/**
 * Get the named pipe for LocalDB instance using SqlLocalDB CLI.
 */
function getLocalDbPipe(instanceName) {
  const parts = instanceName.split('\\');
  const instance = parts[parts.length - 1];

  try {
    const output = execSync(`SqlLocalDB info "${instance}"`, { encoding: 'utf-8' });
    const pipeMatch = output.match(/Instance pipe name:\s*(np:\\.+)/i);
    if (pipeMatch) return pipeMatch[1];
  } catch (e) {
    console.warn('Warning:', e.message);
  }

  try {
    execSync(`SqlLocalDB start "${instance}"`, { encoding: 'utf-8' });
    const output2 = execSync(`SqlLocalDB info "${instance}"`, { encoding: 'utf-8' });
    const pipeMatch = output2.match(/Instance pipe name:\s*(np:\\.+)/i);
    if (pipeMatch) return pipeMatch[1];
  } catch (e) {
    console.warn('Warning:', e.message);
  }

  return null;
}

// ── Main Build ─────────────────────────────────────────────────────────────────

async function build() {
  const startTime = Date.now();
  log(`D365FO XRef -> SQLite Builder (better-sqlite3, file-based)`);
  log(`SQL Server: ${serverInstance}`);
  log(`Database:   ${database}`);
  log(`Output:     ${outputPath}`);
  log(``);

  // ── Connect to SQL Server ──────────────────────────────────────────────────
  log('Resolving LocalDB named pipe...');
  const pipe = getLocalDbPipe(serverInstance);
  if (!pipe) {
    console.error('ERROR: Could not resolve LocalDB named pipe. Ensure LocalDB is running:');
    console.error('  SqlLocalDB start MSSQLLocalDB');
    process.exit(1);
  }
  log(`  Pipe: ${pipe}`);

  log('Connecting to SQL Server...');

  let pool;
  try {
    pool = await sql.connect(`Server=${pipe};Database=${database};Trusted_Connection=yes;TrustServerCertificate=yes;Driver=msnodesqlv8`);
  } catch (err1) {
    log(`  Direct pipe connection failed (${err1.message}), trying server name...`);
    try {
      pool = await sql.connect({
        server: serverInstance.replace(/^\(/, '').replace(/\)$/, '').replace('\\', '\\\\'),
        database: database,
        options: {
          trustServerCertificate: true,
          trustedConnection: true,
          encrypt: false,
        },
      });
    } catch (err2) {
      log(`  Server name connection also failed: ${err2.message}`);
      log(`  Falling back to sqlcmd approach...`);
      pool = null;
    }
  }

  const useSqlCmd = pool === null;
  if (useSqlCmd) {
    log('Using sqlcmd fallback for data extraction.');
  } else {
    log('Connected to SQL Server via mssql/tedious.');
  }

  // ── Helper: query wrapper ──────────────────────────────────────────────────
  async function sqlQuery(queryStr) {
    if (!useSqlCmd) {
      const result = await pool.request().query(queryStr);
      return result.recordset;
    } else {
      const cmd = `sqlcmd -S "${serverInstance}" -d "${database}" -Q "${queryStr.replace(/"/g, '\\"')}" -s "\t" -W -h -1`;
      const output = execSync(cmd, { encoding: 'utf-8', maxBuffer: 512 * 1024 * 1024, timeout: 600000 });
      const lines = output.split('\n').map(l => l.trimEnd()).filter(l => l.length > 0 && !l.startsWith('(') && l !== 'Changed database context');
      return lines;
    }
  }

  // ── Initialize SQLite (file-based via better-sqlite3) ──────────────────────
  if (existsSync(outputPath)) unlinkSync(outputPath);
  const db = new Database(outputPath);

  // Performance pragmas for bulk write
  db.pragma('journal_mode = OFF');
  db.pragma('synchronous = OFF');
  db.pragma('cache_size = -200000');  // 200 MB cache
  db.pragma('locking_mode = EXCLUSIVE');

  log('Creating SQLite schema...');
  for (const stmt of SCHEMA_STATEMENTS) {
    db.exec(stmt);
  }

  // Insert kind map
  const stmtKind = db.prepare('INSERT INTO kind_map (id, name) VALUES (?, ?)');
  for (const [id, name] of Object.entries(KIND_MAP)) {
    stmtKind.run(Number(id), name);
  }

  // ── Export Providers ───────────────────────────────────────────────────────
  log('Exporting Providers...');
  if (!useSqlCmd) {
    const rows = await sqlQuery('SELECT [Id], [Provider] FROM [Providers] ORDER BY [Id]');
    const stmt = db.prepare('INSERT INTO providers (id, provider) VALUES (?, ?)');
    for (const row of rows) {
      stmt.run(row.Id, row.Provider);
    }
    log(`  ${rows.length} providers`);
  } else {
    const lines = await sqlQuery('SELECT [Id], [Provider] FROM [Providers] ORDER BY [Id]');
    const stmt = db.prepare('INSERT INTO providers (id, provider) VALUES (?, ?)');
    for (const line of lines) {
      const [id, prov] = line.split('\t').map(s => s.trim());
      stmt.run(Number(id), prov);
    }
    log(`  ${lines.length} providers`);
  }

  // ── Export Modules ─────────────────────────────────────────────────────────
  log('Exporting Modules...');
  if (!useSqlCmd) {
    const rows = await sqlQuery('SELECT [Id], [Module] FROM [Modules] ORDER BY [Id]');
    const stmt = db.prepare('INSERT INTO modules (id, module) VALUES (?, ?)');
    for (const row of rows) {
      stmt.run(row.Id, row.Module);
    }
    log(`  ${rows.length} modules`);
  } else {
    const lines = await sqlQuery('SELECT [Id], [Module] FROM [Modules] ORDER BY [Id]');
    const stmt = db.prepare('INSERT INTO modules (id, module) VALUES (?, ?)');
    for (const line of lines) {
      const [id, mod] = line.split('\t').map(s => s.trim());
      stmt.run(Number(id), mod);
    }
    log(`  ${lines.length} modules`);
  }

  // ── Export Names (5.8M rows) ───────────────────────────────────────────────
  log('Exporting Names (~5.8M rows)...');
  const stmtName = db.prepare('INSERT INTO names (id, path, provider_id, module_id) VALUES (?, ?, ?, ?)');
  let nameCount = 0;

  if (!useSqlCmd) {
    const BATCH = 500000;
    let offset = 0;
    let txn = db.transaction(() => {});
    db.exec('BEGIN TRANSACTION');
    while (true) {
      const rows = await sqlQuery(`SELECT [Id], [Path], [ProviderId], [ModuleId] FROM [Names] ORDER BY [Id] OFFSET ${offset} ROWS FETCH NEXT ${BATCH} ROWS ONLY`);
      if (rows.length === 0) break;
      for (const row of rows) {
        stmtName.run(row.Id, row.Path, row.ProviderId, row.ModuleId);
        nameCount++;
      }
      offset += BATCH;
      db.exec('COMMIT');
      log(`  ${(nameCount / 1000000).toFixed(1)}M names...`);
      db.exec('BEGIN TRANSACTION');
      if (rows.length < BATCH) break;
    }
    db.exec('COMMIT');
  } else {
    const BATCH = 500000;
    let offset = 0;
    db.exec('BEGIN TRANSACTION');
    while (true) {
      const q = `SELECT [Id], [Path], [ProviderId], [ModuleId] FROM [Names] ORDER BY [Id] OFFSET ${offset} ROWS FETCH NEXT ${BATCH} ROWS ONLY`;
      const cmd = `sqlcmd -S "${serverInstance}" -d "${database}" -Q "${q}" -s "\t" -W -h -1`;
      const output = execSync(cmd, { encoding: 'utf-8', maxBuffer: 512 * 1024 * 1024, timeout: 600000 });
      const lines = output.split('\n').map(l => l.trimEnd()).filter(l => l.length > 0 && !l.startsWith('(') && l !== 'Changed database context');
      if (lines.length === 0) break;
      for (const line of lines) {
        const parts = line.split('\t').map(s => s.trim());
        if (parts.length >= 4) {
          stmtName.run(Number(parts[0]), parts[1], Number(parts[2]), Number(parts[3]));
          nameCount++;
        }
      }
      offset += BATCH;
      db.exec('COMMIT');
      log(`  ${(nameCount / 1000000).toFixed(1)}M names...`);
      db.exec('BEGIN TRANSACTION');
      if (lines.length < BATCH) break;
    }
    db.exec('COMMIT');
  }
  log(`  ${nameCount.toLocaleString()} names exported`);

  // ── Export References (26.6M rows) ─────────────────────────────────────────
  log('Exporting References (~26.6M rows - this will take several minutes)...');
  const stmtRef = db.prepare('INSERT INTO refs (source_id, target_id, kind, line, col) VALUES (?, ?, ?, ?, ?)');
  let refCount = 0;

  if (!useSqlCmd) {
    const BATCH = 1000000;
    let offset = 0;
    db.exec('BEGIN TRANSACTION');
    while (true) {
      const rows = await sqlQuery(`SELECT [SourceId], [TargetId], [Kind], [Line], [Column] FROM [References] ORDER BY [SourceId], [TargetId] OFFSET ${offset} ROWS FETCH NEXT ${BATCH} ROWS ONLY`);
      if (rows.length === 0) break;
      for (const row of rows) {
        stmtRef.run(row.SourceId, row.TargetId, row.Kind, row.Line ?? null, row.Column ?? null);
        refCount++;
      }
      offset += BATCH;
      db.exec('COMMIT');
      log(`  ${(refCount / 1000000).toFixed(1)}M refs...`);
      db.exec('BEGIN TRANSACTION');
      if (rows.length < BATCH) break;
    }
    db.exec('COMMIT');
  } else {
    const BATCH = 500000;
    let offset = 0;
    db.exec('BEGIN TRANSACTION');
    while (true) {
      const q = `SELECT [SourceId], [TargetId], [Kind], [Line], [Column] FROM [References] ORDER BY [SourceId], [TargetId] OFFSET ${offset} ROWS FETCH NEXT ${BATCH} ROWS ONLY`;
      const cmd = `sqlcmd -S "${serverInstance}" -d "${database}" -Q "${q}" -s "\t" -W -h -1`;
      const output = execSync(cmd, { encoding: 'utf-8', maxBuffer: 512 * 1024 * 1024, timeout: 600000 });
      const lines = output.split('\n').map(l => l.trimEnd()).filter(l => l.length > 0 && !l.startsWith('(') && l !== 'Changed database context');
      if (lines.length === 0) break;
      for (const line of lines) {
        const parts = line.split('\t').map(s => s.trim());
        if (parts.length >= 5) {
          const lineNum = parts[3] === 'NULL' || parts[3] === '' ? null : Number(parts[3]);
          const colNum = parts[4] === 'NULL' || parts[4] === '' ? null : Number(parts[4]);
          stmtRef.run(Number(parts[0]), Number(parts[1]), Number(parts[2]), lineNum, colNum);
          refCount++;
        }
      }
      offset += BATCH;
      db.exec('COMMIT');
      log(`  ${(refCount / 1000000).toFixed(1)}M refs...`);
      db.exec('BEGIN TRANSACTION');
      if (lines.length < BATCH) break;
    }
    db.exec('COMMIT');
  }
  log(`  ${refCount.toLocaleString()} references exported`);

  // ── Create indexes ─────────────────────────────────────────────────────────
  log('Creating indexes (this takes a minute)...');
  for (const idxStmt of INDEX_STATEMENTS) {
    log(`  ${idxStmt.match(/idx_\w+/)?.[0] || 'index'}...`);
    db.exec(idxStmt);
  }
  log('  Indexes created.');

  // ── Metadata ───────────────────────────────────────────────────────────────
  log('Writing metadata...');
  const stmtMeta = db.prepare('INSERT INTO xref_metadata (key, value) VALUES (?, ?)');
  stmtMeta.run('source_server', serverInstance);
  stmtMeta.run('source_database', database);
  stmtMeta.run('build_date', new Date().toISOString());
  stmtMeta.run('name_count', String(nameCount));
  stmtMeta.run('ref_count', String(refCount));

  // ── Close database (writes are already on disk) ────────────────────────────
  db.close();

  if (pool) await pool.close();

  const fileSizeMB = (statSync(outputPath).size / 1024 / 1024).toFixed(1);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  log(``);
  log(`==============================================================`);
  log(`  BUILD COMPLETE`);
  log(`  Names:      ${nameCount.toLocaleString()}`);
  log(`  References: ${refCount.toLocaleString()}`);
  log(`  File size:  ${fileSizeMB} MB`);
  log(`  Time:       ${elapsed}s`);
  log(`  Output:     ${outputPath}`);
  log(`==============================================================`);
}

build().catch(err => {
  console.error('BUILD FAILED:', err);
  process.exit(1);
});
