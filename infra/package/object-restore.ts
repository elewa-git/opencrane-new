import { createHash } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { isDeepStrictEqual } from 'node:util';
import type { NatsConnection } from '@nats-io/transport-node';
import { fileUploadedDataSchema, type EventEnvelope } from '@opencrane/events';
import { z } from 'zod';
import type { storageClient } from '../../apps/server/src/files/storage.ts';
import { captureBounds, descriptorSchema } from './event-backup.ts';
import { claimDisposableObjectTarget } from './disposable-object-target.ts';
import { checkHistory, readBackupKey, readBackupObject, readPrivateFile,
  type restoreEventBackup } from './event-restore.ts';

type Storage = ReturnType<typeof storageClient>;
type Bounds = ReturnType<typeof captureBounds>;
interface Options {
  directory: string;
  eventDirectory: string;
  backupKeyFile: string;
  silo: string;
  attempt: string;
  targetSilo: string;
  stopped: boolean;
  exclusive: boolean;
  disposable: boolean;
  proof: Awaited<ReturnType<typeof restoreEventBackup>>;
  signal?: AbortSignal;
  timeoutMs?: number;
}
const maximumBytes = 64 * 1024 * 1024;
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const referenceSchema = z.object({ identity: hashSchema, sha256: hashSchema,
  byteCount: z.number().int().min(0).max(maximumBytes) }).strict();
const objectSchema = z.object({ version: z.literal(2), encryption: z.literal('aes-256-gcm'),
  kind: z.literal('event-referenced-objects-only'), silo: z.string(), attempt: z.string(),
  eventArchiveSha256: hashSchema, eventDescriptorSha256: hashSchema,
  objects: z.array(referenceSchema).max(1_000) }).strict();

function refusal() {
  return new Error('Object restore refused; keep target isolated');
}
function digest(bytes: Buffer | string) {
  const hash = createHash('sha256');
  hash.update(bytes);
  return hash.digest('hex');
}
function privateDirectory(path: string) {
  const info = lstatSync(path);
  if (path !== resolve(path) || realpathSync(path) !== path || !info.isDirectory() ||
      info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700) throw refusal();
}

function readDescription(options: Options) {
  privateDirectory(options.directory);
  privateDirectory(options.eventDirectory);
  if (options.backupKeyFile !== realpathSync(options.backupKeyFile)) throw refusal();
  const key = readBackupKey(options.backupKeyFile);
  key.fill(0);
  const saved = readPrivateFile(join(options.eventDirectory, 'descriptor.json'), 1024 * 1024);
  const descriptor = descriptorSchema.parse(JSON.parse(saved.toString('utf8')));
  const archive = readPrivateFile(join(options.eventDirectory, 'events.snapshot'), maximumBytes);
  const description = readPrivateFile(join(options.directory, 'descriptor.json'), 1024 * 1024);
  const objects = objectSchema.parse(JSON.parse(description.toString('utf8')));
  const targetDescriptor = { ...descriptor, created: options.proof.targetDescriptor.created };
  if (!isDeepStrictEqual(descriptor, options.proof.descriptor) ||
      !isDeepStrictEqual(targetDescriptor, options.proof.targetDescriptor) ||
      descriptor.silo !== options.silo || descriptor.attempt !== options.attempt ||
      objects.silo !== options.silo || objects.attempt !== options.attempt ||
      objects.eventDescriptorSha256 !== digest(saved) ||
      archive.length !== descriptor.byteCount || digest(archive) !== descriptor.sha256 ||
      objects.eventArchiveSha256 !== descriptor.sha256) throw refusal();
  return objects;
}

