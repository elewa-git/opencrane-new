import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { computerSummary, type ComputerControl, type ComputerSummary } from '@opencrane/auth';
import { readEventAt, readStreamSummary, type EventStore } from '@opencrane/event-store';
import { takeoverStartedLeaseDataSchema, takeoverRenewedDataSchema,
  takeoverReturnRequestedDataSchema } from '@opencrane/events';
import { envelope } from '@opencrane/models';

const id = z.string().regex(/^[\w-]{1,200}$/u);
const common = z.object({ commandId: id, assistantId: id, computerId: id,
  generation: z.int().positive(), podUid: id, conversationId: id,
  requesterId: id, requesterEventId: id, takeoverId: id, leaseId: id,
  writerSessionId: id });
const grantSchema = common.extend({ proxyInstanceId: id, expiresAt: z.iso.datetime(),
  originalExpiresAt: z.iso.datetime() }).strict();
const renewSchema = grantSchema.strict();
const returnSchema = common.strict();
type Grant = z.infer<typeof grantSchema>;
type Renew = z.infer<typeof renewSchema>;
type Return = z.infer<typeof returnSchema>;
type AccessCheck = () => Promise<void>;
const MAX_LEASE_MS = 120_000;
// A new server process cannot reopen a writer lease issued by its predecessor.
export const writerProxyInstanceId = randomUUID();

