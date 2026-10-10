import { isDeepStrictEqual } from 'node:util';
import { computerTurnStartedDataSchema, computerTurnClosedDataSchema,
  delegationStartedDataSchema, delegationCompletedDataSchema,
  parseEventByType, type EventEnvelope } from '@opencrane/events';
import type { Query } from './db.ts';
import type { Projection } from './runner.ts';

async function create(db: Query): Promise<void> {
  await db.query(`CREATE TABLE IF NOT EXISTS delegations (
    silo TEXT NOT NULL, delegation_id TEXT NOT NULL, root_id TEXT, parent_delegation_id TEXT,
    start JSONB NOT NULL, start_event_id TEXT NOT NULL, start_position BIGINT NOT NULL,
    outcome JSONB, outcome_event_id TEXT, outcome_position BIGINT,
    PRIMARY KEY (silo, delegation_id))`);
  await db.query(`CREATE INDEX IF NOT EXISTS delegations_root
    ON delegations (silo, root_id, parent_delegation_id)`);
  await db.query(`CREATE TABLE IF NOT EXISTS computer_delegations (
    silo TEXT NOT NULL, assistant_id TEXT NOT NULL, generation BIGINT NOT NULL,
    root_id TEXT NOT NULL, delegation_id TEXT NOT NULL, turn_id TEXT NOT NULL,
    start JSONB NOT NULL, start_event_id TEXT NOT NULL, start_position BIGINT NOT NULL,
    status TEXT, close_event_id TEXT, close_position BIGINT,
    PRIMARY KEY (silo, assistant_id, turn_id))`);
  await db.query(`CREATE INDEX IF NOT EXISTS computer_delegations_root
    ON computer_delegations (silo, assistant_id, generation, root_id)`);
}
async function drop(db: Query): Promise<void> {
  await db.query('DROP TABLE IF EXISTS delegations, computer_delegations');
}
async function apply(db: Query, event: EventEnvelope, position: number): Promise<void> {
  if (event.type === 'computer.turn_started' || event.type === 'computer.turn_closed') {
    if (!parseEventByType(event).success) throw new Error('Invalid computer turn event');
    await applyComputer(db, event, position);
    return;
  }
  if (event.type !== 'delegation.started' && event.type !== 'delegation.completed') return;
  if (!parseEventByType(event).success) throw new Error('Invalid delegation event');
  if (event.type === 'delegation.started') {
    await applyStart(db, event, position);
    return;
  }
  await applyOutcome(db, event, position);
}
async function applyStart(db: Query, event: EventEnvelope, position: number): Promise<void> {
  const data = delegationStartedDataSchema.parse(event.data);
  if (event.subject !== `delegation-${data.delegationId}`) {
    throw new Error('Delegation subject mismatch');
  }
  const modern = 'version' in data;
  const rootId = modern ? data.rootId : null;
  const parentId = modern ? data.parentDelegationId ?? null : null;
  await db.query(`INSERT INTO delegations
    (silo, delegation_id, root_id, parent_delegation_id, start, start_event_id, start_position)
    VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`,
  [event.silo, data.delegationId, rootId, parentId, JSON.stringify(data), event.id, position]);
}
async function applyOutcome(db: Query, event: EventEnvelope, position: number): Promise<void> {
  const data = delegationCompletedDataSchema.parse(event.data);
  if (event.subject !== `delegation-${data.delegationId}`) {
    throw new Error('Delegation subject mismatch');
  }
  const saved = await db.query<{ start: unknown; outcome: unknown }>(
    'SELECT start, outcome FROM delegations WHERE silo = $1 AND delegation_id = $2',
    [event.silo, data.delegationId]);
  const row = saved.rows[0];
  if (!row) throw new Error('Delegation outcome requires a start');
  const start = delegationStartedDataSchema.parse(row.start);
  if (('version' in start) !== ('version' in data)) throw new Error('Mixed delegation formats');
  // Keep the first terminal outcome so late success cannot undo cancellation.
  if (row.outcome !== null) return;
  await db.query(`UPDATE delegations SET outcome = $3, outcome_event_id = $4,
    outcome_position = $5 WHERE silo = $1 AND delegation_id = $2`,
  [event.silo, data.delegationId, JSON.stringify(data), event.id, position]);
}
async function applyComputer(db: Query, event: EventEnvelope, position: number): Promise<void> {
  if (event.type === 'computer.turn_started') {
    const data = computerTurnStartedDataSchema.parse(event.data);
    if (data.task !== 'native_descendant') return;
    if (event.subject !== `computer-${data.assistantId}`) throw new Error('Computer subject mismatch');
    await db.query(`INSERT INTO computer_delegations
      (silo, assistant_id, generation, root_id, delegation_id, turn_id,
       start, start_event_id, start_position)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT DO NOTHING`,
    [event.silo, data.assistantId, data.generation, data.rootId, data.delegationId, data.turnId,
      JSON.stringify(data), event.id, position]);
    return;
  }
  const data = computerTurnClosedDataSchema.parse(event.data);
  if (data.task !== 'native_descendant') return;
  if (event.subject !== `computer-${data.assistantId}`) throw new Error('Computer subject mismatch');
  const saved = await db.query<{ start: unknown; status: string | null }>(
    `SELECT start, status FROM computer_delegations WHERE silo = $1 AND assistant_id = $2
      AND turn_id = $3`, [event.silo, data.assistantId, data.turnId]);
  const row = saved.rows[0];
  const { status, ...binding } = data;
  if (!row || !isDeepStrictEqual(row.start, binding)) throw new Error('Native close binding mismatch');
  if (row.status !== null) return;
  await db.query(`UPDATE computer_delegations SET status = $4, close_event_id = $5,
    close_position = $6 WHERE silo = $1 AND assistant_id = $2 AND turn_id = $3`,
  [event.silo, data.assistantId, data.turnId, status, event.id, position]);
}

export const delegations: Projection = { name: 'delegations', create, drop, apply };
