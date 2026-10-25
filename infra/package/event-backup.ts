import { createHash } from 'node:crypto';
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, realpathSync,
  renameSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInbox, type Msg, type NatsConnection, type QueuedIterator, type Status } from '@nats-io/transport-node';
import { decodeEvent } from '@opencrane/event-store';
import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';

const integer = z.number().int().nonnegative().safe();
const identifier = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const configSchema = z.object({
  name: z.literal('EVENTS'), subjects: z.array(z.string()),
  storage: z.literal('file'), retention: z.literal('limits'), num_replicas: integer,
  consumer_limits: z.record(z.string(), integer).optional(),
  discard: z.literal('old'), compression: z.enum(['none', 's2']).optional(),
  persist_mode: z.literal('default').optional(),
  description: z.literal('').optional(),
  metadata: z.record(z.string().regex(/^_nats\./), z.string()).optional(),
}).catchall(z.union([z.number().finite(), z.boolean()])).transform(withoutServerMetadata);

function withoutServerMetadata(config: Record<string, unknown>) {
  // Omit NATS-generated annotations, which differ between INFO and SNAPSHOT replies.
  const { metadata: _metadata, description: _description, ...settings } = config;
  return settings;
}
const stateSchema = z.object({ first_seq: integer, last_seq: integer, messages: integer });
const infoSchema = z.object({
  error: z.never().optional(),
  created: z.string().datetime({ offset: true }), config: configSchema, state: stateSchema,
});
const snapshotSchema = z.object({
  error: z.never().optional(), config: configSchema, state: stateSchema,
});
export const descriptorSchema = z.object({
  version: z.literal(1), kind: z.literal('event-bytes-only'), silo: identifier,
  attempt: identifier, created: z.string(), config: configSchema,
  firstSequence: integer, lastSequence: integer, eventCount: integer,
  subjectPositions: z.record(z.string(), integer), identityDigest: digest,
  byteCount: integer.positive(), sha256: digest,
}).strict();

interface Options {
  silo: string;
  attempt: string;
  destination: string;
  signal?: AbortSignal;
  maxBytes?: number;
  timeoutMs?: number;
}

const refusal = () => new Error('Event backup refused');
const maximumBytes = 64 * 1024 * 1024;
const maximumMs = 60_000;

function captureBounds(connection: NatsConnection, options: Options) {
  const stopped = Promise.withResolvers<never>();
  // Observe rejection even when a synchronous file operation fails first.
  void stopped.promise.catch(ignoreFailure);
  const timeoutMs = options.timeoutMs ?? maximumMs;
  const deadline = performance.now() + timeoutMs;
  let failed = false;
  function stop() {
    failed = true;
    stopped.reject(refusal());
  }
  function check() {
    if (failed || options.signal?.aborted || connection.isClosed() ||
        performance.now() >= deadline) throw refusal();
  }
  async function bounded<Value>(pending: Promise<Value>): Promise<Value> {
    check();
    const value = await Promise.race([pending, stopped.promise]);
    check();
    return value;
  }
  async function request(subject: string, input: unknown) {
    check();
    const pending = connection.request(subject, JSON.stringify(input), { timeout: 2_000 });
    const reply = await bounded(pending);
    if (reply.data.length > 1024 * 1024) throw refusal();
    return reply.json<unknown>();
  }
  const timer = setTimeout(stop, Math.min(timeoutMs, maximumMs));
  options.signal?.addEventListener('abort', stop, { once: true });
  // Close the SDK's queue on exit; stopping only iteration leaves its listener registered.
  const statuses = connection.status() as QueuedIterator<Status>;
  async function watchConnection() {
    for await (const status of statuses) {
      if (status.type === 'disconnect' || status.type === 'error') stop();
    }
  }
  void watchConnection().catch(stop);
  function dispose() {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', stop);
    statuses.stop();
  }
  return { check, request, bounded, stop, dispose };
}

type Bounds = ReturnType<typeof captureBounds>;

async function readIdentities(bounds: Bounds, before: z.infer<typeof infoSchema>,
  silo: string, maxBytes: number) {
  if (before.state.messages === 0 || before.state.messages > 100_000 ||
      before.state.last_seq - before.state.first_seq + 1 !== before.state.messages) throw refusal();
  const identity = createHash('sha256');
  const subjectPositions: Record<string, number> = Object.create(null);
  let readBytes = 0;
  for (let sequence = before.state.first_seq; sequence <= before.state.last_seq; sequence++) {
    const reply = await bounds.request('$JS.API.STREAM.MSG.GET.EVENTS', { seq: sequence });
    const parsed = z.object({ error: z.never().optional(), message: z.object({
      subject: z.string(), seq: integer, data: z.string(),
    }) }).parse(reply).message;
    const bytes = Buffer.from(parsed.data, 'base64');
    readBytes += bytes.length;
    if (readBytes > maxBytes || parsed.seq !== sequence) throw refusal();
    const event = decodeEvent(bytes, parsed.subject);
    if (event.silo !== silo) throw refusal();
    identity.update(JSON.stringify([sequence, parsed.subject, event.id]));
    identity.update('\n');
    subjectPositions[parsed.subject] = sequence;
  }
  return { subjectPositions, identityDigest: identity.digest('hex') };
}

