import type { Db } from '@opencrane/projections';
import { isDeepStrictEqual } from 'node:util';
import type { EventStore } from '@opencrane/event-store';
import { mcpPublicationIntentDataSchema, type EventEnvelope } from '@opencrane/events';
import { registerHandler } from '@opencrane/handlers';
import { history, prepareGatewayConfiguration, PublicationUnavailable } from '@opencrane/models';

export function prepareGatewayConfigurationHandler(store: EventStore, silo: string, db: Db) {
  async function handle(trigger: EventEnvelope) {
    const parsed = mcpPublicationIntentDataSchema.safeParse(trigger.data);
    if (!parsed.success || trigger.silo !== silo || trigger.type !== 'mcp.server_published' ||
        trigger.subject !== `mcp-${parsed.data.serverId}`) return;
    try {
      const rows = await history(store, trigger.subject, silo);
      function matches(row: typeof rows[number]) {
        return isDeepStrictEqual(row.event, trigger);
      }
      if (!rows.some(matches)) return;
      if (!db.lock) throw new Error('Gateway locking unavailable');
      const intent = parsed.data;
      async function prepare() {
        await prepareGatewayConfiguration(store, silo, intent.serverId, intent.commandId);
      }
      // Share the delivery lock so a saved generation cannot overtake file replacement.
      await db.lock(`gateway-configuration:${silo}`, prepare);
    } catch (error) {
      if (error instanceof PublicationUnavailable) return;
      // Retry store failures without copying event contents into job diagnostics.
      // eslint-disable-next-line preserve-caught-error -- Job errors must not retain private data.
      throw new Error('Gateway preparation unavailable');
    }
  }
  return registerHandler('prepare-gateway-configuration', handle);
}
