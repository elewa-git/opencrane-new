import type { EventEnvelope } from '@opencrane/events';
import { createHash } from 'node:crypto';
import { grantStream, memberAuthorisation, type Binding } from '@opencrane/authz';
import { wireSubject, type StoredEvent, type EventStore } from '@opencrane/event-store';
import { data } from './state.ts';
import { memberStateTypes } from './ownership.ts';
import type { DecisionGrants, DecisionGrantRow } from './decision-grants.ts';

export const outputReportTypes: readonly string[] = [
  'agent.command_ran', 'agent.file_changed', 'agent.reasoning_summarised',
  'agent.message_delta', 'agent.message_completed', 'agent.output_lost',
  'agent.tool_call_started', 'agent.tool_call_finished', 'agent.native_consent_refused',
];

/** Shared by model/MCP decisions; destination checks can use this same resource grant. */
export async function currentAuthority(store: EventStore, binding: Binding, requester: string, assistant: string,
  conversation: string, resourceType: string, resourceId: string,
  fresh?: Awaited<ReturnType<typeof authorityFence>>, conversationRows?: StoredEvent[],
  grants?: DecisionGrants) {
  fresh ??= await authorityFence(store, performance.now());
  const auth = memberAuthorisation(binding);
  const facts = [], receipts: string[] = [];
  let active = true;
  const subjects = [`ownership-${binding.silo}`, `member-${requester}`,
    `assistant-${assistant}`, grantStream(resourceType, resourceId)];
  // Reuse a caller's earlier chat read only when it also checks later access changes.
  if (!conversationRows) subjects.push(`conversation-${conversation}`);
  fresh.include(...subjects, ...(resourceType === 'mcp_server' ? [`mcp-${resourceId}`] : []));
  const snapshotHead = fresh.head;
  const deadline = fresh.deadline;
  function readSubject(subject: string) {
    return readAt(store, subject, snapshotHead, deadline);
  }
  const histories = await readAuthorityHistories(subjects, readSubject, conversationRows, grants);
  const initialRows = histories.flat();
  const teams = authorityTeams(initialRows, binding.silo);
  const forDecision = conversationRows !== undefined;
  const decisionGrantees = grantReceiptGrantees(initialRows, requester, assistant,
    forDecision, grants?.teamGrantees);
  fresh.include(...teams);
  const teamReads = [...teams].map(readSubject);
  histories.push(...await Promise.all(teamReads));
  for (const row of histories.flat().sort((a, b) => a.sequence - b.sequence)) {
    const e = row.event, d = data(e);
    if (e.silo !== binding.silo) continue;
    if (relevant(e, requester, assistant, conversation, resourceType, resourceId, decisionGrantees)) {
      receipts.push(e.id);
      facts.push([e.id, row.sequence, d]);
    }
    if (e.subject === `assistant-${assistant}` && e.type === 'assistant.settings_changed') {
      facts.push([e.id, row.sequence, d]);
      if (typeof d['active'] === 'boolean') active = d['active'];
    }
  }
  for (let offset = 0; offset < receipts.length; offset += 16) {
    if (!(await Promise.all(receipts.slice(offset, offset + 16).map(id => auth.applied(id)))).every(Boolean)) {
      throw new Error('IAM projection behind');
    }
  }
  if (!active) throw new Error('Assistant inactive');
  const permissions = await Promise.all([auth.check(requester, 'member'), auth.actsFor(requester, assistant),
    auth.conversation(requester, conversation, 'post'), auth.use('person', requester, resourceType, resourceId),
    auth.use('assistant', assistant, resourceType, resourceId)]);
  if (permissions.some(p => !p.allowed)) throw new Error('Current authority refused');
  await fresh();
  return createHash('sha256').update(JSON.stringify({ facts, permissions, memoryScopes: [], credential: null })).digest('hex');
}

async function readAuthorityHistories(subjects: string[],
  readSubject: (subject: string) => Promise<StoredEvent[]>,
  conversationRows?: StoredEvent[], grants?: DecisionGrants) {
  let currentSubjects = subjects;
  const histories: DecisionGrantRow[][] = [];
  if (grants) {
    // Reuse grant facts only when the caller checks later changes from their captured position.
    const grantSubject = grants.subject;
    function isOtherSubject(subject: string) {
      return subject !== grantSubject;
    }
    currentSubjects = subjects.filter(isOtherSubject);
    histories.push(grants.rows);
  }
  const reads = currentSubjects.map(readSubject);
  histories.push(...await Promise.all(reads));
  if (conversationRows) histories.push(conversationRows);
  return histories;
}

function authorityTeams(rows: DecisionGrantRow[], silo: string) {
  // Only the assistant's owner and current resource grantees can supply team authority.
  const teams = new Set<string>();
  const grants = new Map<string, Record<string, unknown>>();
  for (const { event } of rows) {
    if (event.silo !== silo) continue;
    const d = data(event);
    if (event.type === 'assistant.created' && d['kind'] === 'team') teams.add(`team-${String(d['ownerId'])}`);
    if (event.type === 'grant.given' && d['granteeKind'] === 'team') {
      grants.set(String(d['granteeId']), d);
    }
    if (event.type === 'grant.revoked' &&
        (d['granteeKind'] === undefined || d['granteeKind'] === 'team')) {
      grants.delete(String(d['granteeId']));
    }
  }
  for (const d of grants.values()) if (d['granteeKind'] === 'team') teams.add(`team-${String(d['granteeId'])}`);
  return teams;
}

