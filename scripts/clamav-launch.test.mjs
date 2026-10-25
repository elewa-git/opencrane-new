import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

async function mockDocker(importOriginal) {
  const original = await importOriginal();
  return { ...original, execFileSync: vi.fn(original.execFileSync),
    spawn: vi.fn(original.spawn) };
}
vi.mock('node:child_process', mockDocker);

const image = `scanner@sha256:${'a'.repeat(64)}`;
const imageId = `sha256:${'b'.repeat(64)}`;
const names = ['main', 'daily', 'bytecode'];
let scratch;
let manifest;
let options;
let now;
let mode;
let commands;
let session;
let realExec;
let launchScanner;
let delays;
let timings;
let daemon;
let sockets;
let supplied;
let children;
let scanMode;
const containerId = 'c'.repeat(64);
const runningState = `${containerId} ${imageId} 2026-10-25T12:00:00Z true 0`;

function hash(bytes) {
  const digest = createHash('sha256');
  digest.update(bytes);
  return digest.digest('hex');
}

function approve() {
  const bytes = JSON.stringify(manifest);
  options.approvedSha = hash(bytes);
  writeFileSync(options.manifestPath, bytes);
  const record = { formatVersion: 1, imageDigest: image.slice(image.indexOf('@') + 1),
    manifestDigest: `sha256:${options.approvedSha}`, databaseUpdatedAt: manifest.databaseUpdatedAt,
    inspectedAt: new Date(now).toISOString() };
  writeFileSync(options.releasePath, JSON.stringify(record));
}

function docker(command, args, options) {
  if (command !== 'docker') {
    throw new Error('private-canary');
  }
  commands.push(args);
  const timing = { operation: args[0], startedAt: now, timeout: options.timeout };
  timings.push(timing);
  if (args[0] !== 'rm') {
    const delay = delays.shift() ?? 0;
    now += Math.min(delay, options.timeout);
    if (delay > options.timeout) {
      throw new Error('private-canary Docker timeout');
    }
  }
  if (args[0] === 'create') {
    return containerId;
  }
  if (args[0] === 'image') {
    return imageId;
  }
  if (args[0] === 'inspect') {
    if (args[2].includes('.State.StartedAt')) {
      return runningState;
    }
    if (args.includes('{{.Image}}')) {
      return mode === 'image' ? 'wrong' : imageId;
    }
    const mounts = mode === 'mount' ? [{ Destination: '/var/lib/clamav' }] : [];
    return JSON.stringify(mounts);
  }
  if (args[0] === 'cp') {
    const directory = args.at(-1);
    for (const name of names) {
      if (mode !== 'missing' || name !== 'daily') {
        cpSync(join(scratch, `${name}.cvd`), join(directory, `${name}.cvd`));
      }
    }
    if (mode === 'changed') {
      writeFileSync(join(directory, 'daily.cvd'), 'private-canary');
    }
    if (mode === 'extra') {
      writeFileSync(join(directory, 'extra.ndb'), 'private-canary');
    }
    if (mode === 'symlink') {
      rmSync(join(directory, 'daily.cvd'));
      symlinkSync(join(scratch, 'daily.cvd'), join(directory, 'daily.cvd'));
    }
  }
  if (args[0] === 'run') {
    let output = '';
    for (const database of manifest.databases) {
      const checksum = `${database.sha256}  ${database.file}\n`;
      output += `\nOPENCRANE_DATABASE ${database.file}\n${checksum}` +
        `File: ${database.file}\nBuild time: 01 Jan 2020 00:00 +0000\n` +
        `Version: 42\nVerification OK.\n${checksum}`;
    }
    return output;
  }
  if (args[0] === 'rm' && mode === 'cleanup') {
    throw new Error('private-canary');
  }
  if (args[0] === 'exec' && mode === 'daemon') {
    throw new Error('private-canary');
  }
  return '';
}

function currentTime() {
  return now;
}

