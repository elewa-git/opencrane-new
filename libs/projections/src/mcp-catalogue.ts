import { getEventDefinition } from '@opencrane/events';
import type { IntegrationRow, SharedStateKind } from '@opencrane/protocol';
import type { Projection } from './runner.ts';

const eventTypes = new Set<string>([
  'mcp.server_registered', 'mcp.server_discovered', 'mcp.server_rejected',
  'mcp.server_published', 'mcp.server_unpublished', 'mcp.tool_mode_set', 'mcp.tools_changed',
]);

function field(data: unknown, name: string): string {
  if (typeof data !== 'object' || data === null) throw new Error('Invalid MCP event data');
  const value: unknown = Reflect.get(data, name);
  if (typeof value !== 'string') throw new Error(`Missing MCP ${name}`);
  return value;
}

function numberField(data: unknown, name: string): number {
  if (typeof data !== 'object' || data === null) throw new Error('Invalid MCP event data');
  const value: unknown = Reflect.get(data, name);
  if (typeof value !== 'number') throw new Error(`Missing MCP ${name}`);
  return value;
}

/** The register keeps event facts only. Labels and status wording are mapped below in TypeScript. */
export const mcpCatalogue: Projection = {
  name: 'mcp catalogue',
  async create(db) {
    await db.query(`CREATE TABLE IF NOT EXISTS mcp_catalogue (
      silo TEXT NOT NULL, server_id TEXT NOT NULL, source_kind TEXT NOT NULL,
      locator TEXT NOT NULL, tool_count INTEGER, lifecycle TEXT NOT NULL,
      changed_at TEXT NOT NULL, position BIGINT NOT NULL,
      PRIMARY KEY (silo, server_id))`);
    await db.query(`CREATE TABLE IF NOT EXISTS mcp_tool_modes (
      silo TEXT NOT NULL, server_id TEXT NOT NULL, tool_name TEXT NOT NULL, mode TEXT NOT NULL,
      PRIMARY KEY (silo, server_id, tool_name))`);
  },
  async drop(db) {
    await db.query('DROP TABLE IF EXISTS mcp_tool_modes');
    await db.query('DROP TABLE IF EXISTS mcp_catalogue');
  },
  async apply(db, event, position) {
    if (!eventTypes.has(event.type)) return;
    const data: unknown = getEventDefinition(event.type)?.dataSchema.parse(event.data);
    const serverId = field(data, 'serverId');
    if (event.subject !== `mcp-${serverId}`) throw new Error('MCP subject mismatch');
    if (event.type === 'mcp.server_registered') {
      await db.query(`INSERT INTO mcp_catalogue VALUES ($1, $2, $3, $4, NULL, 'registered', $5, $6)
        ON CONFLICT (silo, server_id) DO UPDATE SET source_kind = $3, locator = $4,
        tool_count = NULL, lifecycle = 'registered', changed_at = $5, position = $6`,
      [event.silo, serverId, field(data, 'kind'), field(data, 'locator'), event.time, position]);
      return;
    }
    const existing = await db.query('SELECT server_id FROM mcp_catalogue WHERE silo = $1 AND server_id = $2',
      [event.silo, serverId]);
    if (!existing.rows.length) throw new Error('MCP event requires a registered server');
    if (event.type === 'mcp.tool_mode_set') {
      await db.query(`INSERT INTO mcp_tool_modes VALUES ($1, $2, $3, $4)
        ON CONFLICT (silo, server_id, tool_name) DO UPDATE SET mode = $4`,
      [event.silo, serverId, field(data, 'toolName'), field(data, 'mode')]);
      return;
    }
    const lifecycle = event.type.slice('mcp.'.length).replace('server_', '');
    const toolCount = event.type === 'mcp.server_discovered' ? numberField(data, 'toolCount') : null;
    await db.query(`UPDATE mcp_catalogue SET lifecycle = $3,
      tool_count = COALESCE($4, tool_count), changed_at = $5, position = $6
      WHERE silo = $1 AND server_id = $2`,
    [event.silo, serverId, lifecycle, toolCount, event.time, position]);
  },
};

export interface McpCatalogueRow extends Record<string, unknown> {
  server_id: string;
  source_kind: 'remote' | 'hosted';
  locator: string;
  tool_count: number | null;
  lifecycle: string;
  changed_at: string;
  allowed: string | number;
}

function words(serverId: string): string {
  const value = serverId.replace(/^mcp[-_]/u, '').replaceAll(/[-_]+/gu, ' ');
  return value.replace(/\b\p{L}/gu, (letter) => letter.toUpperCase());
}

function source(row: McpCatalogueRow): IntegrationRow['source'] {
  if (row.source_kind === 'remote') {
    return { kind: 'remote_url', label: 'Remote URL', detail: new URL(row.locator).host };
  }
  const [image = row.locator, digest = ''] = row.locator.split('@sha256:');
  return { kind: 'package', label: 'Package', detail: `${image}@sha256:${digest.slice(0, 12)}…` };
}

function status(lifecycle: string, changedAt: string): IntegrationRow['status'] {
  const time = new Date(changedAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' });
  const values: Record<string, [SharedStateKind, string, string, boolean?]> = {
    registered: ['checking', 'Applying / checking', 'Validating server…'],
    discovered: ['needs_input', 'Needs input', 'Pending review'],
    rejected: ['failed', 'Failed', 'Validation failed; review before trying again'],
    published: ['ready', 'Ready', `Published ${time}`],
    unpublished: ['disabled', 'Disabled', `Unpublished ${time}`],
    tools_changed: ['needs_input', 'Needs input', 'Pending review · tools changed'],
  };
  const [kind, label, detail, safeToRetry] = values[lifecycle] ?? ['unknown', 'Outcome unknown', 'Check the server status'];
  return { kind, label, detail, ...(safeToRetry !== undefined && { safeToRetry }) };
}

export function mapMcpCatalogueRows(rows: McpCatalogueRow[]): IntegrationRow[] {
  return rows.map((row) => {
    const total = row.tool_count === null ? null : Number(row.tool_count);
    const allowed = Number(row.allowed);
    return {
      serverId: row.server_id,
      name: words(row.server_id),
      source: source(row),
      version: row.source_kind === 'hosted' ? `Digest ${row.locator.slice(-64, -52)}` : 'Version not provided',
      accountModel: 'Not configured',
      toolsAllowed: total === null ? allowed : Math.min(allowed, total),
      toolsTotal: total,
      status: status(row.lifecycle, row.changed_at),
    };
  });
}
