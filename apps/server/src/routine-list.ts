import { z } from 'zod';
import { memberAuthorisation } from '@opencrane/authz';
import { readActiveMember } from '@opencrane/models';
import type { GroupOptions } from './members/group-routes.ts';
import { conversationListCursor, ConversationListChanged } from './chat/list-cursor.ts';
import { routineMetadataSchema } from './routine-read.ts';

export const routineListQuery = z.strictObject({
  view: z.literal('mine'),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  continuation: z.string().max(2000).optional(),
});
const progressSchema = z.object({ sequence: z.coerce.number().int().nonnegative(),
  generation: z.coerce.number().int().nonnegative() });
const candidateSchema = routineMetadataSchema.extend({ position: z.coerce.number().int().positive() });
type ListQuery = z.infer<typeof routineListQuery>;

async function progress(options: GroupOptions, deadline: number) {
  const queryOptions = { deadline };
  const result = await options.db.query(`SELECT sequence, generation FROM projection_checkpoints
    JOIN projection_generations USING (name) WHERE name = $1`, ['routines'], queryOptions);
  return progressSchema.parse(result.rows[0]);
}
async function loadPage(options: GroupOptions, memberId: string, query: ListQuery, secret: string) {
  const deadline = performance.now() + 10_000;
  const queryOptions = { deadline };
  // Read one stream position, not its history. Chat events cannot change this list binding.
  const position = await options.store.head('routine-*', deadline);
  const identity = ['routine-list', options.silo, memberId, query.view, query.limit, position];
  const cursor = conversationListCursor(secret, identity, query.continuation);
  const before = await progress(options, deadline);
  if (before.sequence < position) throw new Error('Routine list unavailable');
  let after = 0;
  if (query.continuation !== undefined) {
    if (cursor.before[0] !== before.generation) throw new ConversationListChanged();
    after = cursor.before[1];
  }
  // Select only public facts, including from JSON. Never fetch private definitions or run data.
  const result = await options.db.query(`SELECT routine_id AS "routineId", position,
    state #>> '{definition,definition,name}' AS name,
    state #>> '{definition,definition,ownerId}' AS "ownerId",
    state #>> '{definition,definition,assistantId}' AS "assistantId",
    state #>> '{definition,definition,payingGroupId}' AS "payingGroupId",
    state ->> 'status' AS status,
    state #> '{definition,definitionRevision}' AS "definitionRevision",
    state #> '{definition,scheduleRevision}' AS "scheduleRevision",
    state #> '{definition,controlRevision}' AS "controlRevision",
    state #> '{definition,next}' AS next
    FROM routines WHERE silo = $1 AND state #>> '{definition,definition,ownerId}' = $2
      AND position > $3 ORDER BY position LIMIT $4`,
  [options.silo, memberId, after, query.limit + 1], queryOptions);
  return { records: result.rows, cursor, position, ...before };
}

async function authorisedPage(options: GroupOptions, memberId: string,
  query: ListQuery, secret: string) {
  const page = await loadPage(options, memberId, query, secret);
  const candidates = page.records.slice(0, query.limit);
  const rows: z.infer<typeof routineMetadataSchema>[] = [];
  const auth = memberAuthorisation(options.binding, options.store);
  const prepared = [];
  for (const record of candidates) {
    const publicRecord = { ...record, executionAvailable: false };
    const candidate = candidateSchema.parse(publicRecord);
    const saved = await auth.loadRoutineAccess(memberId, candidate.routineId);
    const preparedCandidate = { candidate, saved };
    prepared.push(preparedCandidate);
  }
  // Finish loading before permission checks. A change to any loaded routine restarts paging.
  const deadline = performance.now() + 2000;
  const current = await progress(options, deadline);
  const latestPosition = await options.store.head('routine-*', deadline);
  if (current.generation !== page.generation || latestPosition !== page.position) {
    throw new ConversationListChanged();
  }
  for (const { candidate, saved } of prepared) {
    const permission = await saved.check('read_metadata');
    if (permission.status === 'unavailable') throw new Error('Routine list unavailable');
    if (!permission.allowed || saved.state?.definition?.definition.ownerId !== memberId) continue;
    const latest = saved.rows.at(-1)?.sequence;
    if (latest === undefined || latest > page.sequence) throw new ConversationListChanged();
    const { position: _position, ...metadata } = candidate;
    rows.push(metadata);
  }
  let next: string | null = null;
  if (page.records.length > query.limit) {
    next = page.cursor.next([page.generation, prepared.at(-1)!.candidate.position]);
  }
  const complete = next === null && rows.length === candidates.length;
  return { rows, next, complete, sequence: page.sequence, generation: page.generation,
    executionAvailable: false as const };
}

export async function readRoutineList(options: GroupOptions, memberId: string,
  query: ListQuery, secret: string) {
  const loading = authorisedPage(options, memberId, query, secret);
  const [loaded] = await Promise.allSettled([loading]);
  // Check saved membership after all loading, including failures and empty candidate pages.
  await readActiveMember(options.store, options.binding, memberId);
  if (loaded.status === 'rejected') throw loaded.reason;
  return loaded.value;
}
