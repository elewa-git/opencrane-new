import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tokenIssuer } from '@opencrane/auth';
import { readHostedAdmission } from '@opencrane/models';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { sharedCertificates } from '../libs/event-store/test/certificates.ts';
import { createScannerService } from '../infra/clamav/service.mjs';
import { scanImagePart } from '../infra/clamav/image-client.mjs';
import { runHostedImageScan, runAndWriteHostedImageCheck, savedResultMatches }
  from '../infra/clamav/image-worker.mjs';
import { envelope } from '../libs/models/src/actor.ts';

async function filesystem(importOriginal) {
  const original = await importOriginal();
  return { ...original, readFile: vi.fn(original.readFile) };
}
vi.mock('node:fs/promises', filesystem);

let directory, server, settings, tls, updated, mode, previous;
let received, requests;
const bytes = Buffer.from('clean part');
const eicar = Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*');
const binding = { silo: 'first', serverId: 'server-one', attemptId: 1,
  platform: 'linux/amd64', targetImageDigest: 'c'.repeat(64) };
function hash(content) {
  const digest = createHash('sha256');
  digest.update(content);
  return digest.digest('hex');
}
function tarEntry(part, index) {
  const header = Buffer.alloc(512);
  header.write(`part-${index}`, 0, 'utf8');
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
  return Buffer.concat([header, part, padding]);
}
function imageWithPart(part, identity) {
  const parts = Array.isArray(part) ? part : [part];
  const entries = parts.map(tarEntry);
  const layer = Buffer.concat([...entries, Buffer.alloc(1024)]);
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
      upstream: { host: 'api.github.com', port: 443 } } };
  const event = envelope(image.silo, `mcp-${image.serverId}`, 'mcp.server_registered', data);
  event.principal = { kind: 'human', id: 'alice' };
  const rows = [{ event, sequence: 1 }];
  async function* readStream(subject) {
    if (subject === event.subject) yield* rows;
  }
  return { readStream, rows };
}
async function refuseAlteredImages(image, currentSettings, scannedCount) {
  const changedBytes = { ...image, layers: [
    { ...image.layers[0], bytes: Buffer.from('changed bytes') },
  ] };
  const candidates = [
    changedBytes,
    { ...image, imageDigest: 'd'.repeat(64) },
    { ...image, platform: 'linux/arm64' },
    { ...image, attemptId: 2 },
    { ...image, layers: [] },
  ];
  async function settingsAgain() { return currentSettings; }
  for (const candidate of candidates) {
    async function candidateBytes() { return candidate; }
    const store = savedImageStore(image);
    const result = await runHostedImageScan(store, image.silo, image.serverId,
      candidateBytes, settingsAgain);
    expect(result.verdict).toBe('unavailable');
    expect(received).toHaveLength(scannedCount);
  }
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
    if (input.bytes.equals(eicar)) {
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
  const infected = Buffer.from(eicar);
  const firstImage = imageWithPart(bytes, binding);
  const secondImage = imageWithPart(infected, second);
  const firstStore = writableImageStore(firstImage.image);
  const secondStore = writableImageStore(secondImage.image);
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
  await refuseAlteredImages(firstImage.image, settings, 2);

  const absentStore = savedImageStore(firstImage.image);
  absentStore.rows.length = 0;
  let prepared = 0;
  async function countPreparation() {
    prepared += 1;
    return firstImage.image;
  }
  const absent = await runHostedImageScan(absentStore, 'first', 'server-one',
    countPreparation, firstSettings);
  expect(absent.verdict).toBe('unavailable');
  expect(prepared).toBe(0);
  expect(received).toHaveLength(2);

  const changedStore = savedImageStore(firstImage.image);
  let settingReads = 0;
  async function changedSettings() {
    settingReads += 1;
    if (settingReads === 2) {
      return { ...settings, manifestDigest: `sha256:${'c'.repeat(64)}` };
    }
    return settings;
  }
  const changed = await runHostedImageScan(changedStore, 'first', 'server-one',
    firstImageBytes, changedSettings);
  expect(changed.verdict).toBe('unavailable');

  const replacedStore = savedImageStore(firstImage.image);
  let replacementReads = 0;
  async function replaceAttempt() {
    replacementReads += 1;
    if (replacementReads === 1) replacedStore.rows.length = 0;
    return settings;
  }
  const replaced = await runHostedImageScan(replacedStore, 'first', 'server-one',
    firstImageBytes, replaceAttempt);
  expect(replaced.verdict).toBe('unavailable');

  const cancelled = new AbortController();
  let cancellationReads = 0;
  async function cancelAfterScan() {
    cancellationReads += 1;
    if (cancellationReads === 2) cancelled.abort();
    return settings;
  }
  const stopped = await runHostedImageScan(savedImageStore(firstImage.image), 'first',
    'server-one', firstImageBytes, cancelAfterScan, cancelled.signal);
  expect(stopped.verdict).toBe('unavailable');
  async function readChecks() { return independentChecks(); }
  const written = await Promise.all([
    runAndWriteHostedImageCheck(firstStore, 'first', 'server-one', 1,
      firstImageBytes, firstSettings, readChecks),
    runAndWriteHostedImageCheck(secondStore, 'second', 'server-two', 1,
      secondImageBytes, secondSettings, readChecks),
  ]);
  expect(written[0].status).toBe('appended');
  expect(written[1].status).toBe('unavailable');
  expect(firstStore.rows[1].event.silo).toBe('first');
  expect(secondStore.rows).toHaveLength(1);
}
test('production worker interleaves saved attempts from two trusted silos', twoSilos);

function writableImageStore(image) {
  const store = savedImageStore(image);
  store.appendCount = 0;
  store.loseReply = false;
  store.append = async function append(input) {
    store.appendCount += 1;
    if (input.expectedSequence !== store.rows.at(-1).sequence) {
      return { status: 'conflict' };
    }
    const sequence = store.rows.length + 1;
    store.rows.push({ event: input.event, sequence });
    if (store.loseReply) {
      store.loseReply = false;
      throw new Error('reply lost');
    }
    return { status: 'appended', sequence };
  };
  store.readEvent = async function readEvent(sequence) {
    return store.rows[sequence - 1];
  };
  return store;
}

function independentChecks(verdict = 'pass') {
  const checkedAt = new Date(Date.now() - 1000).toISOString();
  const expiresAt = new Date(Date.now() + 60000).toISOString();
  const common = { verdict, checkedAt, expiresAt, engineVersion: '1',
    reportDigest: 'e'.repeat(64) };
  if (verdict === 'fail') common.reasonCodes = ['refused'];
  const vulnerability = { ...common, databaseDigest: 'f'.repeat(64),
    databaseUpdatedAt: checkedAt };
  return { signature: common, licence: common, vulnerability };
}

async function checkedService(scan) {
  await close();
  const scannerIdentity = { service: 'image-worker', silo: settings.silo };
  const issuer = await tokenIssuer({ ...settings, scannerIdentity });
  const trust = [{ issuer: settings.issuer, jwks: issuer.jwks,
    services: { 'image-worker': settings.silo } }];
  const scanner = { scan, signal: new AbortController().signal,
    databaseUpdatedAt: new Date(updated).toISOString() };
  server = createScannerService({ scanner, tls, trust });
  await listen();
}

async function writesCleanAndRecoversOriginalEvent() {
  async function scan(input) {
    received.push(Buffer.from(input.bytes));
    return facts({ sha256: input.sha256, byteCount: input.byteCount });
  }
  await checkedService(scan);
  const { image } = imageWithPart(bytes, binding);
  const store = writableImageStore(image);
  store.loseReply = true;
  async function prepare() { return image; }
  async function readSettings() { return settings; }
  async function readChecks() { return independentChecks(); }
  const args = [store, image.silo, image.serverId, 1, prepare, readSettings, readChecks];
  const firstOutcome = await runAndWriteHostedImageCheck(...args);
  expect(store.rows).toHaveLength(2);
  expect(firstOutcome.status).toBe('appended');
  expect(store.rows).toHaveLength(2);
  expect(store.rows[1].event.type).toBe('mcp.image_checked');
  expect(store.rows[1].event.data.checks.malware.verdict).toBe('pass');
  const savedResult = store.rows[1].event.data;
  expect(await savedResultMatches(store, image.silo, savedResult)).toBe(true);
  const alteredResults = [
    { ...savedResult, attemptId: 2 },
    { ...savedResult, imageDigest: 'd'.repeat(64) },
    { ...savedResult, platform: 'linux/arm64' },
    { ...savedResult, checks: { ...savedResult.checks,
      signature: { ...savedResult.checks.signature, engineVersion: 'changed' } } },
    { ...savedResult, checks: { ...savedResult.checks,
      malware: { ...savedResult.checks.malware, verdict: 'unknown' } } },
  ];
  for (const altered of alteredResults) {
    expect(await savedResultMatches(store, image.silo, altered)).toBe(false);
  }
  const absentStore = savedImageStore(image);
  absentStore.rows.length = 0;
  expect(await savedResultMatches(absentStore, image.silo, savedResult)).toBe(false);
  const originalId = store.rows[1].event.id;
  expect((await runAndWriteHostedImageCheck(...args)).status).toBe('appended');
  expect(store.rows[1].event.id).toBe(originalId);
  expect(store.appendCount).toBe(1);
  expect(received).toHaveLength(1);
  const admission = await readHostedAdmission(store, image.silo, image.serverId);
  expect(admission.status).toBe('admitted');
  const restarted = { ...store, appendCount: 0 };
  const restartArgs = [restarted, image.silo, image.serverId, 1,
    prepare, readSettings, readChecks];
  expect((await runAndWriteHostedImageCheck(...restartArgs)).status).toBe('appended');
  expect(restarted.appendCount).toBe(0);
  expect(received).toHaveLength(1);
  expect((await runHostedImageScan(restarted, image.silo, image.serverId,
    prepare, readSettings)).verdict).toBe('unavailable');
  expect(received).toHaveLength(1);
  const stale = await runAndWriteHostedImageCheck(store, image.silo, image.serverId, 2,
    prepare, readSettings, readChecks);
  expect(stale.status).toBe('unavailable');
  expect(received).toHaveLength(1);
}
test('clean scan writes one event and a lost reply recovers without scanning again',
  writesCleanAndRecoversOriginalEvent);

function deferred() {
  let resolve;
  const promise = new Promise(complete => { resolve = complete; });
  return { promise, resolve };
}

async function coordinatesConcurrentDeliveries() {
  const releaseScan = deferred();
  const enteredScan = deferred();
  let scanCount = 0;
  async function scan(input) {
    scanCount += 1;
    enteredScan.resolve();
    await releaseScan.promise;
    return facts({ sha256: input.sha256, byteCount: input.byteCount });
  }
  await checkedService(scan);
  const { image } = imageWithPart(bytes, binding);
  const store = writableImageStore(image);
  async function prepare() { return image; }
  async function readSettings() { return settings; }
  async function readChecks() { return independentChecks(); }
  const args = [store, image.silo, image.serverId, 1, prepare, readSettings, readChecks];
  const first = runAndWriteHostedImageCheck(...args);
  const second = runAndWriteHostedImageCheck(...args);
  await enteredScan.promise;
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(scanCount).toBe(1);
  const stopped = new AbortController();
  stopped.abort();
  const cancelledDelivery = runAndWriteHostedImageCheck(...args, stopped.signal);
  releaseScan.resolve();
  expect(await Promise.all([first, second])).toEqual([
    { status: 'appended' }, { status: 'appended' },
  ]);
  expect(scanCount).toBe(1);
  expect(store.appendCount).toBe(1);
  expect(await cancelledDelivery).toEqual({ status: 'unavailable' });
}
test('concurrent deliveries share one scan for the original attempt',
  coordinatesConcurrentDeliveries);

async function coordinatesSeparateStoreWrappers() {
  const releaseScan = deferred();
  const enteredScan = deferred();
  let scanCount = 0;
  async function scan(input) {
    scanCount += 1;
    enteredScan.resolve();
    await releaseScan.promise;
    return facts({ sha256: input.sha256, byteCount: input.byteCount });
  }
  await checkedService(scan);
  const { image } = imageWithPart(bytes, binding);
  const firstStore = writableImageStore(image);
  const secondStore = { ...firstStore };
  async function prepare() { return image; }
  async function readSettings() { return settings; }
  async function readChecks() { return independentChecks(); }
  const first = runAndWriteHostedImageCheck(firstStore, image.silo, image.serverId,
    1, prepare, readSettings, readChecks);
  await enteredScan.promise;
  const second = runAndWriteHostedImageCheck(secondStore, image.silo, image.serverId,
    1, prepare, readSettings, readChecks);
  await new Promise(resolve => setTimeout(resolve, 50));
  releaseScan.resolve();
  const secondOutcome = await second;
  expect(secondOutcome.status).toBe('unavailable');
  expect(scanCount).toBe(1);
  expect((await first).status).toBe('appended');
  expect(scanCount).toBe(1);
}
test('separate worker store wrappers cannot scan the same saved attempt twice',
  coordinatesSeparateStoreWrappers);

async function restartAfterLostResultReply() {
  let scanCount = 0;
  async function scan(input) {
    scanCount += 1;
    return facts({ sha256: input.sha256, byteCount: input.byteCount });
  }
  await checkedService(scan);
  const { image } = imageWithPart(bytes, binding);
  const store = writableImageStore(image);
  const originalAppend = store.append;
  let delayedResult;
  store.append = async function loseResultReply(input) {
    if (input.event.type === 'mcp.image_checked') {
      delayedResult = input;
      throw new Error('reply lost before result became visible');
    }
    return originalAppend(input);
  };
  async function prepare() { return image; }
  async function readSettings() { return settings; }
  async function readChecks() { return independentChecks(); }
  const args = [store, image.silo, image.serverId, 1, prepare, readSettings, readChecks];
  expect((await runAndWriteHostedImageCheck(...args)).status).toBe('unavailable');
  expect(scanCount).toBe(1);
  const restartedStore = { ...store, append: originalAppend };
  const restartedArgs = [restartedStore, image.silo, image.serverId,
    1, prepare, readSettings, readChecks];
  expect((await runAndWriteHostedImageCheck(...restartedArgs)).status).toBe('unavailable');
  expect(scanCount).toBe(1);
  store.rows.push({ event: delayedResult.event, sequence: store.rows.length + 1 });
  expect((await runAndWriteHostedImageCheck(...restartedArgs)).status).toBe('appended');
  expect(scanCount).toBe(1);
}
test('a restarted worker waits for the original result after a lost reply',
  restartAfterLostResultReply);

async function waitsForPendingLostAppend() {
  let scanCount = 0;
  async function scan(input) {
    scanCount += 1;
    return facts({ sha256: input.sha256, byteCount: input.byteCount });
  }
  await checkedService(scan);
  const { image } = imageWithPart(bytes, binding);
  const store = writableImageStore(image);
  const originalAppend = store.append;
  let pendingInput;
  store.append = async function delayedLostReply(input) {
    store.appendCount += 1;
    pendingInput = input;
    throw new Error('reply lost before commit became visible');
  };
  async function prepare() { return image; }
  async function readSettings() { return settings; }
  async function readChecks() { return independentChecks(); }
  const args = [store, image.silo, image.serverId, 1, prepare, readSettings, readChecks];
  expect((await runAndWriteHostedImageCheck(...args)).status).toBe('unavailable');
  expect(store.rows).toHaveLength(1);
  expect(scanCount).toBe(1);
  expect((await runAndWriteHostedImageCheck(...args)).status).toBe('unavailable');
  expect(scanCount).toBe(1);
  expect(store.appendCount).toBe(1);
  store.append = originalAppend;
  store.rows.push({ event: pendingInput.event, sequence: 2 });
  expect((await runAndWriteHostedImageCheck(...args)).status).toBe('appended');
  expect(scanCount).toBe(1);
}
test('lost append reply blocks another scan until its pending commit is visible',
  waitsForPendingLostAppend);

async function retriesAfterValidationFailureBeforeAppend() {
  let scanCount = 0;
  async function scan(input) {
    scanCount += 1;
    return facts({ sha256: input.sha256, byteCount: input.byteCount });
  }
  await checkedService(scan);
  const { image } = imageWithPart(bytes, binding);
  const store = writableImageStore(image);
  let settingsReads = 0;
  async function prepare() { return image; }
  async function readSettings() {
    settingsReads += 1;
    if (settingsReads === 2) {
      return { ...settings, manifestDigest: `sha256:${'c'.repeat(64)}` };
    }
    return settings;
  }
  async function readChecks() { return independentChecks(); }
  const args = [store, image.silo, image.serverId, 1, prepare, readSettings, readChecks];
  expect((await runAndWriteHostedImageCheck(...args)).status).toBe('unavailable');
  expect(store.appendCount).toBe(0);
  expect((await runAndWriteHostedImageCheck(...args)).status).toBe('appended');
  expect(scanCount).toBe(2);
  expect(store.appendCount).toBe(1);
}
test('validation failure before append allows a fresh attempt delivery',
  retriesAfterValidationFailureBeforeAppend);

async function abortsAtWorkerBoundaries(kind) {
  async function scan(input) {
    received.push(Buffer.from(input.bytes));
    return facts({ sha256: input.sha256, byteCount: input.byteCount });
  }
  await checkedService(scan);
  const { image } = imageWithPart(bytes, binding);
  const store = writableImageStore(image);
  const controller = new AbortController();
  let historyReads = 0;
  let settingsReads = 0;
  const originalRead = store.readStream;
  async function* countHistory(...args) {
    historyReads += 1;
    yield* originalRead(...args);
    if (kind === 'after admission read' && historyReads === 1) controller.abort();
    if (kind === 'during validation read' && historyReads === 4) controller.abort();
  }
  store.readStream = countHistory;
  async function prepare() {
    if (kind === 'during preparation') controller.abort();
    return image;
  }
  async function readSettings() {
    settingsReads += 1;
    return settings;
  }
  async function readChecks() {
    if (kind === 'after separate checks') controller.abort();
    return independentChecks();
  }
  if (kind === 'before history') controller.abort();
  const outcome = await runAndWriteHostedImageCheck(store, image.silo, image.serverId, 1,
    prepare, readSettings, readChecks, controller.signal);
  expect(outcome.status).toBe('unavailable');
  expect(store.appendCount).toBe(0);
  if (kind === 'before history') expect(historyReads).toBe(0);
  if (kind === 'after admission read') expect(historyReads).toBe(1);
  if (kind === 'during preparation') expect(settingsReads).toBe(0);
  if (kind === 'during validation read') expect(settingsReads).toBe(1);
  if (kind === 'after separate checks') expect(historyReads).toBe(2);
}
test.each(['before history', 'after admission read', 'during preparation',
  'during validation read', 'after separate checks'])(
  '%s stops worker progress', abortsAtWorkerBoundaries);

async function refusesIncompleteAndIndependentFailures(kind) {
  async function scan(input) {
    received.push(Buffer.from(input.bytes));
    const result = facts({ sha256: input.sha256, byteCount: input.byteCount });
    if (kind === 'infected') result.verdict = 'infected';
    return result;
  }
  await checkedService(scan);
  const { image } = imageWithPart(kind === 'infected' ? eicar : bytes, binding);
  const store = writableImageStore(image);
  async function prepare() { return image; }
  async function readSettings() { return settings; }
  async function readChecks() {
    const checks = independentChecks();
    if (kind === 'signature' || kind === 'licence' || kind === 'vulnerability') {
      checks[kind] = independentChecks('fail')[kind];
    }
    if (kind.startsWith('missing ')) delete checks[kind.slice(8)];
    return checks;
  }
  const outcome = await runAndWriteHostedImageCheck(store, image.silo, image.serverId, 1,
    prepare, readSettings, readChecks);
  if (kind.startsWith('missing ') || kind === 'infected') {
    expect(outcome.status).toBe('unavailable');
    expect(store.rows).toHaveLength(1);
  } else {
    expect(outcome.status).toBe('appended');
    expect(store.rows[1].event.data.checks[kind].verdict).toBe('fail');
    const admission = await readHostedAdmission(store, image.silo, image.serverId);
    expect(admission.status).toBe('rejected');
  }
}
test.each(['infected', 'missing signature', 'missing licence',
  'missing vulnerability', 'signature', 'licence', 'vulnerability'])(
  '%s cannot admit an image after a part scan', refusesIncompleteAndIndependentFailures);

async function refusesChangedFactsBeforeAppend(kind) {
  async function scan(input) {
    received.push(Buffer.from(input.bytes));
    return facts({ sha256: input.sha256, byteCount: input.byteCount });
  }
  await checkedService(scan);
  const { image } = imageWithPart(bytes, binding);
  const store = writableImageStore(image);
  const controller = new AbortController();
  async function prepare() { return image; }
  async function readSettings() { return settings; }
  async function readChecks() {
    if (kind === 'bytes') image.layers[0].bytes[512] = 66;
    if (kind === 'digest') image.imageDigest = 'd'.repeat(64);
    if (kind === 'platform') image.platform = 'linux/arm64';
    if (kind === 'attempt') store.rows.length = 0;
    if (kind === 'part count') image.layers.length = 0;
    if (kind === 'manifest') settings.manifestDigest = `sha256:${'d'.repeat(64)}`;
    if (kind === 'cancel') controller.abort();
    if (kind === 'expiry') {
      const current = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(current + 12000);
    }
    return independentChecks();
  }
  const outcome = await runAndWriteHostedImageCheck(store, image.silo, image.serverId, 1,
    prepare, readSettings, readChecks, controller.signal);
  expect(outcome.status).toBe('unavailable');
  expect(store.appendCount).toBe(0);
  expect(received).toHaveLength(1);
}
test.each(['bytes', 'digest', 'platform', 'attempt', 'part count', 'manifest',
  'cancel', 'expiry'])('%s changing before append refuses the event',
  refusesChangedFactsBeforeAppend);

async function refusesChangeDuringWriterRead(kind) {
  async function scan(input) {
    return facts({ sha256: input.sha256, byteCount: input.byteCount });
  }
  await checkedService(scan);
  const { image } = imageWithPart(bytes, binding);
  const store = writableImageStore(image);
  const originalRead = store.readStream;
  let reads = 0;
  async function* changeOnWriterRead(subject, position, deadline) {
    reads += 1;
    if (reads === 3) {
      if (kind === 'expiry') {
        const current = Date.now();
        const clock = vi.spyOn(Date, 'now');
        clock.mockReturnValue(current + 12000);
      } else {
        settings.manifestDigest = `sha256:${'d'.repeat(64)}`;
      }
    }
    yield* originalRead(subject, position, deadline);
  }
  store.readStream = changeOnWriterRead;
  async function prepare() { return image; }
  async function readSettings() { return settings; }
  async function readChecks() { return independentChecks(); }
  const outcome = await runAndWriteHostedImageCheck(store, image.silo, image.serverId, 1,
    prepare, readSettings, readChecks);
  expect(outcome.status).toBe('unavailable');
  expect(reads).toBeGreaterThanOrEqual(3);
  expect(store.appendCount).toBe(0);
}
test.each(['expiry', 'manifest'])(
  '%s changing during the writer read refuses append', refusesChangeDuringWriterRead);

async function refusesScannerOutageAtWriter() {
  async function scan(input) {
    return facts({ sha256: input.sha256, byteCount: input.byteCount });
  }
  await checkedService(scan);
  await close();
  const { image } = imageWithPart(bytes, binding);
  const store = writableImageStore(image);
  async function prepare() { return image; }
  async function readSettings() { return settings; }
  async function readChecks() { return independentChecks(); }
  const outcome = await runAndWriteHostedImageCheck(store, image.silo, image.serverId, 1,
    prepare, readSettings, readChecks);
  expect(outcome.status).toBe('unavailable');
  expect(store.appendCount).toBe(0);
}
test('scanner outage cannot append a clean image event', refusesScannerOutageAtWriter);

async function refusesWrongTransportProof(kind) {
  const { image } = imageWithPart(bytes, binding);
  const store = writableImageStore(image);
  async function prepare() { return image; }
  async function readSettings() { return settings; }
  async function readChecks() { return independentChecks(); }
  if (kind === 'upload proof') {
    function swapPurpose(result) { result.purpose = 'upload'; }
    mode = swapPurpose;
    server.on('checkContinue', respond);
  } else {
    async function scan(input) {
      return facts({ sha256: input.sha256, byteCount: input.byteCount });
    }
    await checkedService(scan);
    if (kind === 'issuer') settings.issuer = 'https://foreign.invalid';
    if (kind === 'CA') settings.caFile = join(directory, 'unknown.crt');
    if (kind === 'silo') settings.silo = 'second';
  }
  const outcome = await runAndWriteHostedImageCheck(store, image.silo, image.serverId, 1,
    prepare, readSettings, readChecks);
  expect(outcome.status).toBe('unavailable');
  expect(store.appendCount).toBe(0);
}
test.each(['upload proof', 'issuer', 'CA', 'silo'])(
  '%s cannot supply image event evidence', refusesWrongTransportProof);

async function refusesLaterPartExpiryOrOrder(kind) {
  let count = 0;
  async function scan(input) {
    count += 1;
    const result = facts({ sha256: input.sha256, byteCount: input.byteCount });
    if (count === 2) result.expiresAt = new Date(Date.now() + 1000).toISOString();
    return result;
  }
  await checkedService(scan);
  const later = Buffer.from('later clean part');
  const { image } = imageWithPart([bytes, later], binding);
  const store = writableImageStore(image);
  async function prepare() { return image; }
  async function readSettings() { return settings; }
  async function readChecks() {
    if (kind === 'expiry') {
      const current = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(current + 2000);
    }
    return independentChecks();
  }
  if (kind === 'order') {
    const originalRead = readFile.getMockImplementation();
    async function swappedRead(path, options) {
      if (String(path).endsWith('/part-0')) return later;
      if (String(path).endsWith('/part-1')) return bytes;
      return originalRead(path, options);
    }
    readFile.mockImplementation(swappedRead);
  }
  const outcome = await runAndWriteHostedImageCheck(store, image.silo, image.serverId, 1,
    prepare, readSettings, readChecks);
  expect(outcome.status).toBe('unavailable');
  expect(store.appendCount).toBe(0);
}
test.each(['expiry', 'order'])('later part %s refuses the event',
  refusesLaterPartExpiryOrOrder);

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
async function retainsFrozenAuthenticatedEvidence() {
  server.on('checkContinue', respond);
  const validate = await scanImagePart(settings, bytes, binding);
  expect(validate(bytes, binding)).toBe('clean');
  expect(Object.isFrozen(validate.evidence)).toBe(true);
  const originalDigest = validate.evidence.sha256;
  function alterEvidence() {
    validate.evidence.sha256 = 'f'.repeat(64);
  }
  expect(alterEvidence).toThrow(TypeError);
  expect(validate.evidence.sha256).toBe(originalDigest);
}
test('the authenticated part facts remain frozen after the request',
  retainsFrozenAuthenticatedEvidence);
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
