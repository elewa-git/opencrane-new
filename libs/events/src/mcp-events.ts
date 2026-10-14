import { event } from './definition.ts';
import * as data from './data.ts';
const DIGEST_EXAMPLE = '0123456789abcdef'.repeat(4);

export const mcpEvents = [
  // MCP catalogue, grants and connections
  event(
    'mcp.server_registered',
    'mcp',
    'An admin registered a new MCP server in the catalogue (draft).',
    data.mcpServerRegisteredDataSchema,
    { serverId: 'mcp_1', kind: 'remote', locator: 'https://mcp.example.com', registeredBy: 'mem_1',
      catalogueRef: 'catalogue:odoo' },
  ),
  event(
    'mcp.server_discovered',
    'mcp',
    "Discovery read the server's tool list and schema digests.",
    data.mcpServerDiscoveredDataSchema,
    { serverId: 'mcp_1', toolCount: 3, schemaDigest: DIGEST_EXAMPLE,
      serverInfo: { name: 'Odoo', version: '1.4.2' } },
  ),
  event(
    'mcp.catalogue_checked', 'mcp',
    'A tool catalogue check recorded fresh unchanged evidence or a failure.',
    data.mcpCatalogueCheckedDataSchema,
    { serverId: 'mcp_1', outcome: 'unchanged', schemaDigest: DIGEST_EXAMPLE,
      checkedAt: '2026-10-10T12:00:00.000Z', expiresAt: '2026-10-10T12:05:00.000Z' },
  ),
  event(
    'mcp.server_reviewed', 'mcp',
    'An owner or admin reviewed exact saved tools and chose their modes.',
    data.mcpServerReviewedDataSchema,
    { serverId: 'mcp_1', catalogueDigest: DIGEST_EXAMPLE, connectionId: 'installed',
      accountMode: 'none', policyRevision: 1, reviewedBy: 'mem_1', tools: [] },
  ),
  event(
    'mcp.server_rejected',
    'mcp',
    'Validation (SSRF guard or image scan) failed, so the server was rejected.',
    data.mcpServerRejectedDataSchema,
    { serverId: 'mcp_1', reason: 'ssrf_guard_failed' },
  ),
  event(
    'mcp.tool_mode_set',
    'mcp',
    'An admin set a tool to Allow automatically, Ask, or Block.',
    data.mcpToolModeSetDataSchema,
    { serverId: 'mcp_1', toolName: 'odoo.write', mode: 'ask', setBy: 'mem_1' },
  ),
  event(
    'mcp.dispatch_admitted', 'mcp',
    'A one-use call was admitted before later tool policy or hold changes.',
    data.mcpDispatchAdmittedDataSchema,
    { serverId: 'mcp_1', connectionId: 'installed', requestId: 'call_1',
      toolName: 'odoo.write', toolRevision: DIGEST_EXAMPLE,
      schemaDigest: DIGEST_EXAMPLE, generation: 'instance-1' },
  ),
  event(
    'mcp.server_published',
    'mcp',
    'An admin saved publication intent; older records retain their legacy meaning.',
    data.mcpServerPublishedDataSchema,
    { serverId: 'mcp_1', publishedBy: 'mem_1' },
  ),
  event(
    'mcp.server_unpublished',
    'mcp',
    'An admin unpublished an MCP server, removing its gateway route.',
    data.mcpServerUnpublishedDataSchema,
    { serverId: 'mcp_1', unpublishedBy: 'mem_1' },
  ),
  event(
    'mcp.tools_changed',
    'mcp',
    "A drift check found a registered MCP server's tool list or schemas changed.",
    data.mcpToolsChangedDataSchema,
    { serverId: 'mcp_1', previousSchemaDigest: DIGEST_EXAMPLE, newSchemaDigest: DIGEST_EXAMPLE.split('').reverse().join('') },
  ),
  event(
    'grant.given',
    'grant',
    'A shared resource was granted to a person, team or assistant.',
    data.grantGivenDataSchema,
    { resourceType: 'mcp_server', resourceId: 'mcp_1', granteeId: 'team_1', granteeKind: 'team', grantedBy: 'mem_1' },
  ),
  event(
    'grant.revoked',
    'grant',
    'A grant on a shared resource was revoked.',
    data.grantRevokedDataSchema,
    { resourceType: 'mcp_server', resourceId: 'mcp_1', granteeId: 'team_1', revokedBy: 'mem_1' },
  ),
  event(
    'connection.created',
    'connection',
    'A person saved a staged connection reference; account identity may remain unverified.',
    data.connectionCreatedDataSchema,
    { userId: 'mem_1', serverId: 'mcp_1', profile: 'default', secretRef: 'secret:1' },
  ),
  event(
    'connection.refreshed',
    'connection',
    "A command rotated a bearer reference, or a reaction refreshed an OAuth connection.",
    data.connectionRefreshedDataSchema,
    { userId: 'mem_1', serverId: 'mcp_1', profile: 'default', secretRef: 'secret:2' },
  ),
  event(
    'connection.revoked',
    'connection',
    'An owner revoked a connection. Secret cleanup is separate.',
    data.connectionRevokedDataSchema,
    { userId: 'mem_1', serverId: 'mcp_1', profile: 'default', revokedBy: 'mem_1' },
  ),
  event(
    'connection.disabled',
    'connection',
    'An admin blocked personal connections for one member and server.',
    data.connectionDisabledDataSchema,
    { userId: 'mem_1', serverId: 'mcp_1', profile: 'default', disabledBy: 'admin_1',
      expectedSequence: 0, reason: 'admin_disabled' },
  ),

];
