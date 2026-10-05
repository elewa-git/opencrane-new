import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { EventStore, StoredEvent } from '@opencrane/event-store';
import type { Binding } from '@opencrane/authz';
import { assistantCreatedDataSchema, assistantGrantSchema } from '@opencrane/events';
import { authorityFence, history, models } from '@opencrane/models';
import { activeMember, GroupConflict, GroupRefused } from '../members/groups.ts';

const id = z.string().regex(/^[\w-]{1,200}$/u);
const inputSchema = z.object({
  commandId: id, assistantId: z.string().max(200).regex(/^team-[\w-]+$/u),
  groupId: id, payingGroupId: id,
  name: assistantCreatedDataSchema.shape.name.unwrap(),
  grants: z.array(assistantGrantSchema).min(1).max(32),
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
    kind: 'team', payingGroupId: input.payingGroupId, name: input.name, grants: input.grants };
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
  const administratorAuthority = { requiredRole: 'admin' as const, fresh };
  await activeMember(store, binding, memberId, administratorAuthority);
  await requireGroup(store, binding.silo, input.groupId, fresh);
  await requireGroup(store, binding.silo, input.payingGroupId, fresh);
  const rows = await history(store, subject, binding.silo, fresh.deadline);
  const retried = previous(rows, input, memberId);
  if (retried) {
    await fresh();
    return retried;
  }
  if (rows.length) throw new GroupConflict('Assistant already exists');
  await requireGrantResources(store, binding.silo, input.grants, fresh);
  return appendCreation(store, binding, memberId, input, fresh);
}

async function requireGroup(store: EventStore, silo: string, groupId: string,
  fresh: Awaited<ReturnType<typeof authorityFence>>) {
  fresh.include(`team-${groupId}`);
  const rows = await history(store, `team-${groupId}`, silo, fresh.deadline);
  function isCreated(row: StoredEvent) {
    return row.event.type === 'team.created';
  }
  if (!rows.some(isCreated)) throw new GroupRefused('Group unavailable');
}

function matchesModel(resourceId: string) {
  function activeModel(model: typeof models[number]) {
    return model.id === resourceId && !model.retired;
  }
  return models.some(activeModel);
}

async function requireGrantResources(store: EventStore, silo: string,
  grants: z.infer<typeof inputSchema>['grants'],
  fresh: Awaited<ReturnType<typeof authorityFence>>) {
  for (const grant of grants) {
    if (grant.resourceType === 'model') {
      if (!matchesModel(grant.resourceId)) throw new GroupRefused('Model unavailable');
      continue;
    }
    const subject = `mcp-${grant.resourceId}`;
    fresh.include(subject);
    const rows = await history(store, subject, silo, fresh.deadline);
    if (!rows.length) throw new GroupRefused('Integration unavailable');
  }
}

async function appendCreation(store: EventStore, binding: Binding, memberId: string,
  input: z.infer<typeof inputSchema>, fresh: Awaited<ReturnType<typeof authorityFence>>) {
  const subject = `assistant-${input.assistantId}`;
  const data = { assistantId: input.assistantId, ownerId: input.groupId,
    kind: 'team' as const, payingGroupId: input.payingGroupId, name: input.name, grants: input.grants };
  assistantCreatedDataSchema.parse(data);
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
