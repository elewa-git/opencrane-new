import { parseEventByType, memoryWrittenEventSchema, type EventEnvelope,
  type MemoryIdentity } from '@opencrane/events';
import type { Query } from './db.ts';
import type { Projection } from './runner.ts';
import { memoryIdentity } from './memory-keys.ts';

type SavedMemoryWrite = ReturnType<typeof memoryWrittenEventSchema.parse>['data'];
type MemoryWrite = Extract<SavedMemoryWrite, { schemaVersion: 1 }>;

async function create(db: Query): Promise<void> {
  await db.query(`CREATE TABLE IF NOT EXISTS memory_facts (
    silo TEXT NOT NULL, scope_id TEXT NOT NULL, memory_id TEXT NOT NULL,
    scope_kind TEXT, owner_id TEXT, revision BIGINT, kind TEXT, pinned BOOLEAN,
    expires_at TEXT, sources JSONB NOT NULL, ciphertext TEXT NOT NULL, key_id TEXT NOT NULL,
    content_status TEXT NOT NULL, search_text TEXT, search_vector TSVECTOR,
    position BIGINT NOT NULL, saved_at TEXT NOT NULL,
    PRIMARY KEY (silo, scope_id, memory_id))`);
  await db.query(`CREATE INDEX IF NOT EXISTS memory_facts_order
    ON memory_facts (silo, scope_id, position, memory_id)`);
  await db.query(`CREATE INDEX IF NOT EXISTS memory_facts_search
    ON memory_facts USING GIN (search_vector)`);
  await db.query(`CREATE TABLE IF NOT EXISTS memory_dependencies (
    silo TEXT NOT NULL, scope_id TEXT NOT NULL, memory_id TEXT NOT NULL,
    revision BIGINT NOT NULL, dependency_id TEXT NOT NULL, dependency_revision BIGINT NOT NULL,
    PRIMARY KEY (silo, scope_id, memory_id, dependency_id, dependency_revision))`);
  await db.query(`CREATE TABLE IF NOT EXISTS memory_changes (
    silo TEXT NOT NULL, scope_id TEXT NOT NULL, change_id TEXT NOT NULL, command_id TEXT,
    principal_kind TEXT, principal_id TEXT, memory_id TEXT NOT NULL, revision BIGINT,
    outcome TEXT NOT NULL, position BIGINT NOT NULL, saved_at TEXT NOT NULL,
    PRIMARY KEY (silo, scope_id, change_id))`);
  await db.query(`CREATE INDEX IF NOT EXISTS memory_changes_order
    ON memory_changes (silo, scope_id, position)`);
}

async function drop(db: Query): Promise<void> {
  await db.query('DROP TABLE IF EXISTS memory_dependencies, memory_changes, memory_facts');
}

function ignored(): Promise<void> {
  return Promise.resolve();
}

function requiresPreparation(): Promise<void> {
  return Promise.reject(new Error('Memory projection requires ProjectionRunner preparation'));
}

function metadata(current: MemoryWrite | null): unknown[] {
  if (current === null) {
    return [null, null, null, null, null, null, '[]'];
  }
  return [current.scopeKind, current.ownerId, current.revision, current.kind, current.pinned,
    current.expiresAt, JSON.stringify(current.sources)];
}

async function writeMemory(
  db: Query, event: EventEnvelope, data: SavedMemoryWrite, current: MemoryWrite | null,
  text: string | null, status: string, position: number,
): Promise<void> {
  const fact = [event.silo, data.scopeId, data.memoryId];
  const fields = metadata(current);
  const values = [...fact, ...fields, data.ciphertext, data.keyId, status, text, position, event.time];
  // Build the search vector explicitly from the current text. Keep SQL limited to indexing.
  await db.query(`INSERT INTO memory_facts VALUES
    ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,to_tsvector('simple',$14),$15,$16)
    ON CONFLICT (silo, scope_id, memory_id) DO UPDATE SET
    scope_kind=$4, owner_id=$5, revision=$6, kind=$7, pinned=$8, expires_at=$9,
    sources=$10, ciphertext=$11, key_id=$12, content_status=$13,
    search_text=$14, search_vector=to_tsvector('simple',$14), position=$15, saved_at=$16`, values);
  await db.query(`DELETE FROM memory_dependencies
    WHERE silo=$1 AND scope_id=$2 AND memory_id=$3`, fact);
  if (current !== null) {
    for (const dependency of current.dependsOn) {
      const edge = [...fact, current.revision, dependency.memoryId, dependency.revision];
      await db.query('INSERT INTO memory_dependencies VALUES ($1,$2,$3,$4,$5,$6)', edge);
    }
  }
  const change = [event.silo, data.scopeId, event.id, event.commandId ?? null,
    event.principal?.kind ?? null, event.principal?.id ?? null, data.memoryId,
    current?.revision ?? null, status, position, event.time];
  await db.query('INSERT INTO memory_changes VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', change);
}

/** Give replay only decryption access, so it cannot create or delete a revision key. */
export function memoryProjection(custody: {
  decrypt(identity: MemoryIdentity, value: { ciphertext: string; keyId: string }):
    string | null | Promise<string | null>;
}): Projection {
  async function prepare(envelope: EventEnvelope): Promise<Projection['apply']> {
    if (envelope.type !== 'memory.written') {
      if (envelope.type.startsWith('memory.')) {
        throw new Error('Memory change is not supported by this projection yet');
      }
      return ignored;
    }
    const checked = parseEventByType(envelope);
    if (!checked.success) {
      throw new Error('Invalid saved memory event');
    }
    const parsed = memoryWrittenEventSchema.parse(checked.event);
    const identity = memoryIdentity(parsed);
    const data = parsed.data;
    let text: string | null = null;
    let status = 'quarantined';
    if (identity !== null) {
      text = await custody.decrypt(identity, data);
      status = 'available';
      if (text === null) {
        status = 'unavailable';
      }
    }
    const current = 'schemaVersion' in data ? data : null;
    async function apply(db: Query, _event: EventEnvelope, position: number): Promise<void> {
      await writeMemory(db, parsed, data, current, text, status, position);
    }
    return apply;
  }
  return { name: 'memory', create, drop, prepare, apply: requiresPreparation };
}
