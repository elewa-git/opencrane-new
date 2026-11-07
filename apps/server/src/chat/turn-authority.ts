import type { EventStore } from '@opencrane/event-store';
import { authorityFence } from '@opencrane/models';
import { chatMembership } from './participation.ts';
import { ReportRejected } from './reports.ts';

export class TurnAdmissionRejected extends ReportRejected {}
export class BudgetAdmissionRejected extends TurnAdmissionRejected {
  readonly stopId: string;

  constructor(stopId: string) {
    super('Turn stopped by a spending cap');
    this.stopId = stopId;
  }
}

export async function requireTurnMember(store: EventStore, silo: string, requesterId: string) {
  const subjects = [`member-${requesterId}`];
  const fresh = await authorityFence(store, performance.now(), subjects);
  const active = await chatMembership(store, silo, requesterId, fresh.deadline);
  if (!active) throw new TurnAdmissionRejected('Active silo membership required');
  await fresh();
  return fresh;
}
