import type { EventStore } from '@opencrane/event-store';
import { memberAuthorisation, type Binding } from '@opencrane/authz';
import { history } from './actor.ts';
import { data } from './state.ts';

export class PayingGroupRefused extends Error {}
/** Shared spending requires an existing local group and current requester membership. */
export async function payingGroupAuthority(store: EventStore, silo: string, requesterId: string, groupId: string, binding?: Binding) {
  const started = performance.now();
  let rows: Awaited<ReturnType<typeof history>>, member: Awaited<ReturnType<typeof history>>;
  try { [rows, member] = await Promise.all([history(store, `team-${groupId}`, silo), history(store, `member-${requesterId}`, silo)]); }
  catch { throw new PayingGroupRefused('Paying group unavailable or spending permission refused'); }
  const live = member.findLast(r => ['member.joined', 'member.role_changed', 'member.removed'].includes(r.event.type));
  if (!live || live.event.type === 'member.removed') throw new PayingGroupRefused('Active silo membership required');
  const created = rows.find(r => r.event.type === 'team.created');
  const membership = rows.filter(r => ['team.member_added', 'team.member_removed'].includes(r.event.type) && data(r.event)['memberId'] === requesterId).at(-1);
  if (!created || data(created.event)['teamId'] !== groupId || membership?.event.type !== 'team.member_added') throw new PayingGroupRefused('Paying group unavailable or spending permission refused');
  if (binding) {
    const auth = memberAuthorisation(binding);
    if (binding.silo !== silo || !(await auth.check(requesterId, 'member')).allowed || !(await auth.team(requesterId, groupId)).allowed) throw new PayingGroupRefused('Paying group unavailable or spending permission refused');
    for (const row of [...rows, ...member.filter(r => r.event.type !== 'member.invited')]) if (!await auth.applied(row.event.id)) throw new PayingGroupRefused('Paying group membership is still being applied; try again shortly');
  }
  return async () => {
    if (await store.head(`team-${groupId}`) !== rows.at(-1)?.sequence || await store.head(`member-${requesterId}`) !== member.at(-1)?.sequence || performance.now() - started > 2000) throw new PayingGroupRefused('Paying group authority changed; try again');
  };
}
