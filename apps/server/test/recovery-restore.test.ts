import { z } from 'zod';
import { until } from '@opencrane/authz/testing';
import { recoveryHomes } from './support/recovery-homes.ts';
import { stalledStorage } from './support/stalled-storage.ts';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it, onTestFinished, vi } from 'vitest';
import { createEventStore } from '@opencrane/event-store';
import { event, natsFixture } from '@opencrane/event-store/testing';
import { ProjectionRunner } from '@opencrane/projections';
import { HandlerRuntime } from '@opencrane/handlers';
import { volumeExportDescriptorSchema } from '../../../infra/package/computer-volume-export.ts';
import { collectEventBackup, descriptorSchema } from '../../../infra/package/event-backup.ts';
import { collectObjectBackup } from '../../../infra/package/object-backup.ts';
import * as native from '../../../infra/package/event-restore.ts';
import * as custody from '../../../infra/package/memory-restore-check.ts';
import * as objects from '../../../infra/package/object-restore.ts';
import { provisionDisposableObjectTarget } from '../../../infra/package/disposable-object-target.ts';
import { provisionRecoveryEventTarget } from '../../../infra/package/recovery-event-target.ts';
import { restoreRecoveryBackup } from '../../../infra/package/recovery-restore.ts';
import { seedRecoveryFiles } from '../../../infra/package/upgrade-recovery-files-fixture.ts';
import { recoveryEffectProbes } from '../../../infra/package/upgrade-recovery-files-effects.ts';
import { restoreStorage } from './support/restore-storage.ts';

vi.mock('node:fs', { spy: true });

let source: Awaited<ReturnType<typeof natsFixture>>;
let storage: Awaited<ReturnType<typeof restoreStorage>>;
let directory: string;
let options: Parameters<typeof restoreRecoveryBackup>[4];
let uploads: Awaited<ReturnType<typeof seedRecoveryFiles>>;
const refusal = 'Recovery restore refused; keep both targets isolated';

async function start() {
  source = await natsFixture();
  storage = await restoreStorage();
  directory = await mkdtemp(join(tmpdir(), 'recovery-restore-'));
  uploads = await seedRecoveryFiles(source, storage.client);
  const collectHomes = await recoveryHomes(source, ['one', 'two']);
  const volumeDirectory = join(directory, 'homes');
  const eventDirectory = join(directory, 'events');
  const objectDirectory = join(directory, 'objects');
  const backupKeyFile = join(directory, 'key');
  await writeFile(backupKeyFile, randomBytes(32), { mode: 0o600 });
  await collectEventBackup(source.connection,
    { silo: 'test', attempt: 'copy', destination: eventDirectory });
  const scratch = await natsFixture({ provision: false });
  try {
    await collectObjectBackup(source.connection, scratch.connection, storage.client,
      { directory: eventDirectory, destination: objectDirectory, backupKeyFile,
        silo: 'test', attempt: 'copy', writersStopped: true, disposable: true });
  } finally {
    await scratch.close();
  }
  const sourceDirectory = join(directory, 'current');
  const candidateDirectory = join(directory, 'candidate');
  await mkdir(sourceDirectory, { mode: 0o700 });
  await mkdir(candidateDirectory, { mode: 0o700 });
  const memory = { source: source.connection, sourceDirectory, candidateDirectory };
  options = { memory, volumeDirectory, directory: objectDirectory, eventDirectory, backupKeyFile,
    silo: 'test', attempt: 'copy', targetSilo: 'test', stopped: true,
    exclusive: true, disposable: true, effectsDisabled: true };
  await collectHomes({ ...options, volumeDirectory });
}
async function stop() {
  await source?.close();
  await storage?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
}
beforeAll(start, 120_000);
afterAll(stop);

