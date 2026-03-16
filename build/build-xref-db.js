/**
 * build-xref-db.js
 * Extracts D365FO cross-reference data from LocalDB (SQL Server) into a SQLite database.
 * Uses the mssql/tedious package for efficient streaming of large result sets.
 *
 * Usage:
 *   node build-xref-db.js [serverInstance] [databaseName] [outputPath]
 *
 * Defaults:
 *   serverInstance = (LocalDB)\MSSQLLocalDB
 *   databaseName   = XRef_tbg-dev3651002263172
 *   outputPath     = %USERPROFILE%\.claude\d365fo_xref.sqlite
 */

import { join } from 'path';
import { writeFileSync, existsSync, unlinkSync, openSync, writeSync, closeSync } from 'fs';
import { execSync } from 'child_process';
import sql from 'mssql';
import initSqlJs from 'sql.js';

// ── Configuration ──────────────────────────────────────────────────────────────

const DEFAULT_INSTANCE = String.raw`(LocalDB)\MSSQLLocalDB`;
const DEFAULT_DATABASE = 'XRef_tbg-dev3651002263172';
const DEFAULT_OUTPUT = join(process.env.USERPROFILE, '.claude', 'd365fo_xref.sqlite');

const serverInstance = process.argv[2] || DEFAULT_INSTANCE;
const database = process.argv[3] || DEFAULT_DATABASE;
const outputPath = process.argv[4] || DEFAULT_OUTPUT;

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
  // Extract just the instance name after the backslash
  const parts = instanceName.split('\\');
  const instance = parts[parts.length - 1];

  try {
    const output = execSync(`SqlLocalDB info "${instance}"`, { encoding: 'utf-8' });
    const pipeMatch = output.match(/Instance pipe name:\s*(np:\\.+)/i);
    if (pipeMatch) return pipeMatch[1];
  } catch (e) {
    // Ignore
  }

  // Try starting the instance
  try {
    const output = execSync(`SqlLocalDB start "${instance}"`, { encoding: 'utf-8' });
    const output2 = execSync(`SqlLocalDB info "${instance}"`, { encoding: 'utf-8' });
    const pipeMatch = output2.match(/Instance pipe name:\s*(np:\\.+)/i);
    if (pipeMatch) return pipeMatch[1];
  } catch (e) {
    // Ignore
  }

  return null;
}

// ── Main Build ─────────────────────────────────────────────────────────────────

