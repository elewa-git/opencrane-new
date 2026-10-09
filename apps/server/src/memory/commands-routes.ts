import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { isOrganisationSession, type AuthConfig } from '@opencrane/auth';
import { readActiveMember, MemberAccessRefused, PayingGroupRefused } from '@opencrane/models';
import { sessionFor } from '../members/routes.ts';
import { scopeAccess, resolveScope, memoryAccessChecks, MemoryRefused,
  type MemoryOptions } from './access.ts';
import { remember, readCommand, changeParams, reconcileCommands } from './commands.ts';
import { MemoryBusy } from './admission.ts';

export function registerMemoryCommands(app: FastifyInstance, config: AuthConfig,
  options?: MemoryOptions) {
  async function reconcile() {
    try {
      if (options) await reconcileCommands(options);
    } catch {
      app.log.warn('Memory command recovery will need another check');
    }
  }
  function startRecovery(done: () => void) {
    // Let startup finish before scanning files or contacting the event store.
    function runRecovery() {
      void reconcile();
    }
    setImmediate(runRecovery);
    done();
  }
  app.addHook('onReady', startRecovery);
  app.get('/api/memory/:scopeId/changes/:commandId', handle);
  const postOptions = { bodyLimit: 16384, errorHandler: invalidCommandBody };
  app.post('/api/memory/:scopeId/facts', postOptions, handle);

  async function handle(request: FastifyRequest, reply: FastifyReply) {
    reply.header('cache-control', 'no-store');
    const session = sessionFor(request, config, new Date());
    if (!session) {
      return reply.code(401).send({ status: 'refused' });
    }
    if (!options) {
      return reply.code(503).send({ status: 'unavailable', reason: 'memory_unavailable' });
    }
    if (wrongOrigin(request, config)) return reply.code(403).send({ status: 'refused' });
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
      const result = await handleCommand(request, options, requester, checks);
      if (result.status === 409) reply.code(409);
      return result.body;
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

async function handleCommand(request: FastifyRequest, options: MemoryOptions, requester: string,
  checks: ReturnType<typeof memoryAccessChecks>) {
  const params = changeParams.strip().parse(request.params);
  const scope = await resolveScope(options, requester, params.scopeId);
  if (request.method === 'POST') {
    const result = await remember(options, requester, scope, request.body);
    if (result.outcome === 'conflict' || result.outcome === 'failed') {
      return { status: 409, body: result };
    }
    return { status: 200, body: result };
  }
  const access = await scopeAccess(options, requester, scope, true, checks);
  if (!access.canRead && !access.canWrite) {
    throw new MemoryRefused();
  }
  return { status: 200, body: await readCommand(options, requester, scope,
    params.commandId, access.audience) };
}

function wrongOrigin(request: FastifyRequest, config: AuthConfig) {
  return request.method === 'POST' && request.headers.origin !== new URL(config.redirectUri).origin;
}

function invalidCommandBody(_error: Error, _request: FastifyRequest, reply: FastifyReply) {
  reply.header('cache-control', 'no-store');
  return reply.code(422).send({ status: 'refused' });
}

function isRefused(error: unknown) {
  return error instanceof MemoryRefused || error instanceof MemberAccessRefused ||
    error instanceof PayingGroupRefused;
}