async function setup() {
  vi.useFakeTimers();
  now = Date.parse('2026-10-25T12:00:00.000Z');
  scratch = mkdtempSync(join(tmpdir(), 'scanner-test-'));
  options = { image, manifestPath: join(scratch, 'manifest.json'),
    releasePath: join(scratch, 'release.json'), ownership: join(scratch, 'owner'),
    clock: currentTime };
  manifest = { formatVersion: 1,
    toolImage: 'clamav/clamav-debian:1.5.2@' +
      'sha256:14e2e0805c6a5ff6728ea591c05565e0f0954d93e8701919012c3a8c44e20674',
    databaseUpdatedAt: new Date(now - 1000).toISOString(), databases: [],
    updaterEvidence: { tool: 'FreshClam', exitCode: 0, databases: [] } };
  for (const name of names) {
    const file = `${name}.cvd`;
    const header = 'ClamAV-VDB:01 Jan 2020 00-00 +0000:42:1:90:hash:signature:builder:1577836800';
    const bytes = header.padEnd(512, ' ') + name;
    writeFileSync(join(scratch, file), bytes);
    const database = { file, sha256: hash(bytes), version: 42,
      builtAt: '2020-01-01T00:00:00.000Z' };
    const evidence = { file, version: 42, result: 'up-to-date' };
    manifest.databases.push(database);
    manifest.updaterEvidence.databases.push(evidence);
  }
  approve();
  commands = [];
  delays = [];
  timings = [];
  mode = '';
  scanMode = '';
  sockets = [];
  supplied = [];
  children = [];
  session = undefined;
  realExec = (await vi.importActual('node:child_process')).execFileSync;
  execFileSync.mockImplementation(docker);
  spawn.mockImplementation(scanProcess);
  ({ launchScanner } = await import('../infra/clamav/launch.mjs'));
}

async function cleanup() {
  mode = '';
  await session?.stop();
  for (const child of children) {
    child.kill('SIGKILL');
  }
  for (const socket of sockets) {
    socket.destroy();
  }
  if (daemon) {
    function closeDaemon(resolve) {
      daemon.close(resolve);
    }
    await new Promise(closeDaemon);
    daemon = undefined;
  }
  vi.useRealTimers();
  const removeOptions = { recursive: true, force: true };
  rmSync(scratch, removeOptions);
}
beforeEach(setup);
afterEach(cleanup);

function starts(args) {
  return args[0] === 'start';
}
function creates(args) {
  return args[0] === 'create';
}
function removes(args) {
  return args[0] === 'rm';
}

async function refuses(reason) {
  mode = reason;
  if (reason === 'approval') {
    options.approvedSha = '';
  }
  if (reason === 'release') {
    writeFileSync(options.releasePath, '{}');
  }
  if (reason === 'future') {
    manifest.databaseUpdatedAt = new Date(now + 1).toISOString();
  }
  if (reason === 'stale') {
    manifest.databaseUpdatedAt = new Date(now - 86400000).toISOString();
  }
  if (reason === 'partial') {
    manifest.updaterEvidence.databases.pop();
  }
  if (['future', 'stale', 'partial'].includes(reason)) {
    approve();
  }
  await expect(launchScanner(options)).rejects.toThrow('Scanner launch refused');
  expect(commands.filter(starts)).toHaveLength(0);
}
test.each(['approval', 'release', 'future', 'stale', 'partial', 'image', 'mount',
  'missing', 'changed', 'extra', 'symlink'])('prevents start for %s', refuses);

