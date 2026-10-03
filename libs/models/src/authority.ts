import type { EventEnvelope } from '@opencrane/events';
import { createHash } from 'node:crypto';
import { memberAuthorisation, type Binding } from '@opencrane/authz';
import { readEvents } from '@opencrane/projections';
import type { EventStore } from '@opencrane/event-store';
import { data } from './state.ts';

/** Shared by model/MCP decisions; destination checks can use this same resource grant. */
export async function currentAuthority(store: EventStore, binding: Binding, requester: string, assistant: string,
  conversation: string, resourceType: string, resourceId: string) {
  const auth = memberAuthorisation(binding);
  const head = await store.head(), facts = [];
  let active = true;
  // ponytail: scan the captured event head for freshness; replace with a fenced IAM projection when histories grow.
  for await (const row of readEvents(store, 1, head)) {
    const e = row.event, d = data(e);
    if (e.silo !== binding.silo) continue;
    if (relevant(e, requester, assistant, conversation, resourceType, resourceId)) {
      if (!await auth.applied(e.id)) throw new Error('IAM projection behind');
      facts.push([e.id, row.sequence, d]);
    }
    if (e.subject === `assistant-${assistant}` && e.type === 'assistant.settings_changed') {
      facts.push([e.id, row.sequence, d]);
      if (typeof d['active'] === 'boolean') active = d['active'];
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
