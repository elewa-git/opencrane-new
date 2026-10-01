import type { FastifyInstance, FastifyRequest } from 'fastify';
import { decodeSession, parseCookieHeader, SessionExpiredError, SessionInvalidError, type AuthConfig } from '@opencrane/auth';
import { joinInputSchema, joinMember, type JoinResult, type JoinStore } from './join.ts';

export interface MembershipOptions {
  silo: string;
  store: JoinStore;
  now?: () => Date;
}

export function sessionFor(request: FastifyRequest, config: AuthConfig, now: Date) {
  const cookie = parseCookieHeader(request.headers.cookie)[config.cookieName];
  if (!cookie) return undefined;
  try {
    return decodeSession(config, cookie, now);
  } catch (error) {
    if (error instanceof SessionInvalidError || error instanceof SessionExpiredError) return undefined;
    throw error;
  }
}

export function registerMemberRoutes(app: FastifyInstance, config: AuthConfig, options?: MembershipOptions): void {
  app.post('/members/join', { bodyLimit: 4096 }, async (request, reply) => {
    const now = options?.now ?? (() => new Date());
    const send = (code: number, result: JoinResult) => reply.code(code).send(result);
    const session = sessionFor(request, config, now());
    if (!session) return send(401, { status: 'refused', reason: 'no_session' });
    if (request.headers.origin !== new URL(config.redirectUri).origin) {
      return send(403, { status: 'refused', reason: 'wrong_origin' });
    }
    if (!options?.silo || !config.expectedOrgId) return send(503, { status: 'unavailable' });
    if (session.orgId !== config.expectedOrgId) return send(403, { status: 'refused', reason: 'wrong_silo' });
    const input = joinInputSchema.safeParse(request.body);
    if (!input.success) return send(400, { status: 'refused', reason: 'invalid_request' });
    const result = await joinMember(options.store, input.data, {
      silo: options.silo, issuer: config.issuerUrl, sub: session.sub,
    }, now);
    if (result.status === 'unavailable') {
      // Keep upstream errors inside the command boundary: they can contain credentials.
      request.log.error({ operation: 'member.joined' }, 'member join unavailable');
      return send(503, { status: 'unavailable' });
    }
    return send(result.status === 'refused' ? 409 : 200, result);
  });
}
