import { createHash } from 'node:crypto';
// The four browser-facing auth routes: start a login, finish it, log out,
// and report who (if anyone) is signed in. All the OIDC and cookie logic
// lives in @opencrane/auth; this file just wires it to Fastify.
//
// Logging: these routes log through request.log, which is the
// @opencrane/observability logger. It redacts the `code` and `state` in a
// callback URL, and header and cookie values never reach a log line. On top
// of that, a line here carries only a fixed reason. It never carries the
// error object, a cookie, a code or a token, because an error from the
// identity provider can hold the response body it sent back.
import { sessionFor } from '../members/routes.ts';
import { URL } from 'node:url';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  buildLoginRedirect,
  buildLogoutUrl,
  clearCookie,
  completeLogin,
  decodeFlow,
  decodeSession,
  encodeFlow,
  encodeSession,
  FlowInvalidError,
  FLOW_MAX_AGE_SECONDS,
  isIdentityAllowed,
  OidcLoginError,
  parseCookieHeader,
  sanitizeReturnTo,
  serializeCookie,
  SessionExpiredError,
  SessionInvalidError,
  type AuthConfig,
  type SessionData,
  type CookieAttributes,
} from '@opencrane/auth';
import { z } from 'zod';

function cookieAttrs(config: AuthConfig): Pick<CookieAttributes, 'httpOnly' | 'secure' | 'path'> {
  return { httpOnly: true, secure: config.cookieSecure, path: '/' };
}

function readCookie(request: FastifyRequest, name: string): string | undefined {
  return parseCookieHeader(request.headers.cookie)[name];
}

function rejectLogin(request: FastifyRequest, reply: FastifyReply, config: AuthConfig, reason: string) {
  reply.header('set-cookie', [clearCookie(config.flowCookieName, cookieAttrs(config)), clearCookie(config.cookieName, cookieAttrs(config))]);
  if (request.headers.accept?.includes('text/html')) {
    const code = reason === 'this account belongs to a different organisation' ? 'organisation'
      : reason === 'identity provider unavailable' ? 'unavailable' : 'rejected';
    return reply.redirect(`/signin/rejected?reason=${code}`, 302);
  }
  return reply.code(400).send({ error: reason });
}

