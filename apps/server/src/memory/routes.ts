import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { isOrganisationSession, type AuthConfig } from '@opencrane/auth';
import { readActiveMember, MemberAccessRefused, PayingGroupRefused } from '@opencrane/models';
import { sessionFor } from '../members/routes.ts';
import { scopeAccess, scopeFor, resolveScope, memoryAccessChecks, MemoryRefused,
  type MemoryOptions } from './access.ts';
import { detailFact, listFacts, memorySnapshot, readInput, readParams,
  scopeInput, limits, MemoryConflict } from './reads.ts';

export function registerMemoryReads(app: FastifyInstance, config: AuthConfig,
  options?: MemoryOptions) {

  app.get('/api/memory/scopes', handle);
  app.get('/api/memory/:scopeId/facts', handle);
  app.get('/api/memory/:scopeId/facts/:memoryId', handle);

  async function handle(request: FastifyRequest, reply: FastifyReply) {
    reply.header('cache-control', 'no-store');
    const session = sessionFor(request, config, new Date());
    if (!session) {
      return reply.code(401).send({ status: 'refused' });
    }
    if (!options) {
      return reply.code(503).send({ status: 'unavailable', reason: 'memory_unavailable' });
    }
    try {
      if (!isOrganisationSession(config, session) || options.silo !== options.binding.silo) {
        throw new MemoryRefused();
      }
      const requester = await options.feed.memberId(options.silo, config.issuerUrl, session.sub);
      if (!requester) {
        throw new MemoryRefused();
      }
      const checks = memoryAccessChecks(options, requester);
      await readActiveMember(options.store, options.binding, requester, 'member', checks.applied);
      if (request.routeOptions.url === '/api/memory/scopes') {
        return await discoverScopes(request, options, requester, checks);
      }
      const params = readParams.strip().parse(request.params);
      const scope = await resolveScope(options, requester, params.scopeId);
      const access = await scopeAccess(options, requester, scope, false, checks);
      if (!access.canRead) {
        throw new MemoryRefused();
      }
      if (request.routeOptions.url?.endsWith('/:memoryId')) {
        return await readDetail(request, options, requester, scope);
      }
      const query = readInput.parse(request.query);
      return await listFacts(options, requester, scope, query, config.cookieSecret);
    } catch (error) {
      if (error instanceof MemoryBusy) {
        reply.header('retry-after', '1');
        return reply.code(503).send({ status: 'unavailable', reason: 'memory_busy' });
      }
      let status = 503;
      if (error instanceof z.ZodError) {
        status = 422;
      }
      if (error instanceof MemoryConflict) {
        status = 409;
      }
      if (isRefused(error)) {
        status = 404;
      }
      if (status === 503) {
        return reply.code(status).send({ status: 'unavailable', reason: 'memory_unavailable' });
      }
      return reply.code(status).send({ status: 'refused' });
    }
  }
}

function isRefused(error: unknown) {
  return error instanceof MemoryRefused || error instanceof MemberAccessRefused ||
    error instanceof PayingGroupRefused;
}

async function discoverScopes(request: FastifyRequest, options: MemoryOptions, requester: string,
  checks: ReturnType<typeof memoryAccessChecks>) {
  const input = scopeInput.parse(request.query);
  const candidates = [scopeFor(options.silo, 'person', requester)];
  if (input.groupId) {
    candidates.push(scopeFor(options.silo, 'group', input.groupId));
  }
  if (input.assistantId) {
    candidates.push(scopeFor(options.silo, 'assistant_notes', input.assistantId));
  }
  const scopes: Awaited<ReturnType<typeof scopeAccess>>[] = [];
  for (const scope of candidates) {
    try {
      const access = await scopeAccess(options, requester, scope, true, checks);
      await memorySnapshot(options, scope);
      scopes.push(access);
    } catch (error) {
      if (!isRefused(error)) {
        throw error;
      }
    }
  }
  return { scopes, limits };
}

const detailIdentifier = z.object({ memoryId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/u) });
async function readDetail(request: FastifyRequest, options: MemoryOptions, requester: string,
  scope: Awaited<ReturnType<typeof resolveScope>>) {
  const detail = detailIdentifier.safeParse(request.params);
  if (!detail.success) {
    throw new MemoryRefused();
  }
  return detailFact(options, requester, scope, detail.data.memoryId);
}
