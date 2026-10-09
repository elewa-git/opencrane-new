import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  decodeSession,
  isOrganisationSession,
  parseCookieHeader,
  SessionExpiredError,
  SessionInvalidError,
  type AuthConfig,
} from '@opencrane/auth';
import type { Query } from '@opencrane/projections';
import { joinInputSchema, joinMember, type JoinResult, type JoinStore } from './join.ts';

export interface MembershipOptions {
  silo: string;
  store: JoinStore;
  db?: Query;
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
  const routeOptions = { bodyLimit: 1024 };
  app.post('/members/join', routeOptions, acceptInvitation);
  async function acceptInvitation(request: FastifyRequest, reply: FastifyReply) {
    reply.header('cache-control', 'no-store');
    const now = options?.now ?? currentTime;
    function send(code: number, result: JoinResult) {
      return reply.code(code).send(result);
    }
    const session = sessionFor(request, config, now());
    if (!session) return send(401, { status: 'refused', reason: 'no_session' });
    if (request.headers.origin !== new URL(config.redirectUri).origin) {
      return send(403, { status: 'refused', reason: 'wrong_origin' });
    }
    if (!options?.silo || !config.expectedOrgId) return send(503, { status: 'unavailable' });
    if (!isOrganisationSession(config, session) || session.orgId !== config.expectedOrgId) {
      return send(403, { status: 'refused', reason: 'wrong_silo' });
    }
    const input = joinInputSchema.safeParse(request.body);
    if (!input.success) return send(400, { status: 'refused', reason: 'invalid_request' });
    const context = {
      silo: options.silo, issuer: config.issuerUrl, sub: session.sub,
      email: session.email, emailVerified: session.emailVerified,
      authTime: session.authTime,
    };
    const result = await joinMember(options.store, input.data, context, now, options.db);
    if (result.status === 'unavailable') {
      // Keep upstream errors inside the command boundary: they can contain credentials.
      request.log.error({ operation: 'member.joined' }, 'member join unavailable');
      return send(503, { status: 'unavailable' });
    }
    return send(statusForJoin(result), result);
  }
}

function statusForJoin(result: JoinResult): number {
  if (result.status !== 'refused') {
    return 200;
  }
  const accessReasons = ['inviter_authority_ended', 'access_removed'];
  if (accessReasons.includes(result.reason)) {
    return 403;
  }
  return 409;
}

function currentTime() {
  return new Date();
}
