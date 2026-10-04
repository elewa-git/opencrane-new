import type { EventEnvelope } from '@opencrane/events';
import { createHash } from 'node:crypto';
import { memberAuthorisation, type Binding } from '@opencrane/authz';
import type { EventStore } from '@opencrane/event-store';
import { data } from './state.ts';

/** Shared by model/MCP decisions; destination checks can use this same resource grant. */
export async function currentAuthority(store: EventStore, binding: Binding, requester: string, assistant: string,
  conversation: string, resourceType: string, resourceId: string) {
  const auth = memberAuthorisation(binding);
  const head = await store.head(), facts = [], receipts: string[] = [];
  let active = true;
  // ponytail: scan relevant history; use a fenced IAM projection when these histories grow.
  const subjects = [`member-${requester}`, `assistant-${assistant}`, 'team-*', 'conversation-*', 'grant-*'];
  const histories = await Promise.all(subjects.map(async subject => {
    const rows = [];
    for await (const row of store.readStream(subject)) {
      if (row.sequence > head) break;
      rows.push(row);
    }
    return rows;
  }));
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
  return createHash('sha256').update(JSON.stringify({ facts, permissions, memoryScopes: [], credential: null })).digest('hex');
}

function relevant(e: EventEnvelope, requester: string, assistant: string, conversation: string, resourceType: string, resourceId: string) {
  const d = data(e);
  return (e.subject === `member-${requester}` && ['member.joined', 'member.role_changed', 'member.removed'].includes(e.type)) ||
      (e.subject === `assistant-${assistant}` && e.type === 'assistant.created') ||
      (e.type.startsWith('team.') && (d['memberId'] === requester || e.type === 'team.created')) ||
      (d['conversationId'] === conversation && ['conversation.created', 'participant.added', 'participant.removed'].includes(e.type)) ||
      (e.type.startsWith('grant.') && d['resourceType'] === resourceType && d['resourceId'] === resourceId);
}

/** Fence every authority source, including changes while credentials/policy were being read. */
export async function authorityFence(store: EventStore, started: number,
  subjects = ['member-*', 'team-*', 'assistant-*', 'conversation-*', 'computer-*', 'grant-*', 'mcp-*']) {
  // ponytail: model decisions use category heads; narrow further if unrelated IAM changes cause contention.
  const heads = await Promise.all(subjects.map(subject => store.head(subject)));
  return async () => {
    if (performance.now() - started > 2000) throw new Error('Authority snapshot expired');
    const current = await Promise.all(subjects.map(subject => store.head(subject)));
    if (current.some((head, index) => head !== heads[index]) || performance.now() - started > 2000) {
      throw new Error('Authority changed or snapshot expired');
    }
  };
}
