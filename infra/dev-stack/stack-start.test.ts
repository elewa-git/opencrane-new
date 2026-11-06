import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isIP } from 'node:net';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';

type StartOptions = {
  failure?: string;
  signal?: 'SIGINT' | 'SIGTERM';
  previousMode?: '0' | '1';
  webReadyMs?: number;
  webExitMs?: number;
  listener?: string;
  scannerMissing?: boolean;
  routinesExit?: boolean;
  stopAfterStart?: boolean;
  repeat?: boolean;
  previousMemory?: boolean;
  upgradeReport?: 'unchanged' | 'unsafe';
  upgradeFailure?: boolean;
  markerMissing?: boolean;
};

async function ownerStart(start: StartOptions = {}) {
  const home = await mkdtemp(`${tmpdir()}/owner-start-fixture-`);
  const directory = `${home}/stack`;
  await mkdir(directory);
  try {
    if (start.previousMode !== undefined) {
      await writeFile(`${directory}/settings.env`, `DEV_REAL_PROVIDER=${start.previousMode}\n`);
    }
    const environment = {
      HOME: home,
      PATH: '/nonexistent',
      DEV_STACK_DIR: directory,
      DEV_STACK_ID: 'owner',
      DEV_REAL_PROVIDER_FILE: '/synthetic-key-file',
      START_FAILURE: start.failure ?? '',
      START_SIGNAL: start.signal ?? '',
      START_WEB_READY_MS: start.webReadyMs?.toString() ?? '',
      START_WEB_EXIT_MS: start.webExitMs?.toString() ?? '',
      START_LISTENER: start.listener ?? '',
      START_SCANNER_MISSING: start.scannerMissing ? '1' : '',
      START_ROUTINES_EXIT: start.routinesExit ? '1' : '',
      START_UPGRADE_REPORT: start.upgradeReport ?? 'unchanged',
      START_UPGRADE_FAILURE: start.upgradeFailure ? '1' : '',
      START_MARKER_MISSING: start.markerMissing ? '1' : '',
      START_RESTORE_PROCESSES: '',
    };
    const args = ['--experimental-strip-types', '--import',
      './infra/dev-stack/test/stack-start-preload.mjs', 'infra/dev-stack/stack.ts',
      'up', '--owner-run', '--fresh'];
    const options = { env: environment, encoding: 'utf8' as const, timeout: 15_000 };
    if (start.repeat) {
      const firstEnvironment = { ...environment,
        MEMORY_KEY_DIRECTORY: start.previousMemory ? `${home}/memory-keys` : '' };
      const first = spawnSync(process.execPath, args, { ...options, env: firstEnvironment });
      assert.ifError(first.error);
      assert.equal(first.status, 0, first.stdout + first.stderr);
      environment.START_RESTORE_PROCESSES = '1';
      args.pop();
    }
    const result = spawnSync(process.execPath, args, options);
    assert.ifError(result.error);
    if (start.stopAfterStart && result.status === 0) {
      const downEnvironment = { ...environment, START_RESTORE_PROCESSES: '1' };
      const downArgs = args.slice(0, 4);
      downArgs.push('down');
      const down = spawnSync(process.execPath, downArgs,
        { ...options, env: downEnvironment });
      assert.ifError(down.error);
      assert.equal(down.status, 0, down.stdout + down.stderr);
    }
    let operations: string;
    try {
      operations = await readFile(`${home}/operations`, 'utf8');
    } catch {
      throw new Error(result.stdout + result.stderr);
    }
    const settings = await readFile(`${directory}/settings.env`, 'utf8');
    const serviceText = await readFile(`${home}/services.json`, 'utf8');
    const services = JSON.parse(serviceText) as {
      processes: string[]; containers: string[]; switchedOn: boolean;
    };
    let failure = '';
    try {
      failure = await readFile(`${directory}/failure.log`, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return { status: result.status, output: result.stdout + result.stderr, failure,
      operations, settings, services, directory };
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function ownerReadiness() {
  const result = await ownerStart();
  assert.equal(result.status, 0, result.output + result.operations);
  assert.match(result.output, /Stack ready: https:\/\/owner.example.test\/org\/integrations/u);
  assert.equal(result.operations.includes('infra/dev-stack/journey.ts'), false);
  assert.match(result.operations, /health .*\/healthz\/ready/u);
}

async function repeatStopsOldMemoryWorker() {
  const result = await ownerStart({ repeat: true, previousMemory: true });
  assert.equal(result.status, 0, result.output + result.failure);
  assert.match(result.operations, /stop .*worker.ts memory/u);
  assert.match(result.operations, /exec .*upgrade-handlers --dry-run/u);
}

test('repeat start stops an earlier memory worker before preview when memory is now off',
  repeatStopsOldMemoryWorker);

async function unchangedPreviewAllowsRestart() {
  const result = await ownerStart({ repeat: true, upgradeReport: 'unchanged' });
  assert.equal(result.status, 0, result.output + result.failure);
  assert.match(result.output, /Stack ready:/u);
  assert.match(result.operations, /exec .*upgrade-handlers --dry-run/u);
  assert.doesNotMatch(result.operations, /upgrade-handlers --confirm-writers-stopped/u);
}

test('repeat start resumes workers after an unchanged subscription preview',
  unchangedPreviewAllowsRestart);

async function unsafeUpgradeShowsCommand() {
  const result = await ownerStart({ repeat: true, upgradeReport: 'unsafe' });
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /npm run ops -- upgrade-handlers --dry-run/u);
  assert.doesNotMatch(result.output, /postgres:|fixture\.invalid|\/tmp\//u);
}

test('unsafe subscriptions print the fixed operator command', unsafeUpgradeShowsCommand);

async function failedUpgradeShowsCommand() {
  const result = await ownerStart({ repeat: true, upgradeFailure: true });
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /npm run ops -- upgrade-handlers --dry-run/u);
  assert.doesNotMatch(result.output, /postgres:|secret|fixture\.invalid|\/tmp\//u);
}

test('preview errors print fixed instructions without dependency details',
  failedUpgradeShowsCommand);

async function missingMarkerRefusesReadiness() {
  const result = await ownerStart({ markerMissing: true, webReadyMs: 1 });
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /npm run ops -- upgrade-handlers --dry-run/u);
  assert.doesNotMatch(result.output, /Stack ready:/u);
}

test('a dispatcher without its marker refuses stack readiness', missingMarkerRefusesReadiness);

test('an authorised owner real start reports readiness without an automated journey', ownerReadiness);

async function startsRoutineProjection() {
  const result = await ownerStart();
  assert.equal(result.status, 0, result.output);
  function isRoutineWorker(process: string) {
    return process.includes('apps/ops/src/worker.ts routines');
  }
  assert.ok(result.services.processes.some(isRoutineWorker));
}

test('fresh startup runs the routine projection needed by provider binding reads',
  startsRoutineProjection);

async function stoppedRoutineRefusesReadiness() {
  const result = await ownerStart({ routinesExit: true });
  assert.equal(result.status, 1, result.output);
  assert.match(result.failure, /routines stopped/u);
  assert.doesNotMatch(result.output, /Stack ready:/u);
}

test('a stopped routines worker refuses final startup readiness', stoppedRoutineRefusesReadiness);

async function downStopsRoutineWorker() {
  const result = await ownerStart({ stopAfterStart: true });
  assert.equal(result.status, 0, result.output);
  assert.match(result.operations, /stop routines/u);
  assert.equal(result.services.processes.includes('routines'), false);
}

test('down stops the routines worker', downStopsRoutineWorker);

async function startsServerWithScanner() {
  const result = await ownerStart();
  assert.equal(result.status, 0, result.output);
  assert.match(result.operations, /scanner-configured true/u);
  assert.ok(result.services.containers.includes('scanner'));
}

test('fresh startup starts the scanner and gives the server its settings',
  startsServerWithScanner);

async function missingScannerStopsStartup() {
  const result = await ownerStart({ scannerMissing: true, webReadyMs: 1 });
  assert.equal(result.status, 1, result.output);
  assert.match(result.failure, /Timed out waiting for authenticated scanner/u);
  const expectedOutput = 'Dev stack failed: Timed out waiting for authenticated scanner scan; ' +
    "inspect the stack's private log folder\n";
  assert.equal(result.output, expectedOutput);
  assert.equal(result.output.includes(result.directory), false);
  assertRestored(result);
}

test('missing scanner service refuses startup and stops its container',
  missingScannerStopsStartup);

async function modeSavedAfterChecks() {
  const result = await ownerStart();
  assert.equal(result.status, 0, result.output);
  assert.match(result.operations, /mode-at-provider-check stub/u);
  assert.match(result.settings, /DEV_REAL_PROVIDER=1/u);
}

test('real mode is saved only after the infrastructure and provider checks', modeSavedAfterChecks);

function assertRestored(result: Awaited<ReturnType<typeof ownerStart>>, mode?: string) {
  assert.equal(result.status, 1, result.output);
  const modeLine = result.settings.split('\n').find(isModeLine);
  assert.equal(modeLine, mode === undefined ? undefined : `DEV_REAL_PROVIDER=${mode}`);
  assert.deepEqual(result.services.processes, []);
  assert.deepEqual(result.services.containers, []);
}

function isModeLine(line: string) {
  return line.startsWith('DEV_REAL_PROVIDER=');
}

async function failedStartRestoresMode() {
  for (const previousMode of [undefined, '0', '1'] as const) {
    for (const failure of ['infrastructure-check', 'saved-real-mode', 'after-switch-on']) {
      const options: StartOptions = { failure };
      if (previousMode !== undefined) options.previousMode = previousMode;
      const result = await ownerStart(options);
      assert.match(result.operations, new RegExp(failure, 'u'));
      assertRestored(result, previousMode);
    }
  }
}

test('failed owner starts restore each previous mode and stop launched services',
  failedStartRestoresMode);

async function interruptedStartRestoresMode() {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    const result = await ownerStart({ signal, previousMode: '0' });
    assert.equal(result.services.switchedOn, true);
    assertRestored(result, '0');
  }
}

test('interruptions after switch-on restore the previous mode and stop launched services',
  interruptedStartRestoresMode);

async function slowWebsiteBecomesReady() {
  const result = await ownerStart({ webReadyMs: 208_291 });
  assert.equal(result.status, 0, result.output + result.failure);
  assert.match(result.output, /Stack ready:/u);
  assert.match(result.operations, /website-ready 208500/u);
}

test('startup waits for a cold website build that takes longer than two minutes',
  slowWebsiteBecomesReady);

async function websiteNeverBecomesReady() {
  const result = await ownerStart({ webReadyMs: 600_000 });
  assert.equal(result.status, 1, result.output);
  assert.match(result.failure, /Timed out waiting for web/u);
  assert.doesNotMatch(result.output, /Stack ready:|PASS website readiness/u);
  assertRestored(result);
}

test('startup still fails and rolls back when the website never becomes ready',
  websiteNeverBecomesReady);

async function websiteExitsDuringBuild() {
  const result = await ownerStart({ webReadyMs: 208_291, webExitMs: 1_000 });
  assert.equal(result.status, 1, result.output);
  assert.match(result.failure, /Website process stopped before readiness/u);
  assert.doesNotMatch(result.output, /Stack ready:|PASS website readiness/u);
  const healthChecks = result.operations.match(/health .*\/org\/integrations/gu) ?? [];
  assert.equal(healthChecks.length, 2, result.operations);
  assertRestored(result);
}

test('startup fails promptly when the website exits during its build', websiteExitsDuringBuild);

const listenerCases: Array<{ address: string; accepted: boolean; process?: string }> = [
  { address: '100.121.102.47%tailscale0:443', accepted: true },
  { address: '[fd7a:115c:a1e0::1234]%tailscale0:443', accepted: true },
  { address: '[fd7a:115c:a1e0::1234%tailscale0]:443', accepted: true },
  { address: '100.121.102.47:443', accepted: true },
  { address: '[fd7a:115c:a1e0::1234]:443', accepted: true },
  { address: '127.0.0.1:443', accepted: true },
  { address: '[::1]:443', accepted: true },
  { address: '0.0.0.0:443', accepted: false },
  { address: '[::]:443', accepted: false },
  { address: '*:443', accepted: false },
  { address: '100.121.102.47%eth0:443', accepted: false },
  { address: '[fd7a:115c:a1e0::1234]%eth0:443', accepted: false },
  { address: '100.121.102.48%tailscale0:443', accepted: false },
  { address: '[fd7a:115c:a1e0::5678]%tailscale0:443', accepted: false },
  { address: '127.0.0.1%tailscale0:443', accepted: false },
  { address: '[::1]%tailscale0:443', accepted: false },
  { address: '[not-an-ip]%tailscale0:443', accepted: false },
  { address: '[fd7a:115c:a1e0::1234:443', accepted: false },
  { address: '100.121.102.47%:443', accepted: false },
  { address: '100.121.102.47%eth0%tailscale0:443', accepted: false },
  { address: '100.121.102.47%tailscale0%eth0:443', accepted: false },
  { address: '[fd7a:115c:a1e0::1234%tailscale0]%eth0:443', accepted: false },
  { address: '[100.121.102.47]:443', accepted: false },
  { address: '[fd7a:115c:a1e0::1234%eth0]%tailscale0:443', accepted: false },
  { address: '[broken]%tailscale0:48000', accepted: false },
  { address: '[broken]%eth0:9999', accepted: true },
  { address: '0.0.0.0:43000', accepted: true },
  { address: '[::]:43000', accepted: true },
  { address: '*:43000', accepted: true },
  { address: '[broken]%tailscale0:43000', accepted: false },
  { address: '999.1.1.1:43000', accepted: false },
  { address: '[broken]:43000', accepted: false },
  { address: '192.0.2.10%tailscale0:43000', accepted: false },
  { address: '100.121.102.47%eth0:43000', accepted: false },
  { address: 'not-an-address', accepted: false, process: 'users:(("node",pid=900000,fd=1))' },
  { address: '0.0.0.0:9999', accepted: false, process: 'users:(("node",pid=900000,fd=1))' },
];

for (const listenerCase of listenerCases) {
  async function checksListenerAddress() {
    const listener = `LISTEN 0 4096 ${listenerCase.address} *:* ${listenerCase.process ?? ''}`;
    const result = await ownerStart({ listener });
    if (listenerCase.accepted) {
      assert.equal(result.status, 0, result.output + result.failure);
      assert.match(result.output, /PASS listener check:/u);
    } else {
      assert.equal(result.status, 1, result.output);
      assert.match(result.failure, /Cannot verify stack listener|not on loopback or Tailscale/u);
      assert.doesNotMatch(result.output, /PASS listener check:|Stack ready:/u);
    }
  }
  const outcome = listenerCase.accepted ? 'accepts' : 'refuses';
  test(`startup ${outcome} listener ${listenerCase.address}`, checksListenerAddress);
}

async function secondaryModelListeners() {
  const source = await readFile(new URL('./stack.ts', import.meta.url), 'utf8');
  const start = source.indexOf('  const ports = new Set(Object.entries(settings)');
  const end = source.indexOf('  if (!secondary) await modelFirewall(true);', start);
  assert(start >= 0 && end > start, 'Find the complete startup listener check');
  const listenerSource = source.slice(start, end);
  const listenerCheck = stripTypeScriptTypes(listenerSource);
  const addresses = ['127.0.0.1', '[::1]', '0.0.0.0', '[::]', '*'];
  for (const address of addresses) {
    const context = {
      settings: { MODEL_GATEWAY_PORT: '25107' },
      tail: { Self: { TailscaleIPs: [] } },
      after: `LISTEN 0 4096 ${address}:25107 *:*`,
      pids: [],
      secondary: true,
      isIP,
    };
    function checkListener() {
      // Run the actual check with secondary settings, without launching services.
      runInNewContext(listenerCheck, context);
    }
    if (address === '127.0.0.1' || address === '[::1]') {
      assert.doesNotThrow(checkListener, address);
    } else {
      assert.throws(checkListener, /not on loopback or Tailscale/u, address);
    }
  }
}

test('secondary model gateway accepts loopback and refuses every wildcard form',
  secondaryModelListeners);