async function fixture() {
  const events = await provisionRecoveryEventTarget('test');
  onTestFinished(events.close);
  const target = await provisionDisposableObjectTarget('test');
  onTestFinished(target.close);
  onTestFinished(restoreMocks);
  const effects = recoveryEffectProbes();
  const probes = [vi.spyOn(ProjectionRunner.prototype, 'run'),
    vi.spyOn(HandlerRuntime.prototype, 'start'),
    vi.spyOn(HandlerRuntime.prototype, 'work')];
  function record(): never { throw new Error('Offline activity probe'); }
  for (const probe of probes) {
    probe.mockImplementation(record);
    function exercise() { Reflect.apply(probe, undefined, []); }
    expect(exercise).toThrow('Offline activity probe');
    expect(probe).toHaveBeenCalledTimes(1);
    probe.mockClear();
  }
  function quiet() {
    effects();
    for (const probe of probes) expect(probe).not.toHaveBeenCalled();
  }
  onTestFinished(quiet);
  const originalPut = target.client.putObject.bind(target.client);
  const originalRequest = events.connection.request.bind(events.connection);
  const writes = vi.spyOn(target.client, 'putObject');
  const buckets = vi.spyOn(target.client, 'makeBucket');
  const requests = vi.spyOn(events.connection, 'request');
  async function restore(overrides = {}) {
    return restoreRecoveryBackup(source.connection, events.connection, storage.client,
      target.client, { ...options, ...overrides });
  }
  async function untouched() {
    expect(writes).not.toHaveBeenCalled();
    expect(buckets).not.toHaveBeenCalled();
    for (const [subject] of requests.mock.calls) expect(subject).not.toMatch(/RESTORE|CREATE|DELETE|PURGE/);
    expect(await target.client.bucketExists('files')).toBe(false);
  }
  return { events, target, restore, untouched, writes, buckets, requests,
    originalPut, originalRequest };
}
function restoreMocks() { vi.restoreAllMocks(); }

async function restoresOnce() {
  const setup = await fixture();
  const eventRestore = vi.spyOn(native, 'restoreEventBackup');
  const objectRestore = vi.spyOn(objects, 'restoreObjectBackup');
  const result = await setup.restore();
  expect(result).toEqual({ kind: 'events-objects-and-custody-only' });
  expect(fs.readdirSync(options.volumeDirectory).sort())
    .toEqual(['descriptor.json', 'home-0000.enc', 'home-0001.enc']);
  const proof: unknown = await eventRestore.mock.results[0]!.value;
  expect(objectRestore.mock.calls[0]![3].proof).toBe(proof);
  const reader = await createEventStore(setup.events.connection);
  expect(await reader.head()).toBe(await source.reader.head());
  for (let position = 1; position <= await reader.head(); position++) {
    expect(await reader.readEvent(position)).toEqual(await source.reader.readEvent(position));
  }
  for (const upload of uploads) {
    const stream = await setup.target.client.getObject('files', upload.data.objectKey);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      if (!Buffer.isBuffer(chunk)) throw new Error('Invalid fixture bytes');
      chunks.push(chunk);
    }
    expect(Buffer.concat(chunks)).toEqual(upload.bytes);
  }
  await expect(setup.restore()).rejects.toThrow(refusal);
  expect(setup.writes).toHaveBeenCalledTimes(2);
}
it('restores original event identities and file bytes once with no activity', restoresOnce);

async function missingHomeExport() {
  const setup = await fixture();
  const volumeDirectory = join(directory, 'missing-home-export');
  await expect(setup.restore({ volumeDirectory })).rejects.toEqual(new Error(refusal));
  await setup.untouched();
}
it('refuses a missing home export before either target changes', missingHomeExport);

type HomeDescriptor = z.infer<typeof volumeExportDescriptorSchema>;
async function encryptHomes(path: string, descriptor: HomeDescriptor, key: Buffer,
  fault: string) {
  for (const entry of descriptor.exports) {
    const bytes = Buffer.from(`private-home-canary-${entry.home.computerId}`);
    const hash = createHash('sha256');
    hash.update(bytes);
    entry.sha256 = hash.digest('hex');
    entry.byteCount = bytes.length;
    if (fault === 'count') entry.byteCount++;
    if (fault === 'checksum') entry.sha256 = '0'.repeat(64);
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    const associated = [2, 'volume-export-only', 'aes-256-gcm', descriptor.binding, entry];
    cipher.setAAD(Buffer.from(JSON.stringify(associated)));
    const encrypted = Buffer.concat([nonce, cipher.update(bytes), cipher.final(), cipher.getAuthTag()]);
    await writeFile(join(path, entry.file), encrypted, { mode: 0o600 });
  }
}

