import type { EventEnvelope } from '@opencrane/events';
import { createHash } from 'node:crypto';
import { grantStream, memberAuthorisation, type Binding } from '@opencrane/authz';
import type { EventStore } from '@opencrane/event-store';
import { data } from './state.ts';

/** Shared by model/MCP decisions; destination checks can use this same resource grant. */
export async function currentAuthority(store: EventStore, binding: Binding, requester: string, assistant: string,
  conversation: string, resourceType: string, resourceId: string) {
  const auth = memberAuthorisation(binding);
  const head = await store.head(), facts = [], receipts: string[] = [];
  let active = true;
  // IAM handlers enforce these entity subjects. Keep unrelated traffic out of the freshness window.
  const subjects = [`member-${requester}`, `assistant-${assistant}`, `conversation-${conversation}`, 'team-*', grantStream(resourceType, resourceId)];
  const histories = await Promise.all(subjects.map(async subject => {
    const rows = [];
    for await (const row of store.readStream(subject)) {
      if (row.sequence > head) break;
      rows.push(row);
    }
    return rows;
  }));
  // ponytail: replay entity/team histories; use a fenced IAM projection if those grow too large.
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
    while (true) {
      if (performance.now() - started > 2000) throw new Error('Authority snapshot expired');
      const current = await Promise.all(subjects.map(subject => store.head(subject)));
      if (performance.now() - started > 2000) throw new Error('Authority snapshot expired');
      if (current.every((head, index) => head === heads[index])) return;
      if (current.some((head, index) => index !== 3 && head !== heads[index]) || current[3]! < heads[3]!) {
        throw new Error('Authority changed');
      }
      // Output reports can arrive beside their model continuation. They grant no authority.
      for await (const row of store.readStream('conversation-*', heads[3]! + 1, started + 2000)) {
        if (row.sequence > current[3]!) break;
        if (!['agent.command_ran', 'agent.file_changed', 'agent.reasoning_summarised',
          'agent.message_delta', 'agent.message_completed'].includes(row.event.type)) throw new Error('Authority changed');
      }
      heads[3] = current[3]!;
      // Check every category again: a revocation may have arrived during that read.
    }
  };
}