function grantReceiptGrantees(rows: DecisionGrantRow[], requester: string, assistant: string,
  forDecision: boolean, teamGrantees?: ReadonlySet<string>) {
  if (!forDecision) return undefined;
  const grantees = new Set([`member-${requester}`, `assistant-${assistant}`]);
  if (teamGrantees) {
    for (const subject of teamGrantees) grantees.add(subject);
  }
  for (const { event } of rows) {
    const fields = data(event);
    // Keep teams whose grants were revoked too. The permissions service may
    // still allow the old grant until it applies the revocation.
    if (event.type === 'grant.given' && fields['granteeKind'] === 'team') {
      grantees.add(`team-${String(fields['granteeId'])}`);
    }
  }
  return grantees;
}

function relevant(event: DecisionGrantRow['event'], requester: string, assistant: string,
  conversation: string, resourceType: string, resourceId: string,
  decisionGrantees?: Set<string>) {
  const fields = data(event);
  if (event.subject === `ownership-${event.silo}`) {
    return event.type === 'ownership.seeded' || fields['memberId'] === requester;
  }
  if (event.subject === `member-${requester}`) return memberStateTypes.includes(event.type);
  if (event.subject === `assistant-${assistant}`) return event.type === 'assistant.created';
  if (event.type.startsWith('team.')) {
    return fields['memberId'] === requester || event.type === 'team.created';
  }
  const changesParticipation = [
    'conversation.created', 'participant.added', 'participant.removed',
  ].includes(event.type);
  if (fields['conversationId'] === conversation && changesParticipation) return true;
  return relevantGrant(event, resourceType, resourceId, decisionGrantees);
}

function relevantGrant(event: DecisionGrantRow['event'], resourceType: string, resourceId: string,
  decisionGrantees?: Set<string>) {
  if (!event.type.startsWith('grant.')) return false;
  const fields = data(event);
  if (fields['resourceType'] !== resourceType || fields['resourceId'] !== resourceId) return false;
  if (decisionGrantees && !matchesGrantKind(fields, decisionGrantees)) return false;
  return true;
}

async function readAt(store: EventStore, subject: string, head: number, deadline: number) {
  const rows: StoredEvent[] = [];
  try {
    for await (const row of store.readStream(subject, 1, deadline)) {
      if (row.sequence > head) {
        break;
      }
      rows.push(row);
    }
  } catch (error) {
    // Keep the authority failure reason when its deadline stops a pending store read.
    if (performance.now() >= deadline) {
      throw new Error('Authority snapshot expired', { cause: error });
    }
    throw error;
  }
  return rows;
}

/** Add exact subjects as they are discovered; all are fenced against the same starting head. */
export async function authorityFence(store: Pick<EventStore, 'readStream' | 'head'>, started: number,
  subjects: string[] = [], callerDeadline = Infinity) {
  const authority = await createAuthorityFence(
    store, started, subjects, callerDeadline, checkOutputReports);
  return authority.fresh;
}

/** Watch chat participants and membership; keep work approval checks stricter. */
export async function conversationAccessFence(store: EventStore, started: number,
  subjects: string[] = [], callerDeadline = Infinity) {
  const authority = await createAuthorityFence(
    store, started, subjects, callerDeadline, checkChatAccessChanges);
  return authority.fresh;
}

async function createAuthorityFence(store: Pick<EventStore, 'readStream' | 'head'>, started: number,
  subjects: string[], callerDeadline: number, checkChanges: typeof checkOutputReports,
  earlierPositions?: ReadonlyMap<string, number>) {
  const deadline = Math.min(started + 2000, callerDeadline);
  const head = await store.head(undefined, deadline);
  const watched = new Set<string>();
  const include = (...subjects: string[]) => {
    for (const subject of subjects) {
      wireSubject(subject); // Reject wildcard or malformed subjects before any authority read.
      watched.add(subject);
    }
  };
  include(...subjects);
  const outputHeads = new Map<string, number>(earlierPositions);
  async function confirm() {
    if (performance.now() >= deadline) throw new Error('Authority snapshot expired');
    async function readSubjectHead(subject: string) {
      const sequence = await store.head(subject, deadline);
      return { subject, sequence };
    }
    const headReads = [...watched].map(readSubjectHead);
    const current = await Promise.all(headReads);
    function hasChanged({ subject, sequence }: { subject: string; sequence: number }) {
      return sequence > (outputHeads.get(subject) ?? head);
    }
    const changed = current.filter(hasChanged);
    if (performance.now() >= deadline) throw new Error('Authority snapshot expired');
    for (const { subject, sequence } of changed) {
      const fromSequence = (outputHeads.get(subject) ?? head) + 1;
      await checkChanges(store, subject, fromSequence, sequence, deadline);
      outputHeads.set(subject, sequence);
    }
    return changed.length > 0;
  }
  async function fresh() {
    // Recheck every subject because access can change while reading reports.
    while (await confirm()) {
      continue;
    }
  }
  const snapshot = { include, head, deadline };
  return { fresh: Object.assign(fresh, snapshot), confirm };
}

