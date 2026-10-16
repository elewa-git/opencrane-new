import { createHash, randomUUID } from 'node:crypto';
import { link, open, unlink } from 'node:fs/promises';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { z } from 'zod';
import type { EventStore } from '@opencrane/event-store';
import { egressCloseSchema, egressDestinationSchema, egressObservationId,
  egressObservationSchema, parseEventByType, type EventEnvelope } from '@opencrane/events';
import { envelope } from './actor.ts';
import { isPublicAddress } from './address-policy.ts';

type Binding = { requestId: string; permitId: string; channel: 'command' | 'desktop';
  host: string; port: number };
type Status = 'pending' | 'saved' | 'refused';
const missing = z.object({ code: z.literal('ENOENT') });

// Keep one bounded JSONL record per relay. This file is evidence, never permission to connect.
async function readEvidence(file: string): Promise<unknown> {
  let handle;
  try {
    handle = await open(file, 'r');
    const details = await handle.stat();
    if (details.size > 4096) {
      throw new Error('egress_receipt_refused');
    }
    const bytes = await handle.readFile('utf8');
    return JSON.parse(bytes) as unknown;
  } catch (error) {
    if (missing.safeParse(error).success) {
      return undefined;
    }
    // Hide filesystem paths and untrusted evidence from callers.
    // eslint-disable-next-line preserve-caught-error
    throw new Error('egress_receipt_refused');
  } finally {
    await handle?.close();
  }
}
async function saveEvidence(file: string, directory: string, event: EventEnvelope) {
  const bytes = `${JSON.stringify(event)}\n`;
  if (Buffer.byteLength(bytes) > 4096) {
    throw new Error('egress_receipt_refused');
  }
  const temporary = `${file}.${randomUUID()}.pending`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    try {
      await link(temporary, file);
    } catch (error) {
      const exists = z.object({ code: z.literal('EEXIST') }).safeParse(error);
      if (!exists.success) {
        throw error;
      }
      const original = await readEvidence(file);
      if (JSON.stringify(original) !== JSON.stringify(event)) {
        throw new Error('egress_receipt_refused', { cause: error });
      }
    }
  } finally {
    await handle.close();
    await unlink(temporary);
  }
  const parent = await open(directory, 'r');
  try {
    await parent.sync();
  } finally {
    await parent.close();
  }
}

function checkedEvidence(raw: unknown, silo: string, binding: Binding,
  destinationDigest: string) {
  const observationId = egressObservationId(silo, binding.permitId);
  const parsed = parseEventByType(raw);
  if (!parsed.success) {
    throw new Error('egress_receipt_refused');
  }
  const event = parsed.event;
  const observation = egressObservationSchema.safeParse(event.data);
  if (!observation.success) {
    throw new Error('egress_receipt_refused');
  }
  const data = observation.data;
  const record = data.relay;
  const address = { address: record.address ?? '', family: isIP(record.address ?? '') };
  if (event.type !== 'egress.observed' || event.silo !== silo || event.id !== observationId ||
      data.requestId !== binding.requestId || data.channel !== binding.channel ||
      data.destinationDigest !== destinationDigest || record.host !== binding.host ||
      record.port !== binding.port || (record.address !== null && !isPublicAddress(address))) {
    throw new Error('egress_receipt_refused');
  }
  return event;
}

export async function createEgressReceipt(store: Pick<EventStore, 'append' | 'readStream'>,
  silo: string, requested: Binding, directory: string) {
  const requestedDestination = { host: requested.host, port: requested.port };
  const destination = egressDestinationSchema.parse(requestedDestination);
  const binding = { ...requested, ...destination };
  const observationId = egressObservationId(silo, binding.permitId);
  const subject = `egress-${binding.requestId}`;
  const file = join(directory, `${observationId}.jsonl`);
  const hash = createHash('sha256');
  hash.update(JSON.stringify([binding.host, binding.port]));
  const destinationDigest = hash.digest('hex');
  let pending: EventEnvelope | undefined;
  let status: Status = 'pending';
  let writing: Promise<Status> | undefined;

  const retained = await readEvidence(file);
  if (retained !== undefined) {
    pending = checkedEvidence(retained, silo, binding, destinationDigest);
  }

  function capture(raw: unknown) {
    try {
      const relay = egressCloseSchema.parse(raw);
      let outcome: 'unknown' | 'error' = 'unknown';
      if (relay.reason === 'failed' || relay.reason === 'refused') {
        outcome = 'error';
      }
      const data = { requestId: binding.requestId, permitId: binding.permitId,
        channel: binding.channel, destinationDigest, observationId, outcome, relay };
      const event = envelope(silo, subject, 'egress.observed', data, observationId,
        new Date(relay.closedAt));
      const valid = checkedEvidence(event, silo, binding, destinationDigest);
      if (pending && JSON.stringify(pending) !== JSON.stringify(valid)) {
        return false;
      }
      pending = valid;
      void retry();
      return true;
    } catch {
      return false;
    }
  }
  async function saved() {
    for await (const row of store.readStream(subject, 1, performance.now() + 1000)) {
      const event = checkedEvidence(row.event, silo, binding, destinationDigest);
      if (JSON.stringify(event) !== JSON.stringify(pending)) {
        return 'refused' as const;
      }
      return 'saved' as const;
    }
    return 'pending' as const;
  }
  async function persist(): Promise<Status> {
    if (!pending || status !== 'pending') {
      return status;
    }
    try {
      await saveEvidence(file, directory, pending);
      status = await saved();
      if (status !== 'pending') {
        return status;
      }
      const command = { event: pending, expectedSequence: 0, deadline: performance.now() + 1000 };
      await store.append(command);
      status = await saved();
    } catch {
      // Retain the same record after disk or store failure; never report a successful send.
      status = 'pending';
    }
    return status;
  }
  function retry(): Promise<Status> {
    if (writing) {
      return writing;
    }
    writing = persist().finally(finished);
    return writing;
  }
  function finished() {
    writing = undefined;
  }
  return { observationId, capture, retry };
}
