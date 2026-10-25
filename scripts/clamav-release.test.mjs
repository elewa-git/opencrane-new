import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';

const verifier = resolve('infra/clamav/release.mjs');
const pin = 'sha256:14e2e0805c6a5ff6728ea591c05565e0f0954d93e8701919012c3a8c44e20674';
const scannerImage = `private-canary/scanner@sha256:${'a'.repeat(64)}`;
const names = ['main', 'daily', 'bytecode'];
let scratch;
let output;
let manifestPath;
let approvedSha;
let manifest;

// Substitute Docker and sigtool only in these fixtures; no real image is inspected here.
const dockerFixture = `#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const mode = process.env.MODE;
appendFileSync(process.env.SCRATCH + '/calls', JSON.stringify(args) + '\\n');
if (existsSync(process.env.OUTPUT + '/release.json')) {
  process.exit(1);
}
console.error('private-canary /private/docker-path');
if (args[0] === 'image') {
  console.log('sha256:' + 'b'.repeat(64));
} else if (args[0] === 'inspect') {
  console.log('sha256:' + (mode === 'wrong-image' ? 'c' : 'b').repeat(64));
} else if (args[0] === 'cp') {
  const destination = args.at(-1);
  const copyOptions = { recursive: true };
  cpSync(process.env.SCRATCH + '/image-files/.', destination, copyOptions);
  if (mode === 'missing') {
    rmSync(destination + '/daily.cvd');
  }
  if (mode === 'altered') {
    appendFileSync(destination + '/daily.cvd', 'changed');
  }
  if (mode === 'extra') {
    writeFileSync(destination + '/extra.ndb', 'extra');
  }
  if (mode === 'duplicate') {
    cpSync(destination + '/daily.cvd', destination + '/daily.cld');
  }
  if (mode === 'symlink') {
    renameSync(destination + '/daily.cvd', destination + '/daily.saved');
    symlinkSync('daily.saved', destination + '/daily.cvd');
  }
} else if (args[0] === 'run') {
  const mount = args[args.indexOf('--mount') + 1];
  const source = /src=([^,]+)/.exec(mount)[1];
  const options = { cwd: source, env: process.env, stdio: 'inherit' };
  const result = spawnSync('sh', ['-c', args.at(-1)], options);
  if (mode === 'late-failure') {
    process.exit(1);
  }
  process.exit(result.status ?? 1);
} else if (args[0] === 'rm' && mode === 'cleanup-failure') {
  process.exit(1);
}
`;
const sigtoolFixture = `#!/usr/bin/env node
const file = process.argv.at(-1);
console.log('File: ' + file);
console.log('Build time: 01 Jan 2020 00:00 +0000');
console.log('Version: ' + (process.env.MODE === 'metadata' ? '43' : '42'));
console.log('Verification OK.');
`;
const publicationFixture = `import fs from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const mode = process.env.MODE;
if (mode.startsWith('slow-docker')) {
  const startedAt = Date.now();
  const originalExec = childProcess.execFileSync;
  let elapsed = 0;
  let operations = 0;
  function currentTime() {
    return startedAt + elapsed;
  }
  function slowDocker(command, args, options) {
    let delay = 0;
    if (args[0] !== 'rm') {
      if (mode === 'slow-docker') {
        delay = 840_000;
      } else if (mode === 'slow-docker-exact') {
        delay = operations === 0 ? 900_000 : 0;
      } else {
        const selected = Number(mode.slice('slow-docker-'.length));
        delay = operations === 0 && selected > 0 ? 840_000 : 1000;
        if (operations === selected) {
          delay = 960_000;
        }
      }
      operations++;
    }
    const timing = { operation: args[0], startedAt: elapsed, timeout: options.timeout };
    elapsed += Math.min(delay, options.timeout);
    timing.finishedAt = elapsed;
    fs.appendFileSync(process.env.SCRATCH + '/timings', JSON.stringify(timing) + '\\n');
    if (delay > options.timeout) {
      throw new Error('private-canary Docker timeout');
    }
    return originalExec(command, args, options);
  }
  Date.now = currentTime;
  childProcess.execFileSync = slowDocker;
}
const original = fs.promises.rename;
async function checkedRename(source, destination) {
  JSON.parse(fs.readFileSync(source + '/release.json', 'utf8'));
  if (fs.existsSync(destination)) {
    throw new Error('private-canary premature publication');
  }
  fs.writeFileSync(process.env.SCRATCH + '/publication', 'complete record, absent destination');
  if (process.env.MODE === 'publication-failure') {
    throw new Error('private-canary rename failure');
  }
  return original(source, destination);
}
fs.promises.rename = checkedRename;
syncBuiltinESMExports();
`;

function hash(bytes) {
  const digest = createHash('sha256');
  digest.update(bytes);
  return digest.digest('hex');
}

function approve() {
  const encoded = JSON.stringify(manifest);
  writeFileSync(manifestPath, encoded);
  approvedSha = hash(encoded);
}

