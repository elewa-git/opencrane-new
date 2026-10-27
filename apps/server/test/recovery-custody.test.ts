import { z } from 'zod';
import { recoveryHomes } from './support/recovery-homes.ts';
import { createHash, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it, onTestFinished, vi } from 'vitest';
import { event, natsFixture } from '@opencrane/event-store/testing';
import type { EventEnvelope, MemoryIdentity } from '@opencrane/events';
import * as projections from '@opencrane/projections';
import { HandlerRuntime } from '@opencrane/handlers';
import { until } from '@opencrane/authz/testing';
import { collectEventBackup } from '../../../infra/package/event-backup.ts';
import { collectObjectBackup } from '../../../infra/package/object-backup.ts';
import { provisionRecoveryEventTarget } from '../../../infra/package/recovery-event-target.ts';
import { provisionDisposableObjectTarget } from '../../../infra/package/disposable-object-target.ts';
import { restoreRecoveryBackup } from '../../../infra/package/recovery-restore.ts';
import * as custody from '../../../infra/package/memory-restore-check.ts';
import * as native from '../../../infra/package/event-restore.ts';
import * as objects from '../../../infra/package/object-restore.ts';
import { seedRecoveryFiles } from '../../../infra/package/upgrade-recovery-files-fixture.ts';
import { recoveryEffectProbes } from '../../../infra/package/upgrade-recovery-files-effects.ts';
import { restoreStorage } from './support/restore-storage.ts';

let directory: string;
let frozen: Awaited<ReturnType<typeof natsFixture>>;
let current: Awaited<ReturnType<typeof natsFixture>>;
let storage: Awaited<ReturnType<typeof restoreStorage>>;
let options: Omit<Parameters<typeof restoreRecoveryBackup>[4], 'memory'>;
const keys = projections.memoryKeys;
const identities = new Map<string, MemoryIdentity>();
const references = new Map<string, string>();
const values = new Map<string, { keyId: string; ciphertext: string }>();
const refused = new Error('Recovery restore refused; keep both targets isolated');

function fact(memoryId: string, dependsOn: string[] = []): EventEnvelope {
  const scopeId = projections.memoryScopeId('test', 'person', 'alice');
  const identity: MemoryIdentity = { silo: 'test', scopeId, scopeKind: 'person',
    ownerId: 'alice', memoryId, revision: 1 };
  identities.set(memoryId, identity);
  const store = keys(join(directory, 'original'));
  references.set(memoryId, store.provision(identity).slice(4));
  const encrypted = store.encrypt(identity, `Synthetic private ${memoryId}`);
  values.set(memoryId, encrypted);
  function dependency(id: string) {
    return { scopeId, memoryId: id, revision: 1 };
  }
  const dependencies = dependsOn.map(dependency);
  const data = { schemaVersion: 1, scopeId, scopeKind: 'person', ownerId: 'alice',
    memoryId, revision: 1, kind: 'fact', pinned: false, expiresAt: null,
    sources: [{ memberId: 'alice', commandId: memoryId }], dependsOn: dependencies, ...encrypted };
  return { ...event(memoryId), subject: `scope-${scopeId}`, type: 'memory.written', data };
}