function take(summary: ComputerSummary, sequence: number) {
  return { control: structuredClone(summary.control), lifecycle: summary.lifecycle, sequence };
}
async function current(store: EventStore, silo: string, assistantId: string) {
  const deadline = performance.now() + 10_000;
  return readStreamSummary(store, silo, `computer-${assistantId}`,
    computerSummary, deadline, take);
}
function checkedControl(control: ComputerControl | undefined):
  Exclude<ComputerControl, { phase: 'unverified' }> {
  if (!control || control.phase === 'unverified') throw new Error('Control conflict');
  return control;
}
function sameOwner(control: Exclude<ComputerControl, { phase: 'unverified' }>, input: Return) {
  return control.assistantId === input.assistantId && control.computerId === input.computerId
    && control.generation === input.generation && control.podUid === input.podUid
    && control.conversationId === input.conversationId
    && control.requesterId === input.requesterId
    && control.requesterEventId === input.requesterEventId
    && control.takeoverId === input.takeoverId && control.leaseId === input.leaseId;
}
function commandId(eventId: string, subject: string) {
  const hash = createHash('sha256');
  hash.update(JSON.stringify([subject, eventId]));
  return hash.digest('hex');
}
async function append(store: EventStore, silo: string, subject: string,
  type: string, data: Record<string, unknown>, input: Return,
  sequence: number, checkAccess: AccessCheck) {
  const event = envelope(silo, subject, type, data);
  event.id = commandId(input.commandId, subject);
  event.commandId = input.commandId;
  event.source = 'opencrane-server';
  event.principal = { kind: 'human', id: input.requesterId };
  const command = { event, expectedSequence: sequence, checkAccess };
  const result = await store.append(command);
  if (result.status === 'unavailable') throw new Error('Control unavailable');
  if (result.status !== 'appended') throw new Error('Control conflict');
  const saved = await readEventAt(store, subject, result.sequence, performance.now() + 10_000);
  if (!saved) throw new Error('Control unavailable');
  const expected = { ...event, time: saved.event.time };
  if (!isDeepStrictEqual(saved.event, expected)) throw new Error('Control conflict');
  return current(store, silo, input.assistantId);
}
function repeated(control: ComputerControl | undefined, input: Return, phase: string) {
  if (!control || control.phase === 'unverified' || control.phase !== phase
    || control.commandId !== input.commandId || !sameOwner(control, input)
    || control.writerSessionId !== input.writerSessionId) return undefined;
  return control;
}
function validReady(facts: Awaited<ReturnType<typeof current>>, input: Return) {
  const ready = facts.lifecycle;
  if (ready?.event.type !== 'computer.ready') throw new Error('Computer unavailable');
  const data = ready.event.data as Record<string, unknown>;
  if (data['assistantId'] !== input.assistantId || data['computerId'] !== input.computerId
    || data['generation'] !== input.generation || data['podUid'] !== input.podUid) {
    throw new Error('Computer conflict');
  }
}
export async function grantWriter(store: EventStore, silo: string, raw: unknown,
  checkAccess: AccessCheck) {
  const input: Grant = grantSchema.parse(raw);
  if (input.proxyInstanceId !== writerProxyInstanceId) throw new Error('Control conflict');
  const facts = await current(store, silo, input.assistantId);
  const control = checkedControl(facts.control);
  const retry = repeated(control, input, 'started');
  if (retry) return retry;
  validReady(facts, input);
  if (control.phase !== 'paused' || !sameOwner(control, input)
    || !control.quietReceiptId) throw new Error('Control conflict');
  const now = Date.now();
  const expires = Date.parse(input.expiresAt);
  const original = Date.parse(input.originalExpiresAt);
  if (expires <= now || expires > now + MAX_LEASE_MS || original < expires
    || original > now + MAX_LEASE_MS) throw new Error('Control conflict');
  const data = takeoverStartedLeaseDataSchema.parse({
    assistantId: input.assistantId, computerId: input.computerId,
    generation: input.generation, podUid: input.podUid,
    conversationId: input.conversationId, requesterId: input.requesterId,
    requesterEventId: input.requesterEventId, takeoverId: input.takeoverId,
    leaseId: input.leaseId, affectedTurnIds: control.affectedTurnIds,
    writerSessionId: input.writerSessionId, proxyInstanceId: input.proxyInstanceId,
    expiresAt: input.expiresAt, originalExpiresAt: input.originalExpiresAt,
    quietReceiptId: control.quietReceiptId,
  });
  const saved = await append(store, silo, `computer-${input.assistantId}`,
    'takeover.started', data, input, facts.sequence, checkAccess);
  return checkedControl(saved.control);
}
export async function renewWriter(store: EventStore, silo: string, raw: unknown,
  checkAccess: AccessCheck) {
  const input: Renew = renewSchema.parse(raw);
  if (input.proxyInstanceId !== writerProxyInstanceId) throw new Error('Control conflict');
  const facts = await current(store, silo, input.assistantId);
  const control = checkedControl(facts.control);
  const retry = repeated(control, input, 'renewed');
  if (retry) return retry;
  validReady(facts, input);
  if (!sameOwner(control, input) || !['started', 'renewed'].includes(control.phase)
    || control.writerSessionId !== input.writerSessionId
    || control.proxyInstanceId !== input.proxyInstanceId
    || control.originalExpiresAt !== input.originalExpiresAt
    || !WriterSlot.hasCurrent(silo, input.assistantId, input.writerSessionId)) {
    throw new Error('Control conflict');
  }
  const now = Date.now();
  const expires = Date.parse(input.expiresAt);
  if (!control.expiresAt || Date.parse(control.expiresAt) <= now
    || expires <= now || expires > now + MAX_LEASE_MS
    || expires > Date.parse(control.originalExpiresAt!)) throw new Error('Control conflict');
  const { commandId: _commandId, ...renewedData } = input;
  const data = takeoverRenewedDataSchema.parse(renewedData);
  const saved = await append(store, silo, `computer-${input.assistantId}`,
    'takeover.renewed', data, input, facts.sequence, checkAccess);
  return checkedControl(saved.control);
}
export async function returnWriter(store: EventStore, silo: string, raw: unknown,
  checkAccess: AccessCheck) {
  const input: Return = returnSchema.parse(raw);
  const facts = await current(store, silo, input.assistantId);
  const control = checkedControl(facts.control);
  const retry = repeated(control, input, 'returning');
  if (retry) return retry;
  if (!sameOwner(control, input) || !['started', 'renewed'].includes(control.phase)
    || control.writerSessionId !== input.writerSessionId) throw new Error('Control conflict');
  // Stop local input before attempting the saved Return. A failed append keeps it closed.
  WriterSlot.closeCurrent(silo, input.assistantId, input.writerSessionId);
  const { commandId: _commandId, ...returnedData } = input;
  const data = takeoverReturnRequestedDataSchema.parse(returnedData);
  const saved = await append(store, silo, `computer-${input.assistantId}`,
    'takeover.return_requested', data, input, facts.sequence, checkAccess);
  return checkedControl(saved.control);
}