function setup() {
  scratch = mkdtempSync(join(tmpdir(), 'clamav-private-canary-'));
  output = join(scratch, 'attempt');
  manifestPath = join(scratch, 'signatures.json');
  mkdirSync(join(scratch, 'bin'));
  mkdirSync(join(scratch, 'image-files'));
  const executableOptions = { mode: 0o755 };
  writeFileSync(join(scratch, 'bin/docker'), dockerFixture, executableOptions);
  writeFileSync(join(scratch, 'bin/sigtool'), sigtoolFixture, executableOptions);
  writeFileSync(join(scratch, 'publication.mjs'), publicationFixture);
  manifest = {
    formatVersion: 1, toolImage: `clamav/clamav-debian:1.5.2@${pin}`,
    databaseUpdatedAt: new Date().toISOString(), databases: [],
    updaterEvidence: { tool: 'FreshClam', exitCode: 0, databases: [] },
  };
  for (const name of names) {
    const header = 'ClamAV-VDB:01 Jan 2020 00-00 +0000:42:1:90:hash:signature:builder:1577836800';
    const bytes = header.padEnd(512, ' ') + name;
    const file = `${name}.cvd`;
    writeFileSync(join(scratch, 'image-files', file), bytes);
    const database = { file, sha256: hash(bytes), version: 42,
      builtAt: '2020-01-01T00:00:00.000Z' };
    const evidence = { file, version: 42, result: 'up-to-date' };
    manifest.databases.push(database);
    manifest.updaterEvidence.databases.push(evidence);
  }
  approve();
}

function cleanup() {
  const options = { recursive: true, force: true };
  rmSync(scratch, options);
}

function run(mode = '', image = scannerImage, approval = approvedSha) {
  const env = { ...process.env, MODE: mode, SCRATCH: scratch, OUTPUT: output,
    PATH: `${scratch}/bin:${process.env.PATH}` };
  const args = ['--import', join(scratch, 'publication.mjs'),
    verifier, manifestPath, approval, image, output];
  const options = { env, encoding: 'utf8', timeout: 20_000 };
  return spawnSync(process.execPath, args, options);
}

function refused(result) {
  expect(result.status).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toBe('Scanner release refused\n');
  expect(existsSync(join(output, 'release.json'))).toBe(false);
}

beforeEach(setup);
afterEach(cleanup);

function acceptsOldBuildWithRecentCheck() {
  const result = run();
  expect(result.status, result.stderr).toBe(0);
  const encoded = readFileSync(join(output, 'release.json'), 'utf8');
  const record = JSON.parse(encoded);
  const expected = { formatVersion: 1, imageDigest: `sha256:${'a'.repeat(64)}`,
    manifestDigest: `sha256:${approvedSha}`, databaseUpdatedAt: manifest.databaseUpdatedAt,
    inspectedAt: expect.any(String) };
  expect(record).toEqual(expected);
  expect(Date.parse(record.inspectedAt)).toBeLessThanOrEqual(Date.now());
  expect(encoded.length).toBeLessThan(1024);
  expect(encoded + result.stdout + result.stderr).not.toContain('private-canary');
  expect(readFileSync(join(scratch, 'publication'), 'utf8')).toBe(
    'complete record, absent destination');
  const callsText = readFileSync(join(scratch, 'calls'), 'utf8').trim();
  const calls = callsText.split('\n');
  const parsed = calls.map(JSON.parse);
  function isCreate(args) {
    return args[0] === 'create';
  }
  function isRun(args) {
    return args[0] === 'run';
  }
  function isRemoval(args) {
    return args[0] === 'rm';
  }
  expect(parsed.find(isCreate)).toEqual(expect.arrayContaining([
    '--network', 'none', '--read-only', '--pull', 'never', scannerImage,
  ]));
  expect(parsed.find(isRun)).toEqual(expect.arrayContaining([
    '--network', 'none', '--read-only', `clamav/clamav-debian:1.5.2@${pin}`,
  ]));
  expect(parsed.filter(isRemoval)).toHaveLength(2);
  expect(existsSync(`${output}.lock`)).toBe(false);
}
test('publishes bounded evidence only after offline inspection and cleanup', acceptsOldBuildWithRecentCheck);

const inspectionFailures = ['wrong-image', 'missing', 'altered', 'extra', 'duplicate',
  'symlink', 'metadata', 'late-failure', 'cleanup-failure', 'publication-failure'];
function rejectsInspection(mode) {
  refused(run(mode));
}
test.each(inspectionFailures)('refuses %s without a success record', rejectsInspection);

function rejectsApproval() {
  refused(run('', scannerImage, ''));
  refused(run('', scannerImage, 'f'.repeat(64)));
  const altered = { ...manifest, privateCanary: 'private-canary' };
  writeFileSync(manifestPath, JSON.stringify(altered));
  refused(run());
  expect(existsSync(join(scratch, 'calls'))).toBe(false);
}
test('requires a separately supplied approval for the exact manifest bytes', rejectsApproval);

