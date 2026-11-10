import type { EventStore } from '@opencrane/event-store';

/** Allow another call to start without accepting a changed review or policy. */
export async function requireOnlyAdmissions(store: EventStore, silo: string,
  subject: string, fromPosition: number, toPosition: number, deadline: number) {
  if (toPosition === fromPosition) return;
  if (toPosition < fromPosition) throw new Error('MCP policy changed');
  let checkedPosition = fromPosition;
  for await (const row of store.readStream(subject, fromPosition + 1, deadline)) {
    if (row.sequence > toPosition) break;
    if (row.event.silo !== silo || row.event.type !== 'mcp.dispatch_admitted') {
      throw new Error('MCP policy changed');
    }
    checkedPosition = row.sequence;
  }
  if (checkedPosition !== toPosition) throw new Error('MCP position unavailable');
}

/** Check a saved position while allowing another tool call to start. */
export async function requireTrackedPosition(store: EventStore, silo: string,
  subject: string, savedPosition: number, serverId: string, deadline: number) {
  const currentPosition = await store.head(subject, deadline);
  if (subject === `mcp-${serverId}`) {
    await requireOnlyAdmissions(store, silo, subject, savedPosition, currentPosition, deadline);
    return;
  }
  if (currentPosition !== savedPosition) {
    throw new Error('MCP position changed');
  }
}