async function prepareObjects(bounds: Bounds, options: Options) {
  const description = readDescription(options);
  const references = new Map<string, z.infer<typeof referenceSchema> &
    { address: string; mime: string }>();
  function visit(event: EventEnvelope) {
    if (event.type !== 'file.uploaded') return;
    const file = fileUploadedDataSchema.parse(event.data);
    const address = `${options.silo}/${file.conversationId}/${file.fileId}/${file.sha256}`;
    if (event.silo !== options.silo || event.subject !== `conversation-${file.conversationId}` ||
        file.objectKey !== address) throw refusal();
    const identity = digest(JSON.stringify([options.silo, file.conversationId, file.fileId]));
    const reference = { identity, byteCount: file.size, sha256: file.sha256,
      address, mime: file.mime };
    const previous = references.get(identity);
    if (previous && !isDeepStrictEqual(previous, reference)) throw refusal();
    references.set(identity, reference);
    if (references.size > 1_000) throw refusal();
  }
  await checkHistory(bounds, options.proof.targetDescriptor, maximumBytes, visit);
  if (references.size !== description.objects.length) throw refusal();
  const prepared: { address: string; mime: string; bytes: Buffer; sha256: string }[] = [];
  let byteCount = 0;
  try {
    for (const entry of description.objects) {
      bounds.check();
      const reference = references.get(entry.identity);
      if (!reference || reference.byteCount !== entry.byteCount ||
          reference.sha256 !== entry.sha256) throw refusal();
      references.delete(entry.identity);
      byteCount += entry.byteCount;
      if (byteCount > maximumBytes) throw refusal();
      const bytes = readBackupObject(options.directory, options.backupKeyFile, entry);
      prepared.push({ address: reference.address, mime: reference.mime, bytes,
        sha256: entry.sha256 });
    }
    return prepared;
  } catch {
    for (const object of prepared) object.bytes.fill(0);
    throw refusal();
  }
}

async function verifyObject(target: Storage, object: Awaited<ReturnType<typeof prepareObjects>>[number],
  bounds: Bounds, signal: AbortSignal, timeoutMs: number) {
  let stream: Readable | undefined;
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
    bounds.check();
    const metadata = await bounds.bounded(target.statObject('files', object.address));
    if (metadata.metaData['content-type'] !== object.mime ||
        metadata.size !== object.bytes.length) throw refusal();
    const pending = target.getObjectBounded('files', object.address, { signal, timeoutMs });
    const response = await bounds.bounded(pending.then(accept));
    const iterator = response[Symbol.asyncIterator]();
    const hash = createHash('sha256');
    let byteCount = 0;
    for (;;) {
      const next = await bounds.bounded(iterator.next());
      if (next.done) break;
      const bytes: unknown = next.value;
      if (!Buffer.isBuffer(bytes)) throw refusal();
      byteCount += bytes.length;
      if (byteCount > object.bytes.length) throw refusal();
      hash.update(bytes);
    }
    if (byteCount !== object.bytes.length || hash.digest('hex') !== object.sha256) throw refusal();
  } finally {
    stream?.destroy();
  }
}

/** Copy files only after native event restore; leave every uncertain target isolated and intact. */
export async function restoreObjectBackup(events: NatsConnection, source: Storage,
  target: Storage, options: Options): Promise<void> {
  const controller = new AbortController();
  let bounds: Bounds | undefined;
  let prepared: Awaited<ReturnType<typeof prepareObjects>> = [];
  try {
    const timeoutMs = options.timeoutMs ?? 60_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000 ||
        options.stopped !== true || options.exclusive !== true || options.disposable !== true ||
        options.targetSilo !== options.silo || source.endpoint === target.endpoint) throw refusal();
    const signals = [controller.signal, AbortSignal.timeout(timeoutMs)];
    if (options.signal) signals.push(options.signal);
    const signal = AbortSignal.any(signals);
    const checkTarget = claimDisposableObjectTarget(target, options.silo, signal);
    bounds = captureBounds(events, { signal, timeoutMs });
    prepared = await prepareObjects(bounds, options);
    async function transfer() {
      await checkTarget();
      if (await target.bucketExists('files')) throw refusal();
      signal.throwIfAborted();
      // Require MinIO's atomic creation refusal, including an empty bucket created by a rival.
      await target.makeBucket('files');
      for (const object of prepared) {
        await checkTarget();
        signal.throwIfAborted();
        await target.putObject('files', object.address, object.bytes, object.bytes.length,
          { 'Content-Type': object.mime, 'If-None-Match': '*' });
        await verifyObject(target, object, bounds!, signal, timeoutMs);
      }
      await checkTarget();
    }
    bounds.check();
    await bounds.bounded(target.withBounds({ signal, timeoutMs }, transfer));
    await checkHistory(bounds, options.proof.targetDescriptor, maximumBytes);
  } catch {
    // Never resend or delete: an absent reply can still mean the write completed.
    throw refusal();
  } finally {
    controller.abort();
    for (const object of prepared) object.bytes.fill(0);
    bounds?.dispose();
  }
}
