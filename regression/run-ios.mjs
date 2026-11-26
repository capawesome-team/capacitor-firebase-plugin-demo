// Usage: node regression/run-ios.mjs --package <name> --tgz <tarball> --out <output file> --project-id <default app project id>
//          --udid <booted simulator> [--work-dir <dir>] [--derived-data <dir>] [--skip-clean-reinstall]
// Needs: a booted iOS simulator and the Firestore emulator on 127.0.0.1:8080.
import { spawn } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  APP_ID,
  CAP_BIN,
  DEFAULT_WORK_DIR,
  DEMO_DIR,
  PHASES,
  assertEmulatorRunning,
  clearEmulator,
  createLogger,
  dumpEmulatorDocuments,
  parseArgs,
  resolveCasesPath,
  restorePackage,
  sleep,
  swapPackage,
  writeOutput,
} from './lib/common.mjs';

const PUBLIC_DIR = join(DEMO_DIR, 'ios/App/App/public');
const PHASE_FILE = 'regression-phase.txt';
const PHASE_TIMEOUT_MS = 10 * 60 * 1000;
const CRASH_PATTERN = /Terminating app|terminating due to|Fatal error|EXC_|SIGABRT|SIGSEGV/;

const args = parseArgs(process.argv.slice(2));
if (!args.package || !args.tgz || !args.out || !args['project-id'] || !args.udid) {
  console.error('Usage: node regression/run-ios.mjs --package <name> --tgz <tarball> --out <output file> --project-id <project id> --udid <udid> [--work-dir <dir>] [--derived-data <dir>] [--skip-clean-reinstall]');
  process.exit(2);
}
const packageName = args.package;
const casesPath = resolveCasesPath(packageName);
const tarballPath = resolve(args.tgz);
const outputPath = resolve(args.out);
const projectId = args['project-id'];
const udid = args.udid;
const workDir = resolve(args['work-dir'] || DEFAULT_WORK_DIR);
// Derived data keeps absolute paths, so it must stay where it was created.
const derivedDataPath = resolve(args['derived-data'] || join(workDir, 'ios-derived-data'));
const logger = createLogger(outputPath + '.log');
const { log, run } = logger;
const consoleLogPath = outputPath + '.console.log';

const BOOT_SCRIPT = `(function () {
  async function readPhase() {
    try {
      const result = await Capacitor.nativePromise('Filesystem', 'readFile', { path: '${PHASE_FILE}', directory: 'DOCUMENTS', encoding: 'utf8' });
      return String(result.data).trim();
    } catch (error) {
      return null;
    }
  }
  async function main() {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const phase = await readPhase();
    if (!phase) {
      console.log('REGRESSION_IDLE');
      return;
    }
    console.log('REGRESSION_PHASE ' + phase);
    const outputFile = 'regression-output-' + phase + '.txt';
    let writing = Promise.resolve();
    const onLine = (line, lines) => {
      const data = lines.join('\\n') + '\\n';
      writing = writing
        .then(() => Capacitor.nativePromise('Filesystem', 'writeFile', { path: outputFile, data, directory: 'DOCUMENTS', encoding: 'utf8' }))
        .catch((error) => console.log('REGRESSION_WRITE_ERROR ' + error.message));
      return writing;
    };
    await globalThis.__regressionRun(phase, { host: '127.0.0.1', onLine });
    await writing;
    console.log('REGRESSION_DONE ' + phase);
  }
  main().catch((error) => console.log('REGRESSION_SCRIPT_ERROR ' + error.message));
})();
`;

function injectScripts() {
  copyFileSync(casesPath, join(PUBLIC_DIR, 'regression-cases.js'));
  writeFileSync(join(PUBLIC_DIR, 'regression-boot.js'), BOOT_SCRIPT);
  const indexPath = join(PUBLIC_DIR, 'index.html');
  const html = readFileSync(indexPath, 'utf8');
  const anchor = '<app-root></app-root>';
  if (!html.includes(anchor)) {
    throw new Error('index.html has no <app-root> anchor');
  }
  writeFileSync(indexPath, html.replace(anchor, anchor + '<script src="regression-cases.js"></script><script src="regression-boot.js"></script>'));
}

