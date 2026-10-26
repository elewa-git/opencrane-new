import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, realpathSync,
  renameSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { isDeepStrictEqual } from 'node:util';
import type { NatsConnection } from '@nats-io/transport-node';
import { fileUploadedDataSchema, type EventEnvelope } from '@opencrane/events';
import type { storageClient } from '../../apps/server/src/files/storage.ts';
import { captureBounds, descriptorSchema } from './event-backup.ts';
import { checkHistory, readBackupKey, readPrivateFile, restoreEventBackup } from './event-restore.ts';

interface Options {
  backupKeyFile: string;
  directory: string;
  destination: string;
  silo: string;
  attempt: string;
  writersStopped: boolean;
  disposable: boolean;
  signal?: AbortSignal;
  maxObjects?: number;
  maxBytes?: number;
  timeoutMs?: number;
}
interface ObjectReference {
  identity: string;
  byteCount: number;
  sha256: string;
}
type Bounds = ReturnType<typeof captureBounds>;
const maximumBytes = 64 * 1024 * 1024;

function refusal() {
  return new Error('Object backup refused');
}

function sha256(bytes: string | Buffer) {
  const hash = createHash('sha256');
  hash.update(bytes);
  return hash.digest('hex');
}

function boundedLimit(value: number | undefined, maximum: number) {
  const limit = value ?? maximum;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum) throw refusal();
  return limit;
}

function privateDirectory(path: string) {
  const metadata = lstatSync(path);
  if (path !== resolve(path) || realpathSync(path) !== path || !metadata.isDirectory() ||
      metadata.uid !== process.getuid?.() || (metadata.mode & 0o777) !== 0o700) throw refusal();
}

function objectReferences(silo: string, maxObjects: number, maxBytes: number) {
  const references = new Map<string, ObjectReference & { address: string }>();
  let byteCount = 0;
  function visit(event: EventEnvelope) {
    if (event.type !== 'file.uploaded') return;
    const file = fileUploadedDataSchema.parse(event.data);
    const address = `${silo}/${file.conversationId}/${file.fileId}/${file.sha256}`;
    if (event.silo !== silo || event.subject !== `conversation-${file.conversationId}` ||
        file.objectKey !== address) throw refusal();
    const identity = sha256(JSON.stringify([silo, file.conversationId, file.fileId]));
    const reference = { identity, byteCount: file.size, sha256: file.sha256, address };
    const previous = references.get(identity);
    if (previous) {
      if (!isDeepStrictEqual(previous, reference)) throw refusal();
      return;
    }
    byteCount += file.size;
    if (references.size >= maxObjects || byteCount > maxBytes) throw refusal();
    references.set(identity, reference);
  }
  return { references, visit };
}

async function copyObject(objects: ReturnType<typeof storageClient>, address: string,
  reference: ObjectReference, destination: string, bounds: Bounds, key: Buffer,
  signal: AbortSignal, timeoutMs: number) {
  let stream: Readable | undefined;
  let output: number | undefined;
  // Dispose of a response arriving after cancellation without writing any more bytes.
  function accept(response: Readable) {
    try {
      bounds.check();
      stream = response;
      return response;
    } catch {
      response.destroy();
      throw refusal();
    }
  }
  try {
    const requestOptions = { signal, timeoutMs };
    const pending = objects.getObjectBounded('files', address, requestOptions).then(accept);
    const response = await bounds.bounded(pending);
    output = openSync(join(destination, reference.identity), 'wx', 0o600);
    // Write only nonce, ciphertext and tag; bind each file to its archived identity and hash.
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(Buffer.from(JSON.stringify([reference.identity, reference.sha256])));
    writeBytes(output, nonce, bounds);
    const iterator = response[Symbol.asyncIterator]();
    const hash = createHash('sha256');
    let byteCount = 0;
    for (;;) {
      const next = await bounds.bounded(iterator.next());
      if (next.done) break;
      const bytes: unknown = next.value;
      if (!Buffer.isBuffer(bytes)) throw refusal();
      byteCount += bytes.length;
      if (byteCount > reference.byteCount) throw refusal();
      hash.update(bytes);
      writeBytes(output, cipher.update(bytes), bounds);
    }
    if (byteCount !== reference.byteCount || hash.digest('hex') !== reference.sha256) {
      throw refusal();
    }
    writeBytes(output, cipher.final(), bounds);
    writeBytes(output, cipher.getAuthTag(), bounds);
    bounds.check();
    fsyncSync(output);
  } finally {
    stream?.destroy();
    if (output !== undefined) closeSync(output);
  }
}

