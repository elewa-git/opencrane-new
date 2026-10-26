import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { tokenIssuer } from '@opencrane/auth';
import { sharedCertificates } from '../libs/event-store/test/certificates.ts';
import { createScannerService } from '../infra/clamav/service.mjs';
import { scanFile } from '../apps/server/src/files/scanner.ts';
import { uploadFile } from '../apps/server/src/files/routes.ts';
import { fileCommand, ownConversation } from '../apps/server/src/files/commands.ts';

function commands() {
  return { fileCommand: vi.fn(), ownConversation: vi.fn() };
}
vi.mock('../apps/server/src/files/commands.ts', commands);
let directory, server, settings, tls, now, mode, received, requests, options, previous;
const bytes = Buffer.from('Meeting at ten.');
function hash(value) {
  const digest = createHash('sha256');
  digest.update(value);
  return digest.digest('hex');
}
function facts(input) {
  function database(file) {
    return { file, sha256: 'd'.repeat(64), version: 42, builtAt: new Date(now - 2000).toISOString() };
  }
  return { ...input, verdict: 'clean', imageDigest: `sha256:${'a'.repeat(64)}`,
    manifestDigest: `sha256:${'b'.repeat(64)}`,
    databases: ['main.cvd', 'daily.cld', 'bytecode.cvd'].map(database),
    databaseUpdatedAt: new Date(now - 1000).toISOString(),
    checkedAt: new Date(now).toISOString(), expiresAt: new Date(now + 60000).toISOString() };
}
function response(request, reply) {
  requests.push(request.headers['x-scan-request-id']);
  if (mode === 'timeout') {
    request.on('data', received.push.bind(received));
    server.emit('waiting');
    return;
  }
  if (mode === 'redirect') {
    reply.writeHead(307, { location: settings.url });
    reply.end();
    return;
  }
  reply.writeContinue();
  const chunks = [];
  function receive(chunk) {
    chunks.push(chunk);
  }
  function finish() {
    const content = Buffer.concat(chunks);
    received.push(content);
    const input = { purpose: 'upload', silo: request.headers['x-scan-silo'],
      requestId: request.headers['x-scan-request-id'], fileId: request.headers['x-scan-file-id'],
      sha256: hash(content), byteCount: content.length };
    let result = facts(input);
    if (mode === 'lost') {
      request.socket.destroy();
      return;
    }
    if (mode === 'copied') {
      result = previous;
    } else if (typeof mode === 'function') {
      mode(result);
    }
    previous = result;
    reply.setHeader('content-type', 'application/json');
    let body = JSON.stringify(result);
    if (mode === 'large') {
      body = body.padEnd(4097, ' ');
    }
    if (mode === 'malformed') {
      body = 'private-canary';
    }
    reply.end(body);
  }
  request.on('data', receive);
  request.on('end', finish);
}
async function listen() {
  server.listen(0, '0.0.0.0');
  await once(server, 'listening');
  settings.url = `https://127.0.0.1:${server.address().port}/scan/upload`;
}
async function setup() {
  now = Date.now();
  mode = '';
  received = [];
  requests = [];
  directory = await mkdtemp(join(tmpdir(), 'upload-https-'));
  await sharedCertificates(directory);
  tls = { key: await readFile(join(directory, 'server.key')),
    cert: await readFile(join(directory, 'server.crt')) };
  settings = { silo: 'test', caFile: join(directory, 'ca.crt'),
    privateKeyPath: join(directory, 'server.key'), issuer: 'https://issuer.invalid' };
  server = createServer(tls);
  server.on('checkContinue', response);
  await listen();
  function scan(content, binding) {
    return scanFile(settings, content, binding);
  }
  options = { silo: 'test', scan, objects: { putObject: vi.fn() } };
  ownConversation.mockResolvedValue([]);
  fileCommand.mockResolvedValue({ status: 'appended', sequence: 1 });
}
async function cleanup() {
  vi.useRealTimers();
  server.closeAllConnections();
  if (server.listening) {
    server.close();
    await once(server, 'close');
  }
  await rm(directory, { recursive: true, force: true });
  vi.clearAllMocks();
}
beforeEach(setup);
afterEach(cleanup);
function upload(content = bytes, fresh) {
  return uploadFile(options, 'alice', 'conversation', 'key', 'notes.txt', content,
    undefined, fresh);
}
async function refused(content = bytes, fresh) {
  const pending = upload(content, fresh);
  await expect(pending).rejects.toMatchObject({ kind: 'scanner', statusCode: 503,
    message: 'Dependency unavailable' });
  await expect(pending).rejects.not.toHaveProperty('cause');
  expect(options.objects.putObject).not.toHaveBeenCalled();
  expect(fileCommand).not.toHaveBeenCalled();
}
async function exactUpload() {
  const result = await upload();
  expect(result.status).toBe('appended');
  expect(result.fileId).toMatch(/^[a-f0-9]{64}$/);
  expect(received).toEqual([bytes]);
  expect(options.objects.putObject).toHaveBeenCalledOnce();
  const saved = fileCommand.mock.calls[0];
  expect(saved[4]).toBe('file.uploaded');
  expect(saved[5]).toMatchObject({ sha256: hash(bytes), size: bytes.length });
  ownConversation.mockResolvedValue([{ sequence: 1,
    event: { id: saved[3], type: saved[4], data: saved[5] } }]);
  await upload();
  expect(options.objects.putObject).toHaveBeenCalledOnce();
  expect(requests).toHaveLength(1);
}
test('stores exact clean bytes once and preserves the hash upload identity', exactUpload);
const invalid = [
  ['request', { requestId: randomUUID() }], ['silo', { silo: 'other' }],
  ['purpose', { purpose: 'image' }], ['file', { fileId: randomUUID() }],
  ['hash', { sha256: 'f'.repeat(64) }], ['count', { byteCount: 1 }],
  ['verdict', { verdict: 'CLEAN' }], ['image', { imageDigest: 'latest' }],
  ['manifest', { manifestDigest: 'unknown' }], ['databases', { databases: [] }],
  ['stale', { databaseUpdatedAt: '2020-01-01T00:00:00.000Z' }],
  ['future', { databaseUpdatedAt: '2099-01-01T00:00:00.000Z' }],
  ['future check', { checkedAt: '2099-01-01T00:00:00.000Z' }],
  ['expired', { expiresAt: '2020-01-01T00:00:00.000Z' }],
  ['invalid database', { databases: [{ file: 'main.cvd', sha256: 'bad',
    version: -1, builtAt: '2099-01-01T00:00:00.000Z' }] }],
  ['long expiry', { expiresAt: '2099-01-01T00:00:00.000Z' }],
];
async function invalidResult(_name, patch) {
  function alter(result) {
    Object.assign(result, patch);
  }
  mode = alter;
  await refused();
}
test.each(invalid)('refuses %s evidence before storage or append', invalidResult);
async function invalidDatabase(field, value) {
  function alter(result) {
    result.databases[0][field] = value;
  }
  mode = alter;
  await refused();
}
test.each([['file', 'daily.cvd'], ['sha256', 'unknown'], ['version', 0],
  ['builtAt', '2099-01-01T00:00:00.000Z']])('checks each database %s', invalidDatabase);
