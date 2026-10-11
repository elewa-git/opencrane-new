import { parseEventByType, memoryWrittenEventSchema, memoryTextSchema, type EventEnvelope,
  type MemoryIdentity, memoryMaintenanceBoundDataSchema, memoryForgottenEventSchema,
  memoryForgottenDataSchema } from '@opencrane/events';
import type { Query } from './db.ts';
import type { Projection } from './runner.ts';
import type { StoredEvent } from '@opencrane/event-store';
import { memoryErasureHistory } from './memory-erasure.ts';
import { memoryIdentity } from './memory-keys.ts';

type SavedMemoryWrite = ReturnType<typeof memoryWrittenEventSchema.parse>['data'];
type MemoryWrite = Extract<SavedMemoryWrite, { schemaVersion: 1 }>;

async function create(db: Query): Promise<void> {
  await db.query(`CREATE TABLE IF NOT EXISTS memory_maintenance_bindings (
    silo TEXT NOT NULL, scope_id TEXT NOT NULL, data JSONB NOT NULL, position BIGINT NOT NULL,
    PRIMARY KEY (silo, scope_id))`);
  await db.query(`CREATE TABLE IF NOT EXISTS memory_facts (
    silo TEXT NOT NULL, scope_id TEXT NOT NULL, memory_id TEXT NOT NULL,
    scope_kind TEXT, owner_id TEXT, revision BIGINT, kind TEXT, pinned BOOLEAN,
    expires_at TEXT, sources JSONB NOT NULL, ciphertext TEXT NOT NULL, key_id TEXT NOT NULL,
    content_status TEXT NOT NULL, search_text TEXT, search_vector TSVECTOR,
    position BIGINT NOT NULL, saved_at TEXT NOT NULL,
    PRIMARY KEY (silo, scope_id, memory_id))`);
  await db.query(`CREATE INDEX IF NOT EXISTS memory_facts_order
    ON memory_facts (silo, scope_id, position, memory_id)`);
  await db.query(`CREATE INDEX IF NOT EXISTS memory_facts_initial
    ON memory_facts (silo, scope_id, kind, memory_id COLLATE "C")`);
  await db.query(`CREATE INDEX IF NOT EXISTS memory_facts_search
    ON memory_facts USING GIN (search_vector)`);
  await db.query(`CREATE TABLE IF NOT EXISTS memory_dependencies (
    silo TEXT NOT NULL, scope_id TEXT NOT NULL, memory_id TEXT NOT NULL,
    revision BIGINT NOT NULL, dependency_id TEXT NOT NULL, dependency_revision BIGINT NOT NULL,
    PRIMARY KEY (silo, scope_id, memory_id, revision, dependency_id, dependency_revision))`);
  await db.query(`ALTER TABLE memory_dependencies DROP CONSTRAINT memory_dependencies_pkey`);
  await db.query(`ALTER TABLE memory_dependencies ADD PRIMARY KEY
    (silo, scope_id, memory_id, revision, dependency_id, dependency_revision)`);
  await db.query(`CREATE TABLE IF NOT EXISTS memory_changes (
    silo TEXT NOT NULL, scope_id TEXT NOT NULL, change_id TEXT NOT NULL, command_id TEXT,
    principal_kind TEXT, principal_id TEXT, memory_id TEXT NOT NULL, revision BIGINT,
    outcome TEXT NOT NULL, position BIGINT NOT NULL, saved_at TEXT NOT NULL,
    PRIMARY KEY (silo, scope_id, change_id))`);
  await db.query(`CREATE INDEX IF NOT EXISTS memory_changes_order
    ON memory_changes (silo, scope_id, position)`);
}

async function drop(db: Query): Promise<void> {
  await db.query(`DROP TABLE IF EXISTS memory_maintenance_bindings,
    memory_dependencies, memory_changes, memory_facts`);
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
  // Retain links from every saved revision, even when its value is no longer current.
  if (current !== null) {
    for (const dependency of current.dependsOn) {
      const edge = [...fact, current.revision, dependency.memoryId, dependency.revision];
      await db.query(`INSERT INTO memory_dependencies VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT DO NOTHING`, edge);
    }
  }
  const previous = await db.query<{ revision: string | number | null; content_status: string }>(
    `SELECT revision, content_status FROM memory_facts
      WHERE silo=$1 AND scope_id=$2 AND memory_id=$3`, fact,
  );
  // Keep the tombstone permanent if a later saved write reuses this identity.
  if (previous.rows[0]?.content_status === 'erased') {
    await writeChange(db, event, data, current, position);
    return;
  }
  // Keep a newer or equal revision, including when an old event has no known owner.
  const previousRevision = previous.rows[0]?.revision;
  if (previousRevision !== undefined && previousRevision !== null) {
    if (current === null || Number(previousRevision) >= current.revision) {
      await writeChange(db, event, data, current, position);
      return;
    }
  }
  // Build the search vector explicitly from the current text. Keep SQL limited to indexing.
  await db.query(`INSERT INTO memory_facts VALUES
    ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,to_tsvector('simple',$14),$15,$16)
    ON CONFLICT (silo, scope_id, memory_id) DO UPDATE SET
    scope_kind=$4, owner_id=$5, revision=$6, kind=$7, pinned=$8, expires_at=$9,
    sources=$10, ciphertext=$11, key_id=$12, content_status=$13,
    search_text=$14, search_vector=to_tsvector('simple',$14), position=$15, saved_at=$16`, values);
  await writeChange(db, event, data, current, position);
}

