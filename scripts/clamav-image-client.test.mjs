import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tokenIssuer } from '@opencrane/auth';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { sharedCertificates } from '../libs/event-store/test/certificates.ts';
import { createScannerService } from '../infra/clamav/service.mjs';
import { scanImagePart } from '../infra/clamav/image-client.mjs';
import { scanHostedImageAttempt } from '../infra/clamav/image-walk.mjs';
import { runHostedImageScan } from '../infra/clamav/image-worker.mjs';
import { envelope } from '../libs/models/src/actor.ts';

async function filesystem(importOriginal) {
  const original = await importOriginal();
  return { ...original, readFile: vi.fn(original.readFile) };
}
vi.mock('node:fs/promises', filesystem);

let directory, server, settings, tls, updated, mode, previous;
let received, requests;
const bytes = Buffer.from('clean part');
const binding = { silo: 'first', serverId: 'server-one', attemptId: 1,
  platform: 'linux/amd64', targetImageDigest: 'c'.repeat(64) };
function hash(content) {
  const digest = createHash('sha256');
  digest.update(content);
  return digest.digest('hex');
}
function imageWithPart(part, identity) {
  const header = Buffer.alloc(512);
  header.write('part', 0, 'utf8');
  header.write('0000644\0', 100, 'ascii');
  header.write('0000000\0', 108, 'ascii');
  header.write('0000000\0', 116, 'ascii');
  header.write(part.length.toString(8).padStart(11, '0') + '\0', 124, 'ascii');
  header.write('00000000000\0', 136, 'ascii');
  header.fill(32, 148, 156);
  header.write('0', 156, 'ascii');
  header.write('ustar\0', 257, 'ascii');
  let checksum = 0;
  for (const value of header) checksum += value;
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
  const padding = Buffer.alloc((512 - part.length % 512) % 512);
  const layer = Buffer.concat([header, part, padding, Buffer.alloc(1024)]);
  const config = Buffer.from(JSON.stringify({ os: 'linux',
    architecture: identity.platform.split('/')[1],
    rootfs: { diff_ids: [`sha256:${hash(layer)}`] } }));
  const mediaType = 'application/vnd.oci.image.layer.v1.tar';
  const manifest = Buffer.from(JSON.stringify({ schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.manifest.v1+json',
    config: { digest: `sha256:${hash(config)}`, size: config.length },
    layers: [{ digest: `sha256:${hash(layer)}`, size: layer.length, mediaType }] }));
  const imageDigest = hash(manifest);
  const image = { ...identity, imageDigest, manifest, config,
    layers: [{ bytes: layer, digest: `sha256:${hash(layer)}`,
      diffId: `sha256:${hash(layer)}`, mediaType }] };
  const attempt = { ...identity, imageDigest, status: 'checking' };
  return { image, attempt };
}
function savedImageStore(image) {
  const data = { serverId: image.serverId, registeredBy: 'alice', kind: 'hosted',
    locator: `example.invalid/image@sha256:${image.imageDigest}`,
    installation: { attemptId: 1, platform: image.platform,
      upstream: { host: 'example.invalid', port: 443 } } };
  const event = envelope(image.silo, `mcp-${image.serverId}`, 'mcp.server_registered', data);
  event.principal = { kind: 'human', id: 'alice' };
  const rows = [{ event, sequence: 1 }];
  async function* readStream(subject) {
    if (subject === event.subject) yield* rows;
  }
  return { readStream, rows };
}
function facts(input) {
  const now = Date.now();
  function database(file) {
    return { file, sha256: 'd'.repeat(64), version: 42,
      builtAt: new Date(updated - 1000).toISOString() };
  }
  return { ...input, verdict: 'clean', imageDigest: `sha256:${'a'.repeat(64)}`,
    manifestDigest: `sha256:${'b'.repeat(64)}`,
    databases: ['main.cvd', 'daily.cld', 'bytecode.cvd'].map(database),
    databaseUpdatedAt: new Date(updated).toISOString(),
    checkedAt: new Date(now).toISOString(), expiresAt: new Date(now + 10000).toISOString() };
}
async function listen() {
  server.listen(0, '0.0.0.0');
  await once(server, 'listening');
  settings.url = `https://127.0.0.1:${server.address().port}/scan/image-part`;
}
async function close() {
  server.closeAllConnections();
  if (server.listening) {
    server.close();
    await once(server, 'close');
  }
}
async function setup() {
  updated = Date.now() - 1000;
  mode = '';
  received = [];
  requests = [];
  directory = await mkdtemp(join(tmpdir(), 'image-client-'));
  await sharedCertificates(directory);
  tls = { key: await readFile(join(directory, 'server.key')),
    cert: await readFile(join(directory, 'server.crt')) };
  settings = { silo: 'first', caFile: join(directory, 'ca.crt'),
    privateKeyPath: join(directory, 'server.key'), issuer: 'https://issuer.invalid',
    imageDigest: `sha256:${'a'.repeat(64)}`, manifestDigest: `sha256:${'b'.repeat(64)}` };
  server = createServer(tls);
  await listen();
}
async function cleanup() {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await close();
  const removal = { recursive: true, force: true };
  await rm(directory, removal);
}
beforeEach(setup);
afterEach(cleanup);
async function twoSilos() {
  await close();
  const other = { ...settings, silo: 'second', issuer: 'https://second.invalid',
    privateKeyPath: join(directory, 'command.key') };
  const trust = [];
  for (const config of [settings, other]) {
    const scannerIdentity = { service: 'image-worker', silo: config.silo };
    const tokenOptions = { ...config, scannerIdentity };
    const tokens = await tokenIssuer(tokenOptions);
    const trustedIssuer = { issuer: config.issuer, jwks: tokens.jwks,
      services: { 'image-worker': config.silo } };
    trust.push(trustedIssuer);
  }
  let releaseFirst;
  function wait(resolve) {
    releaseFirst = resolve;
  }
  const bothArrived = new Promise(wait);
  async function scan(input) {
    received.push(Buffer.from(input.bytes));
    expect(input.sha256).toBe(hash(input.bytes));
    expect(input.byteCount).toBe(input.bytes.length);
    if (received.length === 2) {
      releaseFirst();
    }
    await bothArrived;
    const scanned = { sha256: input.sha256, byteCount: input.byteCount };
    const result = facts(scanned);
    if (input.bytes.equals(Buffer.from('infected part'))) {
      result.verdict = 'infected';
    }
    return result;
  }
  const scanner = { scan, signal: new AbortController().signal,
    databaseUpdatedAt: new Date(updated).toISOString() };
  const serviceOptions = { scanner, tls, trust };
  server = createScannerService(serviceOptions);
  await listen();
  other.url = settings.url;
  const second = { silo: 'second', serverId: 'server-two', attemptId: 1,
    platform: 'linux/arm64' };
  const infected = Buffer.from('infected part');
  const firstImage = imageWithPart(bytes, binding);
  const secondImage = imageWithPart(infected, second);
  const firstStore = savedImageStore(firstImage.image);
  const secondStore = savedImageStore(secondImage.image);
  async function firstImageBytes() { return firstImage.image; }
  async function secondImageBytes() { return secondImage.image; }
  async function firstSettings() { return settings; }
  async function secondSettings() { return other; }
  const results = await Promise.all([
    runHostedImageScan(firstStore, 'first', 'server-one', firstImageBytes, firstSettings),
    runHostedImageScan(secondStore, 'second', 'server-two', secondImageBytes, secondSettings),
  ]);
  expect(results[0].verdict).toBe('clean');
  expect(results[1].verdict).toBe('infected');
  expect(received).toHaveLength(2);
}
test('production worker interleaves saved attempts from two trusted silos', twoSilos);

