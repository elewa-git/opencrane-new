import { createHash } from 'node:crypto';
import { history } from '@opencrane/models';
import {
  memoryMaintenanceBoundDataSchema,
  memoryMaintenanceRecordedDataSchema,
  memoryWrittenDataSchema,
  memoryForgottenDataSchema,
} from '@opencrane/events';
import type { EventEnvelope } from '@opencrane/events';
import type { EventStore, StoredEvent } from '@opencrane/event-store';
import type { Query } from '@opencrane/projections';

function currentTime(): Date {
  return new Date();
}

function digest(value: unknown): string {
  const hash = createHash('sha256');
  const encoded = JSON.stringify(value);
  hash.update(encoded);
  return hash.digest('hex');
}

function oldest(first: { position: number; memoryId: string },
  second: { position: number; memoryId: string }) {
  const firstId = Buffer.from(first.memoryId);
  const secondId = Buffer.from(second.memoryId);
  return first.position - second.position || Buffer.compare(firstId, secondId);
}

function contentInputs(rows: StoredEvent[]) {
  const facts = new Map<string, { memoryId: string; revision: number;
    expiresAt: string | null; position: number }>();
  let position = 0;
  for (const row of rows) {
    const type = row.event.type;
    if (type !== 'memory.written' && type !== 'memory.forgotten') {
      continue;
    }
    position = row.sequence;
    const schema = type === 'memory.written' ? memoryWrittenDataSchema : memoryForgottenDataSchema;
    const parsed = schema.safeParse(row.event.data);
    if (!parsed.success) {
      continue;
    }
    const data = parsed.data;
    const expiresAt = 'expiresAt' in data ? data.expiresAt : null;
    const reference = { memoryId: data.memoryId, revision: data.revision, expiresAt, position };
    facts.set(data.memoryId, reference);
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
      if (run.date === date) {
        return { binding, boundAt, overlap, claimed: true };
      }
      if (run.action === 'due') {
        overlap = true;
      }
    }
  }
  return { binding, boundAt, overlap, claimed: false };
}

async function recordScope(store: EventStore, silo: string, scopeId: string,
  intendedAt: string, clock: () => Date) {
  const subject = `scope-${scopeId}`;
  const deadline = performance.now() + 10_000;
  const rows = await history(store, subject, silo, deadline);
  const date = intendedAt.slice(0, 10);
  const { binding, boundAt, overlap, claimed } = nightState(rows, date);
  if (claimed) {
    return;
  }
  const boundaryTime = Date.parse(intendedAt);
  if (!binding?.enabled || Date.parse(boundAt) >= boundaryTime) {
    return;
  }
  const inputs = contentInputs(rows);
  if (!inputs.inputRefs.length) {
    return;
  }
  const revisionFields = [silo, scopeId, inputs];
  const inputRevision = digest(revisionFields);
  const nightFields = [silo, scopeId, date];
  const nightId = digest(nightFields);
  const batchFields = [silo, scopeId, date, inputRevision];
  const batchKey = digest(batchFields);
  // Read the clock after preparing this scope, so slow reads cannot extend its window.
  const selectedAt = clock();
  let action: 'refused' | 'missed' = 'refused';
  let reason: 'qualification_blocked' | 'window_missed' | 'overlap' = 'qualification_blocked';
  if (selectedAt.getTime() >= boundaryTime + 15 * 60_000) {
    action = 'missed';
    reason = 'window_missed';
  } else if (overlap) {
    action = 'missed';
    reason = 'overlap';
  }
  const selectionTime = selectedAt.toISOString();
  const data = { scopeId, nightId, batchKey, inputRevision, date,
    bindingRevision: binding.revision, memberId: binding.memberId, acceptedCapCents: 100,
    intendedAt, selectedAt: selectionTime, inputRefs: inputs.inputRefs, action, reason };
  const event: EventEnvelope = { id: nightId, type: 'memory.maintenance_recorded', subject, silo,
    source: 'opencrane-nightly', time: selectionTime, commandId: nightId,
    principal: { kind: 'system', id: 'nightly-memory' }, correlation: {}, data };
  const expectedSequence = rows.at(-1)?.sequence ?? 0;
  await claimNight(store, event, expectedSequence);
}

async function claimNight(store: EventStore, event: EventEnvelope, expectedSequence: number) {
  // Claim one night in the event log. Queue retention and SQL rows cannot grant another attempt.
  const command = { event, expectedSequence, historyChecked: true as const };
  const result = await store.append(command);
  if (result.status === 'conflict' || result.status === 'rejected') {
    const deadline = performance.now() + 10_000;
    const current = await history(store, event.subject, event.silo, deadline);
    for (const row of current) {
      if (row.event.id === event.id && row.event.type === event.type) {
        return;
      }
    }
    throw new Error('Nightly scope changed; reconcile the original night on redelivery');
  }
  if (result.status !== 'appended') {
    throw new Error('Nightly intent append unavailable');
  }
}

export async function scanNightlyMemory(db: Query, store: EventStore, silo: string,
  occurrence: Date, clock: () => Date = currentTime) {
  // Keep the original trigger's night even when delivery resumes on a later date.
  const boundary = new Date(occurrence);
  boundary.setUTCHours(2, 0, 0, 0);
  if (boundary.getTime() > occurrence.getTime()) {
    boundary.setUTCDate(boundary.getUTCDate() - 1);
  }
  const intendedAt = boundary.toISOString();
  const position = await store.head();
  const checkpoint = await db.query<{ sequence: string }>(
    "SELECT sequence FROM projection_checkpoints WHERE name='memory'");
  if (Number(checkpoint.rows[0]?.sequence) < position || !checkpoint.rows.length) {
    throw new Error('Nightly memory metadata is behind the event log');
  }
  let cursor = '';
  while (true) {
    const values = [silo, cursor, position];
    const candidates = await db.query<{ scope_id: string }>(
      `SELECT scope_id FROM memory_maintenance_bindings WHERE silo=$1 AND scope_id>$2
       AND position<=$3 ORDER BY scope_id LIMIT 100`, values);
    for (const candidate of candidates.rows) {
      await recordScope(store, silo, candidate.scope_id, intendedAt, clock);
      cursor = candidate.scope_id;
    }
    if (candidates.rows.length < 100) {
      return;
    }
  }
}