async function alterHomes(path: string, fault: string) {
  const description = join(path, 'descriptor.json');
  const descriptor = volumeExportDescriptorSchema.parse(JSON.parse(await readFile(description, 'utf8')));
  const entry = descriptor.exports[1]!;
  const file = join(path, entry.file);
  if (['missing', 'empty'].includes(fault)) {
    descriptor.binding.volumes.pop();
    descriptor.exports.pop();
    await rm(file);
    if (fault === 'empty') {
      descriptor.binding.volumes = [];
      descriptor.exports = [];
      await rm(join(path, 'home-0000.enc'));
    }
  }
  if (fault === 'duplicate' || fault === 'extra') {
    const added = structuredClone(entry);
    added.file = 'home-0002.enc';
    if (fault === 'extra') {
      added.home.assistantId = 'extra';
      added.home.computerId = 'computer-extra';
    }
    descriptor.binding.volumes.push(added.home);
    descriptor.exports.push(added);
  }
  if (fault === 'generation') {
    entry.home.generation++;
    descriptor.binding.volumes[1]!.generation++;
  }
  if (fault === 'sandbox') {
    entry.home.sandbox.uid = 'replaced';
    descriptor.binding.volumes[1]!.sandbox.uid = 'replaced';
  }
  if (fault === 'attempt' || fault === 'silo') descriptor.binding[fault] = 'other';
  if (fault === 'archive') descriptor.binding.eventArchiveSha256 = '0'.repeat(64);
  if (fault === 'event-description') descriptor.binding.eventDescriptorSha256 = '0'.repeat(64);
  // Re-authenticate edited metadata so coverage and event checks must stand on their own.
  let key = await readFile(options.backupKeyFile);
  if (fault === 'material') key = randomBytes(32);
  await encryptHomes(path, descriptor, key, fault);
  await writeFile(description, JSON.stringify(descriptor));
  if (fault === 'missing-file') await rm(file);
  if (fault === 'extra-file') await writeFile(join(path, 'home-0999.enc'), 'unused');
  if (fault === 'swapped') {
    const first = join(path, 'home-0000.enc');
    const saved = await readFile(first);
    await writeFile(first, await readFile(file));
    await writeFile(file, saved);
  }
  if (['tag', 'truncated', 'oversized'].includes(fault)) {
    const bytes = await readFile(file);
    if (fault === 'tag') bytes[bytes.length - 1]! ^= 1;
    await writeFile(file, bytes);
    if (fault === 'truncated') fs.truncateSync(file, bytes.length - 1);
    if (fault === 'oversized') fs.truncateSync(file, 64 * 1024 * 1024 + 29);
  }
  if (fault === 'symlink') {
    await rm(file);
    await symlink(join(options.volumeDirectory, entry.file), file);
  }
}
const homeFaults = ['missing', 'empty', 'extra', 'duplicate', 'generation', 'sandbox',
  'attempt', 'silo', 'archive', 'event-description', 'material', 'checksum', 'count',
  'missing-file', 'extra-file', 'swapped', 'tag', 'truncated', 'oversized', 'symlink'];
async function refusesBadHome(fault: string) {
  const setup = await fixture();
  const volumeDirectory = join(directory, `homes-${fault}`);
  await cp(options.volumeDirectory, volumeDirectory, { recursive: true });
  await alterHomes(volumeDirectory, fault);
  const logs = vi.spyOn(console, 'log');
  const errors = vi.spyOn(console, 'error');
  await expect(setup.restore({ volumeDirectory })).rejects.toEqual(new Error(refusal));
  await setup.untouched();
  expect(logs).not.toHaveBeenCalled();
  expect(errors).not.toHaveBeenCalled();
}
it.each(homeFaults)('refuses bad home %s without changing either target', refusesBadHome);

async function changesDuringValidation(fault: string) {
  const setup = await fixture();
  const volumeDirectory = join(directory, `changing-${fault}`);
  await cp(options.volumeDirectory, volumeDirectory, { recursive: true });
  const controller = new AbortController();
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  let now = 0;
  function clock() { return now; }
  vi.spyOn(performance, 'now').mockImplementation(clock);
  let changed = false;
  function opening(...args: Parameters<typeof fs.openSync>) {
    const result = actual.openSync(...args);
    if (fault === 'deadline' && args[0] === join(options.directory, 'descriptor.json')) {
      now = 30_000;
    }
    if (args[0] !== join(volumeDirectory, 'home-0001.enc') || changed) return result;
    changed = true;
    if (fault === 'cancel') controller.abort(new Error('private-home-canary'));
    if (fault === 'deadline') now = 60_000;
    if (fault === 'descriptor') {
      actual.appendFileSync(join(volumeDirectory, 'descriptor.json'), '\n');
    }
    if (fault === 'replacement') {
      const file = join(volumeDirectory, 'home-0000.enc');
      const saved = actual.readFileSync(file);
      actual.renameSync(file, join(directory, 'replaced-home'));
      actual.writeFileSync(file, saved, { mode: 0o600 });
    }
    return result;
  }
  vi.mocked(fs.openSync).mockImplementation(opening);
  function reset() { vi.mocked(fs.openSync).mockReset(); }
  onTestFinished(reset);
  await expect(setup.restore({ volumeDirectory, signal: controller.signal }))
    .rejects.toEqual(new Error(refusal));
  expect(changed).toBe(true);
  await setup.untouched();
}
it.each(['descriptor', 'replacement', 'deadline', 'cancel'])(
  'refuses %s during home validation before mutation', changesDuringValidation);

