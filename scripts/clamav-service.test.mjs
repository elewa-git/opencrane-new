import { generateKeyPairSync, createHash, randomUUID, sign } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:https';
import { connect } from 'node:net';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
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
let continued, lastRequest, logs, output;
const requests = [];
const sockets = [];
function clock() {
  return now;
}
function seconds() {
  return Math.floor(now / 1000);
}
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
async function stop() {
  shutdown.abort();
}
function scanProcess(_command, args) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  function close() {
    child.emit('close', 0);
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
      if (mode === 'hang') {
        return;
      }
      if (mode === 'pass-expiry') {
        now += 2000;
      }
      if (mode === 'database-expiry') {
        now = updated + 86400000;
      }
      let reply = 'stream: OK\0';
      if (mode === 'forged') {
        reply += 'private-canary';
      }
      if (bytes.toString() === 'infected') {
        reply = 'stream: fixture FOUND\0';
      }
      child.stderr.write('private-canary');
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
  output = [vi.spyOn(process.stdout, 'write'), vi.spyOn(process.stderr, 'write')];
}
async function cleanup() {
  await stop();
  for (const client of requests) {
    client.destroy();
  }
  for (const socket of sockets) {
    socket.destroy();
  }
  sockets.length = 0;
  if (server) {
    server.closeAllConnections();
    function close(resolve) {
      server.close(resolve);
    }
    await new Promise(close);
  }
  for (const log of logs ?? []) {
    expect(log).not.toHaveBeenCalled();
  }
  for (const stream of output ?? []) {
    const written = JSON.stringify(stream.mock.calls);
    expect(written).not.toContain('private-canary');
    for (const client of requests) {
      expect(written).not.toContain(client.getHeader('authorization'));
    }
  }
  requests.length = 0;
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
      function read(chunk) {
        chunks.push(chunk);
      }
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
function refused(result) {
  expect(result).toEqual({ status: 503, value: { error: 'Scanner request refused' } });
}
async function exactResults() {
  const first = await input();
  const claims = decodeJwt(first.pass);
  first.pass = changedPass(first.pass, claims);
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
function decodeJwt(value) {
  const payload = Buffer.from(value.split('.')[1], 'base64url');
  return JSON.parse(payload.toString());
}
function changedPass(value, claims) {
  const payload = Buffer.from(JSON.stringify(claims));
  const signed = `${value.split('.')[0]}.${payload.toString('base64url')}`;
  const options = { key: key.privateKey, dsaEncoding: 'ieee-p1363' };
  const signature = sign('sha256', Buffer.from(signed), options);
  return `${signed}.${signature.toString('base64url')}`;
}
async function wrongIdentity(kind) {
  const value = await input();
  const claims = decodeJwt(value.pass);
  const changes = { issuer: ['iss', 'https://foreign.invalid/'], service: ['service', 'image-worker'],
    silo: ['silo', 'silo-two'], purpose: ['purpose', 'image'], request: ['requestId', randomUUID()],
    expired: ['exp', seconds()], browser: ['typ', 'browser'], computer: ['typ', 'computer'],
    turn: ['typ', 'turn'] };
  if (kind === 'missing') {
    value.pass = '';
  } else if (kind === 'computer') {
    const identity = { silo: 'silo-one', computerId: 'computer',
      assistantId: 'assistant', generation: 1 };
    value.pass = (await tokens.computer(identity)).value;
  } else if (kind === 'turn') {
    const identity = { silo: 'silo-one', conversationId: 'chat', turnId: 'turn',
      requesterId: 'person', threadId: 'thread', task: 'chat_turn', model: 'model',
      assistantId: 'assistant' };
    value.pass = (await tokens.turn(identity)).value;
  } else {
    const [field, replacement] = changes[kind];
    claims[field] = replacement;
    value.pass = changedPass(value.pass, claims);
  }
  refused(await send(value));
  expect(continued).toBe(false);
  expect(spawn).not.toHaveBeenCalled();
}
test.each(['missing', 'expired', 'issuer', 'service', 'silo', 'purpose', 'request',
  'browser', 'computer', 'turn'])('%s identity cannot reach the scan', wrongIdentity);
async function badInput(kind) {
  if (kind === 'database-expiry') {
    now = updated + 86400000 - 500;
  }
  if (kind === 'pass-expiry') {
    now -= 119000;
  }
  const value = await input();
  if (kind === 'pass-expiry') {
    now += 119000;
  }
  if (kind === 'changed') {
    value.bytes[0] ^= 1;
  }
  if (kind === 'truncated') {
    value.byteCount += 1;
  }
  if (kind === 'oversized') {
    value.byteCount = 20 * 1024 * 1024 + 1;
  }
  if (kind === 'silo') {
    value.silo = 'silo-two';
  }
  if (kind === 'purpose') {
    value.purpose = 'image';
  }
  if (kind === 'request') {
    value.requestId = randomUUID();
  }
  if (kind === 'forged') {
    mode = 'forged';
  }
  if (kind === 'pass-expiry' || kind === 'database-expiry') {
    mode = kind;
  }
  if (kind === 'truncated') {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    function incomplete(client) {
      client.end(value.bytes);
    }
    const pending = send(value, {}, incomplete);
    await once(lastRequest, 'continue');
    await vi.advanceTimersByTimeAsync(60000);
    refused(await pending);
  } else {
    refused(await send(value));
  }
  if (kind !== 'forged' && !kind.endsWith('expiry')) {
    expect(supplied).toHaveLength(0);
  }
}
test.each(['changed', 'truncated', 'oversized', 'silo', 'purpose', 'request', 'forged',
  'pass-expiry', 'database-expiry'])('refuses %s bytes, bindings or results', badInput);
async function transferExpiry(kind) {
  if (kind === 'database') {
    now = updated + 86400000 - 500;
  }
  if (kind === 'pass') {
    now -= 119000;
  }
  const value = await input();
  if (kind === 'pass') {
    now += 119000;
  }
  function transfer(client) {
    now += kind === 'pass' ? 2000 : 500;
    client.end(value.bytes);
  }
  refused(await send(value, {}, transfer));
  expect(supplied).toHaveLength(0);
}
test.each(['pass', 'database'])('refuses %s expiry during transfer', transferExpiry);
async function cancelWork(kind) {
  mode = 'hang';
  const value = await input();
  if (kind === 'timeout') {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  }
  const scanned = once(server, 'scanned');
  const pending = send(value);
  function disconnected() {
    return 'disconnected';
  }
  const settled = pending.catch(disconnected);
  const retired = once(shutdown.signal, 'abort');
  await scanned;
  if (kind === 'timeout') {
    await vi.advanceTimersByTimeAsync(60000);
  }
  if (kind === 'disconnect') {
    lastRequest.destroy();
  }
  if (kind === 'retire') {
    await scanner.stop();
  }
  await settled;
  await retired;
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

async function retiresPending() {
  mode = 'hang';
  const scanned = once(server, 'scanned');
  const first = send(await input());
  await scanned;
  function waitForRetirement(client) {
    client.write('x');
  }
  const second = send(await input(), {}, waitForRetirement);
  await once(lastRequest, 'continue');
  await scanner.stop();
  refused(await first);
  refused(await second);
  refused(await send(await input()));
  expect(supplied).toHaveLength(1);
}
test('retirement refuses a scan, a pending transfer and later calls', retiresPending);
async function sharesDeadline(stage) {
  mode = 'hang';
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const scanned = once(server, 'scanned');
  const value = await input();
  function delayedHeaders() {
    now += 59000;
  }
  if (stage === 'headers') {
    server.once('secureConnection', delayedHeaders);
  }
  let client;
  function holdTransfer(request) {
    client = request;
  }
  const pending = send(value, {}, holdTransfer);
  await once(lastRequest, 'continue');
  if (stage === 'transfer') {
    await vi.advanceTimersByTimeAsync(59000);
    now += 59000;
  }
  client.end(value.bytes);
  await scanned;
  await vi.advanceTimersByTimeAsync(1000);
  refused(await pending);
  expect(shutdown.signal.aborted).toBe(true);
}
test.each(['headers', 'transfer'])('%s and scan share sixty seconds', sharesDeadline);

async function immutableResponse() {
  now -= 119000;
  const value = await input();
  now += 119000;
  const first = await send(value);
  expect(Date.parse(first.value.expiresAt)).toBe(decodeJwt(value.pass).exp * 1000);
  first.value.databases[0].version = 999;
  const second = await send(await input());
  expect(second.value.databases[0].version).toBe(42);
  const headers = { ...lastRequest.getHeaders(), 'x-scan-result': JSON.stringify(first.value) };
  refused(await send(await input(), { headers }));
  expect(supplied).toHaveLength(2);
}
test('caps expiry at the pass and refuses copied success without changing database facts',
  immutableResponse);

function disconnectedResult() {
  return 'disconnected';
}
function holdTransfer() {
  // Leave the body pending after the server has accepted this request.
}
async function occupyCapacity(stage = 'transfer') {
  const held = [];
  for (let index = 0; index < 2; index += 1) {
    const value = await input();
    let scanned;
    let pending;
    if (stage === 'scan') {
      scanned = once(server, 'scanned');
      pending = send(value);
    } else {
      pending = send(value, {}, holdTransfer);
    }
    const result = pending.catch(disconnectedResult);
    const client = lastRequest;
    await once(client, 'continue');
    if (stage === 'scan') {
      await scanned;
    }
    const entry = { value, client, result };
    held.push(entry);
  }
  return held;
}
async function saturatedRequests(stage) {
  mode = 'hang';
  await occupyCapacity(stage);
  const value = await input();
  value.byteCount = 20 * 1024 * 1024;
  let incoming;
  function observeRequest(request) {
    incoming = request;
  }
  server.once('checkContinue', observeRequest);
  const pending = send(value, {}, holdTransfer).catch(disconnectedResult);
  function responseOrContinue(resolve) {
    lastRequest.once('response', resolve);
    lastRequest.once('continue', resolve);
  }
  const answered = new Promise(responseOrContinue);
  // Send bytes before Continue to check that saturation cannot start body collection.
  lastRequest.write(value.bytes);
  await answered;
  expect(continued).toBe(false);
  const result = await pending;
  refused(result);
  expect(continued).toBe(false);
  expect(incoming.listenerCount('data')).toBe(0);
  expect(supplied).toHaveLength(stage === 'scan' ? 2 : 0);
}
test.each(['transfer', 'scan'])('refuses excess requests during %s without collecting bytes',
  saturatedRequests);

async function releaseCapacity(kind) {
  if (kind === 'timeout') {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  }
  const held = await occupyCapacity();
  refused(await send(await input()));
  if (kind === 'success') {
    for (const entry of held) {
      entry.client.end(entry.value.bytes);
      const result = await entry.result;
      expect(result.status).toBe(200);
    }
  } else if (kind === 'abort') {
    for (const entry of held) {
      entry.client.destroy();
      expect(await entry.result).toBe('disconnected');
    }
  } else {
    await vi.advanceTimersByTimeAsync(60000);
    for (const entry of held) {
      refused(await entry.result);
    }
  }
  expect(shutdown.signal.aborted).toBe(false);
  const replacements = await occupyCapacity();
  refused(await send(await input()));
  for (const entry of replacements) {
    entry.client.end(entry.value.bytes);
    const result = await entry.result;
    expect(result.status).toBe(200);
    expect(result.value.verdict).toBe('clean');
  }
}
test.each(['success', 'abort', 'timeout'])('releases all request capacity after transfer %s',
  releaseCapacity);

async function recoverAfterRefusal() {
  for (let index = 0; index < 3; index += 1) {
    const value = await input();
    value.pass = '';
    refused(await send(value));
    expect(continued).toBe(false);
  }
  const held = await occupyCapacity();
  refused(await send(await input()));
  for (const entry of held) {
    entry.client.end(entry.value.bytes);
    const result = await entry.result;
    expect(result.status).toBe(200);
  }
}
test('releases request capacity after authentication errors', recoverAfterRefusal);

async function openConnection() {
  const accepted = once(server, 'connection');
  const options = { host: '127.0.0.1', port: server.address().port };
  const client = connect(options);
  sockets.push(client);
  await once(client, 'connect');
  const [acceptedSocket] = await accepted;
  return { client, acceptedSocket };
}
async function boundedConnections() {
  const held = [];
  for (let index = 0; index < 8; index += 1) {
    held.push(await openConnection());
  }
  const options = { host: '127.0.0.1', port: server.address().port };
  const excess = connect(options);
  sockets.push(excess);
  function ignoreReset() {
    // A refused TCP connection may end with a reset instead of an orderly close.
  }
  excess.on('error', ignoreReset);
  function observeClose(resolve) {
    function closed() {
      clearTimeout(timer);
      resolve(true);
    }
    function stillOpen() {
      resolve(false);
    }
    const timer = setTimeout(stillOpen, 1000);
    excess.once('close', closed);
  }
  expect(await new Promise(observeClose)).toBe(true);
  const closed = once(held[0].acceptedSocket, 'close');
  held[0].client.destroy();
  await closed;
  const replacement = await openConnection();
  expect(replacement.client.destroyed).toBe(false);
  expect(spawn).not.toHaveBeenCalled();
}
test('bounds TCP connections before TLS and admits a replacement after close', boundedConnections);
