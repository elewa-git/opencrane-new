import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { AuthConfig } from '@opencrane/auth';
import { z } from 'zod';
import { readBootstrapToken } from '../bootstrap-token.ts';
import { sessionFor, type MembershipOptions } from './routes.ts';

const inputSchema = z.object({ token: z.string().min(1).max(128), displayName: z.string().trim().min(1).max(200),
  email: z.email().max(254) }).strict();

async function claimedBy(options: MembershipOptions) {
  // ponytail: scan membership history only during installation; index if this grows beyond bootstrap.
  for await (const { event } of options.store.readStream('member-*', 1, performance.now() + 10_000)) {
    if (event.silo !== options.silo) throw new Error('Bootstrap silo mismatch');
    const data = z.record(z.string(), z.unknown()).parse(event.data);
    if (event.type === 'silo.owner_bootstrapped') return event.principal?.id ?? 'existing';
    if ((event.type === 'member.joined' && data['role'] === 'owner') ||
      (event.type === 'member.role_changed' && data['newRole'] === 'owner')) return 'existing';
  }
  return undefined;
}

type ClaimResult = { status: 'refused'; reason: string } | { status: 'claimed'; memberId: string; sequence: number };

async function claimSilo(options: MembershipOptions, issuer: string, sub: string,
  input: z.infer<typeof inputSchema>, tokenFile: string | undefined, now: () => Date): Promise<ClaimResult> {
  const owner = await claimedBy(options);
  if (owner) return { status: 'refused', reason: owner === sub ? 'token_used' : 'owner_exists' };
  if (!tokenFile) throw new Error('Bootstrap token file is not configured');
  const stored = await readBootstrapToken(tokenFile);
  if (stored.silo !== options.silo) throw new Error('Bootstrap token silo mismatch');
  if (Date.parse(stored.expiresAt) <= now().getTime()) return { status: 'refused', reason: 'token_expired' };
  const digest = createHash('sha256').update(input.token).digest();
  if (!timingSafeEqual(digest, Buffer.from(stored.hash, 'hex'))) return { status: 'refused', reason: 'wrong_token' };
  const id = randomUUID();
  const result = await options.store.append({ expectedSequence: 0, event: {
    id, commandId: id, type: 'silo.owner_bootstrapped', subject: 'member-bootstrap-owner',
    silo: options.silo, source: 'opencrane-server', time: now().toISOString(), principal: { kind: 'human', id: sub },
    data: { memberId: 'bootstrap-owner', email: input.email, displayName: input.displayName,
      role: 'owner', identity: { issuer, sub } },
  } });
  if (result.status === 'conflict') return { status: 'refused', reason: 'concurrent_claim' };
  if (result.status !== 'appended') throw new Error('Bootstrap append unavailable');
  return { status: 'claimed', memberId: 'bootstrap-owner', sequence: result.sequence };
}

export function registerBootstrapRoutes(app: FastifyInstance, config: AuthConfig, options?: MembershipOptions) {
  const tokenFile = process.env['BOOTSTRAP_TOKEN_FILE'];
  let windowStart = 0, attempts = 0;
  app.post('/api/silo/claim', { bodyLimit: 2048 }, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const now = options?.now ?? (() => new Date());
    const refuse = (code: number, reason: string) => reply.code(code).send({ status: 'refused', reason });
    const session = sessionFor(request, config, now());
    if (!session) return refuse(401, 'no_session');
    if (request.headers.origin !== new URL(config.redirectUri).origin) return refuse(403, 'wrong_origin');
    // One shared attempt budget prevents changing identities to evade the installation limit.
    if (now().getTime() - windowStart >= 60_000) { attempts = 0; windowStart = now().getTime(); }
    if (attempts >= 5) return reply.header('retry-after', '60').code(429).send({ status: 'refused', reason: 'rate_limited' });
    attempts += 1;
    if (!options || !config.expectedOrgId) return reply.code(503).send({ status: 'unavailable' });
    // Dev identity exceptions never admit an owner through the production token path.
    if (session.orgId !== config.expectedOrgId) return refuse(403, 'wrong_organisation');
    const input = inputSchema.safeParse(request.body);
    if (!input.success) return refuse(400, 'invalid_request');
    try {
      const result = await claimSilo(options, config.issuerUrl, session.sub, input.data, tokenFile, now);
      return reply.code(result.status === 'claimed' ? 201 : 409).send(result);
    } catch {
      request.log.error({ operation: 'silo.owner_bootstrapped' }, 'silo claim unavailable');
      return reply.code(503).send({ status: 'unavailable' });
    }
  });
}