function writeBytes(output: number, bytes: Buffer, bounds: Bounds) {
  let offset = 0;
  while (offset < bytes.length) {
    bounds.check();
    const written = writeSync(output, bytes, offset);
    if (written === 0) throw refusal();
    offset += written;
  }
}

/** Keep writers stopped throughout capture. Stable event positions cannot prove that condition. */
export async function collectObjectBackup(source: NatsConnection, target: NatsConnection,
  objects: ReturnType<typeof storageClient>, options: Options): Promise<void> {
  let key: Buffer | undefined;
  let owned = false;
  let bounds: Bounds | undefined;
  let targetBounds: Bounds | undefined;
  const controller = new AbortController();
  try {
    key = readBackupKey(options.backupKeyFile);
    const timeoutMs = boundedLimit(options.timeoutMs, 60_000);
    const maxBytes = boundedLimit(options.maxBytes, maximumBytes);
    const maxObjects = boundedLimit(options.maxObjects, 1_000);
    const signals = [controller.signal, AbortSignal.timeout(timeoutMs)];
    if (options.signal) signals.push(options.signal);
    const signal = AbortSignal.any(signals);
    bounds = captureBounds(source, { signal, timeoutMs });
    targetBounds = captureBounds(target, { signal, timeoutMs });
    if (options.writersStopped !== true || options.disposable !== true ||
        options.destination !== resolve(options.destination)) throw refusal();
    privateDirectory(options.directory);
    privateDirectory(dirname(options.destination));
    bounds.check();
    mkdirSync(options.destination, { mode: 0o700 });
    owned = true;
    const restoreOptions = { directory: options.directory, silo: options.silo,
      disposable: options.disposable, timeoutMs, signal };
    const restored = await restoreEventBackup(source, target, restoreOptions);
    const { descriptor, targetDescriptor } = restored;
    if (descriptor.attempt !== options.attempt) throw refusal();
    const collected = objectReferences(options.silo, maxObjects, maxBytes);
    await checkHistory(targetBounds, targetDescriptor, maximumBytes, collected.visit);
    const entries: ObjectReference[] = [];
    for (const reference of collected.references.values()) {
      await copyObject(objects, reference.address, reference, options.destination, bounds,
        key, signal, timeoutMs);
      const { address: _address, ...entry } = reference;
      entries.push(entry);
    }
    await checkHistory(bounds, descriptor, maximumBytes);
    await checkHistory(targetBounds, targetDescriptor, maximumBytes);
    // Refuse replacement of the archive or its private description while objects were copied.
    const saved = readPrivateFile(join(options.directory, 'descriptor.json'), 1024 * 1024);
    const current = descriptorSchema.parse(JSON.parse(saved.toString('utf8')));
    const archive = readPrivateFile(join(options.directory, 'events.snapshot'), maximumBytes);
    if (!isDeepStrictEqual(current, descriptor) || archive.length !== descriptor.byteCount ||
        sha256(archive) !== descriptor.sha256) throw refusal();
    const result = { version: 2, encryption: 'aes-256-gcm',
      kind: 'event-referenced-objects-only', silo: descriptor.silo,
      attempt: descriptor.attempt, eventArchiveSha256: descriptor.sha256,
      eventDescriptorSha256: sha256(saved), objects: entries };
    bounds.check();
    writeFileSync(join(options.destination, 'descriptor.partial'), JSON.stringify(result),
      { flag: 'wx', mode: 0o600, flush: true });
    bounds.check();
    targetBounds.check();
    // Publish only after every object has passed its count, hash and disk flush.
    renameSync(join(options.destination, 'descriptor.partial'),
      join(options.destination, 'descriptor.json'));
  } catch {
    if (owned) {
      try {
        rmSync(options.destination, { recursive: true, force: true });
      } catch {
        // Withhold private paths even when cleanup fails.
      }
    }
    throw refusal();
  } finally {
    key?.fill(0);
    controller.abort();
    bounds?.dispose();
    targetBounds?.dispose();
  }
}
