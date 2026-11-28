import { recordIdSchema } from '@opencrane/events';
import type { Query } from '@opencrane/projections';
import { readActiveMember } from '@opencrane/models';
import { z } from 'zod';
import { buildTurnTools, type TurnToolServerState } from './turn-tools.ts';
import { turnToolReaders, type TurnToolReaderOptions } from './turn-tool-readers.ts';

export interface PersonalConnectionNeedsOptions extends TurnToolReaderOptions {
  db: Query;
}
const serverRow = z.object({ server_id: recordIdSchema });

/** Show only the missing accounts that the same turn builder would otherwise offer. */
export async function personalConnectionNeeds(options: PersonalConnectionNeedsOptions,
  requesterId: string, assistantId: string) {
  try {
    const queryOptions = { deadline: performance.now() + 10_000 };
    const result = await options.db.query(`SELECT server_id FROM mcp_catalogue
      WHERE silo = $1 ORDER BY server_id LIMIT 32`, [options.silo],
      queryOptions);
    const rows: { serverId: string }[] = [];
    for (const raw of result.rows) {
      const row = serverRow.parse(raw);
      const server = { serverId: row.server_id };
      rows.push(server);
    }
    const needs: { serverId: string; name: string; reason?: 'assistant_not_allowed' }[] = [];
    function missingConnection(server: TurnToolServerState, reason?: 'assistant_not_allowed') {
      const missing = { serverId: server.serverId,
        name: server.serverInfo?.name ?? server.serverId, ...(reason ? { reason } : {}) };
      needs.push(missing);
    }
    const readers = turnToolReaders(options);
    const toolInput = { rows, requesterId, assistantId, ...readers,
      baseMessageBytes: 0, missingConnection };
    await buildTurnTools(toolInput);
    return needs;
  } finally {
    await readActiveMember(options.store, options.binding, requesterId);
  }
}
