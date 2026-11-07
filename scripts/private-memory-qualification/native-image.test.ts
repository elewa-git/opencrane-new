import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { z } from 'zod';
import { protectionMessages } from './protection-failure.ts';

const tag = `private-native-test:${randomUUID()}`;
const packageTag = `${tag}-package`;
const missingTag = `${tag}-missing`;
const missingHelperTag = `${tag}-missing-helper`;
const changedLauncherTag = `${tag}-changed-launcher`;
const receiptSchema = z.record(z.string(), z.unknown());
const siloHash = createHash('sha256');
siloHash.update('native-test');
const request = {
  sourceSha: 'a'.repeat(40), imageDigest: `sha256:${'b'.repeat(64)}`,
  environmentId: 'c'.repeat(64), siloId: `sha256:${siloHash.digest('hex')}`,
  installationId: `sha256:${'e'.repeat(64)}`, freshInstall: true,
  runId: randomUUID(), challengeId: randomUUID(), name: 'privateTurns',
};
const faults: [string, string, string][] = [
  ['missing binary', 'readFileSync(binary)', "readFileSync('/missing-native')"],
  ['replaced binary', 'readFileSync(binary)', "Buffer.from('replacement')"],
  ['changed running binary', 'binaryDigest(`${base}/exe`)', "'changed'"],
  ['shared home', 'randomUUID()', "'11111111-1111-4111-8111-111111111111'"],
  ['used home', 'mkdirSync(home, directoryOptions);',
    "mkdirSync(home, directoryOptions); writeFileSync(home + '/retained', 'keep'); " +
    'mkdirSync(home, directoryOptions);'],
  ['shared process identity', 'processIdentity(nativePid)', "'same-process-identity'"],
  ['shared thread', "thread['id']", "(fixtureThread ??= thread['id'])"],
  ['reused process', 'return nativePid;', 'return fixturePid ??= nativePid;'],
  ['swapped home', 'readlinkSync(`${base}/cwd`)',
    '(fixtureHome ??= readlinkSync(`${base}/cwd`))'],
  ['swapped thread', 'checkThread(readResponse)', '(fixtureThread ??= checkThread(readResponse))'],
  ['first child failure', 'const configParams =',
    "if (++sample === 1) { child.kill('SIGKILL'); } const configParams ="],
  ['RPC rejection', "connection.rpc('config/read', configParams)",
    "connection.rpc('fixture/reject', configParams)"],
  ['startup timeout', "await connection.rpc('initialize', initialise);",
    "child.stdout.pause(); await connection.rpc('initialize', initialise);"],
  ['surviving process', '!sameProcess(pid, start)', 'false'],
  ['failed home cleanup', 'rmSync(home, removalOptions);', 'void removalOptions;'],
  ['persistent thread', "thread['ephemeral']", 'false'],
  ['saved path', "thread['path']", "'/saved'"],
  ['execution environment', "thread['environments']", '[{}]'],
  ['resumed thread', "thread['turns']", '[{}]'],
  ['wrong CLI version', "thread['cliVersion']", "'0.0.0'"],
  ['disk home', 'statfsSync(home).type', '0xef53'],
  ['core limit', "readFileSync(`${base}/limits`, 'utf8')",
    "'Max core file size        1 1 bytes\\nMax processes 256 256 processes\\n'"],
  ['process limit', "readFileSync(`${base}/limits`, 'utf8')",
    "'Max core file size        0 0 bytes\\nMax processes unlimited unlimited processes\\n'"],
  ['unreadable limits', "readFileSync(`${base}/limits`, 'utf8')",
    "readFileSync('/unreadable-limits', 'utf8')"],
  ['changed process', 'processIdentity(nativePid)', '`${processIdentity(nativePid)}-${++sample}`'],
];
for (const feature of ['shell_tool', 'unified_exec', 'code_mode_host', 'apps',
  'plugins', 'remote_plugin', 'multi_agent', 'shell_snapshot', 'memories']) {
  faults.push([feature, "config['features']", `{ ...config['features'], ${feature}: true }`]);
}
faults.push(['browser', "config['web_search']", "'live'"],
  ['file access', "config['sandbox_mode']", "'danger-full-access'"],
  ['skills', "config['skills']", '{ include_instructions: true }'],
  ['external tools', "config['mcp_servers']", '{ external: {} }']);

