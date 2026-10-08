import { createHmac } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { isOrganisationSession, type AuthConfig } from '@opencrane/auth';
import { memberAuthorisation } from '@opencrane/authz';
import { authorityFence, currentMembership, listEffects, readEffect, resolveEffect } from '@opencrane/models';
import type { EventStore } from '@opencrane/event-store';
import type { IntegrationOptions } from '../integrations/routes.ts';
import { sessionFor } from '../members/routes.ts';

type EffectOptions = IntegrationOptions & { store: EventStore };
export function registerEffectRoutes(app: FastifyInstance, config: AuthConfig, options?: IntegrationOptions) {
  void app.register((scope, _options, done) => {
    scope.removeContentTypeParser('application/json');
    scope.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, parsed) => parsed(null, body));
    registerRoutes(scope, config, options);
    done();
  });
}
function registerRoutes(app: FastifyInstance, config: AuthConfig, options?: IntegrationOptions) {
  for (const url of ['/api/org/effects', '/api/org/effects/:permitId', '/api/org/effects/:permitId/resolve']) {
    app.route({ method: url.endsWith('/resolve') ? 'POST' : 'GET', url, bodyLimit: 8192, handler: async (request, reply) => {
      reply.header('cache-control', 'no-store');
      const session = sessionFor(request, config, new Date());
      if (!session) return reply.code(401).send({ status: 'refused' });
      if (!options?.store || !config.expectedOrgId) return reply.code(503).send({ status: 'unavailable' });
      if (options.silo !== options.binding.silo || !isOrganisationSession(config, session)) {
        return reply.code(403).send({ status: 'refused' });
      }
      try {
        const context = { ...options, store: options.store };
        if (request.method === 'GET') {
          return await handleEffectRead(url, request, reply, config, context, session.sub);
        }
        return await handleEffect(request, reply, config, context, session.sub);
      } catch (error) { return routeError(reply, error); }
    } });
  }
}

async function authorise(options: EffectOptions, issuer: string, sub: string, write = true) {
  const memberId = await options.feed.memberId(options.silo, issuer, sub);
  if (!memberId) throw new Error('Access changed');
  let fresh: Awaited<ReturnType<typeof authorityFence>> | undefined;
  if (write) {
    fresh = await authorityFence(options.store, performance.now(), [`member-${memberId}`]);
  }
  const auth = memberAuthorisation(options.binding);
  const membership = await currentMembership(options.store, options.silo, memberId, fresh);
  if (!['owner', 'admin'].includes(membership.role)) {
    throw new Error('Access changed');
  }
  for (const row of membership.facts) {
    if (!await auth.applied(row.event.id)) {
      throw new Error('IAM behind');
    }
  }
  const permission = await auth.check(memberId, 'admin');
  if (permission.status === 'unavailable') throw new Error('IAM unavailable');
  if (!permission.allowed) throw new Error('Access changed');
  return { memberId, fresh };
}

async function handleEffectRead(url: string, request: FastifyRequest, reply: FastifyReply,
  config: AuthConfig, options: EffectOptions, sub: string) {
  if (url === '/api/org/effects') {
    const effects = await listEffects(options.store, options.silo);
    await authorise(options, config.issuerUrl, sub, false);
    return reply.send({ effects });
  }
  const permitId = requestPermitId(request);
  const effect = await readEffect(options.store, options.silo, permitId);
  // Check current access after the read so a removed admin receives no spending records.
  await authorise(options, config.issuerUrl, sub, false);
  const csrf = effectCsrf(request, config, permitId);
  if (!effect) {
    return reply.code(404).send({ status: 'not_found' });
  }
  return reply.send({ ...effect, csrf });
}

function requestPermitId(request: FastifyRequest) {
  const params = z.object({ permitId: z.string().regex(/^[\w-]{1,200}$/u) });
  return params.parse(request.params).permitId;
}

function effectCsrf(request: FastifyRequest, config: AuthConfig, permitId: string) {
  const hmac = createHmac('sha256', config.cookieSecret);
  hmac.update(JSON.stringify(['effect', request.headers.cookie, permitId]));
  return hmac.digest('hex');
}

async function handleEffect(request: FastifyRequest, reply: FastifyReply,
  config: AuthConfig, options: EffectOptions,
  sub: string) {
  const permitId = requestPermitId(request);
  const csrf = effectCsrf(request, config, permitId);
  if (request.headers.origin !== new URL(config.redirectUri).origin || request.headers['x-csrf-token'] !== csrf) return reply.code(403).send({ status: 'refused' });
  const memberId = await options.feed.memberId(options.silo, config.issuerUrl, sub);
  if (!memberId) throw new Error('Access changed');
  let operator: Awaited<ReturnType<typeof authorise>> | undefined;
  async function fresh() {
    if (!operator) {
      operator = await authorise(options, config.issuerUrl, sub);
      if (operator.memberId !== memberId) throw new Error('Access changed');
    }
    await operator.fresh?.();
  }
  const result = await resolveEffect(
    options.store, options.silo, permitId, memberId, request.body, fresh);
  const codes = { appended: 202, not_found: 404, unavailable: 503, conflict: 409, held: 409, rejected: 409 };
  return reply.code(codes[result.status]).send({ status: result.status });
}
function routeError(reply: FastifyReply, error: unknown) {
  if (error instanceof Error && error.message === 'Invalid resolution JSON') return reply.code(400).send({ status: 'invalid_request' });
  if (error instanceof z.ZodError) return reply.code(400).send({ status: 'invalid_request' });
  if (error instanceof Error && error.message === 'Access changed') return reply.code(403).send({ status: 'refused' });
  return reply.code(503).send({ status: 'unavailable' });
}