async function receiveSnapshot(connection: NatsConnection, archive: number,
  bounds: Bounds, maxBytes: number) {
  const completed = Promise.withResolvers<void>();
  void completed.promise.catch(ignoreFailure);
  const hash = createHash('sha256');
  let byteCount = 0;
  let finalReceived = false;
  function chunk(error: Error | null, message: Msg) {
    try {
      bounds.check();
      if (error || finalReceived) throw refusal();
      if (message.data.length === 0) {
        finalReceived = true;
        completed.resolve();
        return;
      }
      byteCount += message.data.length;
      if (byteCount > maxBytes) throw refusal();
      let offset = 0;
      while (offset < message.data.length) {
        bounds.check();
        offset += writeSync(archive, message.data, offset);
      }
      hash.update(message.data);
      if (message.reply) message.respond();
    } catch {
      bounds.stop();
    }
  }
  const inbox = createInbox();
  const subscription = connection.subscribe(inbox, { callback: chunk });
  try {
    const snapshot = snapshotSchema.parse(await bounds.request('$JS.API.STREAM.SNAPSHOT.EVENTS', {
      deliver_subject: inbox, chunk_size: 32 * 1024, no_consumers: true,
    }));
    await bounds.bounded(completed.promise);
    return { snapshot, byteCount, sha256: hash.digest('hex') };
  } finally {
    subscription.unsubscribe();
  }
}

/** Save only event bytes. Stable positions do not prove that writers have stopped. */
export async function collectEventBackup(connection: NatsConnection, options: Options): Promise<void> {
  const bounds = captureBounds(connection, options);
  const timeoutMs = options.timeoutMs ?? maximumMs;
  const maxBytes = options.maxBytes ?? maximumBytes;
  let owned = false;
  let archive: number | undefined;
  const destination = resolve(options.destination);
  try {
    identifier.parse(options.silo);
    identifier.parse(options.attempt);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > maximumBytes ||
        !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > maximumMs) throw refusal();
    const parent = dirname(destination);
    const metadata = lstatSync(parent);
    if (realpathSync(parent) !== parent || !metadata.isDirectory() ||
        metadata.uid !== process.getuid?.() || (metadata.mode & 0o777) !== 0o700) throw refusal();
    bounds.check();
    mkdirSync(destination, { mode: 0o700 });
    owned = true;
    archive = openSync(join(destination, 'events.partial'), 'wx', 0o600);
    const before = infoSchema.parse(await bounds.request('$JS.API.STREAM.INFO.EVENTS', {}));
    const identities = await readIdentities(bounds, before, options.silo, maxBytes);
    const captured = await receiveSnapshot(connection, archive, bounds, maxBytes);
    const { snapshot, byteCount, sha256 } = captured;
    const after = infoSchema.parse(await bounds.request('$JS.API.STREAM.INFO.EVENTS', {}));
    if (!isDeepStrictEqual(before, after) ||
        !isDeepStrictEqual(snapshot.config, before.config) ||
        !isDeepStrictEqual(snapshot.state, before.state)) throw refusal();
    const descriptor = descriptorSchema.parse({
      version: 1, kind: 'event-bytes-only', silo: options.silo, attempt: options.attempt,
      created: before.created, config: before.config, firstSequence: before.state.first_seq,
      lastSequence: before.state.last_seq, eventCount: before.state.messages,
      ...identities, byteCount, sha256,
    });
    bounds.check();
    fsyncSync(archive);
    closeSync(archive);
    archive = undefined;
    writeFileSync(join(destination, 'descriptor.partial'), JSON.stringify(descriptor),
      { flag: 'wx', mode: 0o600, flush: true });
    bounds.check();
    renameSync(join(destination, 'events.partial'), join(destination, 'events.snapshot'));
    // Publish the descriptor last. Its presence marks a completed event-byte capture only.
    renameSync(join(destination, 'descriptor.partial'), join(destination, 'descriptor.json'));
  } catch {
    try {
      if (archive !== undefined) closeSync(archive);
      if (owned) rmSync(destination, { recursive: true, force: true });
    } finally {
      throw refusal();
    }
  } finally {
    bounds.dispose();
  }
}

function ignoreFailure() {}
