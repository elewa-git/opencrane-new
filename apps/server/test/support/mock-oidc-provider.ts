// A minimal, hand-written OIDC provider for tests (the task's second option:
// "or a minimal hand-written one"). It implements just enough of discovery,
// /authorize, /token, /jwks and /endsession to drive a real
// authorization-code-with-PKCE login through openid-client — no human
// interaction step, and nothing ever leaves 127.0.0.1.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';

// Leave `orgId` or `authTime` out to get an ID token without that claim,
// the way a real provider can (a silent SSO login has no fresh auth_time).
// `claims` adds anything else, such as a Zitadel-style roles object.
export interface MockUser {
  sub: string;
  roles: string[];
  orgId?: string;
  authTime?: number;
  claims?: Record<string, unknown>;
}

// An hour in the past, not "now": a login that wrongly uses its own time
// instead of the provider's auth_time then gives a different number, and the
// tests can tell.
export const DEFAULT_MOCK_USER: MockUser = { sub: 'user-1', orgId: 'org-1', roles: ['member'], authTime: Math.floor(Date.now() / 1000) - 3600 };

interface PendingCode {
  redirectUri: string;
  nonce: string | undefined;
  codeChallenge: string;
  user: MockUser;
  used: boolean;
}

export interface MockOidcProvider {
  url: string;
  clientId: string;
  /** The form fields of every request the token endpoint accepted or refused. */
  tokenRequests: () => Array<Record<string, string | undefined>>;
  close: () => Promise<void>;
}

const KEY_ID = 'test-key';

// When `clientSecret` is given, the token endpoint demands it (client_secret_post).
// `endSessionEndpoint` sets the logout address the discovery document advertises:
// leave it out for the mock's own /endsession, or pass null for a provider that has none.
export async function startMockOidcProvider(
  options: { clientId?: string; clientSecret?: string; user?: MockUser; endSessionEndpoint?: string | null } = {},
): Promise<MockOidcProvider> {
  const clientId = options.clientId ?? 'test-client';
  const user = options.user ?? DEFAULT_MOCK_USER;
  const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
  const publicJwk: JWK = { ...(await exportJWK(publicKey)), kid: KEY_ID, use: 'sig', alg: 'ES256' };

  const codes = new Map<string, PendingCode>();
  const tokenRequests: Array<Record<string, string | undefined>> = [];
  let baseUrl = '';

  const app: FastifyInstance = Fastify({ logger: false });

  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_request, body, done) => {
    try {
      done(null, Object.fromEntries(new URLSearchParams(typeof body === 'string' ? body : body.toString())));
    } catch (err) {
      done(err instanceof Error ? err : new Error('form parsing failed', { cause: err }), undefined);
    }
  });

  app.get('/.well-known/openid-configuration', () => ({
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/authorize`,
    token_endpoint: `${baseUrl}/token`,
    jwks_uri: `${baseUrl}/jwks`,
    ...(options.endSessionEndpoint === null ? {} : { end_session_endpoint: options.endSessionEndpoint ?? `${baseUrl}/endsession` }),
    response_types_supported: ['code'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['ES256'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
    scopes_supported: ['openid', 'profile', 'email'],
  }));

  app.get('/jwks', () => ({ keys: [publicJwk] }));

  // No login form: this provider always signs the request in as `user`.
  // Tests that need a different identity pass one to startMockOidcProvider.
  app.get<{ Querystring: Record<string, string | undefined> }>('/authorize', (request, reply) => {
    const query = request.query;
    const redirectUri = query['redirect_uri'];
    const codeChallenge = query['code_challenge'];
    if (!redirectUri || !codeChallenge) {
      reply.code(400).send('missing redirect_uri or code_challenge');
      return;
    }
    const code = randomUUID();
    codes.set(code, { redirectUri, nonce: query['nonce'], codeChallenge, user, used: false });
    const target = new URL(redirectUri);
    target.searchParams.set('code', code);
    const state = query['state'];
    if (state) {
      target.searchParams.set('state', state);
    }
    reply.redirect(target.href, 302);
  });

  app.post<{ Body: Record<string, string | undefined> }>('/token', async (request, reply) => {
    const body = request.body;
    tokenRequests.push(body);
    const code = body['code'];
    const codeVerifier = body['code_verifier'];
    if (body['client_id'] !== clientId || (options.clientSecret !== undefined && body['client_secret'] !== options.clientSecret)) {
      reply.code(401).send({ error: 'invalid_client' });
      return;
    }
    const pending = code ? codes.get(code) : undefined;
    if (!pending || pending.used || !codeVerifier || body['redirect_uri'] !== pending.redirectUri) {
      reply.code(400).send({ error: 'invalid_grant' });
      return;
    }
    const expectedChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
    if (expectedChallenge !== pending.codeChallenge) {
      reply.code(400).send({ error: 'invalid_grant' });
      return;
    }
    pending.used = true;

    const now = Math.floor(Date.now() / 1000);
    const claims: Record<string, unknown> = { roles: pending.user.roles, ...pending.user.claims };
    if (pending.user.orgId !== undefined) {
      claims['org_id'] = pending.user.orgId;
    }
    if (pending.user.authTime !== undefined) {
      claims['auth_time'] = pending.user.authTime;
    }
    if (pending.nonce) {
      claims['nonce'] = pending.nonce;
    }
    const idToken = await new SignJWT(claims)
      .setProtectedHeader({ alg: 'ES256', kid: KEY_ID })
      .setIssuer(baseUrl)
      .setSubject(pending.user.sub)
      .setAudience(clientId)
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(privateKey);

    reply.send({ access_token: randomBytes(16).toString('hex'), id_token: idToken, token_type: 'Bearer', expires_in: 300 });
  });

  app.get<{ Querystring: Record<string, string | undefined> }>('/endsession', (request, reply) => {
    const query = request.query;
    reply.redirect(query['post_logout_redirect_uri'] ?? '/', 302);
  });

  baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });

  return { url: baseUrl, clientId, tokenRequests: () => tokenRequests, close: () => app.close() };
}