function buildAndInstall() {
  run('xcodebuild', [
    '-project', join(DEMO_DIR, 'ios/App/App.xcodeproj'),
    '-scheme', 'App',
    '-destination', `platform=iOS Simulator,id=${udid}`,
    '-derivedDataPath', derivedDataPath,
    'build',
  ], { cwd: DEMO_DIR });
  run('xcrun', ['simctl', 'install', udid, join(derivedDataPath, 'Build/Products/Debug-iphonesimulator/App.app')]);
}

const terminateApp = () => run('xcrun', ['simctl', 'terminate', udid, APP_ID], { allowFailure: true, quiet: true });

async function runPhase(phase, documentsDir) {
  log(`phase ${phase}: start`);
  const outputFile = join(documentsDir, `regression-output-${phase}.txt`);
  const phaseFile = join(documentsDir, PHASE_FILE);
  rmSync(outputFile, { force: true });
  writeFileSync(phaseFile, phase);
  terminateApp();
  await sleep(1000);
  const child = spawn('xcrun', ['simctl', 'launch', '--console-pty', udid, APP_ID]);
  const crashLines = [];
  let isDone = false;
  let buffer = '';
  const handleOutput = (chunk) => {
    const text = chunk.toString();
    appendFileSync(consoleLogPath, text);
    buffer += text;
    const parts = buffer.split('\n');
    buffer = parts.pop();
    for (const line of parts) {
      if (line.includes(`REGRESSION_DONE ${phase}`)) {
        isDone = true;
      }
      if (CRASH_PATTERN.test(line)) {
        crashLines.push(line.trim());
      }
    }
  };
  child.stdout.on('data', handleOutput);
  child.stderr.on('data', handleOutput);
  let hasExited = false;
  const exited = new Promise((resolveExit) => child.on('exit', (code) => {
    hasExited = true;
    resolveExit(code);
  }));
  const start = Date.now();
  while (!isDone && !hasExited && Date.now() - start < PHASE_TIMEOUT_MS) {
    await sleep(500);
  }
  const lines = existsSync(outputFile) ? readFileSync(outputFile, 'utf8').split('\n').filter((line) => line.length > 0) : [];
  if (!isDone) {
    const reason = hasExited ? 'app process ended' : 'timeout';
    log(`phase ${phase}: not finished (${reason}). Crash lines:\n${crashLines.join('\n')}`);
    lines.push(`CASE ${phase} CRASH: ${JSON.stringify({ crashLines: crashLines.slice(0, 2), reason })}`);
  }
  terminateApp();
  await Promise.race([exited, sleep(10000)]);
  child.kill();
  rmSync(phaseFile, { force: true });
  rmSync(outputFile, { force: true });
  log(`phase ${phase}: ${lines.length} lines`);
  return lines;
}

async function main() {
  await assertEmulatorRunning();
  writeFileSync(consoleLogPath, '');
  swapPackage({ packageName, tarballPath, workDir }, logger);
  try {
    run(CAP_BIN, ['sync', 'ios'], { cwd: DEMO_DIR });
    injectScripts();
    buildAndInstall();
    await clearEmulator(projectId, logger);
    const container = run('xcrun', ['simctl', 'get_app_container', udid, APP_ID, 'data'], { quiet: true }).stdout.trim();
    const documentsDir = join(container, 'Documents');
    mkdirSync(documentsDir, { recursive: true });
    const lines = [];
    for (const phase of PHASES) {
      lines.push(...(await runPhase(phase, documentsDir)));
    }
    lines.push(...(await dumpEmulatorDocuments(projectId)));
    writeOutput(outputPath, lines, projectId);
    log(`wrote ${lines.length} lines to ${outputPath}`);
  } finally {
    terminateApp();
    restorePackage({ packageName, workDir }, logger);
    run(CAP_BIN, ['sync', 'ios'], { cwd: DEMO_DIR });
    if (!args['skip-clean-reinstall']) {
      buildAndInstall();
      log('clean build installed');
    }
  }
}

main().catch((error) => {
  log(`FAILED: ${error.stack || error.message}`);
  process.exitCode = 1;
});
