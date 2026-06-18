/**
 * release-output-lock.js
 *
 * Pre-flight helper for the SQLite database builders. On Windows, the local
 * stdio MCP servers (`src/local/mcp-server-{kb,xref,sec}.js`) keep an open
 * `better-sqlite3` handle on the output `.sqlite` file. That handle blocks
 * `unlinkSync`/`rmSync` with EBUSY when a builder tries to overwrite the file.
 *
 * This helper finds any node.exe processes whose command line references both
 * an `mcp-server-{kb,xref,sec}.js` script AND the target output path, and
 * terminates them. No-op on non-Windows platforms (POSIX allows unlinking
 * open files).
 */

import { execFileSync } from 'child_process';
import { resolve } from 'path';

export function releaseOutputLock(outputPath) {
  if (process.platform !== 'win32') return;

  const abs = resolve(outputPath).replace(/'/g, "''");

  const script = `
    $target = '${abs}';
    $procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
      Where-Object {
        $_.CommandLine -match 'mcp-server-(kb|xref|sec)\\.js' -and
        $_.CommandLine -like "*$target*"
      };
    foreach ($p in $procs) {
      Write-Host ("  Releasing SQLite lock from PID {0}: {1}" -f $p.ProcessId, $p.CommandLine);
      Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue;
    }
  `;

  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      stdio: 'inherit',
    });
  } catch (err) {
    console.warn(`  Warning: releaseOutputLock probe failed (${err.message}). If the next step throws EBUSY, kill node.exe processes holding ${outputPath} manually.`);
  }
}