function docker(args: string[], timeout = 30_000): string {
  const options = { encoding: 'utf8' as const, timeout, stdio: 'pipe' as const,
    maxBuffer: 4 * 1024 * 1024 };
  const output = execFileSync('/usr/bin/docker', args, options);
  return output.trim();
}
// Inject observations only in this fixture image. The shipped entry has no fault switch.
const preload = `import { registerHooks } from 'node:module';
const faults = ${JSON.stringify(faults)};
function load(url, context, next) {
  const loaded = next(url, context);
  if (url.endsWith('/host-probe.ts') && process.env.CASE !== 'host') {
    return { ...loaded, source: 'export function probeHost() { return true; }' };
  }
  function selected(row) {
    return row[0] === process.env.CASE;
  }
  const fault = faults.find(selected);
  if (url.endsWith('/codex-connection.ts') && process.env.CASE === 'startup timeout') {
    const originalSource = String(loaded.source);
    const source = originalSource.replace('30_000', '200');
    return { ...loaded, source };
  }
  if (url.endsWith('/native-checks.ts')) {
    let source = String(loaded.source);
    if (fault) {
      if (!source.includes(fault[1])) {
        process.exit(2);
      }
      source = source.replaceAll(fault[1], fault[2]);
    }
    const audit = String.raw\`
import { existsSync as fixtureExists } from 'node:fs';
let sample = 0, fixtureThread, fixturePid, fixtureHome;
const observed = [];
let independentRead = false;
function observe(home, child, threadId) {
  for (const previous of process.env.CASE === 'safe' ? observed : []) {
    process.kill(previous.pid, 0);
    if (previous.home === home || previous.pid === child.pid || previous.threadId === threadId) {
      throw new Error('fixture_failed');
    }
  }
  const childrenPath = '/proc/' + child.pid + '/task/' + child.pid + '/children';
  const childrenText = readFileSync(childrenPath, 'utf8');
  const trimmedChildren = childrenText.trim();
  const nativePid = Number(trimmedChildren);
  const observation = { home, pid: child.pid, nativePid, threadId };
  observed.push(observation);
  writeFileSync('/run/native-count', String(observed.length));
  if (process.env.CASE === 'collector EOF' && observed.length === 2) {
    process.kill(process.pid, 'SIGSTOP');
  }
}
function auditRead(home, child, threadId) {
  if (process.env.CASE === 'safe' && observed.length === 2 && home === observed[1].home &&
      !fixtureExists(observed[0].home)) {
    if (fixtureExists('/proc/' + observed[0].pid) || fixtureExists('/proc/' + observed[0].nativePid)) {
      throw new Error('fixture_failed');
    }
    process.kill(child.pid, 0);
    process.kill(observed[1].nativePid, 0);
    if (threadId !== observed[1].threadId) {
      throw new Error('fixture_failed');
    }
    independentRead = true;
  }
  return threadId;
}
\`;
    source = source.replaceAll('checkThread(readResponse)',
      'auditRead(home, child, checkThread(readResponse))');
    source = source.replace('const threadId = checkThread(startResponse);',
      'const threadId = checkThread(startResponse); observe(home, child, threadId);');
    source = source.replace('export async function checkNative(', 'async function checkedNative(');
    source += String.raw\`
export async function checkNative(challengeId) {
  await checkedNative(challengeId);
  if (process.env.CASE === 'safe' && (observed.length !== 2 || !independentRead)) {
    throw new Error('fixture_failed');
  }
}
\`;
    return { ...loaded, source: audit + source };
  }
  return loaded;
}
const hooks = { load };
registerHooks(hooks);`;