function respond(request, reply) {
  requests.push(request.headers['x-scan-request-id']);
  if (mode === 'waiting') {
    server.emit('waiting', request.socket);
    return;
  }
  if (mode === 'redirect') {
    const redirect = { location: settings.url };
    reply.writeHead(307, redirect);
    reply.end('private-canary');
    return;
  }
  if (mode !== 'early') {
    reply.writeContinue();
  }
  const chunks = [];
  function receive(chunk) {
    chunks.push(chunk);
  }
  function finish() {
    const content = Buffer.concat(chunks);
    received.push(content);
    const headers = request.headers;
    const input = { ...binding, silo: headers['x-scan-silo'],
      purpose: 'image', requestId: headers['x-scan-request-id'],
      sha256: hash(content), byteCount: content.length };
    let result = facts(input);
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
    } else if (mode === 'malformed') {
      body = 'private-canary';
    } else if (mode === 'incomplete') {
      reply.setHeader('content-length', Buffer.byteLength(body) + 1);
    } else if (mode === 'type') {
      reply.setHeader('content-type', 'text/plain');
    }
    if (mode === 'partial') {
      reply.write(body.slice(0, 20));
      server.emit('waiting', request.socket);
      return;
    }
    reply.end(body);
  }
  request.on('data', receive);
  request.on('end', finish);
  if (mode === 'early') {
    finish();
  }
}
async function refused(content = bytes, identity = binding, signal) {
  server.on('checkContinue', respond);
  const pending = scanImagePart(settings, content, identity, signal);
  await expect(pending).rejects.toEqual(new Error('Image part scan refused'));
  await expect(pending).rejects.not.toHaveProperty('cause');
  server.removeListener('checkContinue', respond);
}
const invalid = [
  ['silo', 'second'], ['requestId', '11111111-1111-4111-8111-111111111111'],
  ['serverId', 'other'], ['attemptId', 2], ['platform', 'linux/arm64'],
  ['targetImageDigest', 'e'.repeat(64)], ['purpose', 'upload'], ['sha256', 'f'.repeat(64)],
  ['byteCount', 1], ['verdict', 'OK'], ['imageDigest', `sha256:${'e'.repeat(64)}`],
  ['manifestDigest', `sha256:${'e'.repeat(64)}`], ['databases', []],
  ['databaseUpdatedAt', '2020-01-01T00:00:00.000Z'],
  ['databaseUpdatedAt', '2099-01-01T00:00:00.000Z'],
  ['checkedAt', '2099-01-01T00:00:00.000Z'], ['expiresAt', '2020-01-01T00:00:00.000Z'],
  ['extra', 'private-canary'],
];
async function invalidFact(field, value) {
  function alter(result) {
    result[field] = value;
  }
  mode = alter;
  await refused();
}
test.each(invalid)('refuses changed or invalid %s facts', invalidFact);
async function invalidDatabase(field, value) {
  function alter(result) {
    result.databases[0][field] = value;
  }
  mode = alter;
  await refused();
}
test.each([['file', 'daily.cvd'], ['sha256', 'unknown'], ['version', 0],
  ['builtAt', '2099-01-01T00:00:00.000Z']])('refuses invalid database %s', invalidDatabase);
