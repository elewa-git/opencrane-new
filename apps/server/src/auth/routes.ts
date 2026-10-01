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
import { URL } from 'node:url';
import type { FastifyInstance, FastifyRequest } from 'fastify';
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
  OidcLoginError,
  parseCookieHeader,
  sanitizeReturnTo,
  serializeCookie,
  SessionExpiredError,
  SessionInvalidError,
  type AuthConfig,
  type CookieAttributes,
} from '@opencrane/auth';
import { logoutResponseSchema, type LogoutResponse } from '@opencrane/protocol';

function cookieAttrs(config: AuthConfig): Pick<CookieAttributes, 'httpOnly' | 'secure' | 'path'> {
  return { httpOnly: true, secure: config.cookieSecure, path: '/' };
}

function readCookie(request: FastifyRequest, name: string): string | undefined {
  return parseCookieHeader(request.headers.cookie)[name];
}

export function registerAuthRoutes(app: FastifyInstance, config: AuthConfig): void {
  app.get('/auth/login', async (request, reply) => {
    const query = request.query;
    const returnTo = sanitizeReturnTo(
      query !== null && typeof query === 'object' && 'returnTo' in query && typeof query.returnTo === 'string'
        ? query.returnTo : undefined,
    );

    const redirect = await buildLoginRedirect(config);
    const flowCookie = encodeFlow(config, {
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
      reply.code(400).send({ error: 'no login is in progress' });
      return;
    }

    let flow;
    try {
      flow = decodeFlow(config, flowCookie);
    } catch (err) {
      const reason = err instanceof FlowInvalidError ? err.message : 'invalid login state';
      request.log.warn(`sign-in callback refused: ${reason}`);
      reply.code(400).send({ error: reason });
      return;
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
      reply.code(400).send({ error: reason });
      return;
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
    // The local session is cleared even if the provider cannot be reached;
    // the endSessionUrl is just what the browser is asked to go to next.
    // The reply uses the schema from @opencrane/protocol, the one the web app
    // reads it with. That schema accepts only an http(s) address, so a
    // provider address of any other kind is dropped here, not sent to the
    // browser to be rejected (or, worse, followed).
    const providerAddress = logoutResponseSchema.safeParse({ endSessionUrl: await buildLogoutUrl(config) });
    const body: LogoutResponse = providerAddress.success ? providerAddress.data : { endSessionUrl: null };
    if (!providerAddress.success) {
      request.log.warn('the identity provider logout address is not an http(s) address, so none was sent');
    }
    reply.header('set-cookie', clearCookie(config.cookieName, cookieAttrs(config)));
    request.log.info({ providerLogout: body.endSessionUrl !== null }, 'signed out');
    reply.send(body);
  });

  app.get('/auth/me', async (request, reply) => {
    const cookieValue = readCookie(request, config.cookieName);
    if (!cookieValue) {
      reply.send({ authenticated: false, user: null });
      return;
    }
    try {
      const session = decodeSession(config, cookieValue);
      reply.send({ authenticated: true, user: session });
    } catch (err) {
      if (err instanceof SessionInvalidError || err instanceof SessionExpiredError) {
        reply.send({ authenticated: false, user: null });
        return;
      }
      throw err;
    }
  });
}