function prepare(): void {
  docker(['build', '-q', '-f', 'infra/package/Dockerfile', '-t', packageTag, '.'], 600_000);
  const directory = mkdtempSync(join(tmpdir(), 'private-native-image-'));
  try {
    writeFileSync(join(directory, 'preload.mjs'), preload);
    const dockerfile = `FROM ${packageTag} AS with_native
USER root
COPY preload.mjs /fixture/preload.mjs
FROM with_native AS missing_native
RUN rm -f /usr/local/bin/codex
FROM with_native AS missing_helper
RUN rm -f /app/apps/computer/src/codex-connection.ts
FROM with_native AS changed_launcher
RUN rm -f /usr/local/bin/codex && ln -s /missing-launcher /usr/local/bin/codex
FROM with_native
`;
    writeFileSync(join(directory, 'Dockerfile'), dockerfile);
    docker(['build', '--network=none', '-q', '--target', 'missing_native',
      '-t', missingTag, directory], 180_000);
    docker(['build', '--network=none', '-q', '--target', 'missing_helper',
      '-t', missingHelperTag, directory], 180_000);
    docker(['build', '--network=none', '-q', '--target', 'changed_launcher',
      '-t', changedLauncherTag, directory], 180_000);
    docker(['build', '--network=none', '-q', '-t', tag, directory], 180_000);
  } finally {
    const removalOptions = { recursive: true, force: true };
    rmSync(directory, removalOptions);
  }
}
function cleanup(): void {
  docker(['image', 'rm', '-f', tag, missingTag, missingHelperTag, changedLauncherTag, packageTag]);
}
beforeAll(prepare, 970_000);
afterAll(cleanup, 30_000);

function startContainer(caseName: string, image: string, scratchDirectory?: string): string {
  const containerName = `private-native-${randomUUID()}`;
  const args = ['run', '-d', '--name', containerName, '--network=none', '--read-only', '--init', '--user=0',
    '--cap-add=SYS_PTRACE', '--cpus=0.5', '--pids-limit=256', '--ulimit=core=0:0',
    '--ulimit=nproc=256:256', '--tmpfs', '/home/private:mode=711',
    '-e', 'SILO_ID=native-test', '-e', `CASE=${caseName}`, image, 'sleep', '120'];
  const mountIndex = args.indexOf('-e');
  if (scratchDirectory) {
    args.splice(mountIndex, 0, '--mount', `type=bind,src=${scratchDirectory},dst=/run`);
  } else {
    args.splice(mountIndex, 0, '--tmpfs', '/run');
  }
  docker(args);
  return containerName;
}
function nativeCommand(image: string): string[] {
  const command = ['nice', '-n', '10', 'node',
    '--experimental-strip-types'];
  if (image !== packageTag) {
    command.push('--import', '/fixture/preload.mjs');
  }
  command.push('/app/scripts/private-memory-qualification/journey.mjs');
  return command;
}
function run(caseName: string, image = tag, name = request.name,
  scratchDirectory?: string): Record<string, unknown> {
  const containerName = startContainer(caseName, image, scratchDirectory);
  const command = ['exec', '-i', containerName, ...nativeCommand(image)];
  try {
    const namedRequest = { ...request, name };
    const options = {
      input: JSON.stringify(namedRequest), encoding: 'utf8' as const, timeout: 45_000,
    };
    const result = spawnSync('/usr/bin/docker', command, options);
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe('');
    const receipt = receiptSchema.parse(JSON.parse(result.stdout));
    expect(result.status).toBe(receipt['result'] === 'FAIL' ? 1 : 0);
    assertStopped(containerName, ['failed home cleanup', 'used home', 'surviving process'].includes(caseName));
    if (caseName === 'used home') {
      const probe = "const fs = require('node:fs'); " +
        "const homes = fs.readdirSync('/home/private'); " +
        "if (homes.length !== 1 || fs.readFileSync('/home/private/' + homes[0] + " +
        "'/retained', 'utf8') !== 'keep') process.exit(1);";
      expect(docker(['exec', containerName, 'node', '-e', probe])).toBe('');
    }
    return receipt;
  } finally {
    docker(['rm', '-f', '-v', containerName]);
  }
}
function assertStopped(containerName: string, allowHome = false): void {
  const probe = String.raw`
const fs = require('node:fs');
for (const entry of fs.readdirSync('/proc')) {
  if (!/^\d+$/.test(entry)) {
    continue;
  }
  let command;
  try {
    command = fs.readFileSync('/proc/' + entry + '/cmdline', 'utf8');
  } catch {
    continue;
  }
  if (command.includes('app-server') && !command.includes('const fs')) {
    process.exit(1);
  }
}
if (!${allowHome} && fs.readdirSync('/home/private').length !== 0) {
  process.exit(1);
}
`;
  expect(docker(['exec', containerName, 'node', '-e', probe])).toBe('');
}
function safeNative(): void {
  const expected = { ...request, result: 'PARTIAL', complete: false };
  expect(run('safe')).toMatchObject(expected);
}
it('observes two simultaneous pinned native processes and keeps qualification incomplete',
  safeNative, 60_000);
