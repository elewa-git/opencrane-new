import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:https';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { tokenIssuer } from '@opencrane/auth';
import { sharedCertificates } from '../libs/event-store/test/certificates.ts';
import { createScanOperation } from '../infra/clamav/scan.mjs';
import { createScannerService } from '../infra/clamav/service.mjs';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

async function mockProcesses(importOriginal) {
  const original = await importOriginal();
  return { ...original, spawn: vi.fn() };
}
vi.mock('node:child_process', mockProcesses);
const state = `${'c'.repeat(64)} sha256:${'a'.repeat(64)} 2026-10-25T12:00:00Z true 0`;
let directory, server, now, updated, shutdown, ca, tls, trust, issuers, mode, supplied;
const clients = [];
let scanOperation;
function clock() {
  return now;
}
function seconds() {
  return Math.floor(now / 1000);
}
async function stop() {
  shutdown.abort();
}
function fresh() {
  if (shutdown.signal.aborted || now < updated || now >= updated + 86400000) {
    throw new Error('Scanner launch refused');
  }
  return now;
}
function scanProcess(_command, args) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  function close() {
    child.emit('close', mode === 'outage' ? 1 : 0);
  }
  function kill() {
    queueMicrotask(close);
  }
  child.kill = kill;
  function finish() {
    if (args[0] === 'inspect') {
      child.stdout.write(state);
    } else {
      const framed = child.stdin.read();
      const chunks = [];
      expect(framed.subarray(0, 10).toString()).toBe('zINSTREAM\0');
      for (let offset = 10; offset < framed.length - 4;) {
        const length = framed.readUInt32BE(offset);
        chunks.push(framed.subarray(offset + 4, offset + 4 + length));
        offset += length + 4;
      }
      const bytes = Buffer.concat(chunks);
      supplied.push(bytes);
      server.emit('scanned');
      if (mode === 'hang') {
        return;
      }
      if (mode === 'expiry') {
        now += 120000;
      }
      let result = bytes.toString() === 'infected' ? 'stream: fixture FOUND\0' : 'stream: OK\0';
      if (mode === 'forged') {
        result += 'private-canary';
      }
      child.stdout.write(result);
      child.stderr.write('private-canary');
    }
    queueMicrotask(close);
  }
  child.stdin.once('finish', finish);
  return child;
}
async function start(scanOverride) {
  shutdown = new AbortController();
  const database = { file: 'main.cvd', sha256: 'd'.repeat(64), version: 42,
    builtAt: '2020-01-01T00:00:00.000Z' };
  const manifest = { databaseUpdatedAt: new Date(updated).toISOString(), databases: [database] };
  const context = { state, manifest, imageDigest: `sha256:${'a'.repeat(64)}`,
    manifestDigest: `sha256:${'b'.repeat(64)}`, clock, fresh, stop, signal: shutdown.signal };
  scanOperation = createScanOperation(context);
  const scan = scanOverride ?? scanOperation;
  const scanner = { scan, signal: shutdown.signal, databaseUpdatedAt: manifest.databaseUpdatedAt };
  server = createScannerService({ scanner, tls, trust, clock });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
}
async function closeServer() {
  server.closeAllConnections();
  const closed = once(server, 'close');
  server.close();
  await closed;
}
async function setup() {
  now = Date.now();
  updated = now - 1000;
  mode = '';
  supplied = [];
  directory = await mkdtemp(join(tmpdir(), 'image-scanner-'));
  await sharedCertificates(directory);
  ca = await readFile(join(directory, 'ca.crt'));
  tls = { key: await readFile(join(directory, 'server.key')),
    cert: await readFile(join(directory, 'server.crt')) };
  trust = [];
  issuers = [];
  for (const silo of ['one', 'two']) {
    const key = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const privateKeyPath = join(directory, `${silo}.pem`);
    const pem = key.privateKey.export({ type: 'pkcs8', format: 'pem' });
    await writeFile(privateKeyPath, pem, { mode: 0o600 });
    const issuer = `https://${silo}.invalid/`;
    const pair = {};
    for (const service of ['server', 'image-worker']) {
      const options = { privateKeyPath, issuer, now: seconds, scannerIdentity: { service, silo } };
      pair[service] = await tokenIssuer(options);
    }
    issuers.push(pair);
    trust.push({ issuer, jwks: pair.server.jwks, services: { server: silo, 'image-worker': silo } });
  }
  spawn.mockImplementation(scanProcess);
  await start();
}
async function cleanup() {
  await stop();
  for (const client of clients) {
    client.destroy();
  }
  clients.length = 0;
  await closeServer();
  vi.useRealTimers();
  await rm(directory, { recursive: true, force: true });
}
beforeEach(setup);
afterEach(cleanup);
async function input(index = 0, purpose = 'image', bytes = Buffer.from('private-canary')) {
  const requestId = randomUUID();
  const identity = purpose === 'image' ? 'image-worker' : 'server';
  const pass = await issuers[index][identity].scanner({ purpose, requestId });
  const digest = createHash('sha256');
  digest.update(bytes);
  const headers = { authorization: `Bearer ${pass.value}`, expect: '100-continue',
    'content-type': 'application/octet-stream', 'content-length': bytes.length,
    'x-scan-silo': index === 0 ? 'one' : 'two', 'x-scan-purpose': purpose,
    'x-scan-request-id': requestId, 'x-scan-sha256': digest.digest('hex') };
  if (purpose === 'image') {
    Object.assign(headers, { 'x-scan-server-id': `server-${index}`, 'x-scan-attempt-id': '1',
      'x-scan-platform': 'linux/amd64', 'x-scan-image-digest': 'e'.repeat(64) });
  } else {
    headers['x-scan-file-id'] = randomUUID();
  }
  return { headers, bytes, path: purpose === 'image' ? '/scan/image-part' : '/scan/upload' };
}
function send(value, transfer, overrides = {}) {
  const options = { hostname: '127.0.0.1', port: server.address().port, servername: 'localhost',
    ca, method: 'POST', agent: false, path: value.path, headers: value.headers, ...overrides };
  let continued = false;
  function exchange(resolve, reject) {
    function response(reply) {
      const chunks = [];
      function read(chunk) {
        chunks.push(chunk);
      }
      function end() {
        const bytes = Buffer.concat(chunks);
        expect(bytes.length).toBeLessThanOrEqual(4096);
        expect(bytes.toString()).not.toContain('private-canary');
        expect(bytes.toString()).not.toContain(value.headers.authorization);
        resolve({ status: reply.statusCode, value: JSON.parse(bytes), continued });
      }
      reply.on('data', read);
      reply.on('end', end);
      reply.on('error', reject);
    }
    const client = request(options, response);
    clients.push(client);
    function proceed() {
      continued = true;
      if (transfer) {
        transfer(client);
      } else {
        client.end(value.bytes);
      }
    }
    client.on('continue', proceed);
    client.on('error', reject);
    client.flushHeaders();
  }
  return new Promise(exchange);
}
function refused(result, beforeContinue = false) {
  expect(result.status).toBe(503);
  expect(result.value).toEqual({ error: 'Scanner request refused' });
  if (beforeContinue) {
    expect(result.continued).toBe(false);
  }
}
async function interleaved() {
  const first = await input();
  const second = await input(1, 'image', Buffer.from('infected'));
  second.headers['x-scan-platform'] = 'linux/arm64';
  second.headers['x-scan-attempt-id'] = '2';
  const results = await Promise.all([send(first), send(second)]);
  for (const [index, value] of [first, second].entries()) {
    expect(results[index].status).toBe(200);
    expect(results[index].value).toMatchObject({ purpose: 'image',
      silo: value.headers['x-scan-silo'], requestId: value.headers['x-scan-request-id'],
      serverId: value.headers['x-scan-server-id'], attemptId: index + 1,
      platform: value.headers['x-scan-platform'], targetImageDigest: 'e'.repeat(64),
      sha256: value.headers['x-scan-sha256'], byteCount: value.bytes.length,
      imageDigest: `sha256:${'a'.repeat(64)}`, databaseUpdatedAt: new Date(updated).toISOString() });
    expect(supplied).toContainEqual(value.bytes);
  }
  expect(results[0].value.verdict).toBe('clean');
  expect(results[1].value.verdict).toBe('infected');
}
test('interleaves two silos and returns exact part bindings without replacing scanner facts', interleaved);
async function identityRefusal(kind) {
  const value = await input();
  if (kind === 'upload') {
    const pass = await issuers[0].server.scanner({ purpose: 'upload',
      requestId: value.headers['x-scan-request-id'] });
    value.headers.authorization = `Bearer ${pass.value}`;
  } else if (kind === 'computer') {
    const pass = await issuers[0].server.computer({ silo: 'one', computerId: 'computer',
      assistantId: 'assistant', generation: 1 });
    value.headers.authorization = `Bearer ${pass.value}`;
  } else if (kind === 'image-on-upload') {
    const upload = await input(0, 'upload');
    upload.headers.authorization = value.headers.authorization;
    upload.headers['x-scan-request-id'] = value.headers['x-scan-request-id'];
    refused(await send(upload), true);
    return;
  } else {
    const changes = { silo: 'two', purpose: 'upload', 'request-id': randomUUID() };
    value.headers[`x-scan-${kind}`] = changes[kind];
  }
  refused(await send(value), true);
  expect(supplied).toHaveLength(0);
  expect((await send(await input(0, 'upload'))).status).toBe(200);
}
test.each(['upload', 'computer', 'image-on-upload', 'silo', 'purpose', 'request-id'])(
  'refuses %s identity before Continue and allows later uploads', identityRefusal);
