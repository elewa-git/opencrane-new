import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';

const refresh = resolve('infra/clamav/refresh.sh');
const pin = 'sha256:14e2e0805c6a5ff6728ea591c05565e0f0954d93e8701919012c3a8c44e20674';
const names = ['main', 'daily', 'bytecode'];
let scratch;
let candidate;
let manifest;
let binaries;

// Run the real container shell with local updater fixtures, without contacting upstream.
const dockerFixture = `#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.CALLS, JSON.stringify(args) + '\\n');
if (args[0] === 'rm') {
  if (process.env.MODE === 'cleanup-failure') process.exit(1);
  process.exit(0);
}
if (process.env.MODE === 'client-failure' || process.env.MODE === 'cleanup-failure') {
  console.error('private-canary Docker connection lost');
  process.exit(1);
}
if (existsSync(process.env.CANDIDATE + '/signatures.json')) process.exit(1);
const options = {
  cwd: process.env.CANDIDATE, env: process.env, stdio: 'inherit',
};
const result = spawnSync('sh', ['-c', args.at(-1)], options);
if (process.env.MODE === 'host-altered') {
  appendFileSync(process.env.CANDIDATE + '/daily.cvd', 'changed after verification');
}
process.exit(result.status ?? 1);
`;
const updaterFixture = `#!/usr/bin/env node
import { copyFileSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
const mode = process.env.MODE;
if (mode === 'offset-date') {
  for (const name of ['main', 'daily', 'bytecode']) {
    const bytes = readFileSync(name + '.cvd', 'utf8');
    writeFileSync(name + '.cvd', bytes.replace('1577836800', '1577851200'));
  }
}
if (mode === 'missing') rmSync('bytecode.cvd');
if (mode === 'duplicate') copyFileSync('daily.cvd', 'daily.cld');
if (mode === 'cld') renameSync('daily.cvd', 'daily.cld');
if (mode === 'extra') writeFileSync('extra.cvd', 'unknown database');
if (mode === 'symlink') {
  renameSync('daily.cvd', 'daily.saved');
  symlinkSync('daily.saved', 'daily.cvd');
}
for (const name of ['main', 'daily', 'bytecode']) {
  if (mode === 'partial' && name === 'bytecode') continue;
  if (mode === 'copied') continue;
  const extension = mode === 'cld' && name === 'daily' ? 'cld' : 'cvd';
  const result = mode === 'cld' ? 'updated' : 'database is up-to-date';
  console.log(name + '.' + extension + ' ' + result +
    ' (version: 42, sigs: 1, f-level: 90, builder: fixture)');
}
if (mode === 'duplicate-check') {
  console.log('main.cvd database is up-to-date ' +
    '(version: 42, sigs: 1, f-level: 90, builder: fixture)');
}
console.error('private-canary /private/updater-path');
if (mode === 'late-failure') process.exit(1);
if (mode === 'oversized') console.log('x'.repeat(2 * 1024 * 1024));
`;
const sigtoolFixture = `#!/usr/bin/env node
import { appendFileSync, existsSync } from 'node:fs';
const file = process.argv.at(-1);
const mode = process.env.MODE;
if (existsSync('signatures.json')) process.exit(1);
let date = '01 Jan 2020 00:00 +0000';
if (mode === 'malformed-date') date = 'private-canary';
if (mode === 'impossible-date') date = '31 Feb 2020 00:00 +0000';
if (mode === 'future-date') date = '01 Jan 2999 00:00 +0000';
if (mode === 'offset-date') date = '01 Jan 2020 00:00 -0400';
if (mode === 'invalid-offset') date = '01 Jan 2020 00:00 +2500';
if (mode === 'invalid-offset-minute') date = '01 Jan 2020 00:00 +0060';
if (mode === 'mismatched-build-date') date = '01 Jan 2021 00:00 +0000';
console.log('File: ' + file);
console.log('Build time: ' + date);
console.log('Version: ' + (mode === 'wrong-version' ? '43' : '42'));
if (mode === 'duplicate-metadata') console.log('Version: 42');
if (mode === 'altered') appendFileSync(file, 'altered');
if (mode === 'metadata-failure') process.exit(1);
if (mode !== 'unverified') console.log('Verification OK.');
`;