async function prepare() {
  directory = await mkdtemp(join(tmpdir(), 'recovery-custody-'));
  await mkdir(join(directory, 'original'), { mode: 0o700 });
  frozen = await natsFixture();
  current = await natsFixture();
  storage = await restoreStorage();
  await seedRecoveryFiles(frozen, storage.client);
  await frozen.seed([fact('healthy'), fact('survivor'), fact('forgotten'),
    fact('derived', ['forgotten'])]);
  await cp(join(directory, 'original'), join(directory, 'stale'), { recursive: true });
  for (let sequence = 1; sequence <= await frozen.reader.head(); sequence++) {
    const stored = await frozen.reader.readEvent(sequence);
    await current.seed([stored.event]);
  }
  const root = identities.get('forgotten')!;
  const { silo: _silo, ...fields } = root;
  const data = { schemaVersion: 1, ...fields, expectedRevision: 1, revision: 2 };
  await current.seed([{ ...event('forget'), subject: `scope-${root.scopeId}`,
    type: 'memory.forgotten', data }]);
  const store = keys(join(directory, 'original'));
  for (const name of ['forgotten', 'derived']) {
    const identity = identities.get(name)!;
    store.delete(identity);
    const next = { ...identity, revision: 2 };
    references.set(`${name}-next`, store.provision(next).slice(4));
    store.delete(next);
  }
  const orphan = { ...root, memoryId: 'unpublished' };
  references.set('orphan', store.provision(orphan).slice(4));
  store.delete(orphan);
  const collectHomes = await recoveryHomes(frozen, []);
  const volumeDirectory = join(directory, 'homes');
  const eventDirectory = join(directory, 'events');
  const objectDirectory = join(directory, 'objects');
  const backupKeyFile = join(directory, 'backup-key');
  await writeFile(backupKeyFile, randomBytes(32), { mode: 0o600 });
  await collectEventBackup(frozen.connection,
    { silo: 'test', attempt: 'old', destination: eventDirectory });
  const scratch = await natsFixture({ provision: false });
  try {
    await collectObjectBackup(frozen.connection, scratch.connection, storage.client,
      { directory: eventDirectory, destination: objectDirectory, backupKeyFile,
        silo: 'test', attempt: 'old', writersStopped: true, disposable: true });
  } finally {
    await scratch.close();
  }
  options = { volumeDirectory, directory: objectDirectory, eventDirectory, backupKeyFile, silo: 'test',
    targetSilo: 'test', attempt: 'old', stopped: true, exclusive: true, disposable: true,
    effectsDisabled: true };
  await collectHomes({ ...options, volumeDirectory });
}
beforeAll(prepare, 120_000);
async function cleanup() {
  await current?.close();
  await frozen?.close();
  await storage?.close();
  if (directory) {
    await rm(directory, { recursive: true, force: true });
  }
}
afterAll(cleanup);

async function inventory(path: string) {
  const result: Record<string, string> = {};
  const names = await readdir(path);
  for (const name of names) {
    result[name] = digest(await readFile(join(path, name)));
  }
  return result;
}

function digest(bytes: Buffer) {
  const hash = createHash('sha256');
  hash.update(bytes);
  return hash.digest('hex');
}

async function fixture(fault?: string) {
  const target = await provisionRecoveryEventTarget('test');
  onTestFinished(target.close);
  const objectTarget = await provisionDisposableObjectTarget('test');
  onTestFinished(objectTarget.close);
  onTestFinished(restoreMocks);
  const sourceDirectory = join(directory, 'current');
  const candidateDirectory = join(directory, 'candidate');
  for (const path of [sourceDirectory, candidateDirectory]) {
    await rm(path, { recursive: true, force: true });
    await cp(join(directory, 'original'), path, { recursive: true });
  }
  const memory = { source: current.connection, sourceDirectory, candidateDirectory };
  const effects = recoveryEffectProbes();
  const probes = [vi.spyOn(projections, 'connectProjectionDb'),
    vi.spyOn(projections.ProjectionRunner.prototype, 'run'),
    vi.spyOn(HandlerRuntime.prototype, 'start')];
  function forbidden(): never {
    throw new Error('Offline activity probe');
  }
  for (const probe of probes) {
    probe.mockImplementation(forbidden);
    function exercise() {
      Reflect.apply(probe, undefined, []);
    }
    expect(exercise).toThrow('Offline activity probe');
    expect(probe).toHaveBeenCalledTimes(1);
    probe.mockClear();
  }
  const decrypt = vi.fn();
  const mutate = vi.fn(forbidden);
  function guardedKeys(path: string) {
    const store = keys(path);
    function guardedDecrypt(...args: Parameters<typeof store.decrypt>) {
      decrypt(...args);
      return store.decrypt(...args);
    }
    function status(identity: MemoryIdentity) {
      const result = store.status(identity);
      if (fault === 'inventory') {
        writeFileSync(join(candidateDirectory, 'f'.repeat(64)), Buffer.alloc(0), { mode: 0o600 });
      }
      return result;
    }
    return { ...store, status, decrypt: guardedDecrypt, provision: mutate, delete: mutate,
      discardUnpublished: mutate, encrypt: mutate };
  }
  vi.spyOn(projections, 'memoryKeys').mockImplementation(guardedKeys);
  function quiet() {
    effects();
    for (const probe of probes) {
      expect(probe).not.toHaveBeenCalled();
    }
    expect(mutate).not.toHaveBeenCalled();
  }
  onTestFinished(quiet);
  const checked = vi.spyOn(custody, 'checkMemoryRestore');
  const eventRestore = vi.spyOn(native, 'restoreEventBackup');
  const objectRestore = vi.spyOn(objects, 'restoreObjectBackup');
  const request = vi.spyOn(target.connection, 'request');
  async function restore(overrides = {}) {
    return restoreRecoveryBackup(frozen.connection, target.connection, storage.client,
      objectTarget.client, { ...options, memory, ...overrides });
  }
  return { target, objectTarget, memory, decrypt, checked, eventRestore, objectRestore,
    request, restore };
}
function restoreMocks() {
  vi.restoreAllMocks();
}

