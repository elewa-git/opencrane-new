import * as fs from 'node:fs';
import * as child from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, onTestFinished, vi } from 'vitest';
import { natsFixture } from '@opencrane/event-store/testing';
import { recoveryHomes } from '../../apps/server/test/support/recovery-homes.ts';
import { captureBounds, collectEventBackup } from './event-backup.ts';
import { provisionComputerHomeTarget, restoreComputerVolumeBackup }
  from './computer-volume-restore.ts';
import { volumeExportDescriptorSchema } from './computer-volume-export.ts';
import { recoveryCustody } from './upgrade-recovery-custody-fixture.ts';
import { recoveryEffectProbes } from './upgrade-recovery-files-effects.ts';
import * as custody from './memory-restore-check.ts';
import { checkComputerVolumeBackup } from './computer-volume-check.ts';

vi.mock('node:fs', { spy: true });
vi.mock('node:child_process', { spy: true });
const actualFs = await vi.importActual<typeof fs>('node:fs');

async function fixture(fault = '') {
  vi.resetAllMocks();
  const source = await natsFixture();
  onTestFinished(source.close);
  const directory = await mkdtemp(join(tmpdir(), 'restore-home-'));
  async function cleanup() {
    vi.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  }
  onTestFinished(cleanup);
  const homes = await recoveryHomes(source, ['one', 'two']);
  const custodySetup = await recoveryCustody(source, directory, fault);
  const controller = new AbortController();
  const options = { eventDirectory: join(directory, 'events'),
    volumeDirectory: join(directory, 'homes'), backupKeyFile: join(directory, 'key'),
    silo: 'test', attempt: 'copy', stopped: true, effectsDisabled: true,
    memory: custodySetup.memory };
  await writeFile(options.backupKeyFile, randomBytes(32), { mode: 0o600 });
  await collectEventBackup(source.connection,
    { silo: options.silo, attempt: options.attempt, destination: options.eventDirectory });
  await homes(options);
  await custodySetup.capture();
  const descriptionPath = join(options.volumeDirectory, 'descriptor.json');
  const description = volumeExportDescriptorSchema.parse(
    JSON.parse(await readFile(descriptionPath, 'utf8')));
  const targets: ReturnType<typeof provisionComputerHomeTarget>[] = [];
  for (const entry of description.exports) {
    const binding = { silo: options.silo, attempt: options.attempt, home: entry.home };
    if (fault === 'target-owner') binding.home.assistantId = 'foreign';
    if (fault === 'target-generation') binding.home.generation++;
    if (fault === 'target-attempt') binding.attempt = 'foreign';
    const target = provisionComputerHomeTarget(binding);
    targets.push(target);
    async function disposeTarget() {
      await rm(target.directory, { recursive: true, force: true });
    }
    onTestFinished(disposeTarget);
  }
  const bounds = captureBounds(source.connection, { signal: controller.signal });
  onTestFinished(bounds.dispose);
  const originalWrite = actualFs.writeSync;
  const writes = vi.spyOn(fs, 'writeSync');
  const opens = vi.fn();
  function open(...args: Parameters<typeof fs.openSync>) {
    if (args[1] === 'wx+') opens();
    return Reflect.apply(actualFs.openSync, fs, args) as number;
  }
  vi.spyOn(fs, 'openSync').mockImplementation(open);
  const effects = recoveryEffectProbes();
  const logs = vi.spyOn(console, 'log');
  const errors = vi.spyOn(console, 'error');
  const spawns = vi.spyOn(child, 'spawn');
  vi.clearAllMocks();
  const plaintext: Buffer[] = [];
  const allocate = Buffer.alloc;
  function remember(...args: Parameters<typeof Buffer.alloc>) {
    const bytes = allocate(...args);
    if (args[0] === 32) plaintext.push(bytes);
    return bytes;
  }
  vi.spyOn(Buffer, 'alloc').mockImplementation(remember);
  function quiet() {
    effects();
    for (const bytes of plaintext) expect(bytes.every(isZero)).toBe(true);
    expect(logs.mock.calls.length).toBe(0);
    expect(errors.mock.calls.length).toBe(0);
    expect(spawns.mock.calls.length).toBe(0);
  }
  async function restore() {
    return restoreComputerVolumeBackup(source.connection, options, targets, bounds);
  }
  return { source, options, bounds, targets, restore, writes, opens, originalWrite,
    controller, custody: custodySetup, quiet, description };
}

