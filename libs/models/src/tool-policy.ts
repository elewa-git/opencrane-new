import { authorityFence } from './authority.ts';
import { currentMembership } from './ownership.ts';
import { z } from 'zod';
import type { EventStore } from '@opencrane/event-store';
import { applyToolPolicy, emptyToolPolicy } from '@opencrane/projections';
import { memberAuthorisation, type Binding } from '@opencrane/authz';
import { envelope, history } from './actor.ts';

export async function readToolPolicy(store: EventStore, silo: string, serverId: string,
  deadline = Infinity) {
  let policy = emptyToolPolicy();
  const rows = await history(store, `mcp-${serverId}`, silo, deadline);
  for (const row of rows) {
    policy = applyToolPolicy(policy, row.event, row.sequence);
  }
  return policy;
}
const id = z.string().regex(/^[\w-]{1,200}$/u);
const input = z.object({ commandId: id, expectedSequence: z.int().nonnegative(), connectionId: id,
  toolName: z.string().min(1).max(200), toolRevision: z.string().regex(/^[a-f0-9]{64}$/u), mode: z.enum(['allow', 'ask', 'block']) }).strict();
export async function setToolPolicy(store: EventStore, binding: Binding, memberId: string, serverId: string, raw: unknown) {
  const command = input.parse(raw);
  if (!(await memberAuthorisation(binding).check(memberId, 'admin')).allowed) throw new Error('Access changed');
  const fresh = await authorityFence(store, performance.now());
  const membership = await currentMembership(store, binding.silo, memberId, fresh);
  if (!['owner', 'admin'].includes(membership.role)) {
    throw new Error('Access changed');
  }
  const auth = memberAuthorisation(binding);
  for (const row of membership.facts) {
    if (!await auth.applied(row.event.id)) {
      throw new Error('IAM projection behind');
    }
  }
  const rows = await history(store, `mcp-${serverId}`, binding.silo);
  const payload = { serverId, connectionId: command.connectionId, toolName: command.toolName,
    toolRevision: command.toolRevision, mode: command.mode, setBy: memberId };
  const prior = rows.find(r => r.event.commandId === command.commandId);
  if (prior) {
    const saved = z.record(z.string(), z.unknown()).parse(prior.event.data);
    return { status: Object.entries(payload).every(([key, value]) => saved[key] === value) ? 'appended' : 'conflict' };
  }
  const state = await readToolPolicy(store, binding.silo, serverId);
  const tool = new Map(state.tools.map(t => [t.name, t])).get(command.toolName);
  if (state.sequence !== command.expectedSequence || state.connectionId !== command.connectionId ||
    !tool?.reviewed || tool.revision !== command.toolRevision) return { status: 'conflict' };
  const event = { ...envelope(binding.silo, `mcp-${serverId}`, 'mcp.tool_mode_set', payload, command.commandId),
    principal: { kind: 'human' as const, id: memberId }, source: 'opencrane-server' };
  await fresh();
  return store.append({ event, expectedSequence: command.expectedSequence });
}