async function transportFailure(failure) {
  mode = failure;
  if (failure === 'ca') {
    settings.caFile = join(directory, 'unknown.crt');
  }
  if (failure === 'hostname') {
    settings.url = settings.url.replace('127.0.0.1', '127.0.0.2');
  }
  if (failure === 'issuance') {
    settings.privateKeyPath = join(directory, 'missing');
  }
  if (failure === 'configuration') {
    settings.url = undefined;
  }
  if (failure === 'outage') {
    server.close();
    await once(server, 'close');
  }
  await refused();
  if (failure !== 'large' && failure !== 'malformed') {
    expect(received).toEqual([]);
  }
}
test.each(['ca', 'hostname', 'issuance', 'configuration', 'redirect', 'large', 'malformed', 'outage'])(
  'fails closed on %s', transportFailure);
async function changedBytes() {
  const content = Buffer.from(bytes);
  async function mutate() {
    content.fill(65);
  }
  await refused(content, mutate);
}
test('checks unchanged bytes after access is rechecked', changedBytes);
async function expiredDuringAccess() {
  async function expire() {
    vi.spyOn(Date, 'now').mockReturnValue(now + 120000);
  }
  try {
    await refused(bytes, expire);
  } finally {
    vi.restoreAllMocks();
  }
}
test('checks expiry again after access is rechecked', expiredDuringAccess);
async function infected() {
  function infect(result) {
    result.verdict = 'infected';
  }
  mode = infect;
  expect((await upload()).status).toBe('infected');
  expect(options.objects.putObject).not.toHaveBeenCalled();
  expect(fileCommand.mock.calls[0][4]).toBe('file.rejected');
}
test('preserves a verified infected rejection', infected);
async function retry() {
  mode = 'lost';
  await refused();
  mode = '';
  await upload();
  expect(new Set(requests).size).toBe(2);
}
test('uses a fresh request after losing the response', retry);
async function copied() {
  await upload();
  vi.clearAllMocks();
  mode = 'copied';
  await refused();
}
test('refuses a copied response even for the same bytes and file', copied);
async function timeout() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  mode = 'timeout';
  const waiting = once(server, 'waiting');
  const pending = refused();
  await waiting;
  await vi.advanceTimersByTimeAsync(60000);
  await pending;
  expect(received).toEqual([]);
}
test('bounds the complete attempt to sixty seconds', timeout);
async function twoSilos() {
  server.close();
  await once(server, 'close');
  const other = { ...settings, silo: 'other', issuer: 'https://other.invalid' };
  const trust = [];
  for (const config of [settings, other]) {
    const scannerIdentity = { service: 'server', silo: config.silo };
    const tokens = await tokenIssuer({ ...config, scannerIdentity });
    trust.push({ issuer: config.issuer, jwks: tokens.jwks, services: { server: config.silo } });
  }
  async function scan(input) {
    await new Promise(setImmediate);
    expect(input.sha256).toBe(hash(input.bytes));
    const result = facts({ sha256: input.sha256, byteCount: input.byteCount });
    return result;
  }
  const scanner = { scan, signal: new AbortController().signal,
    databaseUpdatedAt: new Date(now - 1000).toISOString() };
  server = createScannerService({ scanner, tls, trust });
  await listen();
  other.url = settings.url;
  const first = { silo: 'test', fileId: 'a'.repeat(64) };
  const second = { silo: 'other', fileId: 'b'.repeat(64) };
  const results = await Promise.all([scanFile(settings, bytes, first),
    scanFile(other, Buffer.from('Other silo'), second)]);
  expect(results[0]()).toBe('clean');
  expect(results[1]()).toBe('clean');
}
test('interleaves two trusted silos through the real wrapper with hash file ids', twoSilos);