async function oldArchive() {
  const setup = await fixture();
  const before = await inventory(setup.memory.candidateDirectory);
  expect(await setup.restore()).toEqual({ kind: 'events-objects-and-custody-only' });
  expect(setup.checked).toHaveBeenCalledExactlyOnceWith(current.connection,
    setup.target.connection, { silo: 'test', sourceDirectory: setup.memory.sourceDirectory,
      candidateDirectory: setup.memory.candidateDirectory, stopped: true,
      signal: setup.eventRestore.mock.calls[0]![2].signal });
  expect(setup.checked.mock.invocationCallOrder[0])
    .toBeGreaterThan(setup.objectRestore.mock.invocationCallOrder[0]!);
  expect(setup.checked.mock.calls[0]![2].signal)
    .toBe(setup.objectRestore.mock.calls[0]![3].signal);
  expect(setup.decrypt).toHaveBeenCalledTimes(2);
  for (const name of ['forgotten', 'derived']) {
    expect(keys(setup.memory.candidateDirectory).decrypt(identities.get(name)!, values.get(name)!))
      .toBeNull();
  }
  expect(await inventory(setup.memory.candidateDirectory)).toEqual(before);
  expect(await inventory(setup.memory.sourceDirectory)).toEqual(before);
}
it('checks current custody after restoring an old archive without reviving forgotten facts', oldArchive);

const faults = ['stale', 'missing-folder', 'empty', 'missing', 'next-marker', 'orphan-marker',
  'inventory', 'wrong-silo', 'wrong-source', 'non-prefix', 'source-movement'] as const;
type Fault = typeof faults[number];
async function damageCustody(setup: Awaited<ReturnType<typeof fixture>>, fault: Fault) {
  const { sourceDirectory, candidateDirectory } = setup.memory;
  if (fault === 'stale') {
    await rm(candidateDirectory, { recursive: true });
    await cp(join(directory, 'stale'), candidateDirectory, { recursive: true });
  }
  if (fault === 'missing-folder') {
    setup.memory.candidateDirectory = join(directory, 'absent');
  }
  for (const path of [sourceDirectory, candidateDirectory]) {
    if (fault === 'empty') {
      await writeFile(join(path, references.get('survivor')!), Buffer.alloc(0));
    }
    if (fault === 'missing') {
      await rm(join(path, references.get('survivor')!));
    }
    if (fault === 'next-marker') {
      await rm(join(path, references.get('forgotten-next')!));
    }
  }
  if (fault === 'orphan-marker') {
    await rm(join(candidateDirectory, references.get('orphan')!));
  }
  if (fault === 'wrong-source') {
    setup.memory.source = setup.target.connection;
  }
}

function changeHistory(fault: Fault) {
  const originalRequest = current.connection.request.bind(current.connection);
  let reads = 0;
  let injected = 0;
  async function changed(...args: Parameters<typeof originalRequest>) {
    const reply = await originalRequest(...args);
    if (args[0] === '$JS.API.STREAM.INFO.EVENTS') {
      reads++;
    }
    const saved = z.record(z.string(), z.unknown()).parse(reply.json());
    if (fault === 'source-movement' && reads === 2) {
      saved['created'] = '2000-01-01T00:00:00.000Z';
      injected++;
    }
    if ((fault === 'wrong-silo' || fault === 'non-prefix') &&
        args[0] === '$JS.API.STREAM.MSG.GET.EVENTS') {
      const message = z.object({ data: z.string() }).passthrough().parse(saved['message']);
      const raw: unknown = JSON.parse(Buffer.from(message.data, 'base64').toString());
      const envelope = z.record(z.string(), z.unknown()).parse(raw);
      if (fault === 'wrong-silo') {
        envelope['silo'] = 'foreign';
      } else {
        envelope['id'] = 'different';
      }
      message.data = Buffer.from(JSON.stringify(envelope)).toString('base64');
      saved['message'] = message;
      injected++;
    }
    vi.spyOn(reply, 'json').mockReturnValue(saved);
    return reply;
  }
  vi.spyOn(current.connection, 'request').mockImplementation(changed);
  function assertInjection() {
    if (['wrong-silo', 'non-prefix', 'source-movement'].includes(fault)) {
      expect(injected).toBeGreaterThan(0);
    }
  }
  return assertInjection;
}

