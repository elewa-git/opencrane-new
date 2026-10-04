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
  const subjects = [`member-${requester}`, `assistant-${assistant}`, `conversation-${conversation}`, grantStream(resourceType, resourceId)];
  fresh.include(...subjects, ...(resourceType === 'mcp_server' ? [`mcp-${resourceId}`] : []));
  const histories = await Promise.all(subjects.map(subject => readAt(store, subject, fresh.head)));
  const teams = authorityTeams(histories.flat(), binding.silo);
  fresh.include(...teams);
  histories.push(...await Promise.all([...teams].map(subject => readAt(store, subject, fresh.head))));
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
    if (event.type === 'grant.given') grants.set(String(d['granteeId']), d);
    if (event.type === 'grant.revoked') grants.delete(String(d['granteeId']));
  }
  for (const d of grants.values()) if (d['granteeKind'] === 'team') teams.add(`team-${String(d['granteeId'])}`);
  return teams;
}

function relevant(e: EventEnvelope, requester: string, assistant: string, conversation: string, resourceType: string, resourceId: string) {
  const d = data(e);
  return (e.subject === `member-${requester}` && ['member.joined', 'silo.owner_bootstrapped', 'member.role_changed', 'member.removed'].includes(e.type)) ||
      (e.subject === `assistant-${assistant}` && e.type === 'assistant.created') ||
      (e.type.startsWith('team.') && (d['memberId'] === requester || e.type === 'team.created')) ||
      (d['conversationId'] === conversation && ['conversation.created', 'participant.added', 'participant.removed'].includes(e.type)) ||
      (e.type.startsWith('grant.') && d['resourceType'] === resourceType && d['resourceId'] === resourceId);
}

async function readAt(store: EventStore, subject: string, head: number) {
  const rows: StoredEvent[] = [];
  for await (const row of store.readStream(subject, 1)) {
    if (row.sequence > head) break;
    rows.push(row);
  }
  return rows;
}

/** Add exact subjects as they are discovered; all are fenced against the same starting head. */
export async function authorityFence(store: EventStore, started: number, subjects: string[] = []) {
  const head = await store.head();
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
      if (performance.now() - started > 2000) throw new Error('Authority snapshot expired');
      const current = await Promise.all([...watched].map(async subject => ({ subject, sequence: await store.head(subject) })));
      const changed = current.filter(({ subject, sequence }) => sequence > (outputHeads.get(subject) ?? head));
      if (performance.now() - started > 2000) throw new Error('Authority snapshot expired');
      if (!changed.length) return;
      for (const { subject, sequence } of changed) {
        await checkOutputReports(store, subject, (outputHeads.get(subject) ?? head) + 1, sequence, started + 2000);
        outputHeads.set(subject, sequence);
      }
      // Recheck every exact subject: revocation may have arrived while reading reports.
    }
  };
  return Object.assign(fresh, { include, head });
}

async function checkOutputReports(store: EventStore, subject: string, from: number, to: number, deadline: number) {
  if (!subject.startsWith('conversation-')) throw new Error('Authority changed');
  // Output reports grant no authority and may arrive beside their model continuation.
  for await (const row of store.readStream(subject, from, deadline)) {
    if (row.sequence > to) break;
    if (!['agent.command_ran', 'agent.file_changed', 'agent.reasoning_summarised',
      'agent.message_delta', 'agent.message_completed'].includes(row.event.type)) throw new Error('Authority changed');
  }
}
