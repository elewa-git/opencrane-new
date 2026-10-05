import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { EventStore, StoredEvent } from '@opencrane/event-store';
import type { Binding } from '@opencrane/authz';
import { getEventDefinition } from '@opencrane/events';
import { authorityFence, history, models } from '@opencrane/models';
import { activeMember, GroupConflict, GroupRefused } from '../members/groups.ts';

const id = z.string().regex(/^[\w-]{1,200}$/u);
const inputSchema = z.object({
  commandId: id, assistantId: id, groupId: id,
  name: z.string().trim().min(1).max(200),
  grants: z.array(z.object({ resourceType: z.enum(['model', 'mcp_server']),
    resourceId: z.string().regex(/^[\w.-]{1,200}$/u) }).strict()).min(1).max(32),
}).strict();

function receipt(row: StoredEvent, assistantId: string) {
  return { status: 'appended' as const, assistantId,
    sequence: row.sequence, changeId: row.event.id };
}
function previous(rows: StoredEvent[], input: z.infer<typeof inputSchema>, memberId: string) {
  function matchesCommand(row: StoredEvent) {
    return row.event.commandId === input.commandId;
  }
  const saved = rows.find(matchesCommand);
  if (!saved) return;
  const expected = { assistantId: input.assistantId, ownerId: input.groupId,
    kind: 'team', name: input.name, grants: input.grants };
  if (saved.event.principal?.id !== memberId || saved.event.type !== 'assistant.created' ||
      JSON.stringify(saved.event.data) !== JSON.stringify(expected)) {
    throw new GroupConflict('Command id already used');
  }
  return receipt(saved, input.assistantId);
}

/** The creation event fixes ownership and explicit grants; reactions claim the one computer. */
export async function createSharedAssistant(
  store: EventStore, binding: Binding, memberId: string, raw: unknown,
  fresh?: Awaited<ReturnType<typeof authorityFence>>,
) {
  const input = inputSchema.parse(raw);
  const subject = `assistant-${input.assistantId}`;
  const subjects = [`member-${memberId}`, `team-${input.groupId}`];
  fresh ??= await authorityFence(store, performance.now(), subjects);
  fresh.include(...subjects);
  await activeMember(store, binding, memberId, true, fresh);
  const group = await history(store, `team-${input.groupId}`, binding.silo, fresh.deadline);
  function isCreated(row: StoredEvent) {
    return row.event.type === 'team.created';
  }
  if (!group.some(isCreated)) throw new GroupRefused('Group unavailable');
  const rows = await history(store, subject, binding.silo, fresh.deadline);
  const retried = previous(rows, input, memberId);
  if (retried) {
    await fresh();
    return retried;
  }
  if (rows.length) throw new GroupConflict('Assistant already exists');
  for (const grant of input.grants) {
    if (grant.resourceType === 'model') {
      function matchesModel(model: typeof models[number]) {
        return model.id === grant.resourceId && !model.retired;
      }
      if (!models.some(matchesModel)) throw new GroupRefused('Model unavailable');
    } else {
      const resourceSubject = `mcp-${grant.resourceId}`;
      fresh.include(resourceSubject);
      const resource = await history(store, resourceSubject, binding.silo, fresh.deadline);
      if (!resource.length) throw new GroupRefused('Integration unavailable');
    }
  }
  const data = { assistantId: input.assistantId, ownerId: input.groupId,
    kind: 'team' as const, name: input.name, grants: input.grants };
  getEventDefinition('assistant.created')!.dataSchema.parse(data);
  const event = { id: randomUUID(), commandId: input.commandId, subject,
    silo: binding.silo, type: 'assistant.created', source: 'opencrane-server',
    principal: { kind: 'human' as const, id: memberId }, time: new Date().toISOString(), data };
  await fresh();
  const result = await store.append({ event, expectedSequence: 0 });
  if (result.status === 'unavailable' || result.status === 'rejected') {
    throw new Error('Assistant creation unavailable');
  }
  const committed = await history(store, subject, binding.silo, fresh.deadline);
  const completed = previous(committed, input, memberId);
  if (!completed) throw new GroupConflict('Concurrent assistant creation');
  return completed;
}