function rejectsMutableImage(image) {
  refused(run('', image));
}
test.each(['scanner:latest', '/private-canary/image.tar', 'scanner', 'scanner:tag@sha256:bad'])(
  'refuses a tag or host substitute: %s', rejectsMutableImage);

const evidenceFailures = ['stale', 'future', 'partial', 'duplicate', 'failed', 'wrong-tool',
  'version', 'builtAt', 'hash', 'future-build', 'copied', 'mtime', 'restart'];
function rejectsEvidence(mode) {
  if (['stale', 'copied', 'mtime', 'restart'].includes(mode)) {
    manifest.databaseUpdatedAt = new Date(Date.now() - 86_401_000).toISOString();
  }
  if (mode === 'future') {
    manifest.databaseUpdatedAt = '2999-01-01T00:00:00.000Z';
  }
  if (mode === 'partial') {
    manifest.updaterEvidence.databases.pop();
  }
  if (mode === 'duplicate') {
    manifest.updaterEvidence.databases[2] = manifest.updaterEvidence.databases[0];
  }
  if (mode === 'failed') {
    manifest.updaterEvidence.exitCode = 1;
  }
  if (mode === 'wrong-tool') {
    manifest.toolImage = 'scanner:latest';
  }
  if (mode === 'version') {
    manifest.databases[0].version = 43;
  }
  if (mode === 'builtAt') {
    manifest.databases[0].builtAt = '2021-01-01T00:00:00.000Z';
  }
  if (mode === 'hash') {
    manifest.databases[0].sha256 = 'f'.repeat(64);
  }
  if (mode === 'future-build') {
    manifest.databases[0].builtAt = '2999-01-01T00:00:00.000Z';
  }
  approve();
  const now = new Date();
  utimesSync(manifestPath, now, now);
  refused(run());
  if (mode === 'restart') {
    refused(run());
  }
}
test.each(evidenceFailures)('approval cannot make %s evidence valid', rejectsEvidence);

function retainsUncertainCleanup() {
  refused(run('cleanup-failure'));
  expect(existsSync(`${output}.lock`)).toBe(true);
  const calls = readFileSync(join(scratch, 'calls'), 'utf8');
  refused(run());
  expect(readFileSync(join(scratch, 'calls'), 'utf8')).toBe(calls);
}
test('retains the lock and blocks reuse when cleanup is uncertain', retainsUncertainCleanup);

function keepsEarlierRecords() {
  expect(run().status).toBe(0);
  const previous = readFileSync(join(output, 'release.json'));
  output = join(scratch, 'next-attempt');
  refused(run('late-failure'));
  expect(readFileSync(join(scratch, 'attempt/release.json'))).toEqual(previous);
  expect(existsSync(`${output}.lock`)).toBe(false);
  expect(run().status).toBe(0);
}
test('preserves separate earlier records and permits retry after confirmed cleanup', keepsEarlierRecords);

function isStartup(timing) {
  return timing.operation !== 'rm';
}

function isCleanup(timing) {
  return timing.operation === 'rm';
}

function expectDeadlineAndCleanup(operationCount, cleanupCount) {
  const encoded = readFileSync(join(scratch, 'timings'), 'utf8').trim();
  const lines = encoded.split('\n');
  const timings = lines.map(JSON.parse);
  const startup = timings.filter(isStartup);
  expect(startup).toHaveLength(operationCount);
  expect(startup.at(-1).finishedAt).toBe(900_000);
  for (const timing of startup) {
    expect(timing.timeout).toBeGreaterThan(0);
    expect(timing.startedAt + timing.timeout).toBeLessThanOrEqual(900_000);
  }
  const cleanup = timings.filter(isCleanup);
  expect(cleanup).toHaveLength(cleanupCount);
  for (const timing of cleanup) {
    expect(timing.timeout).toBe(30_000);
  }
  expect(existsSync(`${output}.lock`)).toBe(false);
}

function stopsCumulativeDelay() {
  refused(run('slow-docker'));
  expectDeadlineAndCleanup(2, 1);
}
test('stops cumulative slow Docker calls at the overall release deadline', stopsCumulativeDelay);

function boundsSlowOperation(index) {
  refused(run(`slow-docker-${index}`));
  let cleanupCount = 1;
  if (index === 0) {
    cleanupCount = 0;
  } else if (index === 4) {
    cleanupCount = 2;
  }
  expectDeadlineAndCleanup(index + 1, cleanupCount);
}
test.each([0, 1, 2, 3, 4])(
  'bounds release Docker operation %i by the remaining attempt time', boundsSlowOperation);

function stopsAtExactDeadline() {
  refused(run('slow-docker-exact'));
  expectDeadlineAndCleanup(1, 1);
}
test('starts no further Docker work when the release allowance is exhausted', stopsAtExactDeadline);
