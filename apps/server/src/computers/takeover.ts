import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { history, envelope } from '@opencrane/models';
import type { StoredEvent } from '@opencrane/event-store';
import { readEvents } from '@opencrane/projections';
import { viewAccess } from './view-access.ts';
import type { LiveViewOptions } from './view-access.ts';

const leaseSchema = z.object({ assistantId: z.string(), computerId: z.string(), generation: z.int(), podUid: z.string().optional(),
  requestedBy: z.string(), conversationId: z.string(), turnId: z.string(), leaseId: z.string(), expiresAt: z.string(),
  affectedTurns: z.array(z.object({ conversationId: z.string(), turnId: z.string(), threadId: z.string().optional(), requesterId: z.string() })) });
type Lease = z.infer<typeof leaseSchema>;
export type ControlReason = 'released' | 'disconnected' | 'expired' | 'access_changed' | 'protocol' | 'slow_viewer' | 'upstream' | 'shutdown' | 'crash';

export function takeover(options: LiveViewOptions) {
  const leases = new Map<string, { data: Lease; close?: (() => void) | undefined; connected: boolean; endReason?: ControlReason }>();
  const processing = new Set<string>();
  const ending = new Map<string, Promise<void>>();
  const recovering = new Map<string, Lease>();
  let recovered = false;
  async function access(memberId: string, conversationId: string) {
    const computer = await viewAccess(options, memberId, conversationId);
    const rows = await history(options.store, `conversation-${conversationId}`, options.silo);
    const message = rows.findLast(r => r.event.type === 'message.posted');
    if (!message || z.object({ authorId: z.string() }).parse(message.event.data).authorId !== memberId) throw new Error('Current requester required');
    return { ...computer, turnId: message.event.id };
  }
  async function state(assistantId: string) {
    const rows = await history(options.store, `computer-${assistantId}`, options.silo);
    const latest = rows.findLast(r => r.event.type.startsWith('takeover.'));
    return { rows, latest, data: latest ? leaseSchema.parse(latest.event.data) : undefined };
  }
  function validateTransition(current: Awaited<ReturnType<typeof state>>, type: string) {
    const previous = current.latest?.event.type;
    const released = previous === 'takeover.ended' && z.object({ reason: z.string() }).parse(current.latest!.event.data).reason === 'released';
    switch (type) {
      case 'takeover.requested': if (current.latest && !released) throw new Error('Already paused'); break;
      case 'takeover.started':
      case 'takeover.failed': if (previous !== 'takeover.requested') throw new Error('Pause transition changed'); break;
      case 'takeover.renewed': if (!['takeover.started', 'takeover.renewed'].includes(previous ?? '')) throw new Error('Control ended'); break;
      case 'takeover.ended': if (released) throw new Error('Already released'); break;
      default: throw new Error('Unknown takeover transition');
    }
  }
  async function append(type: string, data: Lease, extra: Record<string, string> = {}, expectedSequence?: number) {
    const current = await state(data.assistantId);
    if (type !== 'takeover.requested' && current.data?.leaseId !== data.leaseId) throw new Error('Lease changed');
    validateTransition(current, type);
    const event = envelope(options.silo, `computer-${data.assistantId}`, type, { ...data, ...extra });
    event.source = 'opencrane-server'; event.principal = { kind: 'human', id: extra['endedBy'] ?? data.requestedBy };
    event.correlation = { conversation: data.conversationId, turn: data.turnId };
    const result = await options.store.append({ event, expectedSequence: expectedSequence ?? current.rows.at(-1)?.sequence ?? 0 });
    if (result.status !== 'appended') throw new Error('Takeover audit unavailable');
    return { event, sequence: result.sequence };
  }
  // Execution effects use only committed takeover events, including retries and recovery.
  async function pauseCommitted(row: StoredEvent, computer: Pick<Lease, 'computerId' | 'generation' | 'podUid'>) {
    if (!options.control) throw new Error('Pause unavailable');
    if (!row.event.type.startsWith('takeover.') || (row.event.type === 'takeover.ended' && z.object({ reason: z.string() }).parse(row.event.data).reason === 'released')) throw new Error('No pause event');
    await options.control(computer, 'pause', leaseSchema.parse(row.event.data).leaseId, row.sequence);
  }
  async function stop(leaseId: string, reason: ControlReason) {
    const previous = ending.get(leaseId); if (previous) return previous;
    const lease = leases.get(leaseId); if (!lease) return;
    lease.endReason ??= reason;
    lease.close?.(); lease.close = undefined;
    const work = append('takeover.ended', lease.data, { endedBy: lease.data.requestedBy, reason: lease.endReason }).then(() => { leases.delete(leaseId); });
    ending.set(leaseId, work);
    try { await work; } finally { ending.delete(leaseId); }
  }
  async function recoverPause(data: Lease) {
    if (processing.has(data.leaseId)) return;
    processing.add(data.leaseId);
    try {
      const saved = await state(data.assistantId);
      if (saved.data?.leaseId !== data.leaseId || (saved.latest?.event.type === 'takeover.ended' && z.object({ reason: z.string() }).parse(saved.latest.event.data).reason === 'released')) {
        recovering.delete(data.leaseId); return;
      }
      const current = saved.rows.findLast(r => r.event.type === 'computer.ready');
      if (!options.control || !current) return;
      // Trusted recovery uses the current Pod binding, never the abandoned writer's transport.
      const computer = leaseSchema.pick({ assistantId: true, computerId: true, generation: true, podUid: true }).parse(current.event.data);
      try { await pauseCommitted(saved.latest!, computer); recovering.delete(data.leaseId); }
      catch { /* Keep retrying; missing Pods and expired credentials grant no writer. */ }
      if (['takeover.requested', 'takeover.started', 'takeover.renewed'].includes(saved.latest!.event.type))
        await append('takeover.ended', data, { endedBy: data.requestedBy, reason: 'crash' });
    } finally { processing.delete(data.leaseId); }
  }
  return {
    async start(memberId: string, conversationId: string, sessionExpiry: number) {
      if (!options.control) throw new Error('Pause unavailable');
      const computer = await access(memberId, conversationId);
      const current = await state(computer.assistantId);
      const active = new Map<string, Lease['affectedTurns'][number]>();
      for (const { event } of current.rows) {
        if (event.type === 'computer.turn_started') { const turn = leaseSchema.shape.affectedTurns.element.parse(event.data); active.set(turn.turnId, turn); }
        if (event.type === 'computer.turn_closed') active.delete(z.object({ turnId: z.string() }).parse(event.data).turnId);
      }
      const data: Lease = { ...computer, requestedBy: memberId, conversationId, leaseId: randomUUID(),
        expiresAt: new Date(Math.min(Date.now() + 120_000, sessionExpiry)).toISOString(), affectedTurns: [...active.values()] };
      processing.add(data.leaseId);
      let requested: StoredEvent;
      try { requested = await append('takeover.requested', data, {}, current.rows.at(-1)?.sequence ?? 0); }
      catch (error) { processing.delete(data.leaseId); throw error; }
      try {
        await pauseCommitted(requested, computer);
        // The bridge's durable terminal reports must be observed before admitting a writer.
        const deadline = Date.now() + 10_000;
        while (true) {
          const rows = (await state(data.assistantId)).rows;
          if (data.affectedTurns.every(turn => rows.some(r => r.event.type === 'computer.turn_closed' && z.object({ turnId: z.string() }).parse(r.event.data).turnId === turn.turnId))) break;
          if (Date.now() >= deadline) throw new Error('Thread reports unavailable');
          await delay(50);
        }
        const fresh = await access(memberId, conversationId);
        if (JSON.stringify(fresh) !== JSON.stringify(computer) || Date.parse(data.expiresAt) <= Date.now()) throw new Error('Access changed');
        await append('takeover.started', data);
        leases.set(data.leaseId, { data, connected: false }); return data;
      } catch {
        await append('takeover.failed', data, { reason: 'pause_failed' }); throw new Error('Pause failed; agent paused');
      } finally { processing.delete(data.leaseId); }
    },
    async check(memberId: string, conversationId: string, leaseId: string) {
      const lease = leases.get(leaseId);
      if (!lease || lease.endReason || lease.data.requestedBy !== memberId || lease.data.conversationId !== conversationId || Date.parse(lease.data.expiresAt) <= Date.now()) throw new Error('Control closed');
      const computer = await access(memberId, conversationId), saved = await state(computer.assistantId);
      if (computer.generation !== lease.data.generation || computer.podUid !== lease.data.podUid || computer.turnId !== lease.data.turnId || saved.data?.leaseId !== leaseId || !['takeover.started', 'takeover.renewed'].includes(saved.latest!.event.type)) throw new Error('Control changed');
      return lease.data;
    },
    connect(leaseId: string, close: () => void) {
      const lease = leases.get(leaseId);
      if (!lease || lease.connected) throw new Error('Writer already used');
      lease.connected = true; lease.close = close;
    },
    async renew(memberId: string, conversationId: string, leaseId: string, sessionExpiry: number) {
      const data = await this.check(memberId, conversationId, leaseId);
      const renewed = { ...data, expiresAt: new Date(Math.min(Date.now() + 120_000, sessionExpiry)).toISOString() };
      await append('takeover.renewed', renewed); leases.get(leaseId)!.data = renewed; return renewed;
    },
    async release(memberId: string, conversationId: string, leaseId: string) {
      if (!options.control) throw new Error('Pause unavailable');
      const computer = await access(memberId, conversationId), saved = await state(computer.assistantId);
      if (!saved.data || saved.data.leaseId !== leaseId || saved.data.conversationId !== conversationId) throw new Error('Foreign control');
      if (processing.has(leaseId)) throw new Error('Still taking control');
      validateTransition(saved, 'takeover.ended');
      // Destroy the transport before persisting release or issuing fresh turns/tokens.
      leases.get(leaseId)?.close?.(); leases.delete(leaseId);
      await append('takeover.ended', saved.data, { endedBy: memberId, reason: 'released' });
    },
    async status(memberId: string, conversationId: string) {
      const computer = await access(memberId, conversationId), saved = await state(computer.assistantId);
      const released = !saved.latest || (saved.latest.event.type === 'takeover.ended' && z.object({ reason: z.string() }).parse(saved.latest.event.data).reason === 'released');
      return { status: released ? 'ready' : leases.has(saved.data!.leaseId) ? 'controlling' : 'paused',
        ...(saved.data?.conversationId === conversationId && !released ? { leaseId: saved.data.leaseId, expiresAt: saved.data.expiresAt } : {}) };
    },
    async reconcile() {
      for (const [id, lease] of leases) {
        try { await this.check(lease.data.requestedBy, lease.data.conversationId, id); }
        catch { await stop(id, Date.parse(lease.data.expiresAt) <= Date.now() ? 'expired' : 'access_changed'); }
      }
      for (const data of recovering.values()) await recoverPause(data);
      if (recovered) return;
      // Recover abandoned intent/start/renewal after a proxy crash. No writer is reconstructed.
      const candidates = new Map<string, Lease>();
      for await (const { event } of readEvents(options.store, 1, await options.store.head())) {
        if (event.silo !== options.silo || !event.type.startsWith('takeover.')) continue;
        const data = leaseSchema.parse(event.data);
        if (event.type !== 'takeover.ended' || z.object({ reason: z.string() }).parse(event.data).reason !== 'released') candidates.set(data.assistantId, data);
        else candidates.delete(data.assistantId);
      }
      for (const data of candidates.values()) if (!leases.has(data.leaseId) && !processing.has(data.leaseId)) { recovering.set(data.leaseId, data); await recoverPause(data); }
      recovered = true;
    },
    stop,
    expires(leaseId: string) { return Date.parse(leases.get(leaseId)?.data.expiresAt ?? '1970-01-01'); },
    async close() { for (const id of leases.keys()) await stop(id, 'shutdown'); },
  };
}
