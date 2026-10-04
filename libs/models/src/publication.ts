import { reviewedHeaders } from './mcp-headers.ts';
import { z } from 'zod';
import type { EventStore } from '@opencrane/event-store';
import { publicationSchema, reviewedToolSchema, mcpServerDiscoveredDataSchema, type EventEnvelope } from '@opencrane/events';
import { grantStream, type Binding } from '@opencrane/authz';
import { envelope, history } from './actor.ts';
import { requireMcpAdmin, readToolPolicy } from './tool-policy.ts';
import { losslessJson } from './lossless-json.ts';

const id = z.string().regex(/^[\w-]{1,200}$/u);
const reviewCommand = z.object({ commandId: id, expectedSequence: z.int().nonnegative(), schemaDigest: z.string(),
  accountMode: z.enum(['none', 'personal', 'company']), tools: z.array(reviewedToolSchema).max(1000) }).strict();
export type McpPublication = z.infer<typeof publicationSchema>;

/** One reviewed revision owns the route, CEL, authz binding and outbound header names. */
export async function publishMcp(store: EventStore, binding: Binding, memberId: string, serverId: string, raw: unknown) {
  const command = reviewCommand.parse(raw);
  await requireMcpAdmin(store, binding, memberId);
  const rows = await history(store, `mcp-${serverId}`, binding.silo);
  const prior = rows.find(r => r.event.commandId === command.commandId);
  if (prior) return { status: 'conflict' as const }; // Check status by reference; never redispatch a change.
  if (rows.at(-1)?.sequence !== command.expectedSequence) return { status: 'conflict' as const };
  const discoveryRow = rows.findLast(r => r.event.type === 'mcp.server_discovered');
  const discovery = mcpServerDiscoveredDataSchema.parse(discoveryRow?.event.data);
  if (rows.some(r => r.sequence > discoveryRow!.sequence && ['mcp.tools_changed', 'mcp.server_rejected'].includes(r.event.type))) throw new Error('Review stale');
  if (discovery.schemaDigest !== command.schemaDigest || !discovery.tools?.length || command.tools.length !== discovery.tools.length ||
    new Set(command.tools.map(t => t.name)).size !== command.tools.length || command.tools.some(t => !discovery.tools!.some(d => d.name === t.name && d.revision === t.revision))) throw new Error('Review stale');
  const registration = z.object({ kind: z.literal('remote'), locator: z.string() }).parse(rows[0]?.event.data);
  const connectionId = (await readToolPolicy(store, binding.silo, serverId)).connectionId ?? `installed-${serverId}`;
  const route = `/mcp/${id.parse(serverId)}/${id.parse(connectionId)}`;
  const tools = [...command.tools].sort((a, b) => a.name.localeCompare(b.name));
  const names = JSON.stringify(tools.map(t => t.name));
  const headerParameters = reviewedHeaders(discovery.tools);
  const desired = { schemaDigest: discovery.schemaDigest, connectionId, accountMode: command.accountMode, tools, target: registration.locator, route,
    cel: `request.headers["mcp-method"] in ["server/discover", "tools/list"] || (request.headers["mcp-method"] == "tools/call" && request.headers["mcp-name"] in ${names})`,
    authz: `/authorize${route}`, headerNames: ['content-type', 'accept', 'mcp-protocol-version', 'mcp-method', 'mcp-name', 'x-request-id', 'x-mcp-permit', ...new Set(headerParameters.map(p => p.headerName))], headerParameters,
    transport: 'guarded-https' as const, version: '2026-07-28' as const };
  const digest = losslessJson(JSON.stringify(desired)).digest;
  const data = publicationSchema.parse({ serverId, publishedBy: memberId, changeRef: command.commandId, digest, desired });
  return store.append({ event: { ...envelope(binding.silo, `mcp-${serverId}`, 'mcp.server_published', data, command.commandId),
    principal: { kind: 'human', id: memberId }, source: 'opencrane-server' }, expectedSequence: command.expectedSequence });
}

