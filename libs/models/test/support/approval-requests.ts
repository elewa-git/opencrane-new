import { readEvents } from '@opencrane/projections';
import type { StoredEvent } from '@opencrane/event-store';
import type { fixture } from '../fixture.ts';

type Fixture = Awaited<ReturnType<typeof fixture>>;

export async function discoverApprovalRequests(setup: Fixture) {
  const position = await setup.nats.store.head();
  const approvalRows: StoredEvent[] = [];
  // Scan every candidate stream so an unexpected second request cannot stay hidden.
  for await (const row of readEvents(setup.nats.store, 1, position)) {
    if (row.event.silo !== 'test') continue;
    if (!row.event.subject.startsWith('approval-')) continue;
    if (row.event.type !== 'tool.approval_requested') continue;
    approvalRows.push(row);
  }
  return approvalRows;
}