async function startsImmutableSet() {
  session = await launchScanner(options);
  expect(await session.ready()).toBe(true);
  expect(session.databaseUpdatedAt).toBe(manifest.databaseUpdatedAt);
  const create = commands.find(creates);
  expect(create).toEqual(expect.arrayContaining(['--network', 'none', '--read-only',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', 'clamav']));
  expect(create).toEqual(expect.arrayContaining(
    ['--tmpfs', '/tmp:rw,noexec,nosuid,size=64m,mode=1777']));
  expect(create).not.toContain('--publish');
  expect(create).not.toContain('--mount');
  const script = create.at(-1);
  expect(script).toContain('TCPAddr 127.0.0.1');
  expect(script).toContain('SelfCheck 0');
  expect(script).not.toContain('freshclam');
  expect(script).toContain('ConcurrentDatabaseReload no');
  expect(JSON.stringify(session)).not.toContain('private-canary');
  now = Date.parse(manifest.databaseUpdatedAt) + 86400000;
  expect(await session.ready()).toBe(false);
  expect(session.databaseUpdatedAt).toBe(manifest.databaseUpdatedAt);
  expect(commands.filter(removes).length).toBeGreaterThan(0);
  await expect(launchScanner(options)).rejects.toThrow('Scanner launch refused');
}
test('loads old builds with a fresh check and stops readiness at expiry', startsImmutableSet);

async function rejectsLastMomentChange(change) {
  session = await launchScanner(options);
  const script = commands.find(creates).at(-1);
  const preflight = script.slice(0, script.indexOf('exec /usr/sbin/clamd')) + '\nprintf verified';
  const directory = join(options.ownership, 'databases');
  const runOptions = { cwd: directory, stdio: 'pipe' };
  expect(realExec('sh', ['-c', preflight], runOptions).toString()).toBe('verified');
  if (change === 'changed') {
    writeFileSync(join(directory, 'daily.cvd'), 'private-canary');
  }
  if (change === 'missing') {
    rmSync(join(directory, 'daily.cvd'));
  }
  if (change === 'extra') {
    writeFileSync(join(directory, 'extra.ndb'), 'extra');
  }
  if (change === 'symlink') {
    rmSync(join(directory, 'daily.cvd'));
    symlinkSync(join(scratch, 'daily.cvd'), join(directory, 'daily.cvd'));
  }
  function runGate() {
    realExec('sh', ['-c', preflight], runOptions);
  }
  expect(runGate).toThrow();
}
test.each(['changed', 'missing', 'extra', 'symlink'])(
  'the actual container start script refuses a later %s file', rejectsLastMomentChange);

async function retainsOwnership() {
  session = await launchScanner(options);
  mode = 'cleanup';
  await expect(session.stop()).rejects.toThrow('Scanner launch refused');
  const before = commands.length;
  await expect(launchScanner(options)).rejects.toThrow('Scanner launch refused');
  expect(commands).toHaveLength(before);
  expect(readFileSync(join(options.ownership, 'containers.json'), 'utf8')).toContain('clamav-');
}
test('retains ownership and refuses retry when cleanup cannot be confirmed', retainsOwnership);

async function stopsOnTerm() {
  session = await launchScanner(options);
  process.emit('SIGTERM');
  expect(await session.ready()).toBe(false);
  await session.stop();
  const removals = commands.filter(removes);
  for (const args of removals) {
    expect(args).toEqual(['rm', '-f', '-v', expect.stringMatching(/^(clamav-|c{64}$)/)]);
  }
}
test('TERM removes only owned containers', stopsOnTerm);

async function expiresWithoutPolling() {
  session = await launchScanner(options);
  await vi.advanceTimersByTimeAsync(86400000);
  await session.stop();
  expect(await session.ready()).toBe(false);
  expect(session.databaseUpdatedAt).toBe(manifest.databaseUpdatedAt);
}
test('expiry stops the container even without a readiness request', expiresWithoutPolling);

async function cleansFailedStart() {
  mode = 'daemon';
  await expect(launchScanner(options)).rejects.toEqual(new Error('Scanner launch refused'));
  expect(commands.filter(removes)).toHaveLength(2);
  mode = '';
  session = await launchScanner(options);
  expect(await session.ready()).toBe(true);
}
test('sanitises daemon failures and permits retry only after cleanup', cleansFailedStart);

async function rejectsReleaseMismatch(field) {
  const record = JSON.parse(readFileSync(options.releasePath, 'utf8'));
  record[field] = 'private-canary';
  writeFileSync(options.releasePath, JSON.stringify(record));
  await expect(launchScanner(options)).rejects.toEqual(new Error('Scanner launch refused'));
  expect(commands).toHaveLength(0);
}
test.each(['imageDigest', 'manifestDigest', 'databaseUpdatedAt', 'inspectedAt'])(
  'rejects changed release %s before Docker runs', rejectsReleaseMismatch);

async function startSession() {
  session = await launchScanner(options);
}

function isStartup(timing) {
  return timing.operation !== 'rm';
}

function isCleanup(timing) {
  return timing.operation === 'rm';
}

function expectDeadlineAndCleanup(startedAt, operationCount) {
  expect(now - startedAt).toBe(900_000);
  const startup = timings.filter(isStartup);
  expect(startup).toHaveLength(operationCount);
  for (const timing of startup) {
    expect(timing.timeout).toBeGreaterThan(0);
    expect(timing.startedAt - startedAt + timing.timeout).toBeLessThanOrEqual(900_000);
  }
  const cleanup = timings.filter(isCleanup);
  expect(cleanup.length).toBeGreaterThan(0);
  for (const timing of cleanup) {
    expect(timing.timeout).toBe(30_000);
  }
}

async function stopsCumulativeDelay() {
  const startedAt = now;
  delays = Array(8).fill(840_000);
  await expect(startSession()).rejects.toEqual(new Error('Scanner launch refused'));
  expectDeadlineAndCleanup(startedAt, 2);
  expect(commands.filter(starts)).toHaveLength(0);
}
test('stops cumulative slow Docker calls at the overall startup deadline', stopsCumulativeDelay);

const startupOperations = ['image lookup', 'create', 'image identity', 'mount inspection',
  'database copy', 'database inspection', 'start', 'initial ping'];

async function boundsSlowOperation(operation) {
  const index = startupOperations.indexOf(operation);
  const startedAt = now;
  delays = Array(index).fill(1000);
  if (index > 0) {
    delays[0] = 840_000;
  }
  delays.push(960_000);
  await expect(startSession()).rejects.toEqual(new Error('Scanner launch refused'));
  expectDeadlineAndCleanup(startedAt, index + 1);
}
test.each(startupOperations)('bounds slow %s by the remaining startup time', boundsSlowOperation);

async function stopsAtExactDeadline() {
  const startedAt = now;
  delays = [900_000];
  await expect(startSession()).rejects.toEqual(new Error('Scanner launch refused'));
  expectDeadlineAndCleanup(startedAt, 1);
  expect(commands.filter(creates)).toHaveLength(0);
}
test('starts no further Docker work when the startup allowance is exhausted', stopsAtExactDeadline);


function scanProcess(command, args, options) {
  expect(command).toBe('docker');
  const realSpawn = realChildProcess.spawn;
  let script;
  if (args[0] === 'inspect') {
    expect(args.at(-1)).toBe(containerId);
    let state = runningState;
    if (scanMode === 'replaced') {
      state = runningState.replace(containerId, 'd'.repeat(64));
    }
    if (scanMode === 'restarted') {
      state = runningState.replace('12:00:00', '12:00:01');
    }
    if (scanMode === 'daemon-stopped') {
      state = runningState.replace('true', 'false');
    }
    script = `process.stdout.write(${JSON.stringify(state)})`;
    if (scanMode === 'slow-inspect') {
      now += 40_000;
    }
    if (scanMode === 'timeout-after-inspection') {
      now += 45000;
    }
  } else {
    expect(args).toEqual(['exec', '-i', containerId, 'nc', '127.0.0.1', '3310']);
    const port = daemon.address().port;
    script = `const socket = require('node:net').connect(${port}, '127.0.0.1');
      process.stdin.pipe(socket); socket.pipe(process.stdout);
      socket.on('error', () => process.exit(1));`;
  }
  if (scanMode === 'tool-error') {
    script = "process.stderr.write('private-canary'); process.exit(1);";
  }
  const child = realSpawn(process.execPath, ['-e', script], options);
  children.push(child);
  return child;
}
let realChildProcess;

function acceptStream(socket) {
  sockets.push(socket);
  let framed = Buffer.alloc(0);
  function receive(chunk) {
    framed = Buffer.concat([framed, chunk]);
    if (framed.length < 10) {
      return;
    }
    expect(framed.subarray(0, 10).toString()).toBe('zINSTREAM\0');
    let offset = 10;
    const parts = [];
    while (offset + 4 <= framed.length) {
      const length = framed.readUInt32BE(offset);
      offset += 4;
      if (offset + length > framed.length) {
        return;
      }
      if (length === 0) {
        expect(offset).toBe(framed.length);
        const bytes = Buffer.concat(parts);
        supplied.push(bytes);
        daemon.emit('supplied');
        if (scanMode === 'hang' || scanMode === 'timeout-after-inspection') {
          return;
        }
        if (scanMode === 'expiry') {
          now = Date.parse(manifest.databaseUpdatedAt) + 86400000;
        }
        if (scanMode === 'slow-inspect') {
          now += 10_000;
        }
        if (scanMode === 'replace-after') {
          scanMode = 'replaced';
        }
        let reply = 'stream: OK\0';
        if (bytes.toString() === 'infected') {
          reply = 'stream: private-canary FOUND\0';
        }
        if (scanMode.startsWith('reply:')) {
          reply = scanMode.slice(6);
        }
        socket.end(reply);
        return;
      }
      expect(length).toBeLessThanOrEqual(65536);
      parts.push(framed.subarray(offset, offset + length));
      offset += length;
    }
  }
  socket.on('data', receive);
}

async function scannerForRequests() {
  realChildProcess = await vi.importActual('node:child_process');
  daemon = createServer(acceptStream);
  daemon.listen(0, '127.0.0.1');
  await once(daemon, 'listening');
  session = await launchScanner(options);
  expect(session.scan).toBeTypeOf('function');
}

function request(bytes = Buffer.from('private-canary')) {
  return { bytes, sha256: hash(bytes), byteCount: bytes.length };
}

async function mapsVerdict(value) {
  await scannerForRequests();
  const input = request(Buffer.from(value));
  const result = await session.scan(input);
  expect(result).toEqual({ verdict: value, sha256: input.sha256, byteCount: input.byteCount,
    imageDigest: image.slice(image.indexOf('@') + 1), manifestDigest: `sha256:${options.approvedSha}`,
    databaseUpdatedAt: manifest.databaseUpdatedAt, databases: manifest.databases,
    checkedAt: new Date(now).toISOString(), expiresAt: new Date(now + 120000).toISOString() });
  expect(supplied).toEqual([input.bytes]);
  expect(JSON.stringify(result)).not.toContain('private-canary');
  result.databases[0].version = 999;
  expect((await session.scan(input)).databases).toEqual(manifest.databases);
}
test.each(['clean', 'infected'])('maps %s with exact bytes and loaded facts', mapsVerdict);

async function refusesBytes(change) {
  await scannerForRequests();
  const input = request();
  if (change === 'changed') {
    input.bytes[0] ^= 1;
  }
  if (change === 'truncated') {
    input.bytes = input.bytes.subarray(1);
  }
  if (change === 'oversized') {
    input.bytes = Buffer.alloc(20 * 1024 * 1024 + 1);
  }
  await expect(session.scan(input)).rejects.toEqual(new Error('Scanner scan refused'));
  expect(supplied).toHaveLength(0);
}
test.each(['changed', 'truncated', 'oversized'])('refuses %s bytes', refusesBytes);

async function refusesReply(reply) {
  await scannerForRequests();
  scanMode = `reply:${reply}`;
  await expect(session.scan(request())).rejects.toEqual(new Error('Scanner scan refused'));
}
test.each(['stream: OK', 'stream: OK\0private-canary', 'private-canary',
  'stream: OK\0stream: OK\0', 'x'.repeat(4097), 'stream: private-canary ERROR\0'])(
  'refuses malformed daemon reply %# without leaking it', refusesReply);

async function refusesChangedDaemon(reason) {
  await scannerForRequests();
  scanMode = reason;
  if (reason === 'stopped') {
    await session.stop();
  }
  if (reason === 'future') {
    now = Date.parse(manifest.databaseUpdatedAt) - 1;
  }
  if (reason === 'stale') {
    now = Date.parse(manifest.databaseUpdatedAt) + 86400000;
  }
  await expect(session.scan(request())).rejects.toEqual(new Error('Scanner scan refused'));
}
test.each(['replaced', 'replace-after', 'restarted', 'daemon-stopped', 'stopped',
  'future', 'stale', 'expiry', 'slow-inspect', 'tool-error'])(
  'refuses %s daemon or dates with one deadline', refusesChangedDaemon);

async function isolatesBuffers() {
  await scannerForRequests();
  const first = request(Buffer.alloc(131073, 7));
  const second = request(Buffer.from('infected'));
  const firstPending = session.scan(first);
  first.bytes.fill(8);
  const results = await Promise.all([firstPending, session.scan(second)]);
  expect(results[0].sha256).toBe(first.sha256);
  expect(results[1].verdict).toBe('infected');
  expect(supplied).toContainEqual(Buffer.alloc(131073, 7));
  expect(supplied).toContainEqual(second.bytes);
}
test('isolates concurrent buffers and snapshots before awaiting Docker', isolatesBuffers);

async function limitsExpiry() {
  await scannerForRequests();
  now = Date.parse(manifest.databaseUpdatedAt) + 86400000 - 500;
  session.databaseUpdatedAt = new Date(now).toISOString();
  options.image = 'forged';
  const result = await session.scan(request());
  expect(Date.parse(result.expiresAt)).toBe(now + 500);
  expect(result.databaseUpdatedAt).toBe(manifest.databaseUpdatedAt);
  expect(result.imageDigest).toBe(image.slice(image.indexOf('@') + 1));
}
test('caps result expiry at the unchanged loaded database expiry', limitsExpiry);

async function closesInterruptedScan(reason) {
  await scannerForRequests();
  scanMode = 'hang';
  if (reason === 'timeout-after-inspection') {
    scanMode = reason;
  }
  const controller = new AbortController();
  const input = { ...request(), signal: controller.signal };
  const received = once(daemon, 'supplied');
  const pending = session.scan(input);
  const rejected = expect(pending).rejects.toEqual(new Error('Scanner scan refused'));
  await received;
  if (reason === 'timeout-after-inspection') {
    await vi.advanceTimersByTimeAsync(15000);
  }
  if (reason === 'timeout') {
    await vi.advanceTimersByTimeAsync(60000);
  }
  if (reason === 'cleanup') {
    mode = 'cleanup';
  }
  if (reason === 'cancel' || reason === 'cleanup') {
    controller.abort();
  }
  if (reason === 'TERM') {
    process.emit('SIGTERM');
  }
  await rejected;
  await expect(session.scan(request())).rejects.toEqual(new Error('Scanner scan refused'));
  if (reason === 'cleanup') {
    expect(readFileSync(join(options.ownership, 'containers.json'), 'utf8')).toContain('clamav-');
    await expect(launchScanner(options)).rejects.toThrow('Scanner launch refused');
  }
  for (const child of children) {
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  }
}
test.each(['timeout', 'timeout-after-inspection', 'cancel', 'TERM', 'cleanup'])(
  '%s closes the request and prevents reuse after uncertain transport cleanup', closesInterruptedScan);
