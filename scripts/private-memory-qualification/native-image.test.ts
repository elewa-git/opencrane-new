import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { z } from 'zod';
import { protectionMessages } from './protection-failure.ts';

const tag = `private-native-test:${randomUUID()}`;
const packageTag = `${tag}-package`;
const computerTag = `${tag}-computer`;
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
  ['changed running binary', 'statSync(`${base}/exe`)',
    "{ dev: -1, ino: -1, size: -1 }"],
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
  ['missing launch record', "writeFileSync(state.recordPath, contents, { flag: 'w' });",
    'void contents;'],
  ['forged launch record', "writeFileSync(state.recordPath, contents, { flag: 'w' });",
    "writeFileSync(state.recordPath, 'forged\\n', { flag: 'w' });"],
  ['writable launch record', 'mode: 0o600', 'mode: 0o666'],
  ['swapped native child', 'state.nativePid = nativePid;', 'state.nativePid = child.pid;'],
  ['stopped native child', 'recordNativeLaunch(supervised);',
    "recordNativeLaunch(supervised); process.kill(nativePid, 'SIGSTOP');"],
  ['double native child', 'const trimmed = children.trim();', "const trimmed = '10 11';"],
];
const proofFaults: [string, string, string][] = [
  ['wrong wrapper hash', "digest('/usr/local/bin/codex')", "'wrong-hash'"],
  ['wrong native executable', 'sameExecutable(binding.childPid, binding.childBinary)', 'false'],
  ['swapped native pipe', 'sameNativePipes(wrapper.pid, child.pid)', 'false'],
  ['wrong wrapper UID', 'wrapper.uid !== 1003', 'wrapper.uid !== 0'],
  ['wrong wrapper executable', "wrapper.executable !== '/usr/local/bin/node'",
    "wrapper.executable !== '/usr/bin/node'"],
  ['wrong wrapper command', 'wrapper.commandLine !== wrapperCommand',
    "wrapper.commandLine !== 'wrong-command'"],
  ['wrong native command', 'child.commandLine !== `${binding.childBinary}\\0app-server\\0--stdio\\0`',
    "child.commandLine !== 'wrong-command'"],
  ['wrong parent', 'wrapperNumbers.parent !== runner.pid', 'wrapperNumbers.parent !== 1'],
  ['wrong start time', 'wrapperNumbers.start !== wrapper.startTime',
    "wrapperNumbers.start !== '1'"],
  ['wrong namespace', 'wrapper.containerIdentity !== runner.containerIdentity',
    "wrapper.containerIdentity !== 'pid:[1]'"],
  ['container replacement', 'const protection = probeContainer();',
    "const protection = 'private_process_identity_changed';"],
  ['live core allowance', '!coreProtected(wrapper.pid)', 'true'],
  ['live swap allowance', 'const protection = probeContainer();',
    "const protection = 'swap_not_disabled';"],
  ['lost kernel probe', 'return helper.pidAlive(pid) === true;', 'return false;'],
  ['dumpable wrapper', 'const wrapperDumpProtected = nativeDumpProtected(binding.wrapperPid);',
    'const wrapperDumpProtected = false;'],
  ['dumpable native child', 'const childDumpProtected = nativeDumpProtected(binding.childPid);',
    'const childDumpProtected = false;'],
  ['wrapper became dumpable',
    'const finalWrapperDumpProtected = nativeDumpProtected(binding.wrapperPid);',
    'const finalWrapperDumpProtected = false;'],
  ['native child became dumpable',
    'const finalChildDumpProtected = nativeDumpProtected(binding.childPid);',
    'const finalChildDumpProtected = false;'],
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

function installation(containerName: string): string {
  const format = '{{.Id}}|{{.Image}}|{{.State.StartedAt}}|{{.State.Pid}}';
  return docker(['inspect', '--format', format, containerName]);
}
// Inject observations only in this fixture image. The shipped entry has no fault switch.
const preload = `import { registerHooks } from 'node:module';
const faults = ${JSON.stringify(faults)};
const proofFaults = ${JSON.stringify(proofFaults)};
function load(url, context, next) {
  const loaded = next(url, context);
  if (url.endsWith('/host-probe.ts') && process.env.CASE !== 'host') {
    return { ...loaded, source: 'export function probeHost() { return true; }' };
  }
  function selected(row) {
    return row[0] === process.env.CASE;
  }
  const fault = faults.find(selected);
  const proofFault = proofFaults.find(selected);
  if (url.endsWith('/codex-connection.ts') && process.env.CASE === 'startup timeout') {
    const originalSource = String(loaded.source);
    const source = originalSource.replace('30_000', '200');
    return { ...loaded, source };
  }
  if (url.endsWith('/native-process-proof.ts')) {
    let source = String(loaded.source);
    if (process.env.CASE !== 'dumpable native') {
      const entry = 'export function nativeDumpProtected(pid: number): boolean {';
      if (!source.includes(entry)) {
        process.exit(2);
      }
      // Keep the other fault cases focused on their own guard.
      source = source.replace(entry, entry + ' return true;');
    }
    if (proofFault) {
      if (!source.includes(proofFault[1])) {
        process.exit(2);
      }
      source = source.replace(proofFault[1], proofFault[2]);
    }
    return { ...loaded, source };
  }
  if (url.endsWith('/canary-helper-proof.ts') &&
      process.env.CASE === 'non-tmpfs launch record') {
    // Keep the supervisor lock on tmpfs while the helper observes a persistent file system.
    let source = String(loaded.source);
    const check = 'statfsSync(recordDirectory).type';
    if (!source.includes(check)) {
      process.exit(2);
    }
    source = source.replace(check, 'fixtureFilesystemType(recordDirectory)');
    const fixture = String.raw\`
function fixtureFilesystemType(path) {
  const filesystem = statfsSync(path);
  if (process.env.CASE === 'non-tmpfs launch record') {
    return 0xef53;
  }
  return filesystem.type;
}
\`;
    return { ...loaded, source: fixture + source };
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
  if ((process.env.CASE === 'collector EOF' || process.env.CASE === 'collector timeout') &&
      observed.length === 2) {
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
  if (url.endsWith('/journey.mjs')) {
    // Let the fixture supervisor return failure receipts for exact assertions.
    const originalSource = String(loaded.source);
    const exitStatus = "process.exitCode = result.result === 'FAIL' ? 1 : 0;";
    if (!originalSource.includes(exitStatus)) {
      process.exit(2);
    }
    const source = originalSource.replace(exitStatus, 'process.exitCode = 0;');
    return { ...loaded, source };
  }
  return loaded;
}
const hooks = { load };
registerHooks(hooks);`;

function prepare(): void {
  docker(['build', '-q', '-f', 'infra/package/Dockerfile', '-t', packageTag, '.'], 600_000);
  docker(['buildx', 'build', '--load', '-q', '-f', 'apps/computer/Dockerfile',
    '--build-context', 'project=.', '-t', computerTag, 'apps/computer'], 600_000);
  const directory = mkdtempSync(join(tmpdir(), 'private-native-image-'));
  try {
    writeFileSync(join(directory, 'preload.mjs'), preload);
    const dockerfile = `FROM ${computerTag} AS with_native
USER root
COPY --from=${packageTag} /app/scripts/private-memory-qualification /app/scripts/private-memory-qualification
COPY --from=${packageTag} /app/apps/computer/src /app/apps/computer/src
COPY --from=${packageTag} /app/node_modules/zod /app/node_modules/zod
COPY preload.mjs /fixture/preload.mjs
FROM with_native AS missing_native
RUN rm -f /usr/local/bin/codex
FROM with_native AS missing_helper
RUN rm -f /app/apps/computer/src/codex-connection.ts
FROM with_native AS changed_launcher
RUN rm -f /usr/local/bin/codex && ln -s /fixture/preload.mjs /usr/local/bin/codex
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
  docker(['image', 'rm', '-f', tag, missingTag, missingHelperTag,
    changedLauncherTag, packageTag, computerTag]);
}
beforeAll(prepare, 970_000);
afterAll(cleanup, 30_000);

function installedProbe(image: string, group: string, path: string): void {
  const containerName = startContainer('safe', image);
  try {
    const output = docker(['exec', containerName, '/usr/local/bin/node',
      '--experimental-strip-types', path, group,
      '11111111-1111-4111-8111-111111111111']);
    expect(output).toBe('null');
  } finally {
    docker(['rm', '-f', '-v', containerName]);
  }
}

function runsInstalledInventoryProbes(): void {
  installedProbe(computerTag, 'nativeWrapper',
    '/scripts/private-memory-qualification/live-inventory-probe.ts');
  installedProbe(packageTag, 'canaryHelper',
    '/app/scripts/private-memory-qualification/live-inventory-probe.ts');
}
it('runs the native and helper probes from their pinned image paths',
  runsInstalledInventoryProbes, 60_000);

function startContainer(caseName: string, image: string): string {
  const containerName = `private-native-${randomUUID()}`;
  const coreLimit = caseName === 'core allowance' ? 'core=1:1' : 'core=0:0';
  const swapLimit = caseName === 'swap allowance' ? '1g' : '512m';
  const memoryOptions: string[] = [];
  if (caseName !== 'host') {
    memoryOptions.push('--memory=512m', `--memory-swap=${swapLimit}`);
  }
  const args = ['run', '-d', '--name', containerName, '--network=none', '--read-only', '--init', '--user=0',
    '--cap-add=SYS_PTRACE', '--cpus=0.5', ...memoryOptions,
    '--pids-limit=256', `--ulimit=${coreLimit}`,
    '--ulimit=nproc=256:256', '--tmpfs', '/home/private:mode=711',
    '-e', 'SILO_ID=native-test', '-e', `CASE=${caseName}`, image, 'sleep', '120'];
  const mountIndex = args.indexOf('-e');
  args.splice(mountIndex, 0, '--tmpfs', '/run');
  docker(args);
  return containerName;
}
function nativeCommand(): string[] {
  const command = ['nice', '-n', '10', '/usr/local/bin/node',
    '--experimental-strip-types'];
  command.push('/app/scripts/private-memory-qualification/journey.mjs');
  return command;
}
function supervisedCommand(): string[] {
  const source = readFileSync(new URL('./supervisor.mjs', import.meta.url), 'utf8');
  const failures = Object.keys(protectionMessages);
  const command = ['/usr/local/bin/node', '--input-type=module', '--eval', source,
    JSON.stringify(failures), JSON.stringify(nativeCommand())];
  return command;
}
function runSupervised(containerName: string, command: string[], input: string,
  useFixturePreload: boolean): Promise<string> {
  const options = { stdio: 'pipe' as const };
  const dockerArguments = ['exec'];
  if (useFixturePreload) {
    dockerArguments.push('--env', 'NODE_OPTIONS=--import=/fixture/preload.mjs');
  }
  dockerArguments.push('-i', containerName, ...command);
  const child = spawn('/usr/bin/docker', dockerArguments, options);
  const output: Buffer[] = [];
  const errors: Buffer[] = [];
  function collectOutput(chunk: Buffer): void {
    output.push(chunk);
  }
  function collectError(chunk: Buffer): void {
    errors.push(chunk);
  }
  function execute(resolve: (output: string) => void,
    reject: (error: Error) => void): void {
    const deadline = setTimeout(stop, 45_000);
    function stop(): void {
      child.kill('SIGKILL');
    }
    function closed(code: number | null): void {
      clearTimeout(deadline);
      const stdout = Buffer.concat(output).toString('utf8');
      const stderr = Buffer.concat(errors).toString('utf8');
      if (code !== 0) {
        reject(new Error(`supervised_fixture_failed:${code}:${stderr}`));
        return;
      }
      if (stderr !== '') {
        reject(new Error('supervised_fixture_wrote_stderr'));
        return;
      }
      resolve(stdout);
    }
    child.on('error', reject);
    child.on('close', closed);
    child.stdout.on('data', collectOutput);
    child.stderr.on('data', collectError);
    child.stdin.on('error', stop);
    child.stdin.write(`${JSON.stringify(input)}\n`);
  }
  return new Promise(execute);
}
async function run(caseName: string, image = tag, name = request.name): Promise<Record<string, unknown>> {
  const containerName = startContainer(caseName, image);
  const installationBefore = installation(containerName);
  try {
    const namedRequest = { ...request, name };
    const command = supervisedCommand();
    const output = await runSupervised(containerName, command, JSON.stringify(namedRequest),
      image !== packageTag);
    const receipt = receiptSchema.parse(JSON.parse(output));
    expect(installation(containerName) === installationBefore).toBe(true);
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
async function safeNative(): Promise<void> {
  const expected = { ...request, result: 'PARTIAL', complete: false };
  expect(await run('safe')).toMatchObject(expected);
}
it('observes two simultaneous pinned native processes and keeps qualification incomplete',
  safeNative, 60_000);
async function refusesActualDumpableNative(): Promise<void> {
  const expected = { result: 'FAIL', reason: 'journey_failed' };
  expect(await run('dumpable native')).toEqual(expected);
}
it('refuses the actual executed native processes when they are dumpable',
  refusesActualDumpableNative, 60_000);
async function refusesFault(name: string): Promise<void> {
  const expected = { result: 'FAIL', reason: 'journey_failed' };
  expect(await run(name)).toEqual(expected);
}
it.each(faults)('refuses %s without returning native output', refusesFault, 60_000);
it.each(proofFaults)('refuses %s before a private-turn receipt', refusesFault, 60_000);
async function refusesCoreAllowance(): Promise<void> {
  const expected = { result: 'FAIL', reason: 'host_refused',
    protectionFailure: 'core_limit_not_zero', complete: false };
  expect(await run('core allowance')).toEqual(expected);
}
it('refuses the helper when its core limit is not zero', refusesCoreAllowance, 60_000);
async function refusesSwapAllowance(): Promise<void> {
  await refusesFault('swap allowance');
}
it('refuses live swap allowance before a private-turn receipt',
  refusesSwapAllowance, 60_000);
async function refusesHost(): Promise<void> {
  const expected = { result: 'FAIL', reason: 'host_refused',
    protectionFailure: 'memory_limit_unproved', complete: false };
  expect(await run('host')).toEqual(expected);
  expect(await run('host', packageTag)).toEqual(expected);
}
it('keeps the real host refusal ahead of native execution in both images', refusesHost, 60_000);

async function missingNative(): Promise<void> {
  const expected = { result: 'FAIL', reason: 'journey_failed' };
  expect(await run('safe', missingTag)).toEqual(expected);
}
it('refuses the package without native files even with safe host observations', missingNative);

async function missingHelper(): Promise<void> {
  const expected = { result: 'FAIL', reason: 'journey_failed' };
  expect(await run('safe', missingHelperTag)).toEqual(expected);
}
it('refuses a missing production connection helper', missingHelper, 60_000);

async function changedLauncher(): Promise<void> {
  const expected = { result: 'FAIL', reason: 'journey_failed' };
  expect(await run('safe', changedLauncherTag)).toEqual(expected);
}
it('refuses a stand-in launcher script', changedLauncher, 60_000);

async function refusesNonTmpfsLaunchRecord(): Promise<void> {
  const expected = { result: 'FAIL', reason: 'host_refused',
    protectionFailure: 'private_process_unreadable', complete: false };
  expect(await run('non-tmpfs launch record')).toEqual(expected);
}
it('refuses a launch record directory that is not tmpfs',
  refusesNonTmpfsLaunchRecord, 60_000);

async function recallPrerequisites(): Promise<void> {
  const expected = { ...request, name: 'nativeRecall', result: 'NOT RUN', complete: false };
  expect(await run('safe', tag, 'nativeRecall')).toMatchObject(expected);
  const refused = { result: 'FAIL', reason: 'journey_failed' };
  expect(await run('safe', missingTag, 'nativeRecall')).toEqual(refused);
}
it('requires shipped native files for recall without qualifying empty threads',
  recallPrerequisites, 60_000);

function waitForNativeCount(containerName: string): string {
  const probe = String.raw`
const fs = require('node:fs');
let lockSeen = false;
const deadline = Date.now() + 90_000;
function readCount() {
  if (!fs.existsSync('/run/native-count')) {
    return 'missing';
  }
  return fs.readFileSync('/run/native-count', 'utf8');
}
function check() {
  const count = readCount();
  const lockExists = fs.existsSync('/run/opencrane-memory-qualification.lock');
  if (count === '2') {
    process.stdout.write(process.env.CASE + '|2');
    return;
  }
  if ((lockSeen && !lockExists) || Date.now() > deadline) {
    process.stdout.write(process.env.CASE + '|not-ready|' + count);
    process.exitCode = 1;
    return;
  }
  if (lockExists) {
    lockSeen = true;
  }
  setTimeout(check, 25);
}
check();
`;
  const argumentsForDocker = ['exec', containerName, 'node', '-e', probe];
  return docker(argumentsForDocker, 95_000);
}

async function collectorLoss(caseName: string): Promise<void> {
  const containerName = startContainer(caseName, tag);
  const installationBefore = installation(containerName);
  try {
    let source = readFileSync(new URL('./supervisor.mjs', import.meta.url), 'utf8');
    if (caseName === 'collector timeout') {
      source = source.replace('120_000', '60_000');
    }
    const failures = Object.keys(protectionMessages);
    const args = ['exec', '--env', 'NODE_OPTIONS=--import=/fixture/preload.mjs',
      '-i', containerName, '/usr/local/bin/node', '--input-type=module', '--eval',
      source, JSON.stringify(failures), JSON.stringify(nativeCommand())];
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
      const latestProbe = waitForNativeCount(containerName);
      const ready = latestProbe === `${caseName}|2`;
      const supervisorOutput = Buffer.concat(output).toString('utf8');
      const diagnostic = `native observation was not ready: ${latestProbe}; ` +
        `supervisor exit: ${String(child.exitCode)}; output: ${supervisorOutput}`;
      expect(ready, diagnostic).toBe(true);
      const unrelatedHome = 'turn-33333333-3333-4333-8333-333333333333';
      docker(['exec', containerName, 'mkdir', `/home/private/${unrelatedHome}`]);
    } finally {
      if (caseName === 'collector EOF') {
        child.stdin.end();
      }
    }
    expect(await stopped).toBe(1);
    expect(installation(containerName) === installationBefore).toBe(true);
    expect(Buffer.concat(output).length).toBe(0);
    assertStopped(containerName, true);
    const remainingHome = "const fs = require('node:fs'); " +
      "const names = fs.readdirSync('/home/private'); " +
      "if (names.length !== 1 || names[0] !== 'turn-33333333-3333-4333-8333-333333333333') " +
      'process.exit(1);';
    expect(docker(['exec', containerName, 'node', '-e', remainingHome])).toBe('');
    docker(['exec', containerName, 'test', '!', '-e', '/run/opencrane-memory-qualification.lock']);
    const recordsGone = "const fs = require('node:fs'); " +
      "function isNativeRecord(name) { return /^opencrane-native-/.test(name); } " +
      "if (fs.readdirSync('/run').some(isNativeRecord)) process.exit(1);";
    expect(docker(['exec', containerName, 'node', '-e', recordsGone])).toBe('');
  } finally {
    docker(['rm', '-f', '-v', containerName]);
  }
}
it.each(['collector EOF', 'collector timeout'])(
  '%s stops both native processes in the supervisor group', collectorLoss, 120_000,
);
