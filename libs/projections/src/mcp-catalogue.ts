import { emptyToolPolicy, applyToolPolicy, isToolPolicyAvailable } from './tool-policy.ts';
import { toolPolicySchema } from '@opencrane/protocol';
import { getEventDefinition } from '@opencrane/events';
import type { IntegrationRow, SharedStateKind, ToolPolicy } from '@opencrane/protocol';
import type { Projection } from './runner.ts';

const eventTypes = new Set<string>([
  'mcp.catalogue_checked', 'mcp.server_registered', 'mcp.server_discovered', 'mcp.server_rejected',
  'mcp.server_reviewed', 'mcp.server_published', 'mcp.server_unpublished', 'mcp.tool_mode_set', 'mcp.tools_changed',
]);
const policyOnlyEvents = new Set(['mcp.catalogue_checked', 'mcp.server_reviewed']);
type ToolMode = 'allow' | 'ask' | 'block';

interface McpCatalogueTables {
  catalogue: string;
  toolModes: string;
}

const live = { catalogue: 'mcp_catalogue', toolModes: 'mcp_tool_modes' } satisfies McpCatalogueTables;
export const replayMcpCatalogueTables = {
  catalogue: 'mcp_catalogue_replay',
  toolModes: 'mcp_tool_modes_replay',
} satisfies McpCatalogueTables;

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

function optionalField(data: unknown, name: string): string | null {
  if (typeof data !== 'object' || data === null) throw new Error('Invalid MCP event data');
  const value: unknown = Reflect.get(data, name);
  if (value === undefined) return null;
  if (typeof value !== 'string') throw new Error(`Invalid MCP ${name}`);
  return value;
}

function serverInfo(data: unknown): { name: string; version: string } | undefined {
  if (typeof data !== 'object' || data === null) throw new Error('Invalid MCP event data');
  const value: unknown = Reflect.get(data, 'serverInfo');
  if (value === undefined) return undefined;
  return { name: field(value, 'name'), version: field(value, 'version') };
}

/** The register keeps event facts only. Labels and status wording are mapped below in TypeScript. */
function mcpCatalogueProjection(name: string, tables: McpCatalogueTables): Projection {
  return {
    name,
    async create(db) {
      await db.query(`CREATE TABLE IF NOT EXISTS ${tables.catalogue} (
      silo TEXT NOT NULL, server_id TEXT NOT NULL, source_kind TEXT NOT NULL,
      locator TEXT NOT NULL, catalogue_ref TEXT, server_name TEXT, server_version TEXT,
      tool_count INTEGER, lifecycle TEXT NOT NULL,
      changed_at TEXT NOT NULL, position BIGINT NOT NULL,
      PRIMARY KEY (silo, server_id))`);
      await db.query(`ALTER TABLE ${tables.catalogue} ADD COLUMN IF NOT EXISTS policy JSONB`);
      await db.query(`ALTER TABLE ${tables.catalogue} ADD COLUMN IF NOT EXISTS rejection_reason TEXT`);
      await db.query(`CREATE TABLE IF NOT EXISTS ${tables.toolModes} (
      silo TEXT NOT NULL, server_id TEXT NOT NULL, tool_name TEXT NOT NULL, mode TEXT NOT NULL,
      PRIMARY KEY (silo, server_id, tool_name))`);
    },
    async drop(db) {
      await db.query(`DROP TABLE IF EXISTS ${tables.toolModes}`);
      await db.query(`DROP TABLE IF EXISTS ${tables.catalogue}`);
    },
    async apply(db, event, position) {
      if (!eventTypes.has(event.type)) return;
      const data: unknown = getEventDefinition(event.type)?.dataSchema.parse(event.data);
      const serverId = field(data, 'serverId');
      if (event.subject !== `mcp-${serverId}`) throw new Error('MCP subject mismatch');
      if (event.type === 'mcp.server_registered') {
        await db.query(`INSERT INTO ${tables.catalogue} (silo, server_id, source_kind, locator, catalogue_ref, server_name, server_version, tool_count, lifecycle, changed_at, position, policy) VALUES ($1, $2, $3, $4, $5, NULL, NULL, NULL, 'registered', $6, $7, $8)
        ON CONFLICT (silo, server_id) DO UPDATE SET source_kind = $3, locator = $4,
        catalogue_ref = $5, server_name = NULL, server_version = NULL,
        tool_count = NULL, policy = $8, lifecycle = 'registered', changed_at = $6, position = $7`,
        [event.silo, serverId, field(data, 'kind'), field(data, 'locator'), optionalField(data, 'catalogueRef'),
          event.time, position, JSON.stringify(applyToolPolicy(emptyToolPolicy(), event, position))]);
        return;
      }
      const existing = await db.query(`SELECT server_id, policy FROM ${tables.catalogue} WHERE silo = $1 AND server_id = $2`,
        [event.silo, serverId]);
      if (!existing.rows.length) throw new Error('MCP event requires a registered server');
      const savedPolicy = existing.rows[0]?.['policy'];
      const current = savedPolicy ? toolPolicySchema.parse(savedPolicy) : emptyToolPolicy();
      const policy = applyToolPolicy(current, event, position);
      await db.query(`UPDATE ${tables.catalogue} SET policy = $3 WHERE silo = $1 AND server_id = $2`, [event.silo, serverId, JSON.stringify(policy)]);
      if (policyOnlyEvents.has(event.type)) return;
      if (event.type === 'mcp.tool_mode_set') {
        await db.query(`INSERT INTO ${tables.toolModes} VALUES ($1, $2, $3, $4)
        ON CONFLICT (silo, server_id, tool_name) DO UPDATE SET mode = $4`,
        [event.silo, serverId, field(data, 'toolName'), field(data, 'mode')]);
        return;
      }
      const lifecycle = catalogueLifecycle(event.type, policy.published);
      const toolCount = catalogueToolCount(event.type, data, policy);
      const info = event.type === 'mcp.server_discovered' ? serverInfo(data) : undefined;
      await db.query(`UPDATE ${tables.catalogue} SET lifecycle = $3,
      tool_count = COALESCE($4, tool_count), server_name = COALESCE($5, server_name),
      server_version = COALESCE($6, server_version), changed_at = $7, position = $8, rejection_reason = $9
      WHERE silo = $1 AND server_id = $2`,
      [event.silo, serverId, lifecycle, toolCount, info?.name ?? null, info?.version ?? null, event.time, position, optionalField(data, 'reason')]);
    },
  };
}