async function invalid(fault: Fault) {
  const setup = await fixture(fault);
  const { sourceDirectory, candidateDirectory } = setup.memory;
  await damageCustody(setup, fault);
  const assertInjection = changeHistory(fault);
  const before = await inventory(sourceDirectory);
  const candidateBefore = await inventory(candidateDirectory);
  if (fault === 'inventory') {
    candidateBefore['f'.repeat(64)] = digest(Buffer.alloc(0));
  }
  await expect(setup.restore()).rejects.toEqual(refused);
  expect(setup.checked).toHaveBeenCalledOnce();
  assertInjection();
  expect(setup.decrypt).not.toHaveBeenCalled();
  expect(await inventory(sourceDirectory)).toEqual(before);
  expect(await inventory(candidateDirectory)).toEqual(candidateBefore);
  expect(await setup.objectTarget.client.bucketExists('files')).toBe(true);
  for (const [subject] of setup.request.mock.calls) {
    expect(subject).not.toMatch(/DELETE|PURGE/);
  }
  await expect(setup.restore()).rejects.toEqual(refused);
  expect(setup.checked).toHaveBeenCalledOnce();
  expect(setup.eventRestore).toHaveBeenCalledOnce();
  expect(setup.objectRestore).toHaveBeenCalledOnce();
}
it.each(faults)('refuses %s before any decryption, replay or database opening', invalid);

async function wrongKey() {
  const setup = await fixture();
  for (const path of [setup.memory.sourceDirectory, setup.memory.candidateDirectory]) {
    await writeFile(join(path, references.get('survivor')!), Buffer.alloc(32, 7));
  }
  await expect(setup.restore()).rejects.toEqual(refused);
  expect(setup.decrypt).toHaveBeenCalledTimes(2);
}
it('keeps wrong-key authentication separate from custody refusals', wrongKey);

async function cancel(deadline: boolean) {
  const setup = await fixture();
  const before = await inventory(setup.memory.candidateDirectory);
  const controller = new AbortController();
  const blocked = Promise.withResolvers<never>();
  function stalled() {
    return blocked.promise;
  }
  const request = vi.spyOn(current.connection, 'request').mockImplementation(stalled);
  const started = performance.now();
  const pending = setup.restore({ signal: controller.signal, timeoutMs: 3_000 });
  const rejected = expect(pending).rejects.toEqual(refused);
  void rejected.catch(ignoreFailure);
  void blocked.promise.catch(ignoreFailure);
  function entered() {
    return request.mock.calls.length > 0;
  }
  try {
    await until(entered, 2_500);
    if (!deadline) {
      controller.abort();
    }
    await rejected;
  } finally {
    blocked.reject(new Error('Private custody path canary'));
  }
  expect(performance.now() - started).toBeLessThan(4_000);
  expect(setup.target.connection.isClosed()).toBe(true);
  expect(await inventory(setup.memory.candidateDirectory)).toEqual(before);
  expect(await inventory(setup.memory.sourceDirectory)).toEqual(before);
  expect(setup.decrypt).not.toHaveBeenCalled();
  expect(await setup.objectTarget.client.bucketExists('files')).toBe(true);
  expect(setup.checked.mock.calls[0]![2].signal)
    .toBe(setup.eventRestore.mock.calls[0]![2].signal);
  await expect(setup.restore()).rejects.toEqual(refused);
  expect(setup.checked).toHaveBeenCalledOnce();
  expect(setup.eventRestore).toHaveBeenCalledOnce();
  expect(setup.objectRestore).toHaveBeenCalledOnce();
  for (const [subject] of setup.request.mock.calls) {
    expect(subject).not.toMatch(/DELETE|PURGE/);
  }
}
it.each([false, true])('cancels custody validation with shared deadline=%s', cancel);

function ignoreFailure() {}
