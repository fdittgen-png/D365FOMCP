/**
 * D365FO Security Database Builder (CLI)
 *
 * Builds a normalized SQLite database of D365FO security configuration by
 * merging two data sources:
 *   1. AOT metadata (PackagesLocalDirectory) — role/duty/privilege definitions
 *   2. DMF XML exports (PROD) — users, user-role assignments, company scoping
 *
 * Usage:
 *   node build/build-sec.js [packagesPath] [dmfInputDir] [outputPath]
 *
 *   packagesPath  — Comma-separated PackagesLocalDirectory paths (for AOT)
 *   dmfInputDir   — Directory containing DMF XML exports from PROD
 *   outputPath    — Output SQLite file (default: %USERPROFILE%\.claude\d365fo_sec.sqlite)
 *
 * DMF input files (from D365 F&O Data Management Framework):
 *   Required:
 *     - System Security Role.xml
 *     - System Security Sub Role V2.xml
 *     - System Security Role Duty.xml
 *   Optional:
 *     - SystemSecurityUserRoleEntity.xml
 *     - SystemSecurityUserRoleOrganizationEntity.xml
 *     - User information.xml
 *     - SecurityDatabaseCustomizations.xml
 */

import { join } from 'path';
import { buildSecurityDatabase } from '../src/azure/sec-builder.js';
import { releaseOutputLock } from './release-output-lock.js';

const DEFAULT_OUTPUT = join(
  process.env.USERPROFILE || process.env.HOME || '.',
  '.claude', 'd365fo_sec.sqlite'
);

const args = process.argv.slice(2);
const packagesPathArg = args[0] || '';
const dmfInputDir = args[1] || '';
const outputPath = args[2] || DEFAULT_OUTPUT;

if (!packagesPathArg && !dmfInputDir) {
  console.error('Usage: node build-sec.js <packagesPath> <dmfInputDir> [outputPath]');
  console.error('  packagesPath: comma-separated PackagesLocalDirectory paths (or "skip" to skip AOT)');
  console.error('  dmfInputDir:  directory with DMF XML exports (or "skip" to skip DMF)');
  process.exit(1);
}

releaseOutputLock(outputPath);
buildSecurityDatabase({ packagesPathArg, dmfInputDir, outputPath });
