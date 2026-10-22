import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { ScriptTarget, transpileModule } from 'typescript';

type Invocation = { script: string; args: string[]; shell?: boolean };
const commands: Invocation[] = [
  { script: 'journey.sh', args: ['--id', 'owner'], shell: true },
  { script: 'stack.ts', args: ['journey'] },
  { script: 'journey.ts', args: [] },
  { script: 'bootstrap-journey.ts', args: [] },
  { script: 'screenshot-journey.ts', args: ['fresh'] },
  { script: 'mcp-journey.ts', args: ['fresh'] },
  { script: 'live-view-repeat.ts', args: [] },
  { script: '../package/capture.mjs', args: ['fresh-1-'] },
  { script: '../package/fresh-twice.ts', args: ['/synthetic-values.json'] },
];

async function invoke(
  command: Invocation,
  fleet?: string,
  id = 'owner',
  realMode = false,
  recordCommands = false,
) {
  const home = await mkdtemp(`${tmpdir()}/journey-refusal-`);
  try {
    const bin = `${home}/bin`;
    await mkdir(bin);
    const executable = { mode: 0o755 };
    if (recordCommands) {
      const nodeStub = '#!/bin/sh\nprintf node >> "$JOURNEY_COMMANDS"\n';
      const flockStub = '#!/bin/sh\nprintf flock >> "$JOURNEY_COMMANDS"\n';
      await writeFile(`${bin}/node`, nodeStub, executable);
      await writeFile(`${bin}/flock`, flockStub, executable);
    } else {
      await symlink(process.execPath, `${bin}/node`);
      await writeFile(`${bin}/flock`, '#!/bin/sh\nshift 2\nexec "$@"\n', executable);
    }
    await symlink('/usr/bin/dirname', `${bin}/dirname`);
    await writeFile(`${bin}/id`, '#!/bin/sh\necho 999999\n', executable);
    const record = `${home}/record`;
    await writeFile(record, '');
    await writeFile(`${home}/commands`, '');
    await writeFile(`${home}/stack-owner`, process.cwd());
    const env: NodeJS.ProcessEnv = {
      HOME: home, PATH: bin, DEV_STACK_ID: id, JOURNEY_RECORD: record,
      JOURNEY_COMMANDS: `${home}/commands`,
      NODE_OPTIONS: '--import=./infra/dev-stack/test/journey-refusal-preload.mjs',
    };
    if (realMode) env['JOURNEY_SAVED_MODE'] = '1';
    if (fleet !== undefined) env['OPENCRANE_FLEET_TASK'] = fleet;
    let executablePath = process.execPath;
    let args = ['--experimental-strip-types', `infra/dev-stack/${command.script}`, ...command.args];
    if (command.shell) {
      executablePath = '/bin/sh';
      args = [`infra/dev-stack/${command.script}`, ...command.args];
    }
    const options = { env, encoding: 'utf8' as const, timeout: 15_000 };
    const result = spawnSync(executablePath, args, options);
    assert.ifError(result.error);
    const reads = await readFile(record, 'utf8');
    const commandCalls = await readFile(`${home}/commands`, 'utf8');
    return {
      status: result.status,
      output: result.stdout + result.stderr,
      reads,
      commandCalls,
    };
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

for (const command of commands) {
  async function refuseOwnerJourney() {
    for (const fleet of [undefined, '', 'demo-kit-2']) {
      const result = await invoke(command, fleet);
      assert.notEqual(result.status, 0, command.script);
      assert.equal(result.reads, '', `${command.script}: ${result.output}`);
      assert.match(result.output, /Automated journeys require a secondary stack/u);
    }
  }
  test(`${command.script} refuses owner before configuration, with or without a fleet marker`,
    refuseOwnerJourney);
}

async function refuseRealStandInJourney() {
  const command = { script: 'journey.ts', args: [] };
  const result = await invoke(command, undefined, '1', true);
  assert.notEqual(result.status, 0);
  assert.equal(result.reads, 'settings read\n', result.output);
  assert.match(result.output, /Journey provider mode does not match the saved stack/u);
}

test('direct journey without real opt-in refuses saved real mode before journey setup',
  refuseRealStandInJourney);

async function refuseFleetJourneys() {
  for (const fleet of ['', 'demo-kit-2']) {
    const result = await invoke({ script: 'journey.ts', args: [] }, fleet, '1');
    assert.notEqual(result.status, 0);
    assert.equal(result.reads, '', result.output);
    assert.match(result.output, /no fleet task/u);
  }
}

test('a fleet marker cannot run a standalone automated journey', refuseFleetJourneys);

async function refuseNonStartConsent() {
  for (const action of ['down', 'status', 'journey', 'package-check']) {
    const command = { script: 'run.sh', shell: true, args: [action, '--id', '1', '--owner-run'] };
    const result = await invoke(command, undefined, '1');
    assert.equal(result.status, 2, result.output);
    assert.equal(result.reads, '', result.output);
  }
}

test('the shell refuses owner consent on non-start actions before invoking Node', refuseNonStartConsent);

async function refuseShellJourney() {
  for (const fleet of [undefined, '', 'demo-kit-2']) {
    const command = { script: 'run.sh', shell: true, args: ['journey'] };
    const result = await invoke(command, fleet, 'owner', false, true);
    assert.equal(result.status, 2, result.output);
    assert.equal(result.commandCalls, '', `flock or Node ran: ${result.commandCalls}`);
    assert.match(result.output, /Automated journeys require a secondary stack and no fleet task/u);
  }
}

test('the shell refuses owner journeys before flock or Node, with any fleet marker',
  refuseShellJourney);

async function refuseInvalidOptions() {
  for (const args of [['up', '--fresh', '--fresh'], ['up', '--owner-run', '--owner-run'],
    ['up', '--owner-run']]) {
    const result = await invoke({ script: 'stack.ts', args }, undefined, '1');
    assert.notEqual(result.status, 0);
    assert.equal(result.reads, '', result.output);

  }
}

test('direct startup refuses duplicate flags and secondary owner consent', refuseInvalidOptions);

for (const script of ['bootstrap-journey.ts', 'live-view-repeat.ts']) {
  async function refuseRealMode() {
    const command = { script, args: [] };
    const result = await invoke(command, undefined, '1', true);
    assert.notEqual(result.status, 0);
    assert.equal(result.reads, 'settings read\n', result.output);
    assert.match(result.output, /This journey requires the stand-in model/u);
  }
  test(`${script} refuses saved real mode before starting a stand-in journey`, refuseRealMode);
}

async function packageCaptureRefusesRealMode() {
  const command = { script: '../package/capture.mjs', args: ['fresh-1-'] };
  const result = await invoke(command, undefined, '1', true);
  assert.notEqual(result.status, 0);
  assert.equal(result.reads, 'settings read\n', result.output);
  assert.match(result.output, /This journey requires the stand-in model/u);
}

test('package browser capture refuses a saved real-mode stack', packageCaptureRefusesRealMode);

// Run the restart function with disposable process records and a clock controlled by the fixture.
// Keep real processes and stack settings out of these health-read checks.
async function restartHealthFixture(statuses: Array<number | 'connection' | 'hanging'>) {
  const source = await readFile('infra/dev-stack/journey.ts', 'utf8');
  const restartStart = source.indexOf('async function restartStackProcess(');
  const restartEnd = source.indexOf('function matchesStackEntrypoint(', restartStart);
  const helpersStart = source.indexOf('function returnUnavailable(');
  const helpersEnd = source.indexOf('async function append(', helpersStart);
  const functions = source.slice(restartStart, restartEnd) + source.slice(helpersStart, helpersEnd);
  const compilerOptions = { target: ScriptTarget.ES2022 };
  const compiled = transpileModule(functions, { compilerOptions }).outputText;
  let elapsed = 0;
  let reads = 0;
  const timeouts: number[] = [];
  const signals = new Map<AbortSignal, { duration: number; controller: AbortController }>();
  const clock = { now: now };
  function now() {
    return elapsed;
  }
  async function delay(duration: number) {
    elapsed += duration;
  }
  function timeout(duration: number) {
    const controller = new AbortController();
    signals.set(controller.signal, { duration, controller });
    timeouts.push(duration);
    return controller.signal;
  }
  async function fetchHealth(_url: string, options?: RequestInit) {
    const result = statuses[Math.min(reads, statuses.length - 1)];
    reads += 1;
    if (result === 'hanging') {
      const signal = options?.signal;
      function neverAnswer(_resolve: unknown, reject: (error: unknown) => void) {
        if (!signal) return;
        const scheduled = signals.get(signal)!;
        function abortRead() {
          elapsed += scheduled.duration;
          const error = new DOMException('The operation timed out', 'TimeoutError');
          scheduled.controller.abort(error);
        }
        function rejectAbortedRead() {
          reject(signal!.reason);
        }
        signal.addEventListener('abort', rejectAbortedRead, { once: true });
        queueMicrotask(abortRead);
      }
      return new Promise<Response>(neverAnswer);
    }
    if (result === 'connection') {
      const cause = { code: 'ECONNREFUSED' };
      throw new TypeError('fetch failed', { cause });
    }
    return new Response(null, { status: result });
  }
  async function readFixtureFile(path: string) {
    if (path.endsWith('.pid')) return '42 start-token';
    if (path.endsWith('/cmdline')) return 'node\0apps/server/src/main.ts';
    if (path.endsWith('/environ')) return 'FIXTURE=1';
    return '/fixture';
  }
  async function nothing() {}
  async function openLog() {
    return { fd: 1, close: nothing };
  }
  function spawnFixture() {
    return { pid: 43, unref: nothing };
  }
  async function processExists() {
    return false;
  }
  async function untilValue() {
    return 'new-start-token';
  }
  function statStartToken() {
    return 'start-token';
  }
  function matchesStackEntrypoint() {
    return true;
  }
  const context = {
    assert, Response, TypeError, Date: clock, AbortSignal: { timeout }, fetch: fetchHealth, delay,
    directory: '/fixture', root: '/fixture', settings: { SERVER_PORT: '1' },
    readFile: readFixtureFile, rm: nothing, writeFile: nothing, open: openLog,
    spawn: spawnFixture, once: nothing, process: { kill: nothing }, processExists,
    statStartToken, matchesStackEntrypoint, splitEnvironmentEntry: nothing, untilValue,
  };
  const invoke = runInNewContext(compiled + '\nrestartStackProcess', context);
  async function run() {
    await invoke('server', nothing);
  }
  function result() {
    return { elapsed, reads, timeouts };
  }
  return { run, result };
}

async function boundsAnUnansweredHealthRead() {
  const fixture = await restartHealthFixture(['hanging']);
  let watchdog: ReturnType<typeof setTimeout>;
  function rejectIfUnbounded(_resolve: unknown, reject: (error: unknown) => void) {
    function exceededDeadline() {
      reject(new Error('The health read outlived its deadline'));
    }
    watchdog = setTimeout(exceededDeadline, 1000);
  }
  const unbounded = new Promise<never>(rejectIfUnbounded);
  try {
    const checked = Promise.race([fixture.run(), unbounded]);
    await assert.rejects(checked, /Timed out: restarted stack server health/u);
  } finally {
    clearTimeout(watchdog!);
  }
  const result = fixture.result();
  assert.equal(result.elapsed, 120_000);
  assert.equal(result.reads, 1);
  assert.deepEqual(result.timeouts, [120_000]);
}

test('a restarted server that never answers ends at the health deadline',
  boundsAnUnansweredHealthRead);

async function refusesUnexpectedHealthStatus() {
  const fixture = await restartHealthFixture([403, 200]);
  await assert.rejects(fixture.run, /restarted stack server health: HTTP 403/u);
  assert.equal(fixture.result().reads, 1);
  assert.equal(fixture.result().elapsed, 0);
}

test('a restarted server health 403 fails immediately without another read',
  refusesUnexpectedHealthStatus);

async function retriesOnlyStartupFailures() {
  const fixture = await restartHealthFixture(['connection', 502, 503, 504, 200]);
  await fixture.run();
  const result = fixture.result();
  assert.equal(result.reads, 5);
  assert.deepEqual(result.timeouts, [120_000, 119_950, 119_900, 119_850, 119_800]);
  for (const status of [400, 401, 404, 409, 425, 429, 500]) {
    const refused = await restartHealthFixture([status, 200]);
    const message = `restarted stack server health: HTTP ${status}`;
    await assert.rejects(refused.run, { message });
    assert.equal(refused.result().reads, 1);
  }
}

test('restarted server health retries connection failures and only 502, 503 and 504',
  retriesOnlyStartupFailures);
