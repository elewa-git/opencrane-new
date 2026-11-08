import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { computerSummary, type ComputerControl, type ComputerSummary } from '@opencrane/auth';
import { readEventAt, readStreamSummary, type EventStore } from '@opencrane/event-store';
import { takeoverStartedLeaseDataSchema, takeoverRenewedDataSchema,
  takeoverReturnRequestedDataSchema, takeoverEndedWithProofDataSchema,
  takeoverClosureUnknownDataSchema, takeoverEndReasonSchema } from '@opencrane/events';
import { envelope } from '@opencrane/models';

const id = z.string().regex(/^[\w-]{1,200}$/u);
const readyIdentity = z.object({ assistantId: id, computerId: id,
  generation: z.int().positive(), podUid: id });
const common = z.object({ commandId: id, assistantId: id, computerId: id,
  generation: z.int().positive(), podUid: id, conversationId: id,
  requesterId: id, requesterEventId: id, takeoverId: id, leaseId: id,
  writerSessionId: id });
const grantSchema = common.extend({ proxyInstanceId: id, expiresAt: z.iso.datetime(),
  originalExpiresAt: z.iso.datetime() }).strict();
const renewSchema = grantSchema.strict();
const returnSchema = common.strict();
const endSchema = common.extend({ reason: takeoverEndReasonSchema }).strict();
type Grant = z.infer<typeof grantSchema>;
type Renew = z.infer<typeof renewSchema>;
type Return = z.infer<typeof returnSchema>;
type End = z.infer<typeof endSchema>;
type AccessCheck = () => Promise<void>;
const MAX_LEASE_MS = 120_000;
const CLOSURE_WAIT_MS = 2_000;
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
function sameOwner(control: Pick<Return, 'assistantId' | 'computerId' | 'generation' |
  'podUid' | 'conversationId' | 'requesterId' | 'requesterEventId' | 'takeoverId' |
  'leaseId'>, input: Return) {
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
  sequence: number, checkAccess: AccessCheck, system = false) {
  const event = envelope(silo, subject, type, data);
  event.id = commandId(input.commandId, subject);
  event.commandId = input.commandId;
  event.source = 'opencrane-server';
  if (system) {
    event.principal = { kind: 'system', id: 'writer-closure' };
  } else {
    event.principal = { kind: 'human', id: input.requesterId };
  }
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
function repeated(control: ComputerControl | undefined, input: Return | Grant, phase: string) {
  if (!control || control.phase === 'unverified' || control.phase !== phase
    || control.commandId !== input.commandId || !sameOwner(control, input)
    || control.writerSessionId !== input.writerSessionId) return undefined;
  if ('expiresAt' in input && (control.expiresAt !== input.expiresAt
    || control.originalExpiresAt !== input.originalExpiresAt
    || control.proxyInstanceId !== input.proxyInstanceId)) return undefined;
  return control;
}
function repeatedEnd(control: ComputerControl, input: End) {
  if (control.phase !== 'ended' && control.phase !== 'closure_unknown') return undefined;
  const retry = repeated(control, input, control.phase);
  const savedReason = control.phase === 'ended' ? control.reason : control.requestedEndReason;
  if (retry && savedReason === input.reason) return retry;
  return undefined;
}
function validReady(facts: Awaited<ReturnType<typeof current>>, input: Return) {
  const ready = facts.lifecycle;
  if (ready?.event.type !== 'computer.ready') throw new Error('Computer unavailable');
  const data = readyIdentity.parse(ready.event.data);
  if (data.assistantId !== input.assistantId || data.computerId !== input.computerId
    || data.generation !== input.generation || data.podUid !== input.podUid) {
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
  if (!control.expiresAt || !control.originalExpiresAt
    || Date.parse(control.expiresAt) <= now
    || expires <= now || expires > now + MAX_LEASE_MS
    || expires > Date.parse(control.originalExpiresAt)) throw new Error('Control conflict');
  const { commandId: _commandId, ...renewedData } = input;
  const data = takeoverRenewedDataSchema.parse(renewedData);
  const saved = await append(store, silo, `computer-${input.assistantId}`,
    'takeover.renewed', data, input, facts.sequence, checkAccess);
  return checkedControl(saved.control);
}
export async function returnWriter(store: EventStore, silo: string, raw: unknown,
  checkAccess: AccessCheck) {
  const input: Return = returnSchema.parse(raw);
  // Close immediately. A slow computer read must not keep the old input slot open.
  WriterSlot.closeCurrent(store, silo, input);
  const facts = await current(store, silo, input.assistantId);
  const control = checkedControl(facts.control);
  const retry = repeated(control, input, 'returning');
  if (retry) return retry;
  if (!sameOwner(control, input) || !['started', 'renewed'].includes(control.phase)
    || control.writerSessionId !== input.writerSessionId) throw new Error('Control conflict');
  const { commandId: _commandId, ...returnedData } = input;
  const data = takeoverReturnRequestedDataSchema.parse(returnedData);
  const saved = await append(store, silo, `computer-${input.assistantId}`,
    'takeover.return_requested', data, input, facts.sequence, checkAccess);
  return checkedControl(saved.control);
}

export async function endWriter(store: EventStore, silo: string, raw: unknown,
  proveInputDrained: () => Promise<string | undefined>, checkAccess: AccessCheck) {
  const input: End = endSchema.parse(raw);
  const slot = WriterSlot.closeCurrent(store, silo, input);
  const facts = await current(store, silo, input.assistantId);
  const control = checkedControl(facts.control);
  const retry = repeatedEnd(control, input);
  if (retry) return retry;
  if (!sameOwner(control, input) || !['started', 'renewed', 'returning'].includes(control.phase)
    || control.writerSessionId !== input.writerSessionId
    || (input.reason === 'returned' && control.phase !== 'returning')) {
    throw new Error('Control conflict');
  }
  const locallyDrained = slot
    ? await Promise.race([slot.drain(), delay(CLOSURE_WAIT_MS, false, { ref: false })]) : false;
  let closureReceiptId: string | undefined;
  if (locallyDrained) {
    try {
      closureReceiptId = await Promise.race([
        proveInputDrained(), delay(CLOSURE_WAIT_MS, undefined, { ref: false }),
      ]);
    } catch {
      // A missing Pod receipt cannot turn socket closure into proof of delivery.
    }
  }
  const { commandId: _commandId, reason: _reason, ...binding } = input;
  const subject = `computer-${input.assistantId}`;
  const system = input.reason !== 'returned';
  const closureAccess = system ? accessNotRequired : checkAccess;
  if (!closureReceiptId) {
    const data = takeoverClosureUnknownDataSchema.parse({ ...binding,
      requestedEndReason: input.reason });
    const saved = await append(store, silo, subject, 'takeover.closure_unknown',
      data, input, facts.sequence, closureAccess, system);
    return checkedControl(saved.control);
  }
  const data = takeoverEndedWithProofDataSchema.parse({ ...binding, reason: input.reason,
    closureReceiptId, startedAt: control.startedAt, endedAt: new Date().toISOString(),
    canStartNewWork: input.reason === 'returned' });
  const saved = await append(store, silo, subject, 'takeover.ended',
    data, input, facts.sequence, closureAccess, system);
  return checkedControl(saved.control);
}
function accessNotRequired() { return Promise.resolve(); }

export class WriterSlot {
  private static active = new Map<string, WriterSlot>();
  private static consumed = new WeakMap<EventStore, Set<string>>();
  private static closed = new WeakMap<EventStore, Map<string, WriterSlot>>();
  private readonly key: string;
  private readonly input: Grant;
  private readonly store: EventStore;
  private readonly silo: string;
  private readonly checkAccess: AccessCheck;
  private owner = false;
  private claimed = false;
  private closed = false;
  private checking = false;
  private permissionUntil = 0;
  private leaseUntil = 0;
  private originalUntil = 0;
  private savedExpiresAt: string | undefined;
  private refreshTimer: ReturnType<typeof setInterval> | undefined;
  private deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingSends = new Set<Promise<void>>();
  private inputFailed = false;
  private readonly inputAbort = new AbortController();

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
    // Check access again after the computer read. That read can take ten seconds.
    const permissionUntil = performance.now() + 1500;
    await this.checkAccess();
    if (performance.now() >= permissionUntil) throw new Error('Control unavailable');
    const savedExpiry = this.savedControl(second);
    this.updateDeadlines(savedExpiry.expiresAt, savedExpiry.originalExpiresAt);
    this.permissionUntil = permissionUntil;
    this.scheduleDeadline();
  }

  private savedControl(facts: Awaited<ReturnType<typeof current>>) {
    validReady(facts, this.input);
    const control = checkedControl(facts.control);
    if (!['started', 'renewed'].includes(control.phase)
      || !sameOwner(control, this.input)
      || control.writerSessionId !== this.input.writerSessionId
      || control.proxyInstanceId !== this.input.proxyInstanceId
      || !control.expiresAt || !control.originalExpiresAt
      || control.originalExpiresAt !== this.input.originalExpiresAt
      || Date.parse(control.expiresAt) <= Date.now()) {
      throw new Error('Control unavailable');
    }
    return { expiresAt: control.expiresAt, originalExpiresAt: control.originalExpiresAt };
  }

  private updateDeadlines(expiresAt: string, originalExpiresAt: string) {
    const monotonicNow = performance.now();
    if (this.leaseUntil && monotonicNow >= this.leaseUntil) {
      throw new Error('Control unavailable');
    }
    if (!this.originalUntil) {
      const originalRemaining = Date.parse(originalExpiresAt) - Date.now();
      this.originalUntil = monotonicNow + originalRemaining;
    }
    if (this.savedExpiresAt !== expiresAt) {
      // Change the monotonic deadline only when a saved renewal changes the expiry.
      const remaining = Date.parse(expiresAt) - Date.now();
      this.leaseUntil = Math.min(this.originalUntil, monotonicNow + remaining);
      this.savedExpiresAt = expiresAt;
    }
    if (monotonicNow >= this.leaseUntil || monotonicNow >= this.originalUntil) {
      throw new Error('Control unavailable');
    }
  }

  private scheduleDeadline() {
    if (this.closed) return;
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    // Close queued input at the earliest deadline even while a refresh read is blocked.
    const deadline = Math.min(this.permissionUntil, this.leaseUntil, this.originalUntil);
    const remaining = Math.max(0, Math.ceil(deadline - performance.now()));
    this.deadlineTimer = setTimeout(this.close.bind(this), remaining);
    this.deadlineTimer.unref();
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
    this.claimed = true;
    this.refreshTimer = setInterval(this.scheduleRefresh.bind(this), 250);
    this.refreshTimer.unref();
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
  private scheduleRefresh() {
    void this.refresh();
  }
  allows(leaseId: string, writerSessionId: string) {
    const now = performance.now();
    return !this.closed && this.owner && now < this.permissionUntil
      && now < this.leaseUntil && leaseId === this.input.leaseId
      && writerSessionId === this.input.writerSessionId;
  }
  send(bytes: Buffer, forward: (bytes: Buffer, signal: AbortSignal) => void | Promise<void>) {
    if (!this.allows(this.input.leaseId, this.input.writerSessionId)) return false;
    try {
      const delivery = Promise.resolve(forward(bytes, this.inputAbort.signal));
      this.pendingSends.add(delivery);
      const complete = () => { this.pendingSends.delete(delivery); };
      const failed = () => { this.inputFailed = true; this.close(); complete(); };
      void delivery.then(complete, failed);
      return true;
    } catch {
      this.inputFailed = true;
      this.close();
      return false;
    }
  }
  async drain() {
    const pending = [...this.pendingSends];
    await Promise.allSettled(pending);
    return !this.inputFailed && this.pendingSends.size === 0;
  }
  close() {
    this.closed = true;
    this.owner = false;
    this.inputAbort.abort();
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    if (WriterSlot.active.get(this.key) === this) WriterSlot.active.delete(this.key);
    if (!this.claimed) return;
    let closed = WriterSlot.closed.get(this.store);
    if (!closed) {
      closed = new Map();
      WriterSlot.closed.set(this.store, closed);
    }
    closed.set(this.key, this);
  }
  static closeCurrent(store: EventStore, silo: string, input: Return) {
    const key = JSON.stringify([silo, input.assistantId]);
    const active = WriterSlot.active.get(key);
    if (active?.store === store && active.input.writerSessionId === input.writerSessionId
      && sameOwner(active.input, input)) {
      active.close();
      return active;
    }
    const closed = WriterSlot.closed.get(store)?.get(key);
    if (closed?.input.writerSessionId === input.writerSessionId
      && sameOwner(closed.input, input)) return closed;
    return undefined;
  }
  static hasCurrent(silo: string, assistantId: string, writerSessionId: string) {
    const key = JSON.stringify([silo, assistantId]);
    const active = WriterSlot.active.get(key);
    return active?.input.writerSessionId === writerSessionId &&
      active.allows(active.input.leaseId, writerSessionId);
  }
}
