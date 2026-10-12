import { createHash } from 'node:crypto';
import { history } from '@opencrane/models';
import { memoryMaintenanceBoundDataSchema, memoryMaintenanceRecordedDataSchema,
  memoryWrittenDataSchema, memoryForgottenDataSchema } from '@opencrane/events';
import type { EventEnvelope } from '@opencrane/events';
import type { EventStore, StoredEvent } from '@opencrane/event-store';
import type { Query } from '@opencrane/projections';

function digest(value: unknown): string {
  const hash = createHash('sha256');
  hash.update(JSON.stringify(value));
  return hash.digest('hex');
}
function contentInputs(rows: StoredEvent[]) {
  const facts = new Map<string, { memoryId: string; revision: number;
    expiresAt: string | null; position: number }>();
  let position = 0;
  for (const row of rows) {
    const type = row.event.type;
    if (type !== 'memory.written' && type !== 'memory.forgotten') continue;
    position = row.sequence;
    const schema = type === 'memory.written' ? memoryWrittenDataSchema : memoryForgottenDataSchema;
    const parsed = schema.safeParse(row.event.data);
    if (!parsed.success) continue;
    const data = parsed.data;
    const expiresAt = 'expiresAt' in data ? data.expiresAt : null;
    facts.set(data.memoryId, { memoryId: data.memoryId, revision: data.revision,
      expiresAt, position });
  }
  function oldest(first: { position: number; memoryId: string },
    second: { position: number; memoryId: string }) {
    return first.position - second.position || Buffer.compare(
      Buffer.from(first.memoryId), Buffer.from(second.memoryId));
  }
  const ordered = [...facts.values()];
  ordered.sort(oldest);
  const inputRefs = ordered.slice(0, 32);
  return { position, inputRefs };
}
function nightState(rows: StoredEvent[], date: string) {
  let binding;
  let boundAt = '';
  let overlap = false;
  for (const row of rows) {
    if (row.event.type === 'memory.maintenance_bound') {
      binding = memoryMaintenanceBoundDataSchema.parse(row.event.data);
      boundAt = row.event.time;
    }
    if (row.event.type === 'memory.maintenance_recorded') {
      const run = memoryMaintenanceRecordedDataSchema.parse(row.event.data);
      if (run.date === date) return { binding, boundAt, overlap, claimed: true };
      if (run.action === 'due') overlap = true;
    }
  }
  return { binding, boundAt, overlap, claimed: false };
}
async function recordScope(store: EventStore, silo: string, scopeId: string, now: Date,
  intendedAt: string) {
  const subject = `scope-${scopeId}`;
  const rows = await history(store, subject, silo, performance.now() + 10_000);
  const date = intendedAt.slice(0, 10);
  const { binding, boundAt, overlap, claimed } = nightState(rows, date);
  if (claimed) return;
  if (!binding?.enabled || Date.parse(boundAt) >= Date.parse(intendedAt)) return;
  const inputs = contentInputs(rows);
  if (!inputs.inputRefs.length) return;
  const inputRevision = digest([silo, scopeId, inputs]);
  const nightId = digest([silo, scopeId, date]);
  const batchKey = digest([silo, scopeId, date, inputRevision]);
  let action: 'refused' | 'missed' = 'refused';
  let reason: 'qualification_blocked' | 'window_missed' | 'overlap' = 'qualification_blocked';
  if (now.getTime() >= Date.parse(intendedAt) + 15 * 60_000) {
    action = 'missed';
    reason = 'window_missed';
  } else if (overlap) {
    action = 'missed';
    reason = 'overlap';
  }
  const data = { scopeId, nightId, batchKey, inputRevision, date,
    bindingRevision: binding.revision, memberId: binding.memberId, acceptedCapCents: 100,
    intendedAt, selectedAt: now.toISOString(), inputRefs: inputs.inputRefs, action, reason };
  const event: EventEnvelope = { id: nightId, type: 'memory.maintenance_recorded', subject, silo,
    source: 'opencrane-nightly', time: now.toISOString(), commandId: nightId,
    principal: { kind: 'system', id: 'nightly-memory' }, correlation: {}, data };
  await claimNight(store, event, rows.at(-1)?.sequence ?? 0);
}
async function claimNight(store: EventStore, event: EventEnvelope, expectedSequence: number) {
  // Claim one night in the event log. Queue retention and SQL rows cannot grant another attempt.
  const command = { event, expectedSequence: expectedSequence,
    historyChecked: true as const };
  const result = await store.append(command);
  if (result.status === 'conflict' || result.status === 'rejected') {
    const current = await history(store, event.subject, event.silo, performance.now() + 10_000);
    for (const row of current) {
      if (row.event.id === event.id && row.event.type === event.type) return;
    }
    throw new Error('Nightly scope changed; reconcile the original night on redelivery');
  }
  if (result.status !== 'appended') throw new Error('Nightly intent append unavailable');
}

export async function scanNightlyMemory(db: Query, store: EventStore, silo: string, now: Date) {
  const boundary = new Date(now);
  boundary.setUTCHours(2, 0, 0, 0);
  if (boundary.getTime() > now.getTime()) boundary.setUTCDate(boundary.getUTCDate() - 1);
  const position = await store.head();
  const checkpoint = await db.query<{ sequence: string }>(
    "SELECT sequence FROM projection_checkpoints WHERE name='memory'");
  if (Number(checkpoint.rows[0]?.sequence) < position || !checkpoint.rows.length) {
    throw new Error('Nightly memory metadata is behind the event log');
  }
  let cursor = '';
  while (true) {
    const candidates = await db.query<{ scope_id: string }>(
      `SELECT scope_id FROM memory_maintenance_bindings WHERE silo=$1 AND scope_id>$2
       AND position<=$3 ORDER BY scope_id LIMIT 100`, [silo, cursor, position]);
    for (const candidate of candidates.rows) {
      await recordScope(store, silo, candidate.scope_id, now, boundary.toISOString());
      cursor = candidate.scope_id;
    }
    if (candidates.rows.length < 100) return;
  }
}
