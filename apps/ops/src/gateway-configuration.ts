import { isDeepStrictEqual } from 'node:util';
import type { EventStore } from '@opencrane/event-store';
import { mcpPublicationIntentDataSchema, type EventEnvelope } from '@opencrane/events';
import { registerHandler } from '@opencrane/handlers';
import { history, prepareGatewayConfiguration, PublicationUnavailable } from '@opencrane/models';

export function prepareGatewayConfigurationHandler(store: EventStore, silo: string) {
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
      await prepareGatewayConfiguration(store, silo, parsed.data.serverId, parsed.data.commandId);
    } catch (error) {
      if (error instanceof PublicationUnavailable) return;
      // Retry store failures without copying event contents into job diagnostics.
      // eslint-disable-next-line preserve-caught-error -- Job errors must not retain private data.
      throw new Error('Gateway preparation unavailable');
    }
  }
  return registerHandler('prepare-gateway-configuration', handle);
}