function catalogueLifecycle(type: string, published: boolean) {
  if (type === 'mcp.server_published' && !published) return 'discovered';
  return type.slice('mcp.'.length).replace('server_', '');
}

export const mcpCatalogue = mcpCatalogueProjection('mcp catalogue', live);
export const replayMcpCatalogue = mcpCatalogueProjection('mcp catalogue-replay', replayMcpCatalogueTables);

export interface McpCatalogueRow extends Record<string, unknown> {
  server_id: string;
  source_kind: 'remote' | 'hosted';
  locator: string;
  catalogue_ref: string | null;
  server_name: string | null;
  server_version: string | null;
  tool_count: number | null;
  lifecycle: string;
  changed_at: string;
  modes: ToolMode[] | null;
}

function words(serverId: string): string {
  const value = serverId.replace(/^mcp[-_]/u, '').replaceAll(/[-_]+/gu, ' ');
  return value.replace(/\b\p{L}/gu, (letter) => letter.toUpperCase());
}

function source(row: McpCatalogueRow): IntegrationRow['source'] {
  if (row.catalogue_ref !== null) {
    return { kind: 'catalogue', label: 'Catalogue', detail: row.catalogue_ref };
  }
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

function catalogueRowStatus(row: McpCatalogueRow): IntegrationRow['status'] {
  const policy = toolPolicySchema.safeParse(row['policy']);
  if (policy.success && policy.data.startupReviewRequired === true &&
      row.lifecycle === 'published') {
    return status('discovered', row.changed_at);
  }
  if (row.source_kind === 'remote' && row['rejection_reason'] === 'connection_required' &&
      row.lifecycle === 'rejected') {
    return { kind: 'needs_input', label: 'Needs input',
      detail: 'A scoped validation connection is required. Protected discovery is not available yet.' };
  }
  return status(row.lifecycle, row.changed_at);
}

export function mapMcpCatalogueRows(rows: McpCatalogueRow[]): IntegrationRow[] {
  return rows.map((row) => {
    const total = row.tool_count === null ? null : Number(row.tool_count);
    const policy = toolPolicySchema.safeParse(row['policy']);
    const modes = policy.success && policy.data.tools.length ? policy.data.tools.map(t => t.mode) : row.modes ?? [];
    const allowed = modes.filter((mode) => mode === 'allow' || mode === 'ask').length;
    return {
      serverId: row.server_id,
      name: row.server_name ?? words(row.server_id),
      source: source(row),
      version: row.server_version ?? (row.source_kind === 'hosted' ? `Digest ${row.locator.slice(-64, -52)}` : 'Version not provided'),
      accountModel: 'Not provided',
      toolsAllowed: total === null ? allowed : Math.min(allowed, total),
      toolsTotal: total,
      status: catalogueStatus(row, policy.success ? policy.data : null),
    };
  });
}


function catalogueStatus(row: McpCatalogueRow, policy: ToolPolicy | null): IntegrationRow['status'] {
  // Keep the saved startup result visible when tool discovery is blocked.
  if (policy?.startupReviewRequired === true) {
    return catalogueRowStatus(row);
  }
  const missingDates = row.tool_count !== null && !policy?.checkedAt;
  const stalePublication = row.lifecycle === 'published' &&
    (!policy || !isToolPolicyAvailable(policy));
  if (missingDates || stalePublication) {
    return { kind: 'disabled', label: 'Unavailable', detail: 'No fresh tool catalogue check' };
  }
  return catalogueRowStatus(row);
}


function catalogueToolCount(type: string, data: unknown, policy: ToolPolicy) {
  if (type === 'mcp.server_discovered') return numberField(data, 'toolCount');
  return policy.catalogue?.toolCount ?? null;
}
