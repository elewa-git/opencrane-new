import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { MemoryRefused } from './access.ts';
import { sourceStatuses } from './detail-sources.ts';
import type { MemoryOptions, Scope } from './access.ts';

export class MemoryConflict extends Error {}
const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/u);
export const readInput = z.strictObject({ q: z.string().default(''),
  cursor: z.string().max(2000).optional() });
export const readParams = z.strictObject({ scopeId: z.string().regex(/^[a-f0-9]{64}$/u) });
export const scopeInput = z.strictObject({ assistantId: identifier.optional(),
  groupId: identifier.optional() });
export const limits = { textBytes: 4096, pageFacts: 20, pageBytes: 16384,
  queryBytes: 256, queryTerms: 8, sources: 8, dependencies: 32, commandBytes: 16384 };

function searchTerms(query: string) {
  const normalised = query.normalize('NFC');
  if (Buffer.byteLength(normalised) > limits.queryBytes) {
    throw new z.ZodError([]);
  }
  const lower = normalised.toLocaleLowerCase('und');
  const terms = lower.match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];
  if (terms.length > limits.queryTerms || (query.trim() !== '' && terms.length === 0)) {
    throw new z.ZodError([]);
  }
  const exact: string[] = [];
  const prefix: string[] = [];
  for (const term of terms) {
    exact.push(term);
    prefix.push(`${term}:*`);
  }
  return { exact: exact.join(' & '), prefix: prefix.join(' & ') };
}

type Snapshot = { position: number; generation: string };
export async function memorySnapshot(options: MemoryOptions, scope: Scope): Promise<Snapshot> {
  const position = await options.store.head(`scope-${scope.scopeId}`, performance.now() + 10_000);
  const result = await options.db.query<{ sequence: string; generation: string }>(`
    SELECT sequence, generation FROM projection_checkpoints
    JOIN projection_generations USING (name) WHERE name='memory'`);
  const row = result.rows[0];
  if (!row || Number(row.sequence) < position) {
    throw new Error('Memory unavailable');
  }
  return { position, generation: String(row.generation) };
}

function cursorSignature(secret: string, encoded: string) {
  const signature = createHmac('sha256', secret);
  signature.update(`memory-page:${encoded}`);
  return signature.digest();
}
function pageCursor(secret: string, binding: string, offset: number, asOf: Date) {
  const payload = JSON.stringify([binding, offset, asOf.toISOString()]);
  const bytes = Buffer.from(payload);
  const encoded = bytes.toString('base64url');
  const signed = cursorSignature(secret, encoded);
  const signature = signed.toString('base64url');
  return `${encoded}.${signature}`;
}
function readCursor(secret: string, binding: string, cursor?: string) {
  if (cursor === undefined) {
    return { offset: 0, asOf: new Date() };
  }
  try {
    const [encoded, signature, extra] = cursor.split('.');
    if (!encoded || !signature || extra !== undefined) {
      throw new MemoryConflict();
    }
    const expected = cursorSignature(secret, encoded);
    const supplied = Buffer.from(signature, 'base64url');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      throw new MemoryConflict();
    }
    const decoded = Buffer.from(encoded, 'base64url');
    const payload: unknown = JSON.parse(decoded.toString());
    const schema = z.tuple([z.literal(binding), z.int().nonnegative(), z.iso.datetime()]);
    const saved = schema.parse(payload);
    return { offset: saved[1], asOf: new Date(saved[2]) };
  } catch {
    throw new MemoryConflict();
  }
}

const factSchema = z.object({ memory_id: identifier, revision: z.coerce.number(),
  search_text: z.string().nullable(), kind: z.enum(['fact', 'preference']), pinned: z.boolean(),
  expires_at: z.string().nullable(), content_status: z.string(), saved_at: z.string() });
const factColumns = `memory_id, revision, search_text, kind, pinned, expires_at,
  content_status, saved_at`;
function publicFact(raw: unknown) {
  const row = factSchema.parse(raw);
  if (row.content_status !== 'available' || row.search_text === null) {
    throw new Error('Memory content unavailable');
  }
  return { memoryId: row.memory_id, revision: row.revision, text: row.search_text,
    kind: row.kind, pinned: row.pinned, expiresAt: row.expires_at, savedAt: row.saved_at };
}

// Check the generation in each content query too, so a rebuild cannot mix two pages.
function currentProjection() {
  return `EXISTS (SELECT 1 FROM projection_checkpoints checkpoint
    JOIN projection_generations generation USING (name)
    WHERE checkpoint.name='memory' AND checkpoint.sequence >= $3 AND generation.generation=$4)`;
}

