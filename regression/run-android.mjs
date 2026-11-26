// Usage: node regression/run-android.mjs --package <name> --tgz <tarball> --out <output file>
//          [--project-id demo-default] [--serial emulator-5554] [--work-dir <dir>]
// Needs: a booted Android emulator and the Firestore emulator on 127.0.0.1:8080.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  poll,
  resolveCasesPath,
  restorePackage,
  swapPackage,
  writeOutput,
} from './lib/common.mjs';

const DEVTOOLS_PORT = 9223;
const EMULATOR_HOST_FROM_DEVICE = '10.0.2.2';
const GOOGLE_SERVICES_PATH = join(DEMO_DIR, 'android/app/google-services.json');
const APK_PATH = join(DEMO_DIR, 'android/app/build/outputs/apk/debug/app-debug.apk');
const PHASE_TIMEOUT_MS = 10 * 60 * 1000;
const FAKE_PROJECT_NUMBER = '123456789012';
/** Firebase checks only the format of the key: "A" and 38 word characters. */
const FAKE_API_KEY = 'AFakeApiKeyForTheLocalFirebaseEmulator0';

const args = parseArgs(process.argv.slice(2));
if (!args.package || !args.tgz || !args.out) {
  console.error('Usage: node regression/run-android.mjs --package <name> --tgz <tarball> --out <output file> [--project-id demo-default] [--serial emulator-5554] [--work-dir <dir>]');
  process.exit(2);
}
const packageName = args.package;
const casesPath = resolveCasesPath(packageName);
const tarballPath = resolve(args.tgz);
const outputPath = resolve(args.out);
const projectId = args['project-id'] || 'demo-default';
const serial = args.serial || 'emulator-5554';
const workDir = resolve(args['work-dir'] || DEFAULT_WORK_DIR);
const logger = createLogger(outputPath + '.log');
const { log, run } = logger;
const adb = (adbArgs, options) => run('adb', ['-s', serial, ...adbArgs], { quiet: true, ...options });

class CdpSession {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.consoleLines = [];
    this.socket.onmessage = (message) => this.handleMessage(JSON.parse(message.data));
    this.socket.onclose = () => {
      for (const { reject } of this.pending.values()) {
        reject(new Error('DevTools socket closed'));
      }
      this.pending.clear();
    };
  }

  async open() {
    await new Promise((resolveOpen, rejectOpen) => {
      this.socket.onopen = resolveOpen;
      this.socket.onerror = () => rejectOpen(new Error('DevTools socket error'));
    });
  }

  handleMessage(message) {
    if (message.method === 'Runtime.consoleAPICalled') {
      const text = (message.params.args || []).map((arg) => arg.value).join(' ');
      if (typeof text === 'string' && text.startsWith('REGRESSION ')) {
        this.consoleLines.push(text.substring('REGRESSION '.length));
      }
      return;
    }
    const pending = this.pending.get(message.id);
    if (pending) {
      this.pending.delete(message.id);
      pending.resolve(message);
    }
  }

  send(method, params = {}, timeoutMs = 30000) {
    const id = this.nextId++;
    return new Promise((resolveSend, rejectSend) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectSend(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (message) => {
          clearTimeout(timer);
          resolveSend(message);
        },
        reject: (error) => {
          clearTimeout(timer);
          rejectSend(error);
        },
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression, timeoutMs = 30000) {
    const message = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, timeoutMs);
    if (message.error) {
      throw new Error(message.error.message);
    }
    if (message.result.exceptionDetails) {
      throw new Error(JSON.stringify(message.result.exceptionDetails));
    }
    return message.result.result.value;
  }

  close() {
    this.socket.close();
  }
}

/** Firebase config with fake values. The plugin talks only to the local emulator, so the app needs no real project. */
function createFakeGoogleServices() {
  const googleServices = {
    project_info: {
      project_number: FAKE_PROJECT_NUMBER,
      project_id: projectId,
      storage_bucket: `${projectId}.appspot.com`,
    },
    client: [
      {
        client_info: {
          mobilesdk_app_id: `1:${FAKE_PROJECT_NUMBER}:android:0000000000000000`,
          android_client_info: { package_name: APP_ID },
        },
        oauth_client: [],
        api_key: [{ current_key: FAKE_API_KEY }],
        services: { appinvite_service: { other_platform_oauth_client: [] } },
      },
    ],
    configuration_version: '1',
  };
  return JSON.stringify(googleServices, null, 2) + '\n';
}

