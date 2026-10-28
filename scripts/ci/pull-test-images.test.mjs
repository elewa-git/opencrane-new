import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const minio = 'mirror.gcr.io/alpine/minio:RELEASE.2025-10-15T17-29-55Z@sha256:' +
  'f93b327d2d9a81ef9d9a966d2c7fbe3ea4d657d23ed412566c20d488e9f73332';
const clamav = 'mirror.gcr.io/clamav/clamav-debian:1.5.2@sha256:' +
  '24b4b24c303efed21633b29d61096fab4a8a7e158a595149238c7bef7b39873c';
const node = 'mirror.gcr.io/library/node:22.23.1-bookworm-slim@sha256:' +
  '8607a9064d4a571140998ae9e52a3b3fcf9cff361d04642d5971e6cd76d39e27';
const openfga = 'ghcr.io/openfga/openfga:v1.21.0@sha256:' +
  '51bece5c31783bfeb150eae0f1c818ae804c50d39e0a311c43ff5357fed6debd';
const images = [minio, clamav, node, openfga];

function writeFakeCommands(directory) {
  const docker = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CI_PULL_CALLS, JSON.stringify(args) + '\\n');
const contents = fs.readFileSync(process.env.CI_PULL_CALLS, 'utf8');
const trimmed = contents.trim();
const calls = trimmed.split('\\n');
if (calls.length <= Number(process.env.CI_PULL_FAILURES)) {
  console.error(process.env.CI_PULL_ERROR);
  process.exit(Number(process.env.CI_PULL_STATUS));
}
`;
  const sleep = `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(process.env.CI_PULL_SLEEPS, process.argv[2] + '\\n');
`;
  const fileOptions = { mode: 0o755 };
  writeFileSync(join(directory, 'docker'), docker, fileOptions);
  writeFileSync(join(directory, 'sleep'), sleep, fileOptions);
}

function readLines(file) {
  const contents = readFileSync(file, 'utf8');
  const trimmed = contents.trim();
  if (!trimmed) {
    return [];
  }
  return trimmed.split('\n');
}

function parseCall(line) {
  return JSON.parse(line);
}

function pullImages(error, failures, failureStatus = 1) {
  const directory = mkdtempSync(join(tmpdir(), 'ci-test-images-'));
  const callsFile = join(directory, 'calls');
  const sleepsFile = join(directory, 'sleeps');
  writeFileSync(callsFile, '');
  writeFileSync(sleepsFile, '');
  writeFakeCommands(directory);
  const environment = { ...process.env, PATH: `${directory}:${process.env.PATH}`,
    CI_PULL_CALLS: callsFile, CI_PULL_SLEEPS: sleepsFile,
    CI_PULL_ERROR: error, CI_PULL_FAILURES: String(failures),
    CI_PULL_STATUS: String(failureStatus) };
  const options = { env: environment, encoding: 'utf8', timeout: 10_000 };
  try {
    const script = resolve('scripts/ci/pull-test-images.sh');
    const result = spawnSync('bash', [script], options);
    const lines = readLines(callsFile);
    const calls = lines.map(parseCall);
    const sleeps = readLines(sleepsFile);
    return { ...result, calls, sleeps };
  } finally {
    const cleanupOptions = { recursive: true, force: true };
    rmSync(directory, cleanupOptions);
  }
}

function expectedPulls() {
  function pull(image) {
    return ['pull', image];
  }
  return images.map(pull);
}

function assertBackoff(sleeps, expectedCount) {
  assert.equal(sleeps.length, expectedCount);
  const delays = sleeps.map(Number);
  const minimums = [10, 30, 60];
  let total = 0;
  for (let index = 0; index < delays.length; index += 1) {
    const delay = delays[index];
    const minimum = minimums[index];
    assert.ok(delay >= minimum, `wait ${index + 1} was only ${delay} seconds`);
    assert.ok(delay <= minimum + 2, `wait ${index + 1} exceeded its jitter limit`);
    total += delay;
  }
  assert.ok(total <= 106, `total wait was ${total} seconds`);
  if (expectedCount === 3) {
    assert.ok(total >= 100, 'allow a per-minute registry quota to reset');
  }
}

function retriesQuotaExceeded() {
  const message = "error from registry: Quota exceeded for quota metric " +
    "'Requests per project in the US multi-region' and limit " +
    "'Requests per project in the US multi-region per minute' of service " +
    "'artifactregistry.googleapis.com'";
  const result = pullImages(message, 2);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls, [
    ['pull', minio], ['pull', minio], ...expectedPulls(),
  ]);
  assertBackoff(result.sleeps, 2);
  assert.ok((result.stdout + result.stderr).includes(message));
}

function retriesMissingAttestation() {
  const message = 'failed to copy: httpReadSeeker: failed open: ' +
    'could not fetch content descriptor ' +
    'sha256:17936259c48931f4b8d8acc21b6f7552e4c80722dce1be36c954be28a50cdbf2 ' +
    '(application/vnd.in-toto+json) from remote: not found';
  const result = pullImages(message, 1);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls, [['pull', minio], ...expectedPulls()]);
  assertBackoff(result.sleeps, 1);
  assert.ok((result.stdout + result.stderr).includes(message));
}

function retriesRateLimits() {
  const message = 'unexpected status from HEAD request: 429 Too Many Requests';
  const result = pullImages(message, 2);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls, [
    ['pull', minio], ['pull', minio], ...expectedPulls(),
  ]);
  assertBackoff(result.sleeps, 2);
  assert.match(result.stdout + result.stderr, /429 Too Many Requests/);
}

function refusesMissingDigest() {
  const message = 'unexpected status from HEAD request: 404 Not Found (upstream timeout)';
  const result = pullImages(message, 99);
  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(result.calls, [['pull', minio]]);
  assert.deepEqual(result.sleeps, []);
  assert.ok((result.stdout + result.stderr).includes(message));
}

function boundsRetries() {
  const result = pullImages('429 Too Many Requests', 99);
  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(result.calls, [
    ['pull', minio], ['pull', minio], ['pull', minio], ['pull', minio],
  ]);
  assertBackoff(result.sleeps, 3);
}

function retriesTemporaryFailures() {
  const errors = [
    'unexpected status from HEAD request: 503 Service Unavailable',
    'received unexpected HTTP status: 502 Bad Gateway',
    'net/http: TLS handshake timeout',
    'failed to copy: httpReadSeeker: failed open: remote unavailable',
    'could not fetch content descriptor sha256:temporary from remote: not found',
    'context deadline exceeded',
    '429',
    'tOo MaNy ReQuEsTs',
    'qUoTa ExCeEdEd',
    'registry rate limit exceeded',
    'RATE LIMIT exceeded',
    'ToOmAnYrEqUeStS',
  ];
  for (const message of errors) {
    const result = pullImages(message, 1);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.calls, [['pull', minio], ...expectedPulls()]);
    assertBackoff(result.sleeps, 1);
  }
}

function refusesOtherFailures() {
  const errors = ['manifest unknown', 'unauthorized: authentication required',
    'unknown digest (upstream quota exceeded)',
    'manifest unknown (upstream rate limit)',
    'manifest unknown: failed to copy: httpReadSeeker',
    'unauthorized: could not fetch content descriptor',
    'unauthorized: authentication required (upstream 429)',
    'Cannot connect to the Docker daemon'];
  for (const message of errors) {
    const result = pullImages(message, 99);
    assert.equal(result.status, 1, result.stderr);
    assert.deepEqual(result.calls, [['pull', minio]]);
    assert.deepEqual(result.sleeps, []);
    assert.ok((result.stdout + result.stderr).includes(message));
  }
}

function usesHelperPins() {
  const sources = [
    'apps/server/test/support/upload-services.ts',
    'apps/server/test/support/restore-storage.ts',
    'apps/server/test/support/bridge-pod.ts',
    'apps/server/test/object-restore.test.ts',
    'libs/authz/test/services.ts',
    'infra/package/disposable-object-target.ts',
    'infra/clamav/Dockerfile',
  ];
  const found = new Set();
  for (const file of sources) {
    const source = readFileSync(file, 'utf8');
    const joined = source.replace(/'\s*\+\s*'/g, '');
    const pattern = /(?:mirror\.gcr\.io|ghcr\.io)\/[^'"\s`]+@sha256:[a-f0-9]{64}/g;
    for (const match of joined.matchAll(pattern)) {
      found.add(match[0]);
    }
  }
  const expectedImages = new Set(images);
  assert.deepEqual(found, expectedImages);
  const result = pullImages('', 0);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls, expectedPulls());
  assert.deepEqual(result.sleeps, []);
}