const bindings = ['server-id', 'attempt-id', 'platform', 'image-digest', 'sha256',
  'silo', 'purpose', 'request-id'];
async function missingOrDuplicate(field, kind) {
  const value = await input();
  const name = `x-scan-${field}`;
  if (kind === 'missing') {
    delete value.headers[name];
  } else {
    value.headers[name] = [value.headers[name], value.headers[name]];
  }
  refused(await send(value), true);
}
for (const field of bindings) {
  test.each(['missing', 'duplicate'])(`${field} %s refuses`, missingOrDuplicate.bind(null, field));
}
async function malformed(field, replacement) {
  const value = await input();
  value.headers[field] = replacement;
  refused(await send(value), true);
}
test.each([
  ['x-scan-server-id', '../private-canary'], ['x-scan-platform', 'windows/amd64'],
  ['x-scan-image-digest', 'latest'], ['x-scan-image-digest', 'E'.repeat(64)],
  ['x-scan-attempt-id', '0'], ['x-scan-attempt-id', '-1'], ['x-scan-attempt-id', '1.5'],
  ['x-scan-attempt-id', '01'], ['x-scan-attempt-id', '9007199254740992'],
  ['content-length', String(20 * 1024 * 1024 + 1)], ['x-scan-file-id', randomUUID()],
  ['x-scan-result', '{"verdict":"clean"}'],
])('refuses unsupported %s=%s before Continue', malformed);
async function badTls(kind) {
  const overrides = kind === 'CA' ? { ca: undefined } : { servername: 'foreign.invalid' };
  await expect(send(await input(), undefined, overrides)).rejects.toThrow();
  expect(supplied).toHaveLength(0);
}
test.each(['CA', 'hostname'])('refuses untrusted TLS %s', badTls);
async function failureAndRecovery(kind) {
  const value = await input();
  if (kind === 'changed') {
    value.bytes[0] ^= 1;
  } else if (kind === 'stale') {
    now = updated + 86400000;
  } else if (kind === 'pass-expiry') {
    now += 120000;
  } else {
    mode = kind;
  }
  refused(await send(value));
  await stop();
  await closeServer();
  mode = '';
  updated = now - 1000;
  await start();
  expect((await send(await input(1))).status).toBe(200);
  expect((await send(await input(0, 'upload'))).status).toBe(200);
}
test.each(['changed', 'stale', 'pass-expiry', 'expiry', 'forged', 'outage'])(
  '%s refuses; a fresh scanner restores image and upload scans', failureAndRecovery);
