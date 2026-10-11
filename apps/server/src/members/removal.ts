import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { memberRemovedDataSchema } from '@opencrane/events';
import type { StoredEvent } from '@opencrane/event-store';
import { activeMember, currentMembership, history, ownershipWriteAccess,
  readActiveMember } from '@opencrane/models';
import type { GroupOptions } from './group-routes.ts';
import { memberInventory, reviewedRevision } from './inventory.ts';
import { projectionProgress } from './roles.ts';

const removalBody = z.object({
  commandId: z.string().regex(/^[\w-]{1,200}$/u),
  expectedSequence: z.int().nonnegative().safe(),
  reviewRevision: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();
type Input = z.infer<typeof removalBody>;
export class RemovalConflict extends Error {}

function receipt(row: StoredEvent) {
  const data = memberRemovedDataSchema.parse(row.event.data);
  return { status: 'recorded' as const, commandId: row.event.commandId,
    changeId: row.event.id, type: row.event.type, sequence: row.sequence,
    recordedAt: row.event.time, removedAt: row.event.time, memberId: data.memberId,
    reviewRevision: data.reviewRevision, access: 'revoked' as const };
}
function previous(rows: StoredEvent[], actor: string, input: Input) {
  function matches(row: StoredEvent) {
    return row.event.commandId === input.commandId;
  }
  const index = rows.findIndex(matches);
  const row = rows[index];
  if (!row) return undefined;
  if (row.event.type !== 'member.removed') throw new RemovalConflict('command_id_reused');
  const data = memberRemovedDataSchema.parse(row.event.data);
  if (row.event.principal?.kind !== 'human' || row.event.principal.id !== actor
    || data.removedBy !== actor || data.reviewRevision !== input.reviewRevision
    || (rows[index - 1]?.sequence ?? 0) !== input.expectedSequence) {
    throw new RemovalConflict('command_id_reused');
  }
  return receipt(row);
}
export async function removalCommand(options: GroupOptions, actor: string,
  memberId: string, raw: unknown) {
  const input = removalBody.parse(raw);
  const { store, binding, silo } = options;
  await readActiveMember(store, binding, actor, 'admin');
  const deadline = performance.now() + 10_000;
  const subject = `member-${memberId}`;
  const rows = await history(store, subject, silo, deadline);
  const saved = previous(rows, actor, input);
  if (saved) return saved;
  const target = await currentMembership(store, silo, memberId, undefined, deadline);
  if (target.role === 'owner') throw new RemovalConflict('ownership_stream_required');
  if (!target.role) throw new RemovalConflict('active_target_required');
  if ((rows.at(-1)?.sequence ?? 0) !== input.expectedSequence) {
    throw new RemovalConflict('concurrent_change');
  }
  const inventory = await memberInventory(options, memberId, deadline);
  if (!inventory.complete || inventory.ownedSharedWork.length) {
    throw new RemovalConflict('incomplete_review');
  }
  const ownershipSequence = target.ownership.at(-1)?.sequence ?? 0;
  const revision = reviewedRevision(inventory.reviewRevision, input.expectedSequence,
    ownershipSequence);
  if (revision !== input.reviewRevision) throw new RemovalConflict('stale_review');
  const membership = await currentMembership(store, silo, actor, undefined, deadline);
  const positions = new Map([...target.positions, ...membership.positions]);
  // Finish the inventory and histories before starting the short write access check.
  const fresh = await ownershipWriteAccess(store, positions);
  const authority = { requiredRole: 'admin' as const, fresh, membership };
  await activeMember(store, binding, actor, authority);
  const data = { memberId, removedBy: actor, reviewRevision: input.reviewRevision };
  const event = { id: randomUUID(), commandId: input.commandId, subject, silo,
    type: 'member.removed', source: 'opencrane-server', time: new Date().toISOString(),
    principal: { kind: 'human' as const, id: actor }, data };
  await fresh();
  // Check only the reviewed inventory inputs. Chat messages do not change these positions.
  await requireCurrentInventory(inventory, fresh.deadline);
  await fresh();
  const command = { event, expectedSequence: input.expectedSequence,
    deadline: fresh.deadline, historyChecked: true as const };
  const result = await store.append(command);
  if (result.status === 'unavailable' || result.status === 'rejected') {
    throw new Error('Removal append unavailable');
  }
  const updated = await history(store, subject, silo, performance.now() + 10_000);
  const completed = previous(updated, actor, input);
  if (completed) return completed;
  throw new RemovalConflict('concurrent_change');
}
async function requireCurrentInventory(inventory: Awaited<ReturnType<typeof memberInventory>>,
  deadline: number) {
  if (!await inventory.checkCurrent(deadline, false)) {
    throw new RemovalConflict('stale_review');
  }
}

export async function removalStatus(options: GroupOptions, actor: string,
  memberId: string, commandId: string) {
  const rows = await history(options.store, `member-${memberId}`, options.silo,
    performance.now() + 10_000);
  function matches(row: StoredEvent) {
    return row.event.type === 'member.removed' && row.event.commandId === commandId;
  }
  const row = rows.find(matches);
  if (!row) return undefined;
  await readActiveMember(options.store, options.binding, actor, 'admin');
  const projection = await projectionProgress(options, row, undefined);
  return { ...receipt(row), projection };
}