async function writeChange(
  db: Query, event: EventEnvelope, data: SavedMemoryWrite, current: MemoryWrite | null,
  position: number,
): Promise<void> {
  // Record what the event changed, so deleting a key cannot rewrite this history.
  let outcome = 'written';
  if (current === null) {
    outcome = 'quarantined';
  }
  const change = [event.silo, data.scopeId, event.id, event.commandId ?? null,
    event.principal?.kind ?? null, event.principal?.id ?? null, data.memoryId,
    current?.revision ?? null, outcome, position, event.time];
  await db.query('INSERT INTO memory_changes VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', change);
}

async function hideMemoryFacts(db: Query, silo: string, scopeId: string, hidden: string[]) {
  if (hidden.length === 0) {
    return;
  }
  const parameters = [silo, scopeId, hidden];
  // Clear every dependent copy together, including links saved after the tombstone.
  await db.query(`UPDATE memory_facts SET content_status='erased', search_text=NULL,
    search_vector=NULL, sources='[]', ciphertext='', key_id=''
    WHERE silo=$1 AND scope_id=$2 AND memory_id=ANY($3::text[])`, parameters);
}

function prepareForgotten(envelope: EventEnvelope,
  erasure: Awaited<ReturnType<typeof memoryErasureHistory>> | undefined) {
  const saved = memoryForgottenEventSchema.parse(envelope);
  if (!('schemaVersion' in saved.data) || !erasure) {
    throw new Error('Memory change is not supported by this projection yet');
  }
  const data = memoryForgottenDataSchema.parse(saved.data);
  const hidden = [...erasure.hidden(saved.silo, data.scopeId)];
  async function applyForgotten(db: Query, _event: EventEnvelope, position: number) {
    await hideMemoryFacts(db, saved.silo, data.scopeId, hidden);
    await db.query(`UPDATE memory_facts SET revision=$4
      WHERE silo=$1 AND scope_id=$2 AND memory_id=$3`,
      [saved.silo, data.scopeId, data.memoryId, data.revision]);
    const change = [saved.silo, data.scopeId, saved.id, saved.commandId ?? null,
      saved.principal?.kind ?? null, saved.principal?.id ?? null, data.memoryId,
      data.revision, 'forgotten', position, saved.time];
    await db.query('INSERT INTO memory_changes VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
      change);
  }
  return applyForgotten;
}

/** Give replay only decryption access, so it cannot create or delete a revision key. */
export function memoryProjection(custody: {
  decrypt(identity: MemoryIdentity, value: { ciphertext: string; keyId: string }):
    string | null | Promise<string | null>;
}): Projection {
  let erasure: Awaited<ReturnType<typeof memoryErasureHistory>> | undefined;
  async function inspectHistory(events: AsyncIterable<StoredEvent>) {
    erasure = await memoryErasureHistory(events);
  }
  async function prepare(envelope: EventEnvelope): Promise<Projection['apply']> {
    if (envelope.type === 'memory.maintenance_bound') {
      if (!parseEventByType(envelope).success) {
        throw new Error('Invalid saved binding event');
      }
      const data = memoryMaintenanceBoundDataSchema.parse(envelope.data);
      async function applyBinding(db: Query, _event: EventEnvelope, position: number) {
        const values = [envelope.silo, data.scopeId, JSON.stringify(data), position];
        await db.query(`INSERT INTO memory_maintenance_bindings VALUES ($1,$2,$3,$4)
          ON CONFLICT (silo, scope_id) DO UPDATE SET data=$3, position=$4`, values);
      }
      return applyBinding;
    }
    if (envelope.type === 'memory.forgotten') {
      return prepareForgotten(envelope, erasure);
    }
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
    const hidden = identity !== null &&
      erasure?.hidden(identity.silo, identity.scopeId).has(identity.memoryId);
    if (hidden) {
      status = 'erased';
    } else if (identity !== null) {
      text = await custody.decrypt(identity, data);
      if (text !== null) text = text.normalize('NFC');
      status = 'available';
      if (text === null) {
        status = 'unavailable';
      } else if (!memoryTextSchema.safeParse(text).success) {
        text = null;
        status = 'quarantined';
      }
    }
    const current = 'schemaVersion' in data ? data : null;
    async function apply(db: Query, _event: EventEnvelope, position: number): Promise<void> {
      await writeMemory(db, parsed, data, current, text, status, position);
      if (identity && erasure) {
        const affected = [...erasure.hidden(identity.silo, identity.scopeId)];
        await hideMemoryFacts(db, identity.silo, identity.scopeId, affected);
      }
    }
    return apply;
  }
  return { name: 'memory', create, drop, inspectHistory, prepare, apply: requiresPreparation };
}

/** Read only one silo and scope; callers must check permission before using this query. */
export async function readMemoryFactIds(
  db: Query, silo: string, scopeId: string, search?: string,
): Promise<{ memory_id: string }[]> {
  const parameters = [silo, scopeId];
  let searchClause = '';
  if (search !== undefined) {
    parameters.push(search);
    searchClause = " AND search_vector @@ to_tsquery('simple', $3)";
  }
  const result = await db.query<{ memory_id: string }>(`SELECT memory_id FROM memory_facts
    WHERE silo=$1 AND scope_id=$2 AND content_status='available'${searchClause}
    ORDER BY position, memory_id`, parameters);
  return result.rows;
}
