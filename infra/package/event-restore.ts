import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { NatsConnection } from '@nats-io/transport-node';
import { z } from 'zod';
import { captureBounds, descriptorSchema, infoSchema, readIdentities } from './event-backup.ts';

interface Options {
  directory: string;
  silo: string;
  disposable: boolean;
  timeoutMs?: number;
  maxBytes?: number;
  signal?: AbortSignal;
}
type Descriptor = z.infer<typeof descriptorSchema>;
type Bounds = ReturnType<typeof captureBounds>;
const maximumBytes = 64 * 1024 * 1024;

function refusal() {
  return new Error('Event restore refused; keep target isolated');
}

function readPrivateFile(path: string, limit: number) {
  const file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(file);
    if (!info.isFile() || info.size > limit || info.uid !== process.getuid?.() ||
        (info.mode & 0o777) !== 0o600) throw refusal();
    const bytes = Buffer.alloc(info.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(file, bytes, offset, bytes.length - offset, null);
      if (count === 0) break;
      offset += count;
    }
    if (offset !== info.size) throw refusal();
    return bytes.subarray(0, offset);
  } finally {
    closeSync(file);
  }
}

function checkInfo(info: z.infer<typeof infoSchema>, descriptor: Descriptor) {
  if (!isDeepStrictEqual(info.config, descriptor.config) ||
      info.state.first_seq !== descriptor.firstSequence ||
      info.state.last_seq !== descriptor.lastSequence ||
      info.state.messages !== descriptor.eventCount) throw refusal();
}

async function checkHistory(bounds: Bounds, descriptor: Descriptor, maxBytes: number) {
  const before = infoSchema.parse(await bounds.request('$JS.API.STREAM.INFO.EVENTS', {}));
  checkInfo(before, descriptor);
  if (before.created !== descriptor.created) throw refusal();
  const identities = await readIdentities(bounds, before, descriptor.silo, maxBytes);
  // Compare plain records because the scanner deliberately builds a record without a prototype.
  const positions = { ...identities.subjectPositions };
  if (identities.identityDigest !== descriptor.identityDigest ||
      !isDeepStrictEqual(positions, descriptor.subjectPositions)) throw refusal();
  const after = infoSchema.parse(await bounds.request('$JS.API.STREAM.INFO.EVENTS', {}));
  if (!isDeepStrictEqual(before, after)) throw refusal();
}

async function transfer(connection: NatsConnection, bounds: Bounds,
  descriptor: Descriptor, archive: Uint8Array) {
  const absent = z.object({ error: z.object({ code: z.literal(404), err_code: z.literal(10059) }) });
  absent.parse(await bounds.request('$JS.API.STREAM.INFO.EVENTS', {}));
  const state = { first_seq: descriptor.firstSequence,
    last_seq: descriptor.lastSequence, messages: descriptor.eventCount };
  const started = await bounds.request('$JS.API.STREAM.RESTORE.EVENTS',
    { config: descriptor.config, state });
  const response = z.object({ error: z.never().optional(),
    deliver_subject: z.string().regex(/^\$JS\.SNAPSHOT\.RESTORE\.[A-Za-z0-9_.-]+$/) }).parse(started);
  async function send(chunk: Uint8Array) {
    bounds.check();
    const reply = await bounds.bounded(connection.request(response.deliver_subject, chunk,
      { timeout: 2_000 }));
    if (reply.headers?.hasError || reply.data.length > 1024 * 1024) throw refusal();
    return reply;
  }
  for (let offset = 0; offset < archive.length; offset += 32 * 1024) {
    const reply = await send(archive.subarray(offset, offset + 32 * 1024));
    if (reply.data.length !== 0) throw refusal();
  }
  const reply = await send(new Uint8Array());
  const restored = infoSchema.parse(reply.json<unknown>());
  checkInfo(restored, descriptor);
  return restored;
}

function checkConnections(source: NatsConnection, target: NatsConnection, disposable: boolean) {
  if (disposable !== true || !source.info?.server_id || !target.info?.server_id ||
      source.info.server_id === target.info.server_id || source.info.cluster ||
      target.info.cluster || Reflect.get(source.info, 'domain') ||
      Reflect.get(target.info, 'domain')) throw refusal();
}

/** Restore event bytes only. Leave every uncertain target intact and isolated. */
export async function restoreEventBackup(source: NatsConnection, target: NatsConnection,
  options: Options): Promise<void> {
  const bounds = captureBounds(target, options);
  try {
    const maxBytes = options.maxBytes ?? maximumBytes;
    const timeoutMs = options.timeoutMs ?? 60_000;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > maximumBytes ||
        !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw refusal();
    checkConnections(source, target, options.disposable);
    const text = readPrivateFile(join(options.directory, 'descriptor.json'), 1024 * 1024);
    const descriptor = descriptorSchema.parse(JSON.parse(text.toString('utf8')));
    if (descriptor.silo !== options.silo || descriptor.config['num_replicas'] !== 1 ||
        !isDeepStrictEqual(descriptor.config['subjects'], ['ev.>'])) throw refusal();
    const archive = readPrivateFile(join(options.directory, 'events.snapshot'), maxBytes);
    const hash = createHash('sha256');
    hash.update(archive);
    if (archive.length !== descriptor.byteCount || hash.digest('hex') !== descriptor.sha256) {
      throw refusal();
    }
    async function requestSource(subject: string, input: unknown) {
      bounds.check();
      const reply = await bounds.bounded(source.request(subject, JSON.stringify(input),
        { timeout: 2_000 }));
      if (reply.headers?.hasError || reply.data.length > 1024 * 1024) throw refusal();
      return reply.json<unknown>();
    }
    const sourceBounds = { ...bounds, request: requestSource };
    await checkHistory(sourceBounds, descriptor, maxBytes);
    const restored = await transfer(target, bounds, descriptor, archive);
    // NATS assigns a new creation time. Require that restored stream to stay unchanged.
    const targetDescriptor = { ...descriptor, created: restored.created };
    await checkHistory(bounds, targetDescriptor, maxBytes);
  } catch {
    // Never erase or retry: a missing reply can still mean NATS completed the restore.
    throw refusal();
  } finally {
    bounds.dispose();
  }
}
