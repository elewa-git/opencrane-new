import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, opendirSync,
  readSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { NatsConnection } from '@nats-io/transport-node';
import { decodeEvent, type StoredEvent } from '@opencrane/event-store';
import { memoryValueEventSchema, type MemoryIdentity } from '@opencrane/events';
import { memoryErasureHistory, memoryIdentity, memoryKeys } from '@opencrane/projections';
import { z } from 'zod';
import { captureBounds, infoSchema } from './event-backup.ts';

type Bounds = ReturnType<typeof captureBounds>;
interface Options {
  silo: string;
  sourceDirectory: string;
  candidateDirectory: string;
  stopped: boolean;
  signal?: AbortSignal;
}
const messageSchema = z.object({ error: z.never().optional(), message: z.object({
  subject: z.string(), seq: z.number().int().positive().safe(), data: z.string(),
}) });
function refusal() {
  return new Error('Memory restore refused; keep target isolated');
}
async function streamInfo(bounds: Bounds) {
  return infoSchema.parse(await bounds.request('$JS.API.STREAM.INFO.EVENTS', {}));
}
async function history(bounds: Bounds, silo: string) {
  const info = await streamInfo(bounds);
  if (info.state.first_seq !== 1 || info.state.messages !== info.state.last_seq ||
      info.state.messages > 100_000) {
    throw refusal();
  }
  const events: StoredEvent[] = [];
  let totalBytes = 0;
  for (let sequence = 1; sequence <= info.state.last_seq; sequence++) {
    const response = await bounds.request('$JS.API.STREAM.MSG.GET.EVENTS', { seq: sequence });
    const saved = messageSchema.parse(response).message;
    const bytes = Buffer.from(saved.data, 'base64');
    totalBytes += bytes.length;
    if (saved.seq !== sequence || totalBytes > 64 * 1024 * 1024) {
      throw refusal();
    }
    const event = decodeEvent(bytes, saved.subject);
    if (event.silo !== silo) {
      throw refusal();
    }
    events.push({ sequence, event });
  }
  return { info, events };
}

function inventory(directory: string, bounds: Bounds) {
  const path = resolve(directory);
  const details = lstatSync(path);
  if (realpathSync(path) !== path || !details.isDirectory() ||
      details.uid !== process.getuid?.() || (details.mode & 0o777) !== 0o700) {
    throw refusal();
  }
  const entries = opendirSync(path);
  const records = new Map<string, string>();
  try {
    for (let entry = entries.readSync(); entry !== null; entry = entries.readSync()) {
      bounds.check();
      if (records.size >= 100_000 || !/^[a-f0-9]{64}$/.test(entry.name)) {
        throw refusal();
      }
      const file = openSync(`${path}/${entry.name}`,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const info = fstatSync(file);
        if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600 ||
            (info.size !== 0 && info.size !== 32)) {
          throw refusal();
        }
        const buffer = Buffer.alloc(33);
        let length = 0;
        while (length < buffer.length) {
          const count = readSync(file, buffer, length, buffer.length - length, null);
          if (count === 0) {
            break;
          }
          length += count;
        }
        if (length !== info.size) {
          throw refusal();
        }
        const bytes = buffer.subarray(0, length);
        const hash = createHash('sha256');
        hash.update(bytes);
        records.set(entry.name, hash.digest('hex'));
      } finally {
        closeSync(file);
      }
    }
  } finally {
    entries.closeSync();
  }
  return records;
}

async function checkRevisions(events: StoredEvent[], options: Options, bounds: Bounds) {
  const erased = await memoryErasureHistory(events);
  const current = memoryKeys(options.sourceDirectory);
  const candidate = memoryKeys(options.candidateDirectory);
  const latest = new Map<string, MemoryIdentity>();
  for (const stored of events) {
    bounds.check();
    if (stored.event.type !== 'memory.written' && stored.event.type !== 'memory.corrected') {
      continue;
    }
    const identity = memoryIdentity(stored.event);
    if (!identity) {
      throw refusal();
    }
    const hiddenIdentities = erased.hidden(identity.silo, identity.scopeId);
    const hidden = hiddenIdentities.has(identity.memoryId);
    const superseded = erased.superseded(identity.silo, identity.scopeId);
    const replaced = superseded.get(identity.memoryId) ?? 0;
    const status = current.status(identity);
    if (status === 'missing' || ((hidden || identity.revision <= replaced) && status !== 'destroyed') ||
        candidate.status(identity) !== status) {
      throw refusal();
    }
    const data = memoryValueEventSchema.parse(stored.event).data;
    // Authenticate surviving material. Destroyed markers return null without reading old text.
    candidate.decrypt(identity, data);
    const reference = JSON.stringify([identity.scopeId, identity.memoryId]);
    const previous = latest.get(reference);
    if (!previous || identity.revision > previous.revision) {
      latest.set(reference, identity);
    }
  }
  for (const identity of latest.values()) {
    const hidden = erased.hidden(identity.silo, identity.scopeId);
    if (!hidden.has(identity.memoryId)) {
      continue;
    }
    // Require the marker for an unpublished correction that could have raced the forget.
    const next = { ...identity, revision: identity.revision + 1 };
    if (current.status(next) !== 'destroyed' || candidate.status(next) !== 'destroyed') {
      throw refusal();
    }
  }
}

/** Validate stopped, operator-trusted sources only; never import or change custody. */
export async function checkMemoryRestore(source: NatsConnection, target: NatsConnection,
  options: Options): Promise<void> {
  const sourceBounds = captureBounds(source, options);
  const targetBounds = captureBounds(target, options);
  try {
    if (options.stopped !== true || !options.silo || !source.info?.server_id ||
        !target.info?.server_id || source.info.server_id === target.info.server_id ||
        source.info.cluster || target.info.cluster ||
        Reflect.get(source.info, 'domain') || Reflect.get(target.info, 'domain')) {
      throw refusal();
    }
    const current = await history(sourceBounds, options.silo);
    const restored = await history(targetBounds, options.silo);
    if (restored.events.length > current.events.length) {
      throw refusal();
    }
    for (let index = 0; index < restored.events.length; index++) {
      if (!isDeepStrictEqual(restored.events[index], current.events[index])) {
        throw refusal();
      }
    }
    const sourceInventory = inventory(options.sourceDirectory, sourceBounds);
    const candidateInventory = inventory(options.candidateDirectory, targetBounds);
    // Include markers with no surviving event, and reject pending or unrecognised files.
    if (!isDeepStrictEqual(sourceInventory, candidateInventory)) {
      throw refusal();
    }
    await checkRevisions(current.events, options, sourceBounds);
    if (!isDeepStrictEqual(sourceInventory, inventory(options.sourceDirectory, sourceBounds)) ||
        !isDeepStrictEqual(candidateInventory, inventory(options.candidateDirectory, targetBounds)) ||
        !isDeepStrictEqual(current.info, await streamInfo(sourceBounds)) ||
        !isDeepStrictEqual(restored.info, await streamInfo(targetBounds))) {
      throw refusal();
    }
    sourceBounds.check();
    targetBounds.check();
  } catch {
    throw refusal();
  } finally {
    sourceBounds.dispose();
    targetBounds.dispose();
  }
}
