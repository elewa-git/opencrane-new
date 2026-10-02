import { getEventDefinition } from '@opencrane/events';
import type { ComputerRow } from '@opencrane/protocol';
import type { Projection } from './runner.ts';

const eventTypes = new Set([
  'assistant.created', 'computer.claimed', 'computer.ready', 'computer.suspended',
  'computer.resumed', 'computer.lost', 'computer.retired',
]);
export const replayComputersTable = 'computers_replay';

function field(data: unknown, name: string): string {
  if (typeof data !== 'object' || data === null) throw new Error('Invalid computer event data');
  const value: unknown = Reflect.get(data, name);
  if (typeof value !== 'string') throw new Error(`Missing computer ${name}`);
  return value;
}
function numberField(data: unknown, name: string): number {
  if (typeof data !== 'object' || data === null) throw new Error('Invalid computer event data');
  const value: unknown = Reflect.get(data, name);
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error(`Missing computer ${name}`);
  return value;
}

function computerProjection(name: string, table: string): Projection {
  return {
    name,
    async create(db) {
      await db.query(`CREATE TABLE IF NOT EXISTS ${table} (
        silo TEXT NOT NULL, assistant_id TEXT NOT NULL, owner_id TEXT NOT NULL,
        kind TEXT NOT NULL, computer_id TEXT, sandbox_uid TEXT, generation INTEGER NOT NULL DEFAULT 0,
        token_id TEXT, status TEXT NOT NULL, changed_at TEXT NOT NULL, position BIGINT NOT NULL,
        PRIMARY KEY (silo, assistant_id))`);
    },
    drop: (db) => db.query(`DROP TABLE IF EXISTS ${table}`).then(() => undefined),
    async apply(db, event, position) {
      if (!eventTypes.has(event.type)) return;
      const data: unknown = getEventDefinition(event.type)?.dataSchema.parse(event.data);
      const assistantId = field(data, 'assistantId');
      if (event.type === 'assistant.created') {
        if (event.subject !== `assistant-${assistantId}`) throw new Error('Assistant subject mismatch');
        await db.query(`INSERT INTO ${table}
          (silo, assistant_id, owner_id, kind, status, changed_at, position)
          VALUES ($1, $2, $3, $4, 'claiming', $5, $6)
          ON CONFLICT (silo, assistant_id) DO NOTHING`,
        [event.silo, assistantId, field(data, 'ownerId'), field(data, 'kind'), event.time, position]);
        return;
      }
      if (event.subject !== `computer-${assistantId}`) throw new Error('Computer subject mismatch');
      const status = ({ 'computer.claimed': 'claiming', 'computer.ready': 'ready',
        'computer.suspended': 'suspended', 'computer.resumed': 'starting',
        'computer.lost': 'lost', 'computer.retired': 'retired' } as Record<string, string>)[event.type];
      const claimed = event.type === 'computer.claimed';
      const resumed = event.type === 'computer.resumed';
      const result = await db.query(`UPDATE ${table} SET computer_id = COALESCE($3, computer_id),
        sandbox_uid = COALESCE($4, sandbox_uid), generation = COALESCE($5, generation),
        token_id = COALESCE($6, token_id), status = $7, changed_at = $8, position = $9
        WHERE silo = $1 AND assistant_id = $2 RETURNING assistant_id`, [event.silo, assistantId,
        claimed ? field(data, 'computerId') : null, claimed ? field(data, 'sandboxUid') : null,
        claimed ? numberField(data, 'generation') : null,
        claimed || resumed ? field(data, 'tokenId') : null, status, event.time, position]);
      if (!result.rows.length) throw new Error('Computer event requires an assistant');
    },
  };
}

export const computers = computerProjection('computers', 'computers');
export const replayComputers = computerProjection('computers-replay', replayComputersTable);

export interface ComputerDbRow extends Record<string, unknown> {
  assistant_id: string; owner_id: string; kind: 'personal' | 'team'; computer_id: string | null;
  generation: number; status: ComputerRow['status']; changed_at: string;
}
export function mapComputerRows(rows: ComputerDbRow[]): ComputerRow[] {
  return rows.map((row) => ({ assistantId: row.assistant_id, ownerId: row.owner_id,
    kind: row.kind, computerId: row.computer_id, generation: row.generation,
    status: row.status, changedAt: row.changed_at }));
}