export function registerAuthRoutes(app: FastifyInstance, config: AuthConfig): void {
  app.get('/auth/login', async (request, reply) => {
    const query = request.query;
    const returnTo = sanitizeReturnTo(
      query !== null && typeof query === 'object' && 'returnTo' in query && typeof query.returnTo === 'string'
        ? query.returnTo : undefined,
    );

    const approval = z.object({ approval: z.string().regex(/^[a-f0-9]{64}$/u).optional() }).safeParse(query);
    if (!approval.success) return reply.code(400).send({ error: 'Invalid sign-in request' });
    const session = sessionFor(request, config, new Date());
    if (approval.data.approval && !session) return reply.code(401).send({ error: 'No session' });
    const stepUp = approval.data.approval && session ? { approvalId: approval.data.approval, sub: session.sub,
      sessionDigest: createHash('sha256').update(readCookie(request, config.cookieName) ?? '').digest('hex') } : undefined;
    let redirect;
    try { redirect = await buildLoginRedirect(config, !!stepUp); }
    catch { return rejectLogin(request, reply, config, 'identity provider unavailable'); }
    const flowCookie = encodeFlow(config, {
      ...(stepUp ? { stepUp } : {}),
      state: redirect.state,
      nonce: redirect.nonce,
      codeVerifier: redirect.codeVerifier,
      returnTo,
      createdAt: Math.floor(Date.now() / 1000),
    });

    reply.header('set-cookie', serializeCookie(config.flowCookieName, flowCookie, { ...cookieAttrs(config), maxAgeSeconds: FLOW_MAX_AGE_SECONDS }));
    reply.redirect(redirect.url, 302);
  });

  app.get('/auth/callback', async (request, reply) => {
    const flowCookie = readCookie(request, config.flowCookieName);
    if (!flowCookie) {
      request.log.warn('sign-in callback refused: no login is in progress');
      return rejectLogin(request, reply, config, 'no login is in progress');
    }

    let flow;
    try {
      flow = decodeFlow(config, flowCookie);
    } catch (err) {
      const reason = err instanceof FlowInvalidError ? err.message : 'invalid login state';
      request.log.warn(`sign-in callback refused: ${reason}`);
      return rejectLogin(request, reply, config, reason);
    }

    // The query carries `state`, which authorizationCodeGrant checks below;
    // a request URL with a mismatched state fails there, not here.
    const currentUrl = new URL(request.url, config.redirectUri);

    let result;
    try {
      result = await completeLogin(config, currentUrl, flow);
    } catch (err) {
      const reason = err instanceof OidcLoginError ? err.message : 'login failed';
      request.log.warn(`sign-in failed: ${reason}`);
      return rejectLogin(request, reply, config, reason);
    }

    if (flow.stepUp) {
      const previous = sessionFor(request, config, new Date());
      const digest = createHash('sha256').update(readCookie(request, config.cookieName) ?? '').digest('hex');
      if (!validStepUp(previous, result.session, flow.stepUp, digest)) {
        return rejectLogin(request, reply, config, 'Recent sign-in for the same requester is required');
      }
      result.session.stepUpApproval = flow.stepUp.approvalId;
    }
    const sessionCookie = encodeSession(config, result.session);
    reply.header('set-cookie', [
      serializeCookie(config.cookieName, sessionCookie, { ...cookieAttrs(config), maxAgeSeconds: config.sessionMaxAgeSeconds }),
      clearCookie(config.flowCookieName, cookieAttrs(config)),
    ]);
    request.log.info('sign-in completed');
    reply.redirect(flow.returnTo, 302);
  });

  app.post('/auth/logout', async (request, reply) => {
    if (request.headers.origin !== new URL(config.redirectUri).origin) {
      return reply.code(403).send({ error: 'wrong origin' });
    }
    const session = sessionFor(request, config, new Date());
    if (!session) return reply.code(401).send({ error: 'no session' });
    if (!isIdentityAllowed(config, { issuer: config.issuerUrl, subject: session.sub, orgId: session.orgId })) {
      return reply.code(403).send({ error: 'wrong organisation' });
    }
    // Keep the token in the navigation header; never put it in a response body.
    const address = await buildLogoutUrl(config, session.idToken);
    const provider = z.url({ protocol: /^https?$/u }).safeParse(address);
    if (address !== null && !provider.success) {
      request.log.warn('the identity provider logout address is not an http(s) address, so none was sent');
    }
    reply.header('set-cookie', clearCookie(config.cookieName, cookieAttrs(config)));
    reply.header('cache-control', 'no-store');
    request.log.info({ providerLogout: provider.success }, 'signed out');
    if (provider.success) return reply.code(303).header('location', provider.data).send();
    return reply.type('text/plain').send('You are signed out of OpenCrane. Your identity provider session could not be ended.');
  });

  app.get('/auth/me', async (request, reply) => {
    const cookieValue = readCookie(request, config.cookieName);
    if (!cookieValue) {
      reply.send({ authenticated: false, user: null });
      return;
    }
    try {
      const session = decodeSession(config, cookieValue);
      if (!isIdentityAllowed(config, { issuer: config.issuerUrl, subject: session.sub, orgId: session.orgId })) {
        return reply.send({ authenticated: false, user: null });
      }
      const { sub, orgId, roles, authTime, exp, name } = session;
      reply.send({ authenticated: true, user: { sub, orgId, roles, authTime, exp, name } });
    } catch (err) {
      if (err instanceof SessionInvalidError || err instanceof SessionExpiredError) {
        reply.send({ authenticated: false, user: null });
        return;
      }
      throw err;
    }
  });
}

function validStepUp(previous: SessionData | undefined, current: SessionData, step: { sub: string; sessionDigest: string }, digest: string) {
  const age = Date.now() / 1000 - current.authTime;
  return previous && digest === step.sessionDigest && previous.sub === step.sub && current.sub === step.sub &&
    current.orgId === previous.orgId && current.authTime > 0 && age >= 0 && age <= 300;
}