const faults = ['missing-events', 'missing-objects', 'corrupt-events', 'corrupt-objects',
  'archive', 'missing-archive', 'missing-ciphertext', 'mixed-events', 'mixed-objects', 'mode', 'ciphertext', 'source', 'target',
  'stopped', 'effectsDisabled', 'disposable', 'exclusive', 'occupied-events',
  'occupied-objects', 'other-bucket', 'swapped-storage', 'lost-owner', 'foreign-events',
  'unmanaged-events', 'lost-events', 'wrong-source'] as const;
async function refusesBeforeMutation(fault: typeof faults[number]) {
  const setup = await fixture();
  const overrides: Record<string, unknown> = {};
  let path: string | undefined;
  if (fault.includes('events') && !fault.startsWith('occupied')) {
    path = join(options.eventDirectory, 'descriptor.json');
  }
  if (fault.includes('objects') && !fault.startsWith('occupied')) {
    path = join(options.directory, 'descriptor.json');
  }
  if (fault === 'archive' || fault === 'missing-archive') {
    path = join(options.eventDirectory, 'events.snapshot');
  }
  if (fault === 'mode') path = join(options.directory, 'descriptor.json');
  if (fault === 'ciphertext' || fault === 'missing-ciphertext') {
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(options.directory);
    path = join(options.directory, entries.find(isObject)!);
  }
  if (path) {
    const original = await readFile(path);
    const changedPath = path;
    async function reset() {
      await writeFile(changedPath, original, { mode: 0o600 });
      await chmod(changedPath, 0o600);
    }
    onTestFinished(reset);
    if (fault.startsWith('missing')) await rm(path);
    else if (fault.startsWith('mixed')) {
      const changed = z.record(z.string(), z.unknown()).parse(JSON.parse(original.toString()));
      changed['attempt'] = 'another';
      await writeFile(path, JSON.stringify(changed));
    } else if (fault === 'mode') await chmod(path, 0o644);
    else await writeFile(path, 'private-corruption-canary');
  }
  if (fault === 'source') overrides['silo'] = 'another';
  if (fault === 'target') overrides['targetSilo'] = 'another';
  if (['stopped', 'effectsDisabled', 'disposable', 'exclusive'].includes(fault)) {
    overrides[fault] = false;
  }
  if (fault === 'occupied-events') {
    const store = await createEventStore(setup.events.connection);
    await store.ensureStream({ replicas: 1 });
  }
  if (fault === 'occupied-objects') await setup.target.client.makeBucket('files');
  if (fault === 'other-bucket') await setup.target.client.makeBucket('other');
  if (fault === 'lost-events') await setup.events.connection.close();
  if (fault === 'lost-owner') {
    await setup.target.client.putObject('opencrane-restore', 'owner', 'foreign-marker');
  }
  if (fault === 'wrong-source') {
    const foreign = await natsFixture();
    onTestFinished(foreign.close);
    await foreign.seed([event('foreign-history')]);
    await expect(restoreRecoveryBackup(foreign.connection, setup.events.connection,
      storage.client, setup.target.client, options)).rejects.toThrow(refusal);
  } else if (fault === 'foreign-events' || fault === 'unmanaged-events') {
    let connection = source.connection;
    if (fault === 'foreign-events') {
      const foreign = await provisionRecoveryEventTarget('foreign');
      onTestFinished(foreign.close);
      connection = foreign.connection;
    }
    await expect(restoreRecoveryBackup(source.connection, connection,
      storage.client, setup.target.client, options)).rejects.toThrow(refusal);
  } else if (fault === 'swapped-storage') {
    const foreign = await provisionDisposableObjectTarget('foreign');
    onTestFinished(foreign.close);
    await expect(restoreRecoveryBackup(source.connection, setup.events.connection,
      storage.client, foreign.client, options)).rejects.toThrow(refusal);
    expect(await foreign.client.bucketExists('files')).toBe(false);
  } else {
    setup.writes.mockClear();
    setup.buckets.mockClear();
    setup.requests.mockClear();
    await expect(setup.restore(overrides)).rejects.toThrow(refusal);
  }
  if (fault === 'occupied-objects') {
    expect(setup.writes).not.toHaveBeenCalled();
    expect(setup.buckets).not.toHaveBeenCalled();
    expect(await setup.target.client.bucketExists('files')).toBe(true);
  } else await setup.untouched();
}
function isObject(name: string) { return name !== 'descriptor.json'; }
it.each(faults)('refuses %s before either target changes', refusesBeforeMutation);

