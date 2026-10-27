import { randomBytes } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { expect, onTestFinished, vi, type MockInstance } from 'vitest';
import { natsFixture } from '@opencrane/event-store/testing';
import { recoveryHomes } from '../../apps/server/test/support/recovery-homes.ts';
import { collectBackupCapture } from './backup-capture.ts';
import { descriptorSchema } from './event-backup.ts';
import { volumeExportDescriptorSchema } from './computer-volume-export.ts';

type Source = Awaited<ReturnType<typeof natsFixture>>;
type Storage = Parameters<typeof collectBackupCapture>[3];

export async function recoveryCapture(source: Source, objects: Storage,
  directory: string, fault: string) {
  const homes = await recoveryHomes(source, ['one', 'two']);
  const objectReader = await natsFixture({ provision: false });
  onTestFinished(objectReader.close);
  const homeReader = await natsFixture({ provision: false });
  onTestFinished(homeReader.close);
  const backupKeyFile = join(directory, 'file-key');
  await writeFile(backupKeyFile, randomBytes(32), { mode: 0o600 });
  const destination = join(directory, 'capture');
  const eventDirectory = join(destination, 'events');
  const volumeDirectory = join(destination, 'homes');
  const directories = { eventDirectory, volumeDirectory, backupKeyFile,
    directory: join(destination, 'objects') };
  const controller = new AbortController();
  const options = { destination, backupKeyFile, silo: 'test', attempt: 'before-upgrade',
    writersStopped: true, disposable: true, namespace: 'owned', namespaceUid: 'owned',
    kubeconfig: '/synthetic', context: 'owned', signal: controller.signal, timeoutMs: 60_000 };

  async function capture() {
    const streams: Readable[] = [];
    const signals: AbortSignal[] = [];
    const get = objects.getObjectBounded.bind(objects);
    let clock: MockInstance<typeof performance.now> | undefined;
    if (fault === 'capture-deadline') {
      clock = vi.spyOn(performance, 'now');
      clock.mockReturnValue(0);
    }
    async function readObject(...args: Parameters<typeof get>) {
      const stream = await get(...args);
      signals.push(args[2].signal);
      streams.push(stream);
      clock?.mockReturnValue(40_000);
      return stream;
    }
    async function readHome(...args: Parameters<typeof homes.contents>) {
      const input = await homes.contents(...args);
      signals.push(args[1]);
      streams.push(input.stream);
      clock?.mockReturnValue(60_001);
      if (input.home.computerId === 'computer-two') {
        if (fault === 'copy-corrupt') {
          await writeFile(join(volumeDirectory, 'home-0000.enc'), Buffer.alloc(16));
        }
        if (fault === 'writer-resumed') {
          options.writersStopped = false;
        }
        if (fault === 'capture-cancelled') {
          controller.abort(new Error('private-capture-canary'));
        }
      }
      return input;
    }
    const reading = vi.spyOn(objects, 'getObjectBounded');
    reading.mockImplementation(readObject);
    try {
      await collectBackupCapture(source.connection, objectReader.connection, homeReader.connection,
        objects, options, readHome, homes.read);
    } finally {
      reading.mockRestore();
      clock?.mockRestore();
      const expectedStreams = fault === 'capture-deadline' ? 3 : 4;
      expect(streams).toHaveLength(expectedStreams);
      for (const stream of streams) {
        expect(stream.destroyed).toBe(true);
      }
      for (const signal of signals) {
        expect(signal.aborted).toBe(true);
      }
    }
  }
  async function collect() {
    await capture();
    const descriptorPath = join(eventDirectory, 'descriptor.json');
    const saved = await readFile(descriptorPath, 'utf8');
    const descriptor = descriptorSchema.parse(JSON.parse(saved));
    if (fault === 'corrupt') {
      const archivePath = join(eventDirectory, 'events.snapshot');
      const archive = await readFile(archivePath);
      await writeFile(archivePath, archive.subarray(0, -1));
    }
    if (fault === 'mixed') {
      const mixed = { ...descriptor, attempt: 'different-attempt' };
      await writeFile(descriptorPath, JSON.stringify(mixed));
    }
    if (fault === 'incomplete-homes') {
      const path = join(volumeDirectory, 'descriptor.json');
      const savedHomes = await readFile(path, 'utf8');
      const description = volumeExportDescriptorSchema.parse(JSON.parse(savedHomes));
      const missing = description.exports.pop()!;
      description.binding.volumes.pop();
      await rm(join(volumeDirectory, missing.file));
      await writeFile(path, JSON.stringify(description));
    }
    if (fault === 'home-one' || fault === 'home-two') {
      const file = fault === 'home-one' ? 'home-0000.enc' : 'home-0001.enc';
      const path = join(volumeDirectory, file);
      const bytes = await readFile(path);
      bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
      await writeFile(path, bytes);
    }
    return { descriptor };
  }
  return { collect, directories };
}
