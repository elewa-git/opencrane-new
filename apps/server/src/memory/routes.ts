import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { isOrganisationSession, type AuthConfig } from '@opencrane/auth';
import { readActiveMember, MemberAccessRefused, PayingGroupRefused } from '@opencrane/models';
import { sessionFor } from '../members/routes.ts';
import { scopeAccess, scopeFor, resolveScope, MemoryRefused, type MemoryOptions } from './access.ts';
import { listFacts, memorySnapshot, readInput, readParams,
  scopeInput, limits, MemoryConflict } from './reads.ts';

export function registerMemoryReads(app: FastifyInstance, config: AuthConfig,
  options?: MemoryOptions) {
  app.get('/api/memory/scopes', handle);
  app.get('/api/memory/:scopeId/facts', handle);

  async function handle(request: FastifyRequest, reply: FastifyReply) {
    reply.header('cache-control', 'no-store');
    const session = sessionFor(request, config, new Date());
    if (!session) return reply.code(401).send({ status: 'refused' });
    if (!options) return reply.code(503).send({ status: 'unavailable' });
    try {
      if (!isOrganisationSession(config, session) || options.silo !== options.binding.silo) {
        throw new MemoryRefused();
      }
      const requester = await options.feed.memberId(options.silo, config.issuerUrl, session.sub);
      if (!requester) throw new MemoryRefused();
      await readActiveMember(options.store, options.binding, requester);
      if (request.routeOptions.url === '/api/memory/scopes') {
        return await discoverScopes(request, options, requester);
      }
      const params = readParams.parse(request.params);
      const scope = await resolveScope(options, requester, params.scopeId);
      const access = await scopeAccess(options, requester, scope);
      if (!access.canRead) throw new MemoryRefused();
      const query = readInput.parse(request.query);
      return await listFacts(options, requester, scope, query, config.cookieSecret);
    } catch (error) {
      let status = 503;
      if (error instanceof z.ZodError) status = 422;
      if (error instanceof MemoryConflict) status = 409;
      if (isRefused(error)) status = 404;
      let body = 'refused';
      if (status === 503) body = 'unavailable';
      return reply.code(status).send({ status: body });
    }
  }
}

function isRefused(error: unknown) {
  return error instanceof MemoryRefused || error instanceof MemberAccessRefused ||
    error instanceof PayingGroupRefused;
}

async function discoverScopes(request: FastifyRequest, options: MemoryOptions, requester: string) {
  const input = scopeInput.parse(request.query);
  const candidates = [scopeFor(options.silo, 'person', requester)];
  if (input.groupId) candidates.push(scopeFor(options.silo, 'group', input.groupId));
  if (input.assistantId) candidates.push(scopeFor(options.silo, 'assistant_notes', input.assistantId));
  const scopes: Awaited<ReturnType<typeof scopeAccess>>[] = [];
  for (const scope of candidates) {
    try {
      const access = await scopeAccess(options, requester, scope, true);
      await memorySnapshot(options, scope);
      scopes.push(access);
    } catch (error) {
      if (!isRefused(error)) throw error;
    }
  }
  return { scopes, limits };
}
