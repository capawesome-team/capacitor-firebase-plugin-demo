// Shared helpers for run-android.mjs and run-ios.mjs.
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LIB_DIR = dirname(fileURLToPath(import.meta.url));
const REGRESSION_DIR = dirname(LIB_DIR);
export const DEMO_DIR = dirname(REGRESSION_DIR);
export const DEFAULT_WORK_DIR = join(REGRESSION_DIR, '.work');
export const APP_ID = JSON.parse(readFileSync(join(DEMO_DIR, 'capacitor.config.json'), 'utf8')).appId;
export const PHASES = ['main', 'settingsA', 'settingsB'];
export const CAP_BIN = join(DEMO_DIR, 'node_modules/.bin/cap');

const CASES_DIR = join(REGRESSION_DIR, 'cases');
const SWAP_MARKER = '.regression-swapped';
const EMULATOR_URL = 'http://127.0.0.1:8080';
const DUMPED_COLLECTIONS = ['types'];
const DUMPED_DOCUMENTS = ['fv/a', 'settings/a', 'settings/b'];
const SERVER_TIME_PREFIX = 'serverTime';

export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '');
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

/** Returns the case file of the package. Throws when the package has none. */
export function resolveCasesPath(packageName) {
  const casesPath = join(CASES_DIR, `${packageName}.js`);
  if (!existsSync(casesPath)) {
    throw new Error(`No case file for package ${packageName} at ${casesPath}`);
  }
  return casesPath;
}

export function createLogger(logPath) {
  mkdirSync(dirname(logPath), { recursive: true });
  writeFileSync(logPath, '');
  const log = (message) => {
    appendFileSync(logPath, message + '\n');
    console.log(message);
  };
  const run = (command, args, { cwd, allowFailure = false, quiet = false } = {}) => {
    appendFileSync(logPath, `$ ${command} ${args.join(' ')}\n`);
    const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 1 << 28 });
    appendFileSync(logPath, (result.stdout || '') + (result.stderr || ''));
    if (result.status !== 0 && !allowFailure) {
      throw new Error(`${command} ${args.join(' ')} failed with status ${result.status}`);
    }
    if (!quiet) {
      console.log(`done: ${command} ${args.slice(0, 3).join(' ')} (status ${result.status})`);
    }
    return result;
  };
  return { log, run, logPath };
}

export function swapPackage({ packageName, tarballPath, workDir }, { run }) {
  const { packageDir, backupDir } = resolvePackagePaths({ packageName, workDir });
  if (existsSync(backupDir)) {
    throw new Error(`${backupDir} exists. A previous run did not restore the package. Restore it first.`);
  }
  mkdirSync(dirname(backupDir), { recursive: true });
  run('mv', [packageDir, backupDir]);
  mkdirSync(packageDir);
  writeFileSync(join(packageDir, SWAP_MARKER), '');
  run('tar', ['-xzf', tarballPath, '--strip-components=1', '-C', packageDir]);
}

export function restorePackage({ packageName, workDir }, { run, log }) {
  const { packageDir, backupDir } = resolvePackagePaths({ packageName, workDir });
  if (!existsSync(backupDir)) {
    log('restorePackage: no backup found, nothing to restore');
    return;
  }
  if (existsSync(join(packageDir, SWAP_MARKER))) {
    run('rm', ['-rf', packageDir]);
  }
  if (existsSync(packageDir)) {
    throw new Error(`${packageDir} exists and is not the swapped package. Restore by hand from ${backupDir}.`);
  }
  run('mv', [backupDir, packageDir]);
}

function resolvePackagePaths({ packageName, workDir }) {
  return {
    packageDir: join(DEMO_DIR, 'node_modules/@capacitor-firebase', packageName),
    backupDir: join(workDir, 'backup', packageName),
  };
}

export async function assertEmulatorRunning() {
  try {
    await fetch(EMULATOR_URL + '/');
  } catch (error) {
    throw new Error(`Firestore emulator is not reachable at ${EMULATOR_URL}: ${error.message}`);
  }
}

export async function clearEmulator(projectId, { log }) {
  const response = await fetch(`${EMULATOR_URL}/emulator/v1/projects/${projectId}/databases/(default)/documents`, {
    method: 'DELETE',
  });
  log(`clearEmulator ${projectId}: ${response.status}`);
  if (!response.ok) {
    throw new Error(`Clearing the emulator failed with status ${response.status}`);
  }
}

function normalizeRestValue(value, fieldName) {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeRestValue(item));
  }
  if (value && typeof value === 'object') {
    if (typeof fieldName === 'string' && fieldName.startsWith(SERVER_TIME_PREFIX) && 'timestampValue' in value) {
      return { timestampValue: '<serverTimestamp>' };
    }
    const result = {};
    for (const key of Object.keys(value).sort()) {
      const isFieldsMap = key === 'fields';
      const child = value[key];
      if (isFieldsMap && child && typeof child === 'object') {
        const fields = {};
        for (const name of Object.keys(child).sort()) {
          fields[name] = normalizeRestValue(child[name], name);
        }
        result[key] = fields;
      } else {
        result[key] = normalizeRestValue(child);
      }
    }
    return result;
  }
  return value;
}

async function fetchEmulator(projectId, path) {
  const response = await fetch(`${EMULATOR_URL}/v1/projects/${projectId}/databases/(default)/documents/${path}`, {
    headers: { Authorization: 'Bearer owner' },
  });
  return { status: response.status, body: await response.json() };
}

/** Reads the stored documents from the emulator, so that the stored value types (integer or double) show in the output. */
export async function dumpEmulatorDocuments(projectId) {
  const lines = [];
  for (const collection of DUMPED_COLLECTIONS) {
    const { status, body } = await fetchEmulator(projectId, `${collection}?pageSize=300`);
    if (status !== 200) {
      lines.push(`CASE emulator ${collection}: ${JSON.stringify({ status })}`);
      continue;
    }
    for (const document of body.documents || []) {
      const path = document.name.split('/documents/')[1];
      lines.push(`CASE emulator ${path}: ${JSON.stringify(normalizeRestValue({ fields: document.fields || {} }))}`);
    }
  }
  for (const path of DUMPED_DOCUMENTS) {
    const { status, body } = await fetchEmulator(projectId, path);
    const value = status === 200 ? { fields: body.fields || {} } : { status };
    lines.push(`CASE emulator ${path}: ${JSON.stringify(normalizeRestValue(value))}`);
  }
  return lines;
}

/** Writes the lines and masks the project ID, which differs between the platforms. */
export function writeOutput(outputPath, lines, projectId) {
  mkdirSync(dirname(outputPath), { recursive: true });
  const masked = lines.map((line) => line.split(projectId).join('<projectId>'));
  writeFileSync(outputPath, masked.join('\n') + '\n');
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function poll(check, timeoutMs, intervalMs = 500) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const value = await check();
      if (value) {
        return value;
      }
    } catch {
      // Not ready yet.
    }
    await sleep(intervalMs);
  }
  return null;
}