async function uncertain(stage: 'native' | 'object', saved: boolean) {
  const setup = await fixture();
  const checked = vi.spyOn(custody, 'checkMemoryRestore');
  const request = setup.originalRequest;
  async function loseNative(...args: Parameters<typeof request>) {
    if (args[0] === '$JS.API.STREAM.RESTORE.EVENTS' && !saved) throw new Error('private-canary');
    const reply = await request(...args);
    if (args[0].startsWith('$JS.SNAPSHOT.RESTORE.') && !args[1]?.length) {
      throw new Error('private-canary');
    }
    return reply;
  }
  const put = setup.originalPut;
  async function loseObject(...args: Parameters<typeof put>): Promise<never> {
    if (saved) await put(...args);
    throw new Error('private-canary');
  }
  if (stage === 'native') setup.requests.mockImplementation(loseNative);
  else setup.writes.mockImplementation(loseObject);
  await expect(setup.restore()).rejects.toThrow(refusal);
  if (stage === 'native') {
    expect(setup.buckets).not.toHaveBeenCalled();
    expect(setup.requests).toHaveBeenCalledWith('$JS.API.STREAM.RESTORE.EVENTS',
      expect.any(String), expect.any(Object));
    if (saved) {
      const reader = await createEventStore(setup.events.connection);
      expect(await reader.head()).toBe(await source.reader.head());
    }
  } else {
    expect(await setup.target.client.bucketExists('files')).toBe(true);
    expect(setup.writes).toHaveBeenCalledTimes(1);
    if (saved) {
      const restored = await setup.target.client.statObject('files', uploads[0]!.data.objectKey);
      expect(restored.size).toBe(uploads[0]!.bytes.length);
    }
    const descriptor = descriptorSchema.parse(JSON.parse(
      await readFile(join(options.eventDirectory, 'descriptor.json'), 'utf8')));
    const reader = await createEventStore(setup.events.connection);
    expect(await reader.head()).toBe(descriptor.lastSequence);
  }
  await expect(setup.restore()).rejects.toThrow(refusal);
  expect(checked).not.toHaveBeenCalled();
  for (const [subject] of setup.requests.mock.calls) expect(subject).not.toMatch(/DELETE|PURGE/);
}
async function nativeFailure() { await uncertain('native', false); }
async function nativeUncertainty() { await uncertain('native', true); }
async function objectFailure() { await uncertain('object', false); }
async function objectUncertainty() { await uncertain('object', true); }
it('native failure prevents object restore', nativeFailure);
it('native uncertainty prevents object restore', nativeUncertainty);
it('object failure keeps restored events isolated', objectFailure);
it('object uncertainty leaves bytes intact and refuses retry', objectUncertainty);

async function cancelsTransfer(deadline: boolean) {
  const setup = await fixture();
  const stalled = await stalledStorage('headers');
  onTestFinished(stalled.close);
  const controller = new AbortController();
  const nativeRestore = vi.spyOn(native, 'restoreEventBackup');
  const objectRestore = vi.spyOn(objects, 'restoreObjectBackup');
  type Get = typeof setup.target.client.getObjectBounded;
  function stall(...args: Parameters<Get>) {
    return stalled.client.getObjectBounded('files', 'fixture', args[2]);
  }
  vi.spyOn(setup.target.client, 'getObjectBounded').mockImplementation(stall);
  const timeoutMs = 3_000;
  const started = performance.now();
  const pending = setup.restore({ signal: controller.signal, timeoutMs });
  const rejected = expect(pending).rejects.toEqual(new Error(refusal));
  function transferring() { return stalled.requests() >= 2; }
  await until(transferring, 2_500);
  if (!deadline) controller.abort();
  await rejected;
  await until(stalled.closed, 1_000);
  expect(stalled.closed()).toBe(true);
  expect(setup.events.connection.isClosed()).toBe(true);
  expect(performance.now() - started).toBeLessThan(4_000);
  expect(nativeRestore.mock.calls[0]![2].signal).toBe(objectRestore.mock.calls[0]![3].signal);
  expect(setup.writes).toHaveBeenCalledTimes(1);
  expect(await setup.target.client.bucketExists('files')).toBe(true);
  await expect(setup.restore()).rejects.toThrow(refusal);
}
async function cancellation() { await cancelsTransfer(false); }
async function deadline() { await cancelsTransfer(true); }
it('cancellation closes the active object transfer and NATS connection', cancellation);
it('one deadline covers both restore stages and closes transfers', deadline);
