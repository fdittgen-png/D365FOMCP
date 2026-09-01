/**
 * xref-source.js
 *
 * Connection to the D365FO cross-reference SQL database — the LocalDB instance
 * the X++ compiler writes when a model is built with `GenerateCrossReferences`.
 *
 * Extracted so `build/update-xref-module.js` does not re-implement the three-way
 * connect dance (named pipe -> server name -> sqlcmd) that `build-xref-db.js`
 * works out at the top of its build. The full builder still carries its own copy:
 * it is a 20-60 minute path that runs rarely, and moving it onto this module is a
 * refactor worth doing on its own, not as a side effect of adding the delta path.
 *
 * `query()` always returns an array of row OBJECTS, including on the sqlcmd
 * fallback — the caller passes a column list and the tab-separated output is
 * zipped back into objects here, so the two transports are interchangeable.
 */

import { execSync } from 'child_process';
import sql from 'mssql';

/** Resolve (and if necessary start) the named pipe of a LocalDB instance. */
export function getLocalDbPipe(instanceName, log = () => {}) {
  const instance = instanceName.split('\\').pop();
  const read = () => {
    const output = execSync(`SqlLocalDB info "${instance}"`, { encoding: 'utf-8' });
    return output.match(/Instance pipe name:\s*(np:\\.+)/i)?.[1] ?? null;
  };
  try {
    const pipe = read();
    if (pipe) return pipe;
  } catch (e) {
    log(`SqlLocalDB info failed: ${e.message}`);
  }
  try {
    execSync(`SqlLocalDB start "${instance}"`, { encoding: 'utf-8' });
    return read();
  } catch (e) {
    log(`SqlLocalDB start failed: ${e.message}`);
    return null;
  }
}

/** `NULL` and the empty string both mean "no value" in sqlcmd's -W output. */
function coerce(raw) {
  if (raw === undefined || raw === 'NULL' || raw === '') return null;
  return raw;
}

/**
 * Open the cross-reference source.
 *
 * @returns {Promise<{query(sqlText:string, columns:string[]):Promise<object[]>,
 *                    close():Promise<void>, transport:'tedious'|'sqlcmd'}>}
 */
export async function openXrefSource({ serverInstance, database, log = () => {} }) {
  if (!database) throw new Error('No cross-reference database name provided.');

  const pipe = getLocalDbPipe(serverInstance, log);
  let pool = null;

  if (pipe) {
    try {
      pool = await sql.connect(`Server=${pipe};Database=${database};Trusted_Connection=yes;TrustServerCertificate=yes;Driver=msnodesqlv8`);
    } catch (err) {
      log(`  pipe connection failed (${err.message}), trying server name...`);
    }
  }
  if (!pool) {
    try {
      pool = await sql.connect({
        server: serverInstance.replace(/^\(/, '').replace(/\)$/, '').replace('\\', '\\\\'),
        database,
        options: { trustServerCertificate: true, trustedConnection: true, encrypt: false },
      });
    } catch (err) {
      log(`  server-name connection failed (${err.message}); using the sqlcmd fallback.`);
      pool = null;
    }
  }

  const transport = pool ? 'tedious' : 'sqlcmd';
  log(`  transport: ${transport}`);

  async function query(sqlText, columns) {
    if (pool) return (await pool.request().query(sqlText)).recordset;

    // execSync goes through cmd.exe, where a literal newline inside the -Q
    // argument TERMINATES the command: sqlcmd then runs a truncated query and
    // the trailing lines come back as shell errors, which this parser happily
    // reads as data rows. Collapse the statement to one line first. (Symptom
    // when this is missing: a 37,466-row module reports 2 names.)
    const oneLine = sqlText.replace(/\s+/g, ' ').trim();
    const cmd = `sqlcmd -S "${serverInstance}" -d "${database}" -Q "${oneLine.replace(/"/g, '\\"')}" -s "\t" -W -h -1`;
    const output = execSync(cmd, { encoding: 'utf-8', maxBuffer: 512 * 1024 * 1024, timeout: 600000 });
    const rows = [];
    for (const line of output.split('\n')) {
      const trimmed = line.trimEnd();
      if (!trimmed || trimmed.startsWith('(') || trimmed === 'Changed database context') continue;
      const parts = trimmed.split('\t');
      const row = {};
      columns.forEach((c, i) => { row[c] = coerce(parts[i] === undefined ? undefined : parts[i].trim()); });
      rows.push(row);
    }
    return rows;
  }

  return {
    transport,
    query,
    async close() { if (pool) await pool.close(); },
  };
}
