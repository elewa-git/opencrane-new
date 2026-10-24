import { memberAuthorisation, grantStream, type Binding } from '@opencrane/authz';
import type { EventStore, StoredEvent } from '@opencrane/event-store';
import type { parseMemoryRequest } from './mcp.ts';
import { history } from './actor.ts';
import { data } from './state.ts';
import { prepareMemoryActivity, type MemoryContext } from './memory-context.ts';

type Identity = Pick<MemoryContext, 'silo' | 'requester' | 'assistant' | 'computer' |
  'generation' | 'conversation' | 'turn' | 'thread'>;

export async function prepareMemoryReads(store: EventStore, binding: Binding,
  claims: Identity, parsed: ReturnType<typeof parseMemoryRequest>) {
  const deadline = performance.now() + 10_000;
  const activity = await prepareMemoryActivity(store, binding, claims, parsed, deadline);
  const readScopes: string[] = [];
  const writeScopes: string[] = [];
  if (parsed.input) {
    readScopes.push(parsed.input.scopeId);
    if (parsed.input.operation !== 'recall') {
      writeScopes.push(parsed.input.scopeId);
    }
  }
  const applied = await prepareMemoryReceipts(store, binding, claims, activity.conversation,
    readScopes, writeScopes, deadline);
  return { activity, applied };
}

export async function prepareMemoryReceipts(store: EventStore, binding: Binding,
  claims: Identity, conversation: StoredEvent[], readScopes: Iterable<string>,
  writeScopes: Iterable<string>, deadline: number) {
  const subjects = new Set([`ownership-${claims.silo}`, `member-${claims.requester}`,
    `assistant-${claims.assistant}`, grantStream('mcp_server', 'memory')]);
  for (const scopeId of readScopes) {
    subjects.add(grantStream('memory_read', scopeId));
  }
  for (const scopeId of writeScopes) {
    subjects.add(grantStream('memory_write', scopeId));
  }
  const rows = [...conversation];
  for (const subject of subjects) {
    const loaded = await history(store, subject, claims.silo, deadline);
    rows.push(...loaded);
    for (const row of loaded) {
      const fields = data(row.event);
      if (row.event.type === 'assistant.created' && fields['kind'] === 'team') {
        subjects.add(`team-${String(fields['ownerId'])}`);
      }
      if (fields['granteeKind'] === 'team') {
        subjects.add(`team-${String(fields['granteeId'])}`);
      }
    }
  }
  const receipts = new Map<string, boolean>();
  const auth = memberAuthorisation(binding);
  for (const row of rows) {
    if (row.event.subject.startsWith('conversation-') &&
        !['conversation.created', 'participant.added', 'participant.removed']
          .includes(row.event.type)) continue;
    const applied = await auth.applied(row.event.id);
    if (performance.now() >= deadline) throw new Error('Memory preparation expired');
    receipts.set(row.event.id, applied);
  }
  function applied(eventId: string) {
    // Keep only receipt facts. Permission checks still run for the signed request.
    return Promise.resolve(receipts.get(eventId) === true);
  }
  return applied;
}