export async function listFacts(options: MemoryOptions, requester: string, scope: Scope,
  query: z.infer<typeof readInput>, secret: string) {
  const terms = searchTerms(query.q);
  const state = await memorySnapshot(options, scope);
  const identity = [options.silo, requester, scope.scopeId, query.q.normalize('NFC'),
    'pin-exact-rank-id', state.position, state.generation];
  const hash = createHash('sha256');
  hash.update(JSON.stringify(identity));
  const binding = hash.digest('hex');
  const { offset, asOf } = readCursor(secret, binding, query.cursor);
  const values = [options.silo, scope.scopeId, state.position, state.generation,
    terms.prefix, terms.exact];
  const result = await options.db.query(`SELECT ${factColumns} FROM memory_facts
    WHERE silo=$1 AND scope_id=$2 AND ${currentProjection()}
    AND content_status='available'
    AND ($5='' OR search_vector @@ to_tsquery('simple',$5))
    ORDER BY pinned DESC, (search_vector @@ to_tsquery('simple',$6)) DESC,
    ts_rank_cd(search_vector,to_tsquery('simple',$5)) DESC, memory_id
    `, values);
  await requireSameProjection(options, state);
  function pageFact(raw: unknown) {
    const fact = publicFact(raw);
    const single = { scopeId: scope.scopeId, facts: [fact], returnedCount: 1,
      nextCursor: pageCursor(secret, binding, offset + 1, asOf) };
    if (Buffer.byteLength(JSON.stringify(single)) > limits.pageBytes) {
      return { memoryId: fact.memoryId, revision: fact.revision, reason: 'page_limit' };
    }
    return fact;
  }
  // Keep expiry fixed while paging. Compare dates before applying the saved offset.
  function unexpired(raw: unknown) {
    const row = factSchema.parse(raw);
    if (row.expires_at === null) {
      return true;
    }
    const expiry = new Date(row.expires_at);
    return expiry.getTime() > asOf.getTime();
  }
  const current = result.rows.filter(unexpired);
  const window = current.slice(offset, offset + limits.pageFacts + 1);
  const facts = window.map(pageFact);
  const page = facts.slice(0, limits.pageFacts);
  while (true) {
    let nextCursor: string | null = null;
    if (page.length < facts.length) {
      nextCursor = pageCursor(secret, binding, offset + page.length, asOf);
    }
    const response = { scopeId: scope.scopeId, facts: page,
      returnedCount: page.length, nextCursor };
    if (Buffer.byteLength(JSON.stringify(response)) <= limits.pageBytes) {
      return response;
    }
    if (page.length === 0) {
      throw new Error('Memory page unavailable');
    }
    page.pop();
  }
}

async function requireSameProjection(options: MemoryOptions, state: Snapshot) {
  const result = await options.db.query<{ sequence: string; generation: string }>(`
    SELECT sequence, generation FROM projection_checkpoints
    JOIN projection_generations USING (name) WHERE name='memory'`);
  const current = result.rows[0];
  if (!current || String(current.generation) !== state.generation ||
    Number(current.sequence) < state.position) {
    throw new Error('Memory rebuild in progress');
  }
}

export async function detailFact(options: MemoryOptions, requester: string, scope: Scope,
  memoryId: string) {
  const state = await memorySnapshot(options, scope);
  const values = [options.silo, scope.scopeId, state.position, state.generation, memoryId];
  const result = await options.db.query(`SELECT ${factColumns}, sources FROM memory_facts
    WHERE silo=$1 AND scope_id=$2 AND ${currentProjection()} AND memory_id=$5`, values);
  await requireSameProjection(options, state);
  const row = result.rows[0];
  if (!row) {
    throw new MemoryRefused();
  }
  const saved = factSchema.parse(row);
  if (saved.expires_at !== null && Date.parse(saved.expires_at) <= Date.now()) {
    throw new MemoryRefused();
  }
  const unavailableStatuses = ['destroyed', 'unavailable', 'quarantined'];
  if (unavailableStatuses.includes(saved.content_status)) {
    // Treat the read table's unavailable value as a deleted key, not a service outage.
    let reason = 'destroyed';
    if (saved.content_status === 'quarantined') {
      reason = 'quarantined';
    }
    // Return an unavailable result so callers do not keep retrying a service failure.
    return { status: 'unavailable' as const, scopeId: scope.scopeId,
      memoryId: saved.memory_id, revision: saved.revision, reason };
  }
  const fact = publicFact(saved);
  const sources = await sourceStatuses(options, requester, row['sources']);
  const response = { scopeId: scope.scopeId, fact, sources };
  if (Buffer.byteLength(JSON.stringify(response)) > limits.pageBytes) {
    throw new Error('Memory detail exceeds size limit');
  }
  return response;
}