export class WriterSlot {
  private static active = new Map<string, WriterSlot>();
  private static consumed = new WeakMap<EventStore, Set<string>>();
  private readonly key: string;
  private readonly input: Grant;
  private readonly store: EventStore;
  private readonly silo: string;
  private readonly checkAccess: AccessCheck;
  private owner = false;
  private closed = false;
  private checking = false;
  private permissionUntil = 0;
  private leaseUntil = 0;
  private originalUntil = 0;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(store: EventStore, silo: string, raw: unknown, checkAccess: AccessCheck) {
    this.input = grantSchema.parse(raw);
    this.store = store;
    this.silo = silo;
    this.checkAccess = checkAccess;
    this.key = JSON.stringify([silo, this.input.assistantId]);
  }

  private async verify() {
    const first = await current(this.store, this.silo, this.input.assistantId);
    await this.checkAccess();
    const second = await current(this.store, this.silo, this.input.assistantId);
    if (first.sequence !== second.sequence) throw new Error('Control changed');
    validReady(second, this.input);
    const control = checkedControl(second.control);
    if (!['started', 'renewed'].includes(control.phase)
      || !sameOwner(control, this.input)
      || control.writerSessionId !== this.input.writerSessionId
      || control.proxyInstanceId !== this.input.proxyInstanceId
      || !control.expiresAt || !control.originalExpiresAt
      || Date.parse(control.expiresAt) <= Date.now()) {
      throw new Error('Control unavailable');
    }
    const remaining = Date.parse(control.expiresAt) - Date.now();
    const originalRemaining = Date.parse(control.originalExpiresAt) - Date.now();
    this.originalUntil = Math.min(this.originalUntil || Infinity,
      performance.now() + originalRemaining);
    this.leaseUntil = Math.min(this.originalUntil, performance.now() + remaining);
    this.permissionUntil = performance.now() + 1500;
  }

  async claim() {
    if (this.input.proxyInstanceId !== writerProxyInstanceId) return false;
    if (this.closed || this.owner || this.checking || WriterSlot.active.has(this.key)) return false;
    let consumed = WriterSlot.consumed.get(this.store);
    if (!consumed) {
      consumed = new Set();
      WriterSlot.consumed.set(this.store, consumed);
    }
    const leaseKey = JSON.stringify([this.key, this.input.leaseId]);
    if (consumed.has(leaseKey)) return false;
    this.checking = true;
    WriterSlot.active.set(this.key, this);
    try {
      await this.verify();
    } catch {
      this.close();
      return false;
    } finally {
      this.checking = false;
    }
    if (this.closed) return false;
    // Consume once permission is proved and before any input is admitted.
    consumed.add(leaseKey);
    this.owner = true;
    this.timer = setInterval(this.refresh.bind(this), 250);
    this.timer.unref();
    return true;
  }
  private async refresh() {
    if (this.closed || this.checking) return;
    this.checking = true;
    try {
      await this.verify();
    } catch {
      this.close();
    } finally {
      this.checking = false;
    }
  }
  allows(leaseId: string, writerSessionId: string) {
    const now = performance.now();
    return !this.closed && this.owner && now < this.permissionUntil
      && now < this.leaseUntil && leaseId === this.input.leaseId
      && writerSessionId === this.input.writerSessionId;
  }
  close() {
    this.closed = true;
    this.owner = false;
    if (this.timer) clearInterval(this.timer);
    if (WriterSlot.active.get(this.key) === this) WriterSlot.active.delete(this.key);
  }
  static closeCurrent(silo: string, assistantId: string, writerSessionId: string) {
    const key = JSON.stringify([silo, assistantId]);
    const active = WriterSlot.active.get(key);
    if (active?.input.writerSessionId === writerSessionId) active.close();
  }
  static hasCurrent(silo: string, assistantId: string, writerSessionId: string) {
    const key = JSON.stringify([silo, assistantId]);
    const active = WriterSlot.active.get(key);
    return active?.input.writerSessionId === writerSessionId &&
      active.allows(active.input.leaseId, writerSessionId);
  }
}
