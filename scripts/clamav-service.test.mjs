import { generateKeyPairSync, createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:https';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { decodeJwt, importPKCS8, SignJWT } from 'jose';
import { tokenIssuer } from '@opencrane/auth';
import { sharedCertificates } from '../libs/event-store/test/certificates.ts';
import { createScanOperation } from '../infra/clamav/scan.mjs';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

async function mockProcesses(importOriginal) {
  const original = await importOriginal();
  return { ...original, spawn: vi.fn() };
}
vi.mock('node:child_process', mockProcesses);
const issuer = 'https://scanner.invalid/';
const state = `${'c'.repeat(64)} sha256:${'a'.repeat(64)} 2026-10-25T12:00:00Z true 0`;
let directory, server, scanner, now, updated, tokens, key, ca, mode, supplied, shutdown;
let continued, lastRequest, logs;
const requests = [];
function clock() { return now; }
function seconds() { return Math.floor(now / 1000); }
function hash(bytes) {
  const digest = createHash('sha256');
  digest.update(bytes);
  return digest.digest('hex');
}
function fresh() {
  if (shutdown.signal.aborted || now < updated || now >= updated + 86400000) {
    throw new Error('Scanner launch refused');
  }
  return now;
}
async function stop() { shutdown.abort(); }
function scanProcess(_command, args) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  function close() { child.emit('close', 0); }
  function kill() { queueMicrotask(close); }
  child.kill = kill;
  function finish() {
    if (args[0] === 'inspect') {
      child.stdout.write(state);
    } else {
      const framed = child.stdin.read();
      expect(framed.subarray(0, 10).toString()).toBe('zINSTREAM\0');
      const parts = [];
      for (let offset = 10; offset < framed.length - 4;) {
        const length = framed.readUInt32BE(offset);
        parts.push(framed.subarray(offset + 4, offset + 4 + length));
        offset += 4 + length;
      }
      const bytes = Buffer.concat(parts);
      supplied.push(bytes);
      server.emit('scanned');
      if (mode === 'hang') return;
      if (mode === 'pass-expiry') now += 120000;
      if (mode === 'database-expiry') now = updated + 86400000;
      let reply = 'stream: OK\0';
      if (mode === 'forged') reply += 'private-canary';
      if (bytes.toString() === 'infected') reply = 'stream: fixture FOUND\0';
      child.stdout.write(reply);
    }
    queueMicrotask(close);
  }
  child.stdin.once('finish', finish);
  return child;
}
async function setup() {
  now = Date.now();
  updated = now - 1000;
  mode = '';
  supplied = [];
  shutdown = new AbortController();
  directory = await mkdtemp(join(tmpdir(), 'scanner-https-'));
  await sharedCertificates(directory);
  const keyOptions = { namedCurve: 'P-256',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' } };
  key = generateKeyPairSync('ec', keyOptions);
  const privateKeyPath = join(directory, 'issuer.pem');
  await writeFile(privateKeyPath, key.privateKey, { mode: 0o600 });
  const identity = { service: 'server', silo: 'silo-one' };
  tokens = await tokenIssuer({ privateKeyPath, issuer, now: seconds, scannerIdentity: identity });
  const database = { file: 'main.cvd', sha256: 'd'.repeat(64), version: 42,
    builtAt: '2020-01-01T00:00:00.000Z' };
  const manifest = { databaseUpdatedAt: new Date(updated).toISOString(), databases: [database] };
  const context = { state, manifest, imageDigest: `sha256:${'a'.repeat(64)}`,
    manifestDigest: `sha256:${'b'.repeat(64)}`, clock, fresh, stop, signal: shutdown.signal };
  scanner = { scan: createScanOperation(context), stop, signal: shutdown.signal,
    databaseUpdatedAt: manifest.databaseUpdatedAt };
  spawn.mockImplementation(scanProcess);
  ca = await readFile(join(directory, 'ca.crt'));
  const tls = { key: await readFile(join(directory, 'server.key')),
    cert: await readFile(join(directory, 'server.crt')) };
  const trust = [{ issuer, jwks: tokens.jwks, services: { server: 'silo-one' } }];
  const { createScannerService } = await import('../infra/clamav/service.mjs');
  server = createScannerService({ scanner, tls, trust, clock });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'error'), vi.spyOn(console, 'warn')];
}
async function cleanup() {
  await stop();
  for (const client of requests) client.destroy();
  requests.length = 0;
  if (server) {
    server.closeAllConnections();
    await new Promise(function close(resolve) { server.close(resolve); });
  }
  for (const log of logs ?? []) expect(log).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.useRealTimers();
  await rm(directory, { recursive: true, force: true });
}
beforeEach(setup);
afterEach(cleanup);
async function input(bytes = Buffer.from('private-canary')) {
  const requestId = randomUUID();
  const pass = await tokens.scanner({ purpose: 'upload', requestId });
  return { bytes, pass: pass.value, requestId, fileId: randomUUID(), silo: 'silo-one',
    purpose: 'upload', sha256: hash(bytes), byteCount: bytes.length };
}
function send(value, overrides = {}, transfer) {
  continued = false;
  const headers = { authorization: `Bearer ${value.pass}`, expect: '100-continue',
    'content-type': 'application/octet-stream', 'content-length': value.byteCount,
    'x-scan-silo': value.silo, 'x-scan-purpose': value.purpose,
    'x-scan-request-id': value.requestId, 'x-scan-file-id': value.fileId,
    'x-scan-sha256': value.sha256 };
  const options = { hostname: '127.0.0.1', port: server.address().port,
    servername: 'localhost', ca, method: 'POST', path: '/scan/upload', headers,
    agent: false, ...overrides };
  function exchange(resolve, reject) {
    function response(reply) {
      const chunks = [];
      function read(chunk) { chunks.push(chunk); }
      function end() {
        const bytes = Buffer.concat(chunks);
        expect(bytes.length).toBeLessThanOrEqual(4096);
        resolve({ status: reply.statusCode, value: JSON.parse(bytes.toString()) });
      }
      reply.on('data', read);
      reply.on('end', end);
      reply.on('error', reject);
    }
    const client = request(options, response);
    lastRequest = client;
    requests.push(client);
    function proceed() {
      continued = true;
      if (transfer) transfer(client);
      else client.end(value.bytes);
    }
    client.on('continue', proceed);
    client.on('error', reject);
    client.flushHeaders();
  }
  return new Promise(exchange);
}
function refused(result) {
  expect(result).toEqual({ status: 503, value: { error: 'Scanner request refused' } });
}
async function exactResults() {
  const first = await input();
  const second = await input(Buffer.from('infected'));
  const results = await Promise.all([send(first), send(second)]);
  for (const [index, value] of [first, second].entries()) {
    expect(results[index].status).toBe(200);
    expect(results[index].value).toMatchObject({ silo: value.silo, purpose: 'upload',
      requestId: value.requestId, fileId: value.fileId, sha256: value.sha256,
      byteCount: value.byteCount, databaseUpdatedAt: scanner.databaseUpdatedAt });
    expect(JSON.stringify(results[index])).not.toContain('private-canary');
    expect(JSON.stringify(results[index])).not.toContain(value.pass);
  }
  expect(results[0].value.verdict).toBe('clean');
  expect(results[1].value.verdict).toBe('infected');
  expect(supplied).toContainEqual(first.bytes);
  expect(supplied).toContainEqual(second.bytes);
}
test('returns separate exact byte and identity bindings over trusted TLS', exactResults);
async function badTls(kind) {
  const overrides = kind === 'hostname' ? { servername: 'foreign.invalid' } : { ca: undefined };
  await expect(send(await input(), overrides)).rejects.toThrow();
  expect(supplied).toHaveLength(0);
  expect(continued).toBe(false);
}
test.each(['CA', 'hostname'])('refuses wrong TLS %s', badTls);
async function wrongIdentity(kind) {
  const value = await input();
  const claims = decodeJwt(value.pass);
  const changes = { issuer: ['iss', 'https://foreign.invalid/'], service: ['service', 'image-worker'],
    silo: ['silo', 'silo-two'], purpose: ['purpose', 'image'], request: ['requestId', randomUUID()],
    expired: ['exp', seconds()], browser: ['typ', 'browser'], computer: ['typ', 'computer'],
    turn: ['typ', 'turn'] };
  if (kind === 'missing') value.pass = '';
  else {
    const [field, replacement] = changes[kind];
    claims[field] = replacement;
    const signingKey = await importPKCS8(key.privateKey, 'ES256');
    const jwt = new SignJWT(claims);
    jwt.setProtectedHeader({ alg: 'ES256', kid: 'lifecycle' });
    value.pass = await jwt.sign(signingKey);
  }
  refused(await send(value));
  expect(continued).toBe(false);
  expect(spawn).not.toHaveBeenCalled();
}
test.each(['missing', 'expired', 'issuer', 'service', 'silo', 'purpose', 'request',
  'browser', 'computer', 'turn'])('%s identity cannot reach the scan', wrongIdentity);