async function startApp() {
  adb(['shell', 'am', 'force-stop', APP_ID]);
  adb(['shell', 'monkey', '-p', APP_ID, '-c', 'android.intent.category.LAUNCHER', '1']);
  const pid = await poll(() => adb(['shell', 'pidof', APP_ID], { allowFailure: true }).stdout.trim(), 30000);
  if (!pid) {
    throw new Error('App did not start');
  }
  const socketName = `webview_devtools_remote_${pid}`;
  const hasSocket = await poll(() => adb(['shell', 'cat', '/proc/net/unix']).stdout.includes(socketName), 30000);
  if (!hasSocket) {
    throw new Error('DevTools socket not found');
  }
  adb(['forward', `tcp:${DEVTOOLS_PORT}`, `localabstract:${socketName}`]);
  return pid;
}

async function connectToPage() {
  const target = await poll(async () => {
    const targets = await (await fetch(`http://127.0.0.1:${DEVTOOLS_PORT}/json`)).json();
    return targets.find((candidate) => candidate.type === 'page' && candidate.webSocketDebuggerUrl);
  }, 30000);
  if (!target) {
    throw new Error('No page target');
  }
  const session = new CdpSession(target.webSocketDebuggerUrl);
  await session.open();
  await session.send('Runtime.enable');
  const isReady = await poll(
    () => session.evaluate("typeof Capacitor !== 'undefined' && typeof Capacitor.nativePromise === 'function' && typeof Capacitor.nativeCallback === 'function'"),
    30000,
  );
  if (!isReady) {
    throw new Error('Capacitor not ready');
  }
  return session;
}

async function runPhase(phase) {
  log(`phase ${phase}: start`);
  const pid = await startApp();
  let session;
  try {
    session = await connectToPage();
    await session.evaluate(readFileSync(casesPath, 'utf8'));
    const lines = await session.evaluate(
      `__regressionRun(${JSON.stringify(phase)}, { host: ${JSON.stringify(EMULATOR_HOST_FROM_DEVICE)} })`,
      PHASE_TIMEOUT_MS,
    );
    log(`phase ${phase}: ${lines.length} lines`);
    return lines;
  } catch (error) {
    const pidNow = adb(['shell', 'pidof', APP_ID], { allowFailure: true }).stdout.trim();
    const crashLog = adb(['logcat', '-d', '-b', 'crash'], { allowFailure: true }).stdout;
    log(`phase ${phase}: failed: ${error.message}. App pid before ${pid}, now ${pidNow || 'none'}. Crash buffer:\n${crashLog}`);
    const partialLines = session ? session.consoleLines : [];
    return [...partialLines, `CASE ${phase} CRASH: ${JSON.stringify({ isAppRunning: pidNow === pid, message: error.message })}`];
  } finally {
    if (session) {
      session.close();
    }
    adb(['forward', '--remove', `tcp:${DEVTOOLS_PORT}`], { allowFailure: true });
  }
}

async function main() {
  await assertEmulatorRunning();
  if (adb(['get-state'], { allowFailure: true }).stdout.trim() !== 'device') {
    throw new Error(`Android device ${serial} is not ready`);
  }
  let isGoogleServicesPlaced = false;
  swapPackage({ packageName, tarballPath, workDir }, logger);
  try {
    if (!existsSync(GOOGLE_SERVICES_PATH)) {
      writeFileSync(GOOGLE_SERVICES_PATH, createFakeGoogleServices());
      isGoogleServicesPlaced = true;
    }
    run(CAP_BIN, ['sync', 'android'], { cwd: DEMO_DIR });
    run('./gradlew', ['assembleDebug'], { cwd: join(DEMO_DIR, 'android') });
    adb(['install', '-r', APK_PATH]);
    await clearEmulator(projectId, logger);
    adb(['logcat', '-c', '-b', 'crash'], { allowFailure: true });
    const lines = [];
    for (const phase of PHASES) {
      lines.push(...(await runPhase(phase)));
    }
    lines.push(...(await dumpEmulatorDocuments(projectId)));
    writeOutput(outputPath, lines, projectId);
    log(`wrote ${lines.length} lines to ${outputPath}`);
  } finally {
    adb(['shell', 'am', 'force-stop', APP_ID], { allowFailure: true });
    if (isGoogleServicesPlaced) {
      rmSync(GOOGLE_SERVICES_PATH, { force: true });
    }
    restorePackage({ packageName, workDir }, logger);
    run(CAP_BIN, ['sync', 'android'], { cwd: DEMO_DIR });
  }
}

main().catch((error) => {
  log(`FAILED: ${error.stack || error.message}`);
  process.exitCode = 1;
});
