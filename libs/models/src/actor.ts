import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { EventStore } from '@opencrane/event-store';
import { effectObservedDataSchema, parseEventByType, type EventEnvelope } from '@opencrane/events';
import { registerHandler } from '@opencrane/handlers';
import { applyBudget, costCents, data, emptyBudget, priceTableId, totals, type ModelCall } from './state.ts';

export async function history(store: EventStore, subject: string, silo: string) {
  const rows = [];
  for await (const row of store.readStream(subject)) {
    if (row.event.silo !== silo) throw new Error('Wrong silo');
    rows.push(row);
  }
  return rows;
}
export function envelope(silo: string, subject: string, type: string, payload: unknown, id: string = randomUUID(), now = new Date()): EventEnvelope {
  const parsed = parseEventByType({ id, commandId: id, type, subject, silo, data: payload,
    source: 'models', time: now.toISOString(), principal: { kind: 'system', id: 'models' } });
  if (!parsed.success) throw new Error('Invalid model event');
  return parsed.event;
}
export class BudgetActor {
  readonly state = emptyBudget();
  private sequence = 0;
  private queue = Promise.resolve();
  private auditQueue = Promise.resolve();
  private failed = false;
  private exhaustedDay: string | undefined;
  readonly store: EventStore;
  readonly silo: string;
  readonly now: () => Date;
  constructor(store: EventStore, silo: string, now = () => new Date()) { this.store = store; this.silo = silo; this.now = now; }
  // Call only after winning the process leadership lease. A new append fences the old leader.
  async start(dailyCeilingCents = 2000, ceilingCents = 20000) {
    for (const row of await history(this.store, `budget-${this.silo}`, this.silo)) {
      this.apply(row.event); this.sequence = row.sequence;
    }
    if (!this.sequence) await this.append('budget.ceiling_set', { scope: 'global', dailyCeilingCents, ceilingCents, setBy: 'installation' });
    await this.append('budget.period_started', { periodStart: this.now().toISOString() });
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(() => {
      if (this.failed) throw new Error('Budget writer unavailable');
      return work();
    });
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
  private async append(type: string, payload: unknown) {
    const event = envelope(this.silo, `budget-${this.silo}`, type, payload, randomUUID(), this.now());
    const result = await this.store.append({ event, expectedSequence: this.sequence });
    if (result.status !== 'appended') { this.failed = true; throw new Error('Budget writer lost its fence'); }
    this.sequence = result.sequence;
    this.apply(event);
  }
  private apply(event: EventEnvelope) {
    applyBudget(this.state, event);
    // Leadership changes do not reset a refusal; budget changes or a new UTC day do.
    if (event.type !== 'budget.period_started') {
      this.exhaustedDay = event.type === 'budget.exhausted' ? event.time.slice(0, 10) : undefined;
    }
  }
  reserve(call: ModelCall, amountCents: number) {
    return this.serial(async () => {
      z.int().positive().parse(amountCents);
      const t = totals(this.state, this.now());
      if (t.todayCents + t.reservedCents + amountCents > t.dailyCeilingCents ||
          t.monthCents + t.reservedCents + amountCents > t.ceilingCents) {
        if (this.exhaustedDay !== this.now().toISOString().slice(0, 10)) await this.append('budget.exhausted', { scope: 'global' });
        throw new Error('Silo spending cap reached; wait for the next budget period');
      }
      const id = randomUUID();
      await this.append('budget.reserved', { reservationId: id, permitId: id, amountCents,
        payingGroupId: this.silo, assistantId: call.assistantId, modelCall: call });
      return id;
    });
  }
  settle(event: EventEnvelope) {
    return this.serial(async () => {
      if (event.silo !== this.silo || event.type !== 'effect.observed') throw new Error('Wrong effect');
      const d = effectObservedDataSchema.parse(event.data);
      const r = this.state.reservations.find(r => r.id === d.permitId);
      const validCost = d.usage ? d.usage.priceTableId === priceTableId &&
        d.costCents === costCents(d.tool, d.usage.inputTokens, d.usage.outputTokens) : d.outcome === 'error' && d.costCents === 0;
      if (!r || !validCost || d.computerId !== r.call.computerId || d.tool !== r.call.model) throw new Error('Usage does not match reservation');
      if (r.settledCents !== undefined) {
        if (r.settledCents !== d.costCents) throw new Error('Conflicting settlement');
        return;
      }
      // Never erase a larger observed charge. Overruns stop subsequent reservations.
      await this.append('budget.settled', { reservationId: r.id, permitId: r.id, settledCents: d.costCents });
    });
  }
  async effect(id: string, usage?: { inputTokens: number; outputTokens: number }, outcome: 'success' | 'error' = 'success') {
    const r = this.state.reservations.find(r => r.id === id);
    if (!r) throw new Error('Unmatched gateway reservation');
    const type = usage || outcome === 'error' ? 'effect.observed' : 'effect.uncertain';
    const eventId = `${id}:${type}`;
    const rows = await history(this.store, `effect-${id}`, this.silo);
    if (rows.some(row => row.event.id === eventId)) return;
    const payload = type === 'effect.observed' ? { permitId: id, computerId: r.call.computerId, tool: r.call.model, destination: 'openai',
      costCents: usage ? costCents(r.call.model, usage.inputTokens, usage.outputTokens) : 0, outcome,
      ...(usage ? { usage: { ...usage, priceTableId } } : {}) }
      : { permitId: id, computerId: r.call.computerId, reason: 'settle_timeout' };
    const result = await this.store.append({ event: envelope(this.silo, `effect-${id}`, type, payload, eventId),
      expectedSequence: rows.at(-1)?.sequence ?? 0 });
    if (result.status !== 'appended') throw new Error('Effect append failed');
  }
  async expire() {
    for (const r of this.state.reservations) {
      if (r.settledCents === undefined && this.now().getTime() - Date.parse(r.time) > 180_000) await this.effect(r.id);
    }
  }
  refuse(context?: { requesterId: string; assistantId: string; claims: unknown }) {
    const result = this.auditQueue.then(() => this.appendRefusal(context));
    this.auditQueue = result.catch(() => undefined);
    return result;
  }
  private async appendRefusal(context?: { requesterId: string; assistantId: string; claims: unknown }) {
    const id = randomUUID();
    const event = envelope(this.silo, `security-${this.silo}`, 'security.alert_raised', { alertId: id,
      severity: 'low', reason: 'model_request_refused', decision: { outcome: 'deny',
        ...(context ? { requesterId: context.requesterId, assistantId: context.assistantId } : {}),
        contextDigest: createHash('sha256').update(JSON.stringify(context?.claims ?? 'unverified')).digest('hex') } }, id);
    for (let attempt = 0; attempt < 3; attempt++) {
      const rows = await history(this.store, event.subject, this.silo);
      const result = await this.store.append({ event, expectedSequence: rows.at(-1)?.sequence ?? 0 });
      if (result.status === 'appended') return;
      if (result.status !== 'conflict') break;
    }
    throw new Error('Decision audit unavailable');
  }
  async settleRecorded(id: string, eventId: string) {
    const row = (await history(this.store, `effect-${id}`, this.silo)).find(row => row.event.id === eventId);
    if (!row) throw new Error('Effect not recorded');
    await this.settle(row.event);
  }
}
export function settlementHandler(decisionUrl: string) {
  return registerHandler('settle-budget', async event => {
    const d = data(event);
    const response = await fetch(`${decisionUrl}/settle`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ permitId: d['permitId'], eventId: event.id }), signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error('Budget settlement unavailable');
  });
}
