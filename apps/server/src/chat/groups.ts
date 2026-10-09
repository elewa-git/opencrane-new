import { z } from 'zod';
import { memberAuthorisation } from '@opencrane/authz';
import { getEventDefinition, chatIdSchema } from '@opencrane/events';
import { readStreamSummary, WrongSiloError, type StoredEvent, type SummaryKind }
  from '@opencrane/event-store';
import { activeChatMember, ChatRefused, isChatRefused, type ChatOptions } from './access.ts';
import { ChatConflict } from './commands.ts';

export class GroupSnapshotTooLarge extends ChatConflict {}

const querySchema = z.object({
  q: z.string().trim().max(100).default(''),
  after: chatIdSchema.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
}).strict();
const groupData = z.object({ teamId: chatIdSchema, name: z.string().optional(),
  memberId: chatIdSchema.optional() });

type GroupFacts = { groupId: string | undefined; name: string | undefined; joins: Map<string, string> };
function emptyGroup(): GroupFacts {
  return { groupId: undefined, name: undefined, joins: new Map() };
}
function addGroup(facts: GroupFacts, row: StoredEvent) {
  getEventDefinition(row.event.type)!.dataSchema.parse(row.event.data);
  const data = groupData.parse(row.event.data);
  if (row.event.subject !== `team-${data.teamId}`) throw new Error('Group history mismatch');
  if (facts.groupId && facts.groupId !== data.teamId) throw new Error('Group history mismatch');
  facts.groupId = data.teamId;
  if (row.event.type === 'team.created') facts.name = data.name;
  if (row.event.type === 'team.member_added' && data.memberId) {
    facts.joins.set(data.memberId, row.event.id);
  }
  if (row.event.type === 'team.member_removed' && data.memberId) facts.joins.delete(data.memberId);
}
const groupKind: SummaryKind<GroupFacts> = {
  name: 'chat-group', keep: 64, empty: emptyGroup, add: addGroup,
};
async function groupFacts(options: ChatOptions, groupId: string) {
  function take(facts: GroupFacts, position: number) {
    if (facts.groupId && facts.groupId !== groupId) throw new Error('Group history mismatch');
    return { groupId, name: facts.name, joins: new Map(facts.joins), position };
  }
  try {
    return await readStreamSummary(options.store, options.silo, `team-${groupId}`,
      groupKind, performance.now() + 10_000, take);
  } catch (error) {
    if (error instanceof WrongSiloError) throw new ChatRefused('Group refused');
    throw error;
  }
}

async function ownGroup(options: ChatOptions, memberId: string,
  facts: Awaited<ReturnType<typeof groupFacts>>) {
  const join = facts.joins.get(memberId);
  if (!facts.name || !join) throw new ChatRefused('Group refused');
  const auth = memberAuthorisation(options.binding);
  const permission = await auth.team(memberId, facts.groupId);
  if (permission.status === 'unavailable') throw new Error('IAM unavailable');
  if (!permission.allowed || !await auth.applied(join)) throw new ChatRefused('Group refused');
}

export async function chatGroups(options: ChatOptions, memberId: string, query: unknown) {
  const input = querySchema.parse(query);
  const candidates = await options.db.query<{ group_id: string }>(
    `SELECT g.group_id FROM groups g JOIN group_members m
      ON m.silo = g.silo AND m.group_id = g.group_id
      WHERE g.silo = $1 AND m.member_id = $2 AND g.group_id > $3
      AND ($4 = '' OR strpos(lower(g.name), lower($4)) > 0)
      ORDER BY g.group_id LIMIT $5`,
    [options.silo, memberId, input.after ?? '', input.q, input.limit + 1]);
  const page = candidates.rows.slice(0, input.limit);
  const rows = [];
  for (const candidate of page) {
    try {
      const facts = await groupFacts(options, candidate.group_id);
      await ownGroup(options, memberId, facts);
      rows.push({ groupId: facts.groupId, name: facts.name });
    } catch (error) {
      if (!isChatRefused(error)) throw error;
    }
  }
  let next: string | null = null;
  if (candidates.rows.length > input.limit) next = page.at(-1)?.group_id ?? null;
  return { rows, next };
}

export async function chatGroupSnapshot(options: ChatOptions, memberId: string, groupId: string) {
  const facts = await groupFacts(options, groupId);
  await ownGroup(options, memberId, facts);
  const candidates = await options.db.query<{ memberId: string; displayName: string | null }>(
    `SELECT member_id AS "memberId", display_name AS "displayName" FROM members
      WHERE silo = $1 AND member_id = ANY($2::text[]) ORDER BY member_id`,
    [options.silo, [...facts.joins.keys()]]);
  const names = new Map<string, string | null>();
  for (const candidate of candidates.rows) names.set(candidate.memberId, candidate.displayName);
  const members = [];
  const ids = [...facts.joins.keys()].sort();
  for (const memberId of ids) {
    try {
      await activeChatMember(options, memberId);
      members.push({ memberId, displayName: names.get(memberId) ?? null });
    } catch (error) {
      if (!isChatRefused(error)) throw error;
    }
    if (members.length > 97) {
      throw new GroupSnapshotTooLarge('Select colleagues instead; the group has more than 97 people');
    }
  }
  return { groupId, name: facts.name, position: facts.position, members };
}

export async function reviewedGroup(options: ChatOptions, memberId: string,
  input: { groupId?: string | undefined; groupSnapshotPosition?: number | undefined;
    participantIds: string[] }) {
  if (!input.groupId) return;
  const snapshot = await chatGroupSnapshot(options, memberId, input.groupId);
  function memberIdFor(member: (typeof snapshot.members)[number]) {
    return member.memberId;
  }
  const ids = snapshot.members.map(memberIdFor);
  const reviewedIds = [...input.participantIds].sort();
  if (snapshot.position !== input.groupSnapshotPosition ||
      JSON.stringify(ids) !== JSON.stringify(reviewedIds)) {
    throw new ChatConflict('Group changed; review its members again');
  }
  return snapshot;
}