async function deliversOnlyAuthenticatedBytes() {
  const setup = await fixture();
  const retained: Buffer[] = [];
  function receive(_descriptor: unknown, plaintext: Buffer[]) {
    for (let index = 0; index < plaintext.length; index++) {
      const name = index === 0 ? 'one' : 'two';
      const expected = Buffer.from(`private-home-canary-computer-${name}`);
      expect(plaintext[index]!.equals(expected)).toBe(true);
    }
    retained.push(...plaintext);
    return Promise.resolve();
  }
  const deliver = vi.fn(receive);
  await checkComputerVolumeBackup(setup.source.connection, setup.options, setup.bounds, deliver);
  expect(deliver.mock.calls.length).toBe(1);
  expect(retained.length).toBe(2);
  for (const bytes of retained) expect(bytes.every(isZero)).toBe(true);
}
it('hands off both authenticated homes before erasing their plaintext', deliversOnlyAuthenticatedBytes);

const refusal = 'Computer home restore refused; keep targets isolated';
const faults = ['pre-abort', 'pre-deadline', 'missing', 'swapped', 'duplicate', 'owner', 'generation', 'attempt',
  'tag', 'occupied', 'foreign', 'target-owner', 'target-generation', 'target-attempt',
  'alias', 'changed-source', 'deadline', 'abort', 'missing-custody', 'resurrected'];

async function refusesBeforeWriting(fault: string) {
  const setup = await fixture(fault);
  const path = join(setup.options.volumeDirectory, 'descriptor.json');
  const description = volumeExportDescriptorSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  const second = description.exports[1]!;
  const secondPath = join(setup.options.volumeDirectory, second.file);
  if (fault === 'missing') {
    description.exports.pop();
    description.binding.volumes.pop();
    await rm(secondPath);
  }
  if (fault === 'duplicate') {
    second.home = description.exports[0]!.home;
    description.binding.volumes[1] = second.home;
  }
  if (fault === 'owner') {
    second.home.assistantId = 'foreign';
    description.binding.volumes[1]!.assistantId = 'foreign';
  }
  if (fault === 'generation') {
    second.home.generation++;
    description.binding.volumes[1]!.generation++;
  }
  if (fault === 'attempt') description.binding.attempt = 'foreign';
  await writeFile(path, JSON.stringify(description));
  if (fault === 'swapped') {
    const firstPath = join(setup.options.volumeDirectory, description.exports[0]!.file);
    const first = await readFile(firstPath);
    await writeFile(firstPath, await readFile(secondPath));
    await writeFile(secondPath, first);
  }
  if (fault === 'tag') {
    const bytes = await readFile(secondPath);
    bytes[bytes.length - 1]! ^= 1;
    await writeFile(secondPath, bytes);
  }
  if (fault === 'occupied') {
    await writeFile(join(setup.targets[1]!.directory, 'occupied'), 'leave intact');
  }
  if (fault === 'foreign') setup.targets[1] = { directory: setup.targets[1]!.directory };
  if (fault === 'alias') {
    await rm(setup.targets[1]!.directory, { recursive: true });
    await symlink(setup.options.volumeDirectory, setup.targets[1]!.directory);
  }
  const original = custody.checkMemoryRestore;
  async function afterValidation(...args: Parameters<typeof original>) {
    await original(...args);
    if (fault === 'changed-source') await writeFile(secondPath, 'private-change');
    if (fault === 'deadline') vi.spyOn(performance, 'now').mockReturnValue(Infinity);
    if (fault === 'abort') setup.controller.abort(new Error('private-cancellation'));
  }
  vi.spyOn(custody, 'checkMemoryRestore').mockImplementation(afterValidation);
  if (fault === 'pre-abort') setup.controller.abort(new Error('private-cancellation'));
  if (fault === 'pre-deadline') vi.spyOn(performance, 'now').mockReturnValue(Infinity);
  await expect(setup.restore()).rejects.toEqual(new Error(refusal));
  expect(setup.writes.mock.calls.length).toBe(0);
  expect(setup.opens.mock.calls.length).toBe(0);
  setup.quiet();
}
it.each(faults)('refuses %s before any home write', refusesBeforeWriting);

