import type { EventEnvelope } from '@opencrane/events';
import { createHash } from 'node:crypto';
import { grantStream, memberAuthorisation, type Binding } from '@opencrane/authz';
import { wireSubject, type StoredEvent, type EventStore } from '@opencrane/event-store';
import { data } from './state.ts';

/** Shared by model/MCP decisions; destination checks can use this same resource grant. */
export async function currentAuthority(store: EventStore, binding: Binding, requester: string, assistant: string,
  conversation: string, resourceType: string, resourceId: string,
  fresh?: Awaited<ReturnType<typeof authorityFence>>) {
  fresh ??= await authorityFence(store, performance.now());
  const auth = memberAuthorisation(binding);
  const facts = [], receipts: string[] = [];
  let active = true;
  const subjects = [`ownership-${binding.silo}`, `member-${requester}`, `assistant-${assistant}`, `conversation-${conversation}`, grantStream(resourceType, resourceId)];
  fresh.include(...subjects, ...(resourceType === 'mcp_server' ? [`mcp-${resourceId}`] : []));
  const snapshotHead = fresh.head;
  const deadline = fresh.deadline;
  function readSubject(subject: string) {
    return readAt(store, subject, snapshotHead, deadline);
  }
  const histories = await Promise.all(subjects.map(readSubject));
  const teams = authorityTeams(histories.flat(), binding.silo);
  fresh.include(...teams);
  const teamReads = [...teams].map(readSubject);
  histories.push(...await Promise.all(teamReads));
  for (const row of histories.flat().sort((a, b) => a.sequence - b.sequence)) {
    const e = row.event, d = data(e);
    if (e.silo !== binding.silo) continue;
    if (relevant(e, requester, assistant, conversation, resourceType, resourceId)) {
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

function authorityTeams(rows: StoredEvent[], silo: string) {
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
    if (event.type === 'grant.revoked') grants.delete(String(d['granteeId']));
  }
  for (const d of grants.values()) if (d['granteeKind'] === 'team') teams.add(`team-${String(d['granteeId'])}`);
  return teams;
}

function relevant(e: EventEnvelope, requester: string, assistant: string, conversation: string, resourceType: string, resourceId: string) {
  const d = data(e);
  return (e.subject === `ownership-${e.silo}` && (e.type === 'ownership.seeded' || d['memberId'] === requester)) ||
      (e.subject === `member-${requester}` && ['member.joined', 'silo.owner_bootstrapped', 'member.role_changed', 'member.removed'].includes(e.type)) ||
      (e.subject === `assistant-${assistant}` && e.type === 'assistant.created') ||
      (e.type.startsWith('team.') && (d['memberId'] === requester || e.type === 'team.created')) ||
      (d['conversationId'] === conversation && ['conversation.created', 'participant.added', 'participant.removed'].includes(e.type)) ||
      (e.type.startsWith('grant.') && d['resourceType'] === resourceType && d['resourceId'] === resourceId);
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
export async function authorityFence(store: EventStore, started: number,
  subjects: string[] = [], callerDeadline = Infinity) {
  return createAuthorityFence(store, started, subjects, callerDeadline, false);
}

/** Chat membership access survives message posts; work approvals may be cancelled by them. */
export async function conversationAccessFence(store: EventStore, started: number,
  subjects: string[] = [], callerDeadline = Infinity) {
  return createAuthorityFence(store, started, subjects, callerDeadline, true);
}

async function createAuthorityFence(store: EventStore, started: number,
  subjects: string[], callerDeadline: number, allowMessages: boolean) {
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
  const outputHeads = new Map<string, number>();
  const fresh = async () => {
    while (true) {
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
      if (!changed.length) return;
      for (const { subject, sequence } of changed) {
        const fromSequence = (outputHeads.get(subject) ?? head) + 1;
        await checkOutputReports(store, subject, fromSequence, sequence, deadline, allowMessages);
        outputHeads.set(subject, sequence);
      }
      // Recheck every exact subject: revocation may have arrived while reading reports.
    }
  };
  const snapshot = { include, head, deadline };
  return Object.assign(fresh, snapshot);
}

async function checkOutputReports(store: EventStore, subject: string, from: number,
  to: number, deadline: number, allowMessages: boolean) {
  if (!subject.startsWith('conversation-')) throw new Error('Authority changed');
  // A post leaves chat access intact but can cancel approved work. Only the chat
  // access entrypoint accepts it; model and approval fences keep their strict rule.
  for await (const row of store.readStream(subject, from, deadline)) {
    if (row.sequence > to) break;
    if (allowMessages && row.event.type === 'message.posted') continue;
    if (!['agent.command_ran', 'agent.file_changed', 'agent.reasoning_summarised',
      'agent.message_delta', 'agent.message_completed'].includes(row.event.type)) throw new Error('Authority changed');
  }
}