function refusesFault(name: string): void {
  const expected = { result: 'FAIL', reason: 'journey_failed' };
  expect(run(name)).toEqual(expected);
}
it.each(faults)('refuses %s without returning native output', refusesFault, 60_000);
function refusesHost(): void {
  const expected = { result: 'FAIL', reason: 'host_refused',
    protectionFailure: 'memory_limit_unproved' };
  expect(run('host')).toEqual(expected);
  expect(run('host', packageTag)).toEqual(expected);
}
it('keeps the real host refusal ahead of native execution in both images', refusesHost, 60_000);

function missingNative(): void {
  const expected = { result: 'FAIL', reason: 'journey_failed' };
  expect(run('safe', missingTag)).toEqual(expected);
}
it('refuses the package without native files even with safe host observations', missingNative);

function missingHelper(): void {
  const expected = { result: 'FAIL', reason: 'journey_failed' };
  expect(run('safe', missingHelperTag)).toEqual(expected);
}
it('refuses a missing production connection helper', missingHelper, 60_000);

function changedLauncher(): void {
  const expected = { result: 'FAIL', reason: 'journey_failed' };
  expect(run('safe', changedLauncherTag)).toEqual(expected);
}
it('refuses a changed launcher link', changedLauncher, 60_000);

function persistentScratch(): void {
  const directory = mkdtempSync(join(tmpdir(), 'private-native-scratch-'));
  try {
    const expected = { result: 'FAIL', reason: 'journey_failed' };
    expect(run('safe', tag, request.name, directory)).toEqual(expected);
  } finally {
    const removalOptions = { recursive: true, force: true };
    rmSync(directory, removalOptions);
  }
}
it('refuses writable scratch that is not tmpfs', persistentScratch, 60_000);

function recallPrerequisites(): void {
  const expected = { ...request, name: 'nativeRecall', result: 'NOT RUN', complete: false };
  expect(run('safe', tag, 'nativeRecall')).toMatchObject(expected);
  const refused = { result: 'FAIL', reason: 'journey_failed' };
  expect(run('safe', missingTag, 'nativeRecall')).toEqual(refused);
}
it('requires shipped native files for recall without qualifying empty threads',
  recallPrerequisites, 60_000);

async function collectorEof(): Promise<void> {
  const containerName = startContainer('collector EOF', tag);
  try {
    const source = readFileSync(new URL('./supervisor.mjs', import.meta.url), 'utf8');
    const failures = Object.keys(protectionMessages);
    const args = ['exec', '-i', containerName, 'node', '--input-type=module', '--eval',
      source, JSON.stringify(failures), JSON.stringify(nativeCommand(tag))];
    const options = { stdio: 'pipe' as const };
    const child = spawn('/usr/bin/docker', args, options);
    function closed(resolve: (code: number | null) => void): void {
      child.once('close', resolve);
    }
    const stopped = new Promise(closed);
    const output: Buffer[] = [];
    function collect(chunk: Buffer): void {
      output.push(chunk);
    }
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.stdin.write(`${JSON.stringify(JSON.stringify(request))}\n`);
    try {
      let ready = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const probe = "const fs = require('node:fs'); " +
          "if (fs.existsSync('/run/native-count')) " +
          "process.stdout.write(fs.readFileSync('/run/native-count'));";
        ready = docker(['exec', containerName, 'node', '-e', probe]) === '2';
        if (ready) {
          break;
        }
        await delay(50);
      }
      expect(ready).toBe(true);
    } finally {
      child.stdin.end();
    }
    expect(await stopped).toBe(1);
    expect(Buffer.concat(output).length).toBe(0);
    assertStopped(containerName, true);
    docker(['exec', containerName, 'test', '!', '-e', '/run/opencrane-memory-qualification.lock']);
  } finally {
    docker(['rm', '-f', '-v', containerName]);
  }
}
it('collector EOF stops both native processes in the supervisor group', collectorEof, 30_000);
