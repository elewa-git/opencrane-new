import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const minio = 'mirror.gcr.io/alpine/minio:RELEASE.2025-10-15T17-29-55Z@sha256:' +
  'cf23643a6cf9ce159c57643ceb88279e431262282428c9e0bf3a7ef1a97e84b4';
const clamav = 'mirror.gcr.io/clamav/clamav-debian:1.5.2@sha256:' +
  '14e2e0805c6a5ff6728ea591c05565e0f0954d93e8701919012c3a8c44e20674';
const node = 'mirror.gcr.io/library/node:22.23.1-bookworm-slim@sha256:' +
  '6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3';
const openfga = 'ghcr.io/openfga/openfga:v1.21.0@sha256:' +
  '2113c664a486b5da8d7a2cdab479e0d4e30639c80fd2c000540f645c1dbc1e55';
const images = [minio, clamav, node, openfga];

function writeFakeCommands(directory) {
  const docker = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CI_PULL_CALLS, JSON.stringify(args) + '\\n');
const calls = fs.readFileSync(process.env.CI_PULL_CALLS, 'utf8').trim().split('\\n');
if (calls.length <= Number(process.env.CI_PULL_FAILURES)) {
  console.error(process.env.CI_PULL_ERROR);
  process.exit(1);
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

function pullImages(error, failures) {
  const directory = mkdtempSync(join(tmpdir(), 'ci-test-images-'));
  const callsFile = join(directory, 'calls');
  const sleepsFile = join(directory, 'sleeps');
  writeFileSync(callsFile, '');
  writeFileSync(sleepsFile, '');
  writeFakeCommands(directory);
  const environment = { ...process.env, PATH: `${directory}:${process.env.PATH}`,
    CI_PULL_CALLS: callsFile, CI_PULL_SLEEPS: sleepsFile,
    CI_PULL_ERROR: error, CI_PULL_FAILURES: String(failures) };
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

function retriesRateLimits() {
  const message = 'unexpected status from HEAD request: 429 Too Many Requests';
  const result = pullImages(message, 2);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls, [
    ['pull', minio], ['pull', minio], ...expectedPulls(),
  ]);
  assert.deepEqual(result.sleeps, ['2', '4']);
  assert.match(result.stdout + result.stderr, /429 Too Many Requests/);
}

function refusesMissingDigest() {
  const message = 'manifest unknown: unexpected status from HEAD request: 404 Not Found';
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
  assert.deepEqual(result.sleeps, ['2', '4', '8']);
}

function retriesTemporaryFailures() {
  const errors = [
    'unexpected status from HEAD request: 503 Service Unavailable',
    'received unexpected HTTP status: 502 Bad Gateway',
    'net/http: TLS handshake timeout',
    'context deadline exceeded',
  ];
  for (const message of errors) {
    const result = pullImages(message, 1);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.calls, [['pull', minio], ...expectedPulls()]);
    assert.deepEqual(result.sleeps, ['2']);
  }
}

function refusesOtherFailures() {
  const errors = ['manifest unknown', 'unauthorized: authentication required',
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
  assert.deepEqual(found, new Set(images));
  const result = pullImages('', 0);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls, expectedPulls());
  assert.deepEqual(result.sleeps, []);
}

test('pulls the exact images after two rate limits', retriesRateLimits);
test('fails immediately with the registry message for a missing digest', refusesMissingDigest);
test('stops after four failed pulls with bounded backoff', boundsRetries);
test('retries registry server errors and timeouts', retriesTemporaryFailures);
test('fails immediately for permanent and unrecognised errors', refusesOtherFailures);
test('pulls each helper and Dockerfile pin once', usesHelperPins);
