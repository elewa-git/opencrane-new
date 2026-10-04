import { grantStream } from '@opencrane/authz';
import { z } from 'zod';
import type { FastifyRequest, FastifyReply } from 'fastify';
import type { AuthConfig } from '@opencrane/auth';
import { publishMcp, publicationStatus, mcpGrants, grantMcp, removeMcp, history } from '@opencrane/models';
import type { EventStore } from '@opencrane/event-store';
import type { Binding } from '@opencrane/authz';
interface PublicationOptions { store?: EventStore; silo: string; binding: Binding }

export async function publicationRequest(request: FastifyRequest, reply: FastifyReply, config: AuthConfig, options: PublicationOptions, memberId: string) {
  if (!options.store) return reply.code(503).send({ status: 'unavailable' });
  const { serverId } = z.object({ serverId: z.string().regex(/^[\w-]{1,200}$/u) }).parse(request.params);
  if (request.method === 'GET') {
    const query = z.object({ changeRef: z.string().max(200).optional() }).strict().parse(request.query);
    const status = await publicationStatus(options.store, options.silo, serverId);
    const grants = await mcpGrants(options.store, options.silo, serverId);
    const rows = await history(options.store, `mcp-${serverId}`, options.silo);
    const found = !query.changeRef || rows.some(r => r.event.commandId === query.changeRef) ||
      (await history(options.store, grantStream('mcp_server', serverId), options.silo)).some(r => r.event.commandId === query.changeRef);
    return reply.send({ ...status, ...(query.changeRef && !found ? { state: 'unknown', changeRef: query.changeRef } : {}),
      grants: grants.grants, grantSequence: grants.sequence, ...await audience(options.store, options.silo, grants.grants) });
  }
  if (request.headers.origin !== new URL(config.redirectUri).origin) return reply.code(403).send({ status: 'refused' });
  const command = request.url.endsWith('/grants') ? grantMcp : request.url.endsWith('/remove') ? removeMcp : publishMcp;
  const result = await command(options.store, options.binding, memberId, serverId, request.body);
  const { commandId } = z.object({ commandId: z.string() }).parse(request.body);
  return reply.code(result.status === 'appended' ? 202 : result.status === 'conflict' ? 409 : 503).send({ status: result.status, changeRef: commandId });
}

async function audience(store: EventStore, silo: string, grants: Awaited<ReturnType<typeof mcpGrants>>['grants']) {
  const candidates = new Map<string, { id: string; kind: 'member' | 'team' | 'assistant'; name: string }>();
  const teams = new Map<string, Set<string>>();
  for (const category of ['member', 'team', 'assistant'] as const) for await (const { event } of store.readStream(`${category}-*`)) {
    if (event.silo !== silo) continue;
    const d = z.record(z.string(), z.unknown()).parse(event.data), id = String(d[`${category}Id`]);
    if (['member.joined', 'team.created', 'assistant.created'].includes(event.type)) candidates.set(`${category}:${id}`, { id, kind: category, name: z.string().parse(d['displayName'] ?? d['name'] ?? id) });
    if (event.type === 'member.removed') candidates.delete(`member:${id}`);
    if (category === 'team') {
      const members = teams.get(id) ?? new Set<string>();
      if (event.type === 'team.member_added') members.add(String(d['memberId']));
      if (event.type === 'team.member_removed') members.delete(String(d['memberId']));
      teams.set(id, members);
    }
  }
  const affected = new Set(grants.flatMap(g => g.granteeKind === 'member' ? [g.granteeId] : g.granteeKind === 'team' ? [...teams.get(g.granteeId) ?? []] : []));
  return { candidates: [...candidates.values()], affectedUsers: [...affected].map(id => candidates.get(`member:${id}`)).filter(c => c !== undefined) };
}