test('pulls the exact images after two registry quota errors', retriesQuotaExceeded);
test('retries the missing mirror attestation then pulls every image', retriesMissingAttestation);
test('pulls the exact images after two rate limits', retriesRateLimits);
test('fails immediately with the registry message for a missing digest', refusesMissingDigest);
test('stops after four failed pulls with bounded backoff', boundsRetries);
test('retries registry server errors and timeouts', retriesTemporaryFailures);
test('fails immediately for permanent and unrecognised errors', refusesOtherFailures);
test('pulls the linux/amd64 manifest pins used by helpers and Dockerfiles', usesHelperPins);

function preparesEveryTestJob() {
  const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
  const jobs = ['test', 'fixtures-image', 'fixtures-browser'];
  for (const job of jobs) {
    const start = workflow.indexOf(`\n  ${job}:\n`);
    const remaining = workflow.slice(start + 1);
    const nextJob = remaining.search(/\n {2}[a-z][a-z-]*:\n/);
    let block = remaining;
    if (nextJob !== -1) {
      block = remaining.slice(0, nextJob);
    }
    assert.notEqual(start, -1, job);
    const pull = 'run: bash scripts/ci/pull-test-images.sh';
    assert.equal(block.split(pull).length - 1, 1, job);
    const pullsAt = block.indexOf(pull);
    const testsAt = block.indexOf('node scripts/ci/run-tests.mjs');
    assert.ok(pullsAt < testsAt, job);
  }
}

test('prepares images once before tests in every test job', preparesEveryTestJob);

function retriesCommandTimeouts() {
  for (const status of [124, 137]) {
    const result = pullImages('', 1, status);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.calls, [['pull', minio], ...expectedPulls()]);
    assertBackoff(result.sleeps, 1);
  }
}

test('retries pulls stopped by the command time limit', retriesCommandTimeouts);