export async function currentPublication(store: EventStore, silo: string, serverId: string) {
  const rows = await history(store, `mcp-${serverId}`, silo);
  const relevant = rows.filter(r => ['mcp.server_published', 'mcp.server_discovered', 'mcp.server_unpublished', 'mcp.tools_changed', 'mcp.server_rejected'].includes(r.event.type)).at(-1);
  const parsed = relevant?.event.type === 'mcp.server_published' ? publicationSchema.safeParse(relevant.event.data) : undefined;
  if (!parsed?.success || losslessJson(JSON.stringify(parsed.data.desired)).digest !== parsed.data.digest) return undefined;
  return parsed.data;
}

export async function publicationStatus(store: EventStore, silo: string, serverId: string) {
  const rows = await history(store, `mcp-${serverId}`, silo);
  const policy = await readToolPolicy(store, silo, serverId);
  const publication = await currentPublication(store, silo, serverId);
  const last = rows.at(-1);
  return { serverId, sequence: policy.sequence, changeRef: publication?.changeRef ?? last?.event.commandId,
    digest: publication?.digest, state: publication ? policy.published ? 'ready' : 'applying' : last?.event.type === 'mcp.server_unpublished' ? 'removed' : 'needs_review', policy };
}

/** Called only by the gateway reconciler after reading the loaded generation. */
export async function acknowledgeMcp(store: EventStore, silo: string, serverId: string, changeRef: string, digest: string) {
  const publication = await currentPublication(store, silo, serverId);
  const policy = await readToolPolicy(store, silo, serverId);
  if (!publication || publication.changeRef !== changeRef || publication.digest !== digest) return false;
  if (policy.published) return true;
  return (await store.append({ event: envelope(silo, `mcp-${serverId}`, 'mcp.configuration_applied', { serverId, changeRef, digest }), expectedSequence: policy.sequence })).status === 'appended';
}

export async function removeMcp(store: EventStore, binding: Binding, memberId: string, serverId: string, raw: unknown) {
  const command = z.object({ commandId: id, expectedSequence: z.int().nonnegative() }).strict().parse(raw);
  await requireMcpAdmin(store, binding, memberId);
  return store.append({ event: { ...envelope(binding.silo, `mcp-${id.parse(serverId)}`, 'mcp.server_unpublished', { serverId, unpublishedBy: memberId }, command.commandId),
    principal: { kind: 'human', id: memberId }, source: 'opencrane-server' }, expectedSequence: command.expectedSequence });
}

export async function mcpGrants(store: EventStore, silo: string, serverId: string) {
  const rows = await history(store, grantStream('mcp_server', serverId), silo);
  const grants = new Map<string, { granteeId: string; granteeKind: 'member' | 'team' | 'assistant' }>();
  for (const { event } of rows) {
    const data = z.object({ granteeId: id, granteeKind: z.enum(['member', 'team', 'assistant']).optional() }).parse(event.data);
    if (event.type === 'grant.revoked') grants.delete(data.granteeId);
    else if (data.granteeKind) grants.set(data.granteeId, { granteeId: data.granteeId, granteeKind: data.granteeKind });
  }
  return { sequence: rows.at(-1)?.sequence ?? 0, grants: [...grants.values()] };
}
export async function grantMcp(store: EventStore, binding: Binding, memberId: string, serverId: string, raw: unknown) {
  const command = z.object({ commandId: id, expectedSequence: z.int().nonnegative(), granteeId: id,
    granteeKind: z.enum(['member', 'team', 'assistant']), action: z.enum(['give', 'revoke']) }).strict().parse(raw);
  await requireMcpAdmin(store, binding, memberId);
  if (command.action === 'give' && !await currentPublication(store, binding.silo, serverId)) throw new Error('Review required');
  const type = command.action === 'give' ? 'grant.given' : 'grant.revoked';
  const data = { resourceType: 'mcp_server', resourceId: serverId, granteeId: command.granteeId,
    ...(command.action === 'give' ? { granteeKind: command.granteeKind, grantedBy: memberId } : { revokedBy: memberId }) };
  const event: EventEnvelope = { ...envelope(binding.silo, grantStream('mcp_server', serverId), type, data, command.commandId), principal: { kind: 'human', id: memberId }, source: 'opencrane-server' };
  return store.append({ event, expectedSequence: command.expectedSequence });
}
