import { z } from 'zod';
import { foldConnectionSelection, history, loadPersonalProfileMetadata,
  readActiveMember } from '@opencrane/models';
import type { GroupOptions } from '../members/group-routes.ts';
import { conversationListCursor, ConversationListChanged } from '../chat/list-cursor.ts';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/u);
export const profileListQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  status: z.enum(['all', 'saved', 'unavailable']).default('all'),
  cursor: z.string().max(2000).optional(),
});
type Query = z.infer<typeof profileListQuery>;
const progressSchema = z.object({ sequence: z.coerce.number().int().nonnegative(),
  generation: z.coerce.number().int().nonnegative() });
const candidateSchema = z.object({ profile_id: id, position: z.coerce.number().int().positive() });
function candidate(record: Record<string, unknown>) {
  return candidateSchema.parse(record);
}

function matchesStatus(status: string, filter: Query['status']) {
  if (filter === 'all') return true;
  if (filter === 'saved') return status === 'saved_unverified' || status === 'verified';
  return status === 'unavailable';
}

async function profileRows(options: GroupOptions, memberId: string, serverId: string,
  query: Query, candidates: z.infer<typeof candidateSchema>[], deadline: number) {
  const selectedRows = await history(options.store,
    `connection-selection-${memberId}-${serverId}`, options.silo, deadline);
  const selection = foldConnectionSelection(selectedRows).selected;
  const rows = [];
  for (const entry of candidates.slice(0, query.limit)) {
    const reference = { userId: memberId, serverId, profileId: entry.profile_id };
    const metadata = await loadPersonalProfileMetadata(options.store, options.silo, reference);
    if (!metadata || !matchesStatus(metadata.status, query.status)) continue;
    const selected = selection?.action === 'select' && selection.ownerKind !== 'company' &&
      selection.profileId === entry.profile_id;
    rows.push({ ...metadata, ownerKind: 'personal' as const, selected });
  }
  return rows;
}

async function loadPage(options: GroupOptions, memberId: string, serverId: string,
  query: Query, secret: string) {
  const deadline = performance.now() + 10_000;
  const position = await options.store.head('connection-*', deadline);
  const progress = await options.db.query(`SELECT sequence, generation
    FROM projection_checkpoints JOIN projection_generations USING (name)
    WHERE name = 'connection-profiles'`, [], { deadline });
  const checkpoint = progressSchema.parse(progress.rows[0]);
  if (checkpoint.sequence < position) throw new Error('Profile list unavailable');
  const identity = ['connection-profile-list', options.silo, memberId, serverId,
    query.limit, query.status, position];
  const cursor = conversationListCursor(secret, identity, query.cursor);
  let after = 0;
  if (query.cursor !== undefined) {
    if (cursor.before[0] !== checkpoint.generation) throw new ConversationListChanged();
    after = cursor.before[1];
  }
  const result = await options.db.query(`SELECT profile_id, position FROM connection_profiles
    WHERE silo = $1 AND member_id = $2 AND server_id = $3 AND position > $4
    ORDER BY position LIMIT $5`,
  [options.silo, memberId, serverId, after, query.limit + 1], { deadline });
  const candidates = result.rows.map(candidate);
  const rows = await profileRows(options, memberId, serverId, query, candidates, deadline);
  const current = await options.store.head('connection-*', deadline);
  if (current !== position) throw new ConversationListChanged();
  let next: string | null = null;
  if (candidates.length > query.limit) {
    next = cursor.next([checkpoint.generation, candidates[query.limit - 1]!.position]);
  }
  return { rows, next, generation: checkpoint.generation, sequence: position,
    complete: next === null && rows.length === candidates.length };
}

/** List only event-backed personal profiles for the signed-in member. */
export async function readOwnConnectionList(options: GroupOptions, memberId: string,
  serverId: string, query: Query, secret: string) {
  const loading = loadPage(options, memberId, serverId, query, secret);
  const [loaded] = await Promise.allSettled([loading]);
  // Decide access once after data loading, including failed and empty pages.
  await readActiveMember(options.store, options.binding, memberId);
  if (loaded.status === 'rejected') throw loaded.reason;
  return loaded.value;
}
