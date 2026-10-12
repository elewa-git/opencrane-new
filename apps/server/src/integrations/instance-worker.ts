import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { EventStore } from '@opencrane/event-store';
import { z } from 'zod';
import { mcpInstanceWorkerRegistration, mcpInstanceObservation } from '@opencrane/models';
import { idSchema } from '../members/guard.ts';
import { instanceError, invalidBody } from './instance-routes.ts';

type Worker = Awaited<ReturnType<typeof mcpInstanceWorkerRegistration>>;
interface Lease {
  worker: Worker;
  expiresAt: number;
  controller: AbortController;
  expiryTimer?: NodeJS.Timeout;
}
const parameters = z.strictObject({ instanceId: idSchema.regex(/^[a-f0-9]{64}$/u) });

function credentialDigest(authorization: string) {
  const hash = createHash('sha256');
  hash.update(authorization);
  return hash.digest('hex');
}

export function registerMcpInstanceWorkerRoutes(app: FastifyInstance, store: EventStore,
  silo: string) {
  const leases = new Map<string, Lease>();
  const routeOptions = { bodyLimit: 4096, errorHandler: invalidBody };
  app.post('/internal/mcp/instances/:instanceId/observations', routeOptions, observe);
  app.addHook('onClose', clear);

  function retire(digest: string, lease: Lease) {
    clearTimeout(lease.expiryTimer);
    lease.controller.abort();
    leases.delete(digest);
  }

  function clear() {
    for (const [digest, lease] of leases) {
      retire(digest, lease);
    }
    return Promise.resolve();
  }

  function retain(digest: string, lease: Lease) {
    function expire() {
      retire(digest, lease);
    }
    // Keep the timer outside registration so its closure cannot retain the issued bearer.
    lease.expiryTimer = setTimeout(expire, Math.max(0, lease.expiresAt - Date.now()));
    lease.expiryTimer.unref();
    leases.set(digest, lease);
  }

  // Issue a pass only to trusted server code; no browser or HTTP route can register a worker.
  async function register(input: unknown) {
    const worker = await mcpInstanceWorkerRegistration(store, silo, input);
    const now = Date.now();
    for (const [digest, lease] of leases) {
      if (lease.expiresAt <= now || lease.worker.instanceId === worker.instanceId) {
        retire(digest, lease);
      }
    }
    const authorization = `Bearer ${randomBytes(32).toString('hex')}`;
    const expiresAt = now + 30_000;
    const controller = new AbortController();
    const lease = { worker, expiresAt, controller };
    retain(credentialDigest(authorization), lease);
    return { authorization, expiresAt };
  }

  async function observe(request: FastifyRequest, reply: FastifyReply) {
    reply.header('cache-control', 'no-store');
    const digest = credentialDigest(request.headers.authorization ?? '');
    const lease = leases.get(digest);
    if (!lease || lease.expiresAt <= Date.now()) {
      if (lease) retire(digest, lease);
      return reply.code(403).send({ status: 'refused' });
    }
    try {
      const { instanceId } = parameters.parse(request.params);
      if (instanceId !== lease.worker.instanceId) {
        return reply.code(403).send({ status: 'refused' });
      }
      const permission = { expiresAt: lease.expiresAt, signal: lease.controller.signal };
      return await mcpInstanceObservation(store, silo, lease.worker, permission, request.body);
    } catch (error) {
      return instanceError(reply, error);
    }
  }
  return { register };
}
