import { createDecipheriv, createHash } from 'node:crypto';
import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import type { NatsConnection } from '@nats-io/transport-node';
import type { z } from 'zod';
import { volumeExportDescriptorSchema } from './computer-volume-export.ts';
import { requiredComputers } from './computer-volume-inventory.ts';
import { type captureBounds, descriptorSchema } from './event-backup.ts';
import { checkHistory, readBackupKey, readPrivateFile } from './event-restore.ts';

type Bounds = ReturnType<typeof captureBounds>;
type Descriptor = z.infer<typeof volumeExportDescriptorSchema>;
type Delivery = (descriptor: Descriptor, plaintext: Buffer[], recheck: () => Promise<void>)
  => Promise<void>;
interface Options {
  eventDirectory: string;
  volumeDirectory: string;
  backupKeyFile: string;
  silo: string;
  attempt: string;
}
const maximumBytes = 64 * 1024 * 1024;
function refusal() {
  return new Error('Computer volume validation refused');
}
function digest(bytes: Buffer) {
  const hash = createHash('sha256');
  hash.update(bytes);
  return hash.digest('hex');
}

function fileIdentity(path: string, directory: boolean) {
  const info = lstatSync(path, { bigint: true });
  const mode = directory ? 0o700n : 0o600n;
  const correctType = directory ? info.isDirectory() : info.isFile();
  if (path !== resolve(path) || realpathSync(path) !== path || !correctType ||
      info.uid !== BigInt(process.getuid!()) || (info.mode & 0o777n) !== mode) throw refusal();
  return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs, info.mode, info.uid];
}

function privateInputs(options: Options) {
  const initial = new Map<string, { directory: boolean; identity: bigint[] }>();
  function remember(path: string, directory = false) {
    const identity = fileIdentity(path, directory);
    initial.set(path, { directory, identity });
  }
  function unchanged() {
    for (const [path, saved] of initial) {
      const current = fileIdentity(path, saved.directory);
      if (!isDeepStrictEqual(current, saved.identity)) throw refusal();
    }
  }
  remember(options.eventDirectory, true);
  remember(options.volumeDirectory, true);
  remember(options.backupKeyFile);
  remember(join(options.eventDirectory, 'descriptor.json'));
  remember(join(options.eventDirectory, 'events.snapshot'));
  remember(join(options.volumeDirectory, 'descriptor.json'));
  return { remember, unchanged };
}

function checkComputers(descriptor: Descriptor, required: ReturnType<typeof requiredComputers>) {
  if (required.computers.size !== descriptor.binding.volumes.length) throw refusal();
  for (const home of descriptor.binding.volumes) {
    const computer = required.computers.get(home.assistantId);
    if (!computer || computer.computerId !== home.computerId ||
        computer.generation !== home.generation || computer.sandboxUid !== home.sandbox.uid ||
        home.sandbox.name !== home.computerId || home.home.name !== `home-${home.computerId}`) {
      throw refusal();
    }
    required.computers.delete(home.assistantId);
  }
}

async function authenticate(directory: string, descriptor: Descriptor,
  entry: Descriptor['exports'][number], key: Buffer, bounds: Bounds, output?: Buffer) {
  bounds.check();
  const bytes = readPrivateFile(join(directory, entry.file), entry.byteCount + 28);
  if (bytes.length !== entry.byteCount + 28) throw refusal();
  const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
  const associated = [2, 'volume-export-only', 'aes-256-gcm', descriptor.binding, entry];
  decipher.setAAD(Buffer.from(JSON.stringify(associated)));
  decipher.setAuthTag(bytes.subarray(-16));
  const hash = createHash('sha256');
  let byteCount = 0;
  function count(plaintext: Buffer) {
    try {
      byteCount += plaintext.length;
      if (byteCount > entry.byteCount) throw refusal();
      hash.update(plaintext);
      if (output) plaintext.copy(output, byteCount - plaintext.length);
    } finally {
      // Erase each chunk even when a later authentication tag fails.
      plaintext.fill(0);
    }
  }
  for (let offset = 12; offset < bytes.length - 16; offset += 32 * 1024) {
    bounds.check();
    const end = Math.min(offset + 32 * 1024, bytes.length - 16);
    count(decipher.update(bytes.subarray(offset, end)));
    await bounds.bounded(setImmediate());
  }
  count(decipher.final());
  if (byteCount !== entry.byteCount || hash.digest('hex') !== entry.sha256) throw refusal();
}

/** Check every home before recovery writes anything, using the caller's original time limit. */
export async function checkComputerVolumeBackup(source: NatsConnection, options: Options,
  bounds: Bounds, deliver?: Delivery): Promise<void> {
  const plaintext: Buffer[] = [];
  let key: Buffer | undefined;
  try {
    bounds.check();
    const inputs = privateInputs(options);
    const saved = readPrivateFile(join(options.eventDirectory, 'descriptor.json'), 1024 * 1024);
    const events = descriptorSchema.parse(JSON.parse(saved.toString('utf8')));
    const archive = readPrivateFile(join(options.eventDirectory, 'events.snapshot'), maximumBytes);
    const path = join(options.volumeDirectory, 'descriptor.json');
    const original = readPrivateFile(path, 2 * 1024 * 1024);
    const descriptor = volumeExportDescriptorSchema.parse(JSON.parse(original.toString('utf8')));
    const binding = descriptor.binding;
    if (events.silo !== options.silo || events.attempt !== options.attempt ||
        binding.silo !== options.silo || binding.attempt !== options.attempt ||
        binding.eventDescriptorSha256 !== digest(saved) ||
        binding.eventArchiveSha256 !== events.sha256 || archive.length !== events.byteCount ||
        digest(archive) !== events.sha256) throw refusal();
    const expectedFiles = ['descriptor.json'];
    for (const entry of descriptor.exports) {
      inputs.remember(join(options.volumeDirectory, entry.file));
      expectedFiles.push(entry.file);
    }
    const files = readdirSync(options.volumeDirectory);
    if (!isDeepStrictEqual(files.sort(), expectedFiles.sort())) throw refusal();
    key = readBackupKey(options.backupKeyFile);
    async function request(subject: string, input: unknown) {
      bounds.check();
      const reply = await bounds.bounded(source.request(subject, JSON.stringify(input),
        { timeout: 2_000 }));
      if (reply.headers?.hasError || reply.data.length > 1024 * 1024) throw refusal();
      return reply.json<unknown>();
    }
    const sourceBounds = { ...bounds, request };
    const required = requiredComputers();
    await checkHistory(sourceBounds, events, maximumBytes, required.visit);
    checkComputers(descriptor, required);
    inputs.unchanged();
    for (const entry of descriptor.exports) {
      let output: Buffer | undefined;
      if (deliver) {
        output = Buffer.alloc(entry.byteCount);
        plaintext.push(output);
      }
      await authenticate(options.volumeDirectory, descriptor, entry, key, bounds, output);
    }
    async function recheck() {
      await checkHistory(sourceBounds, events, maximumBytes);
      inputs.unchanged();
      const current = readPrivateFile(path, 2 * 1024 * 1024);
      if (!current.equals(original)) throw refusal();
      inputs.unchanged();
      bounds.check();
    }
    await recheck();
    // Keep ownership of these buffers until delivery settles, including cancellation.
    if (deliver) await deliver(descriptor, plaintext, recheck);
    bounds.check();
  } catch {
    throw refusal();
  } finally {
    key?.fill(0);
    for (const bytes of plaintext) bytes.fill(0);
  }
}
