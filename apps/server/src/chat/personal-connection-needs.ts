import type { Query } from '@opencrane/projections';
import { readActiveMember } from '@opencrane/models';
import { z } from 'zod';
import { buildTurnTools, type TurnToolServerState } from './turn-tools.ts';
import { turnToolReaders, type TurnToolReaderOptions } from './turn-tool-readers.ts';

export interface PersonalConnectionNeedsOptions extends TurnToolReaderOptions {
  db: Query;
}
const serverRow = z.object({ server_id: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/u) });

/** Show only the missing accounts that the same turn builder would otherwise offer. */
export async function personalConnectionNeeds(options: PersonalConnectionNeedsOptions,
  requesterId: string, assistantId: string) {
  try {
    const result = await options.db.query(`SELECT server_id FROM mcp_catalogue
      WHERE silo = $1 ORDER BY server_id LIMIT 32`, [options.silo],
    { deadline: performance.now() + 10_000 });
    const rows: { serverId: string }[] = [];
    for (const raw of result.rows) {
      const row = serverRow.parse(raw);
      rows.push({ serverId: row.server_id });
    }
    const needs: { serverId: string; name: string }[] = [];
    function missingConnection(server: TurnToolServerState) {
      needs.push({ serverId: server.serverId, name: server.serverInfo?.name ?? server.serverId });
    }
    const readers = turnToolReaders(options);
    await buildTurnTools({ rows, requesterId, assistantId, ...readers,
      baseMessageBytes: 0, missingConnection });
    return needs;
  } finally {
    await readActiveMember(options.store, options.binding, requesterId);
  }
}