function executable(name, source) {
  const options = { mode: 0o755 };
  writeFileSync(join(binaries, name), source, options);
}

function setup() {
  scratch = mkdtempSync(join(tmpdir(), 'clamav-private-canary-'));
  candidate = join(scratch, 'candidate');
  binaries = join(scratch, 'bin');
  mkdirSync(candidate);
  mkdirSync(binaries);
  manifest = join(candidate, 'signatures.json');
  executable('docker', dockerFixture);
  executable('freshclam', updaterFixture);
  executable('sigtool', sigtoolFixture);
  for (const name of names) {
    const header = 'ClamAV-VDB:01 Jan 2020 00-00 +0000:42:1:90:hash:signature:builder:1577836800';
    const bytes = header.padEnd(512, ' ') + `${name} fixture bytes`;
    writeFileSync(join(candidate, `${name}.cvd`), bytes);
  }
}

function cleanup() {
  const options = { recursive: true, force: true };
  rmSync(scratch, options);
}

function run(mode = 'unchanged') {
  const env = {
    ...process.env, MODE: mode, CANDIDATE: candidate,
    CALLS: join(scratch, 'calls'), PATH: `${binaries}:${process.env.PATH}`,
  };
  const options = { env, encoding: 'utf8', timeout: 20_000 };
  return spawnSync('sh', [refresh, candidate], options);
}

function readManifest() {
  return JSON.parse(readFileSync(manifest, 'utf8'));
}

beforeEach(setup);
afterEach(cleanup);

function recordsUnchangedSet() {
  const startedAt = Date.now();
  const result = run();
  expect(result.status, result.stderr).toBe(0);
  const evidence = readManifest();
  expect(evidence.toolImage).toContain(pin);
  expect(Date.parse(evidence.databaseUpdatedAt)).toBeGreaterThanOrEqual(startedAt);
  expect(Date.parse(evidence.databaseUpdatedAt)).toBeLessThanOrEqual(Date.now());
  expect(evidence.databases).toHaveLength(3);
  for (const database of evidence.databases) {
    const hash = createHash('sha256');
    hash.update(readFileSync(join(candidate, database.file)));
    expect(database.sha256).toBe(hash.digest('hex'));
    expect(database.version).toBe(42);
    expect(database.builtAt).toBe('2020-01-01T00:00:00.000Z');
  }
  expect(evidence.updaterEvidence.databases).toHaveLength(3);
  expect(readFileSync(manifest, 'utf8')).not.toContain('private-canary');
  expect(readFileSync(manifest, 'utf8').length).toBeLessThan(8192);
  expect(result.stdout + result.stderr).not.toContain('private-canary');
  expect(readFileSync(join(scratch, 'calls'), 'utf8')).toContain(pin);
  expect(readFileSync(join(scratch, 'calls'), 'utf8')).not.toContain('clamd');
}
test('binds unchanged verified bytes and old build dates to this complete check', recordsUnchangedSet);

function recordsUpdatedCld() {
  const result = run('cld');
  expect(result.status, result.stderr).toBe(0);
  expect(readManifest().databases[1].file).toBe('daily.cld');
  expect(readManifest().updaterEvidence.databases[1].result).toBe('updated');
}
test('records verified local databases after a scripted update', recordsUpdatedCld);

function normalisesBuildDateOffset() {
  const result = run('offset-date');
  expect(result.status, result.stderr).toBe(0);
  expect(readManifest().databases[2].builtAt).toBe('2020-01-01T04:00:00.000Z');
}
test('accepts the numeric timezone offset used by the pinned bytecode database',
  normalisesBuildDateOffset);