async function failure(kind) {
  mode = kind;
  if (kind === 'ca') {
    settings.caFile = join(directory, 'unknown.crt');
  } else if (kind === 'hostname') {
    settings.url = settings.url.replace('127.0.0.1', '127.0.0.2');
  } else if (kind === 'key') {
    settings.privateKeyPath = join(directory, 'missing');
  } else if (kind === 'url') {
    settings.url = settings.url.replace('/scan/image-part', '/scan/upload');
  } else if (kind === 'http') {
    settings.url = settings.url.replace('https:', 'http:');
  } else if (kind === 'custody') {
    delete settings.privateKeyPath;
  } else if (kind === 'trust') {
    delete settings.manifestDigest;
  } else if (kind === 'outage') {
    await close();
  }
  await refused();
  if (['redirect', 'early', 'ca', 'hostname', 'custody', 'key'].includes(kind)) {
    function empty(content) {
      return content.length === 0;
    }
    expect(received.every(empty)).toBe(true);
  }
}
test.each(['ca', 'hostname', 'key', 'custody', 'trust', 'url', 'http', 'outage',
  'redirect', 'early', 'large', 'malformed', 'incomplete', 'type'])('refuses %s', failure);
async function copied() {
  server.on('checkContinue', respond);
  await scanImagePart(settings, bytes, binding);
  server.removeListener('checkContinue', respond);
  mode = 'copied';
  await refused();
  expect(new Set(requests).size).toBe(2);
}
test('a retry gets a fresh UUID and cannot use cached JSON', copied);
async function changedDuringTransfer(kind) {
  const content = Buffer.from(bytes);
  const identity = { ...binding };
  function change() {
    if (kind === 'bytes') {
      content.fill(65);
    } else {
      identity.attemptId += 1;
    }
  }
  mode = change;
  await refused(content, identity);
}
test.each(['bytes', 'binding'])('refuses changed %s while awaiting', changedDuringTransfer);
async function expiryCap(kind) {
  const now = Math.floor(Date.now() / 1000) * 1000 + 500;
  const clockSpy = vi.spyOn(Date, 'now');
  clockSpy.mockReturnValue(now);
  function alter(result) {
    const now = Date.now();
    let expires = now + 119500;
    if (kind === 'two minutes') {
      result.checkedAt = new Date(now - 1000).toISOString();
      result.databaseUpdatedAt = new Date(now - 2000).toISOString();
      for (const database of result.databases) {
        database.builtAt = result.databaseUpdatedAt;
      }
    }
    if (kind === 'pass') {
      expires = now + 120000;
    } else if (kind === 'database') {
      result.databaseUpdatedAt = new Date(now - 86400000 + 1000).toISOString();
      for (const database of result.databases) {
        database.builtAt = result.databaseUpdatedAt;
      }
      expires = now + 2000;
    } else if (kind === 'transfer') {
      const transferClockSpy = vi.spyOn(Date, 'now');
      transferClockSpy.mockReturnValue(now + 11000);
    }
    if (kind !== 'transfer') {
      result.expiresAt = new Date(expires).toISOString();
    }
  }
  mode = alter;
  await refused();
}
test.each(['pass', 'database', 'two minutes', 'transfer'])('refuses %s expiry', expiryCap);
async function useAgain(kind) {
  server.on('checkContinue', respond);
  const validate = await scanImagePart(settings, bytes, binding);
  const now = Date.now();
  if (kind === 'wall') {
    const wallClockSpy = vi.spyOn(Date, 'now');
    wallClockSpy.mockReturnValue(now + 11000);
  } else if (kind === 'backwards') {
    const backwardsClockSpy = vi.spyOn(Date, 'now');
    backwardsClockSpy.mockReturnValue(now - 60000);
  } else if (kind === 'monotonic') {
    const monotonicClockSpy = vi.spyOn(performance, 'now');
    monotonicClockSpy.mockReturnValue(performance.now() + 11000);
  }
  function use() {
    validate(kind === 'bytes' ? Buffer.from('other part') : bytes, binding);
  }
  expect(use).toThrow('Image part scan refused');
}
test.each(['wall', 'backwards', 'monotonic', 'bytes'])('checks %s again at use', useAgain);
async function cancelled(kind) {
  mode = kind === 'partial' ? 'partial' : 'waiting';
  const controller = new AbortController();
  const timers = { toFake: ['setTimeout', 'clearTimeout'] };
  vi.useFakeTimers(timers);
  const waiting = once(server, 'waiting');
  let releaseKey;
  let key;
  if (kind === 'issuance') {
    const ca = await readFile(settings.caFile);
    key = await readFile(settings.privateKeyPath, 'utf8');
    function holdKey() {
      function wait(resolve) {
        releaseKey = resolve;
      }
      return new Promise(wait);
    }
    readFile.mockResolvedValueOnce(ca);
    readFile.mockImplementationOnce(holdKey);
  }
  const pending = refused(bytes, binding, controller.signal);
  if (kind === 'issuance') {
    await vi.advanceTimersByTimeAsync(59000);
    releaseKey(key);
  }
  const [socket] = await waiting;
  function waitForClose(resolve) {
    socket.once('close', resolve);
  }
  const closed = new Promise(waitForClose);
  if (kind === 'cancel' || kind === 'partial') {
    controller.abort();
  } else {
    await vi.advanceTimersByTimeAsync(kind === 'issuance' ? 1000 : 60000);
  }
  await pending;
  await closed;
  expect(received).toEqual(kind === 'partial' ? [bytes] : []);
  expect(vi.getTimerCount()).toBe(0);
}
test.each(['cancel', 'deadline', 'partial', 'issuance'])('%s closes the pending socket', cancelled);
async function oversized() {
  await refused(Buffer.alloc(20 * 1024 * 1024 + 1));
  expect(requests).toEqual([]);
}
test('refuses oversized input before connecting', oversized);