async function badInput(kind) {
  const value = await input();
  if (kind === 'changed') value.bytes[0] ^= 1;
  if (kind === 'truncated') value.byteCount += 1;
  if (kind === 'oversized') value.byteCount = 20 * 1024 * 1024 + 1;
  if (kind === 'silo') value.silo = 'silo-two';
  if (kind === 'purpose') value.purpose = 'image';
  if (kind === 'request') value.requestId = randomUUID();
  if (kind === 'forged') mode = 'forged';
  if (kind === 'pass-expiry' || kind === 'database-expiry') mode = kind;
  if (kind === 'truncated') {
    function incomplete(client) { client.end(value.bytes); }
    const pending = send(value, {}, incomplete);
    await once(lastRequest, 'continue');
    await scanner.stop();
    refused(await pending);
  } else refused(await send(value));
  if (kind !== 'forged' && !kind.endsWith('expiry')) expect(supplied).toHaveLength(0);
}
test.each(['changed', 'truncated', 'oversized', 'silo', 'purpose', 'request', 'forged',
  'pass-expiry', 'database-expiry'])('refuses %s bytes, bindings or results', badInput);
async function transferExpiry(kind) {
  const value = await input();
  function transfer(client) {
    now += kind === 'pass' ? 120000 : 86400000;
    client.end(value.bytes);
  }
  refused(await send(value, {}, transfer));
  expect(supplied).toHaveLength(0);
}
test.each(['pass', 'database'])('refuses %s expiry during transfer', transferExpiry);
async function cancelWork(kind) {
  mode = 'hang';
  const value = await input();
  if (kind === 'timeout') vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const scanned = once(server, 'scanned');
  const pending = send(value);
  const settled = pending.catch(function disconnected() { return 'disconnected'; });
  await scanned;
  if (kind === 'timeout') await vi.advanceTimersByTimeAsync(60000);
  if (kind === 'disconnect') lastRequest.destroy();
  if (kind === 'retire') await scanner.stop();
  await settled;
  expect(shutdown.signal.aborted).toBe(true);
  refused(await send(await input()));
}
test.each(['timeout', 'disconnect', 'retire'])('%s cancels work and refuses reuse', cancelWork);
async function rejectsOtherRoutes() {
  for (const path of ['/scan/upload?url=https://foreign.invalid', '/mint', '/redirect']) {
    refused(await send(await input(), { path }));
  }
  expect(supplied).toHaveLength(0);
}
test('accepts no URL, redirect or minting endpoint', rejectsOtherRoutes);