const refusals = [
  'late-failure', 'partial', 'missing', 'duplicate', 'altered', 'metadata-failure',
  'malformed-date', 'impossible-date', 'future-date', 'wrong-version',
  'duplicate-metadata', 'oversized', 'copied', 'hash-failure',
  'host-altered', 'extra', 'symlink', 'duplicate-check', 'unverified',
  'invalid-offset', 'invalid-offset-minute',
  'mismatched-build-date',
];
function refusesIncompleteEvidence(mode) {
  expect(run().status).toBe(0);
  const oldEvidence = readFileSync(manifest);
  writeFileSync(join(candidate, 'updater.log'), oldEvidence);
  writeFileSync(join(candidate, 'signatures.sha256'), 'old hashes');
  if (mode === 'hash-failure') {
    executable('sha256sum', '#!/bin/sh\nexit 1\n');
  }
  const result = run(mode);
  expect(result.status).toBe(1);
  expect(result.stderr).toBe('Candidate refresh refused\n');
  expect(result.stdout).toBe('');
  expect(existsSync(manifest)).toBe(false);
  expect(existsSync(join(candidate, 'signatures.sha256'))).toBe(false);
  expect(existsSync(join(candidate, '.refresh-lock'))).toBe(false);
}
test.each(refusals)('refuses %s and removes the previous success', refusesIncompleteEvidence);

function keepsLockAfterFailedCleanup() {
  const result = run('cleanup-failure');
  expect(result.status).toBe(1);
  expect(result.stderr).toBe('Candidate refresh refused\n');
  expect(result.stdout).toBe('');
  expect(existsSync(manifest)).toBe(false);
  const callsBeforeRetry = readFileSync(join(scratch, 'calls'), 'utf8');
  const callLines = callsBeforeRetry.trim().split('\n');
  expect(callLines).toHaveLength(2);
  const runArgs = JSON.parse(callLines[0]);
  const cleanupArgs = JSON.parse(callLines[1]);
  const containerName = runArgs[runArgs.indexOf('--name') + 1];
  expect(cleanupArgs).toEqual(['rm', '-f', '-v', containerName]);

  const retry = run();
  expect(retry.status).toBe(1);
  expect(retry.stderr).toBe('Candidate refresh refused\n');
  expect(retry.stdout).toBe('');
  expect(readFileSync(join(scratch, 'calls'), 'utf8')).toBe(callsBeforeRetry);
  expect(existsSync(join(candidate, '.refresh-lock'))).toBe(true);
  expect(existsSync(manifest)).toBe(false);
}
test('keeps the lock and refuses another updater after failed cleanup', keepsLockAfterFailedCleanup);

function allowsRetryAfterConfirmedCleanup() {
  const result = run('client-failure');
  expect(result.status).toBe(1);
  expect(result.stderr).toBe('Candidate refresh refused\n');
  expect(result.stdout).toBe('');
  expect(existsSync(manifest)).toBe(false);
  expect(existsSync(join(candidate, '.refresh-lock'))).toBe(false);
  const retry = run();
  expect(retry.status, retry.stderr).toBe(0);
  expect(readManifest().databases).toHaveLength(3);
}
test('allows another updater after container cleanup succeeds', allowsRetryAfterConfirmedCleanup);

function copyingDoesNotRefresh() {
  expect(run().status).toBe(0);
  const original = readFileSync(manifest, 'utf8');
  const now = new Date();
  for (const name of names) {
    utimesSync(join(candidate, `${name}.cvd`), now, now);
  }
  utimesSync(manifest, now, now);
  expect(readFileSync(manifest, 'utf8')).toBe(original);
  expect(run('copied').status).toBe(1);
  expect(existsSync(manifest)).toBe(false);
}
test('mtime changes and copied evidence cannot become a new update check', copyingDoesNotRefresh);