async function build() {
  const startTime = Date.now();
  log(`D365FO XRef → SQLite Builder`);
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

  // Extract pipe path for tedious server option
  // np:\\.\pipe\LOCALDB#032FB0BA\tsql\query → \\.\pipe\LOCALDB#032FB0BA\tsql\query
  const pipePath = pipe.replace(/^np:/, '');

  const config = {
    server: pipePath,
    database: database,
    options: {
      trustServerCertificate: true,
      instanceName: undefined,
    },
    driver: 'tedious',
    connectionString: `Server=${pipe};Database=${database};Trusted_Connection=yes;TrustServerCertificate=yes;`,
  };

  // tedious needs special config for named pipes / LocalDB
  // Use the connection string approach
  log('Connecting to SQL Server...');

  let pool;
  try {
    pool = await sql.connect(`Server=${pipe};Database=${database};Trusted_Connection=yes;TrustServerCertificate=yes;Driver=msnodesqlv8`);
  } catch (err1) {
    // Fallback: try direct server name connection
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

  // If mssql connection fails, fall back to sqlcmd
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
      // sqlcmd fallback
      const cmd = `sqlcmd -S "${serverInstance}" -d "${database}" -Q "${queryStr.replace(/"/g, '\\"')}" -s "\t" -W -h -1`;
      const output = execSync(cmd, { encoding: 'utf-8', maxBuffer: 512 * 1024 * 1024, timeout: 600000 });
      const lines = output.split('\n').map(l => l.trimEnd()).filter(l => l.length > 0 && !l.startsWith('(') && l !== 'Changed database context');
      return lines; // raw lines (tab-separated), caller must parse
    }
  }

  // ── Initialize SQLite ──────────────────────────────────────────────────────
  const SQL = await initSqlJs();
  const db = new SQL.Database();

  log('Creating SQLite schema...');
  for (const stmt of SCHEMA_STATEMENTS) {
    db.run(stmt);
  }

  // Insert kind map
  const stmtKind = db.prepare('INSERT INTO kind_map (id, name) VALUES (?, ?)');
  for (const [id, name] of Object.entries(KIND_MAP)) {
    stmtKind.run([Number(id), name]);
  }
  stmtKind.free();

  // ── Export Providers ───────────────────────────────────────────────────────
  log('Exporting Providers...');
  if (!useSqlCmd) {
    const rows = await sqlQuery('SELECT [Id], [Provider] FROM [Providers] ORDER BY [Id]');
    const stmt = db.prepare('INSERT INTO providers (id, provider) VALUES (?, ?)');
    for (const row of rows) {
      stmt.run([row.Id, row.Provider]);
    }
    stmt.free();
    log(`  ${rows.length} providers`);
  } else {
    const lines = await sqlQuery('SELECT [Id], [Provider] FROM [Providers] ORDER BY [Id]');
    const stmt = db.prepare('INSERT INTO providers (id, provider) VALUES (?, ?)');
    for (const line of lines) {
      const [id, prov] = line.split('\t').map(s => s.trim());
      stmt.run([Number(id), prov]);
    }
    stmt.free();
    log(`  ${lines.length} providers`);
  }

  // ── Export Modules ─────────────────────────────────────────────────────────
  log('Exporting Modules...');
  if (!useSqlCmd) {
    const rows = await sqlQuery('SELECT [Id], [Module] FROM [Modules] ORDER BY [Id]');
    const stmt = db.prepare('INSERT INTO modules (id, module) VALUES (?, ?)');
    for (const row of rows) {
      stmt.run([row.Id, row.Module]);
    }
    stmt.free();
    log(`  ${rows.length} modules`);
  } else {
    const lines = await sqlQuery('SELECT [Id], [Module] FROM [Modules] ORDER BY [Id]');
    const stmt = db.prepare('INSERT INTO modules (id, module) VALUES (?, ?)');
    for (const line of lines) {
      const [id, mod] = line.split('\t').map(s => s.trim());
      stmt.run([Number(id), mod]);
    }
    stmt.free();
    log(`  ${lines.length} modules`);
  }

  // ── Export Names (5.8M rows) ───────────────────────────────────────────────
  log('Exporting Names (~5.8M rows)...');
  const stmtName = db.prepare('INSERT INTO names (id, path, provider_id, module_id) VALUES (?, ?, ?, ?)');
  let nameCount = 0;

  if (!useSqlCmd) {
    // Stream via batched queries for memory efficiency
    const BATCH = 500000;
    let offset = 0;
    db.run('BEGIN TRANSACTION');
    while (true) {
      const rows = await sqlQuery(`SELECT [Id], [Path], [ProviderId], [ModuleId] FROM [Names] ORDER BY [Id] OFFSET ${offset} ROWS FETCH NEXT ${BATCH} ROWS ONLY`);
      if (rows.length === 0) break;
      for (const row of rows) {
        stmtName.run([row.Id, row.Path, row.ProviderId, row.ModuleId]);
        nameCount++;
      }
      offset += BATCH;
      db.run('COMMIT');
      log(`  ${(nameCount / 1000000).toFixed(1)}M names...`);
      db.run('BEGIN TRANSACTION');
      if (rows.length < BATCH) break;
    }
    db.run('COMMIT');
  } else {
    // sqlcmd batched extraction
    const BATCH = 500000;
    let offset = 0;
    db.run('BEGIN TRANSACTION');
    while (true) {
      const q = `SELECT [Id], [Path], [ProviderId], [ModuleId] FROM [Names] ORDER BY [Id] OFFSET ${offset} ROWS FETCH NEXT ${BATCH} ROWS ONLY`;
      const cmd = `sqlcmd -S "${serverInstance}" -d "${database}" -Q "${q}" -s "\t" -W -h -1`;
      const output = execSync(cmd, { encoding: 'utf-8', maxBuffer: 512 * 1024 * 1024, timeout: 600000 });
      const lines = output.split('\n').map(l => l.trimEnd()).filter(l => l.length > 0 && !l.startsWith('(') && l !== 'Changed database context');
      if (lines.length === 0) break;
      for (const line of lines) {
        const parts = line.split('\t').map(s => s.trim());
        if (parts.length >= 4) {
          stmtName.run([Number(parts[0]), parts[1], Number(parts[2]), Number(parts[3])]);
          nameCount++;
        }
      }
      offset += BATCH;
      db.run('COMMIT');
      log(`  ${(nameCount / 1000000).toFixed(1)}M names...`);
      db.run('BEGIN TRANSACTION');
      if (lines.length < BATCH) break;
    }
    db.run('COMMIT');
  }
  stmtName.free();
  log(`  ${nameCount.toLocaleString()} names exported`);

  // ── Export References (26.6M rows) ─────────────────────────────────────────
  log('Exporting References (~26.6M rows - this will take several minutes)...');
  const stmtRef = db.prepare('INSERT INTO refs (source_id, target_id, kind, line, col) VALUES (?, ?, ?, ?, ?)');
  let refCount = 0;

  if (!useSqlCmd) {
    const BATCH = 1000000;
    let offset = 0;
    db.run('BEGIN TRANSACTION');
    while (true) {
      const rows = await sqlQuery(`SELECT [SourceId], [TargetId], [Kind], [Line], [Column] FROM [References] ORDER BY [SourceId], [TargetId] OFFSET ${offset} ROWS FETCH NEXT ${BATCH} ROWS ONLY`);
      if (rows.length === 0) break;
      for (const row of rows) {
        stmtRef.run([row.SourceId, row.TargetId, row.Kind, row.Line ?? null, row.Column ?? null]);
        refCount++;
      }
      offset += BATCH;
      db.run('COMMIT');
      log(`  ${(refCount / 1000000).toFixed(1)}M refs...`);
      db.run('BEGIN TRANSACTION');
      if (rows.length < BATCH) break;
    }
    db.run('COMMIT');
  } else {
    const BATCH = 500000;
    let offset = 0;
    db.run('BEGIN TRANSACTION');
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
          stmtRef.run([Number(parts[0]), Number(parts[1]), Number(parts[2]), lineNum, colNum]);
          refCount++;
        }
      }
      offset += BATCH;
      db.run('COMMIT');
      log(`  ${(refCount / 1000000).toFixed(1)}M refs...`);
      db.run('BEGIN TRANSACTION');
      if (lines.length < BATCH) break;
    }
    db.run('COMMIT');
  }
  stmtRef.free();
  log(`  ${refCount.toLocaleString()} references exported`);

  // ── Create indexes ─────────────────────────────────────────────────────────
  log('Creating indexes (this takes a minute)...');
  for (const stmt of INDEX_STATEMENTS) {
    log(`  ${stmt.match(/idx_\w+/)?.[0] || 'index'}...`);
    db.run(stmt);
  }
  log('  Indexes created.');

  // ── Metadata ───────────────────────────────────────────────────────────────
  log('Writing metadata...');
  const stmtMeta = db.prepare('INSERT INTO xref_metadata (key, value) VALUES (?, ?)');
  stmtMeta.run(['source_server', serverInstance]);
  stmtMeta.run(['source_database', database]);
  stmtMeta.run(['build_date', new Date().toISOString()]);
  stmtMeta.run(['name_count', String(nameCount)]);
  stmtMeta.run(['ref_count', String(refCount)]);
  stmtMeta.free();

  // ── Write to disk ──────────────────────────────────────────────────────────
  log('Writing SQLite database to disk...');
  if (existsSync(outputPath)) unlinkSync(outputPath);
  const data = db.export();  // Returns Uint8Array (may exceed 2 GB)
  db.close();

  // Write in chunks to avoid Node.js Buffer 2 GB limit
  const CHUNK_SIZE = 256 * 1024 * 1024;  // 256 MB chunks
  const fd = openSync(outputPath, 'w');
  let written = 0;
  while (written < data.byteLength) {
    const end = Math.min(written + CHUNK_SIZE, data.byteLength);
    const chunk = data.subarray(written, end);
    writeSync(fd, chunk);
    written = end;
    if (data.byteLength > CHUNK_SIZE) {
      log(`  Written ${(written / 1024 / 1024).toFixed(0)} / ${(data.byteLength / 1024 / 1024).toFixed(0)} MB...`);
    }
  }
  closeSync(fd);

  if (pool) await pool.close();

  const fileSizeMB = (data.byteLength / 1024 / 1024).toFixed(1);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  log(``);
  log(`══════════════════════════════════════════════════════════════`);
  log(`  BUILD COMPLETE`);
  log(`  Names:      ${nameCount.toLocaleString()}`);
  log(`  References: ${refCount.toLocaleString()}`);
  log(`  File size:  ${fileSizeMB} MB`);
  log(`  Time:       ${elapsed}s`);
  log(`  Output:     ${outputPath}`);
  log(`══════════════════════════════════════════════════════════════`);
}

build().catch(err => {
  console.error('BUILD FAILED:', err);
  process.exit(1);
});