async function transferExpiry(kind) {
  const value = await input();
  function transfer(client) {
    now = kind === 'pass' ? now + 120000 : updated + 86400000;
    client.end(value.bytes);
  }
  refused(await send(value, transfer));
  expect(supplied).toHaveLength(0);
}
test.each(['pass', 'database'])('refuses %s expiry during image transfer', transferExpiry);
async function cancelled(kind) {
  mode = 'hang';
  if (kind === 'timeout') {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  }
  const scanned = once(server, 'scanned');
  function disconnected() {
    return 'disconnected';
  }
  const pending = send(await input()).catch(disconnected);
  const observed = await Promise.race([scanned, pending]);
  expect(Array.isArray(observed)).toBe(true);
  const retired = once(shutdown.signal, 'abort');
  if (kind === 'timeout') {
    await vi.advanceTimersByTimeAsync(60000);
  } else {
    clients.at(-1).destroy();
  }
  await pending;
  await retired;
  refused(await send(await input(0, 'upload')), true);
  vi.useRealTimers();
  await closeServer();
  mode = '';
  await start();
  expect((await send(await input(0, 'upload'))).status).toBe(200);
}
test.each(['timeout', 'disconnect'])('%s retires the scan; replacement restores uploads', cancelled);
async function holdsCleanupCapacity() {
  await closeServer();
  const finishCleanup = [];
  let holding = true;
  function controlledScan(input) {
    if (!holding) {
      return scanOperation(input);
    }
    function waitForCleanup(_resolve, reject) {
      function cleaned() {
        reject(new Error('private-canary'));
      }
      finishCleanup.push(cleaned);
      server.emit('scanned');
    }
    return new Promise(waitForCleanup);
  }
  await start(controlledScan);
  const pending = [];
  function disconnected() {
    return 'disconnected';
  }
  for (const purpose of ['image', 'upload']) {
    const scanned = once(server, 'scanned');
    const exchange = send(await input(0, purpose)).catch(disconnected);
    pending.push(exchange);
    const observed = await Promise.race([scanned, exchange]);
    expect(Array.isArray(observed)).toBe(true);
  }
  refused(await send(await input(1)), true);
  // Keep both slots while the scanner fixture delays cancellation cleanup.
  for (const client of clients.slice(0, 2)) {
    const closed = once(client, 'close');
    client.destroy();
    await closed;
  }
  refused(await send(await input(1, 'upload')), true);
  holding = false;
  for (const finish of finishCleanup) {
    finish();
  }
  await Promise.allSettled(pending);
  vi.useRealTimers();
  expect((await send(await input(1, 'upload'))).status).toBe(200);
  expect((await send(await input(1))).status).toBe(200);
}
test('both routes hold the two shared slots until cancellation cleanup finishes', holdsCleanupCapacity);