async function checkOutputReports(store: Pick<EventStore, 'readStream'>, subject: string, from: number,
  to: number, deadline: number) {
  if (!subject.startsWith('conversation-')) throw new Error('Authority changed');
  // Treat output reports, including lost output, as granting no authority.
  // Keep them from refusing an in-flight call or a reader.
  for await (const row of store.readStream(subject, from, deadline)) {
    if (row.sequence > to) break;
    if (!outputReportTypes.includes(row.event.type)) {
      throw new Error('Authority changed');
    }
  }
}

async function checkChatAccessChanges(store: Pick<EventStore, 'readStream'>, subject: string, from: number,
  to: number, deadline: number) {
  if (subject.startsWith('ownership-')) return;
  for await (const row of store.readStream(subject, from, deadline)) {
    if (row.sequence > to) break;
    if (changesChatAccess(subject, row.event.type)) throw new Error('Authority changed');
  }
}

export function isAuthorityChanged(error: unknown) {
  return error instanceof Error && error.message === 'Authority changed';
}

function changesChatAccess(subject: string, type: string) {
  if (subject.startsWith('conversation-')) {
    return ['conversation.created', 'participant.added', 'participant.removed'].includes(type);
  }
  if (subject.startsWith('member-')) {
    return memberStateTypes.includes(type);
  }
  return true;
}

/** Keep other callers strict; only decisions can ignore unrelated access events. */
export async function decisionAuthorityFence(store: EventStore, started: number,
  subjects: string[], requesterId: string, assistantId: string,
  grantHistory?: DecisionGrants) {
  const grantees = new Set([`member-${requesterId}`, `assistant-${assistantId}`]);
  const earlierPositions = new Map<string, number>();
  if (grantHistory) {
    subjects = [...subjects, grantHistory.subject];
    earlierPositions.set(grantHistory.subject, grantHistory.sequence);
    for (const team of grantHistory.teamGrantees) grantees.add(team);
  }
  async function checkDecisionChanges(store: Pick<EventStore, 'readStream'>, subject: string, from: number,
    to: number, deadline: number) {
    for await (const row of store.readStream(subject, from, deadline)) {
      if (row.sequence > to) break;
      if (!unrelatedDecisionEvent(row.event, requesterId, grantees)) {
        throw new Error('Authority changed');
      }
    }
  }
  const authority = await createAuthorityFence(
    store, started, subjects, Infinity, checkDecisionChanges, earlierPositions);
  const includeSubjects = authority.fresh.include;
  function include(...subjects: string[]) {
    includeSubjects(...subjects);
    for (const subject of subjects) {
      // Remember team ids so revocations without granteeKind still refuse this call.
      if (subject.startsWith('team-')) grantees.add(subject);
    }
  }
  const snapshot = { include, head: authority.fresh.head, deadline: authority.fresh.deadline };
  return Object.assign(authority.confirm, snapshot);
}

function unrelatedDecisionEvent(event: EventEnvelope, requesterId: string,
  grantees: Set<string>) {
  const fields = data(event);
  if (event.type === 'grant.given' || event.type === 'grant.revoked') {
    // Refuse team grant changes because they may alter this person's access.
    return fields['granteeKind'] !== 'team' && !matchesGrantKind(fields, grantees);
  }
  if (event.subject.startsWith('ownership-')) {
    const changesOwner = ['ownership.transferred', 'ownership.stepped_down'].includes(event.type);
    return changesOwner && fields['memberId'] !== requesterId;
  }
  if (event.subject.startsWith('member-')) {
    return event.type === 'member.invited';
  }
  if (event.subject.startsWith('team-')) {
    const changesMembership = ['team.member_added', 'team.member_removed'].includes(event.type);
    return changesMembership && fields['memberId'] !== requesterId;
  }
  return false;
}

function matchesGrantKind(fields: Record<string, unknown>, grantees: Set<string>) {
  const id = String(fields['granteeId']);
  const kind = fields['granteeKind'];
  if (typeof kind === 'string') {
    return grantees.has(`${kind}-${id}`);
  }
  if (kind !== undefined) return false;
  for (const kind of ['member', 'team', 'assistant']) {
    if (grantees.has(`${kind}-${id}`)) return true;
  }
  return false;
}

export async function ownershipWriteAccess(store: EventStore, positions: ReadonlyMap<string, number>) {
  const fresh = await authorityFence(store, performance.now(), [...positions.keys()]);
  for (const [subject, position] of positions) {
    if (await store.head(subject, fresh.deadline) !== position) {
      throw new Error('Authority changed');
    }
  }
  return fresh;
}