async function restoresRawImages() {
  const setup = await fixture();
  const proof = await setup.restore();
  expect(proof).toEqual({ kind: 'home-image-bytes-only', homes: 2, byteCount: 64 });
  for (let index = 0; index < setup.targets.length; index++) {
    const name = index === 0 ? 'one' : 'two';
    const bytes = await readFile(join(setup.targets[index]!.directory, 'home-image'));
    const expected = Buffer.from(`private-home-canary-computer-${name}`);
    expect(bytes.equals(expected)).toBe(true);
  }
  setup.custody.expectDeleted();
  expect(setup.writes.mock.calls.length).toBe(2);
  for (const [, bytes] of setup.writes.mock.calls) {
    expect(Buffer.isBuffer(bytes) && bytes.every(isZero)).toBe(true);
  }
  await expect(setup.restore()).rejects.toEqual(new Error(refusal));
  expect(setup.writes.mock.calls.length).toBe(2);
  setup.quiet();
}
it('restores two distinct raw home images once and reads back exact bytes', restoresRawImages);

async function isolatesUncertainWrite(fault: string) {
  const setup = await fixture();
  const write = setup.originalWrite;
  function cancel() {
    setup.controller.abort(new Error('private-cancellation'));
  }
  function uncertain(...args: Parameters<typeof write>) {
    if (fault === 'failed') throw new Error('private-write-failure');
    if (fault === 'short-write') {
      const bytes = args[1] as unknown as Buffer;
      return actualFs.writeSync(args[0], bytes, 0, 16, 0);
    }
    const count = Reflect.apply(write, fs, args) as number;
    if (fault === 'queued-abort') {
      setImmediate(cancel);
      return count;
    }
    if (fault === 'abort') {
      cancel();
      return count;
    }
    throw new Error('private-path-and-home-bytes');
  }
  if (fault === 'readback') {
    function damaged(...args: Parameters<typeof fs.readSync>) {
      if (setup.writes.mock.calls.length > 0 && args[0] === setup.writes.mock.calls[0]![0]) {
        return 0;
      }
      return Reflect.apply(actualFs.readSync, fs, args) as number;
    }
    vi.spyOn(fs, 'readSync').mockImplementation(damaged);
  } else {
    setup.writes.mockImplementation(uncertain);
  }
  await expect(setup.restore()).rejects.toEqual(new Error(refusal));
  expect(setup.writes.mock.calls.length).toBe(1);
  const saved = await readFile(join(setup.targets[0]!.directory, 'home-image'));
  let expectedLength = 32;
  if (fault === 'failed') expectedLength = 0;
  if (fault === 'short-write') expectedLength = 16;
  expect(saved.length).toBe(expectedLength);
  expect(await readdir(setup.targets[1]!.directory)).toEqual([]);
  for (const [, bytes] of setup.writes.mock.calls) {
    expect(Buffer.isBuffer(bytes) && bytes.every(isZero)).toBe(true);
  }
  await expect(setup.restore()).rejects.toEqual(new Error(refusal));
  expect(setup.writes.mock.calls.length).toBe(1);
  expect(setup.opens.mock.calls.length).toBe(1);
  const retained = await readFile(join(setup.targets[0]!.directory, 'home-image'));
  expect(retained.equals(saved)).toBe(true);
  const binding = { silo: setup.options.silo, attempt: setup.options.attempt,
    home: setup.description.binding.volumes[0]! };
  const fresh = provisionComputerHomeTarget(binding);
  async function cleanupFresh() {
    await rm(fresh.directory, { recursive: true, force: true });
  }
  onTestFinished(cleanupFresh);
  setup.targets[0] = fresh;
  const retryBounds = captureBounds(setup.source.connection, {});
  onTestFinished(retryBounds.dispose);
  await expect(restoreComputerVolumeBackup(setup.source.connection, setup.options,
    setup.targets, retryBounds)).rejects.toEqual(new Error(refusal));
  expect(setup.writes.mock.calls.length).toBe(1);
  expect(setup.opens.mock.calls.length).toBe(1);
  setup.quiet();
}
it.each(['failed', 'short-write', 'write', 'readback', 'abort', 'queued-abort'])('isolates an uncertain %s without a later writer',
  isolatesUncertainWrite);

function isZero(value: number) {
  return value === 0;
}
