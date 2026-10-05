import { memberAuthorisation } from '@opencrane/authz';
import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { AuthConfig, tokenIssuer } from '@opencrane/auth';
import { readProviders } from '@opencrane/projections';
import { providerAuthority, providerCommand, providerReceipt,
  ProviderRefused, ProviderUnpriced, ProviderConflict, providerHistory, providerSecretRef,
  type ProviderSecrets, requestProviderVerification, providerTestQuote,
  providerVerificationSchema, providerPermission } from '@opencrane/models';
import type { GroupOptions } from '../members/group-routes.ts';
import { sessionFor } from '../members/routes.ts';

export interface ProviderOptions extends GroupOptions {
  secrets?: ProviderSecrets;
  verification?: { decisionUrl: string;
    tokens: Pick<Awaited<ReturnType<typeof tokenIssuer>>, 'budget'> };
}
const id = z.string().regex(/^[\w-]{1,200}$/u);
const parameters = z.object({ providerId: id.optional(), commandId: id.optional() }).strict();

export function registerProviderRoutes(app: FastifyInstance, config: AuthConfig,
  options?: ProviderOptions) {
  app.route({ method: ['GET', 'POST'], url: '/api/org/providers', bodyLimit: 8192, handler });
  app.get('/api/org/providers/:providerId', handler);
  app.get('/api/org/providers/:providerId/changes/:commandId', handler);
  app.post('/api/org/providers/:providerId/key', { bodyLimit: 8192 }, handler);
  app.route({ method: ['GET', 'POST'], url: '/api/org/providers/:providerId/verify',
    bodyLimit: 8192, handler });
  async function handler(request: FastifyRequest, reply: FastifyReply) {
    reply.header('cache-control', 'no-store');
    const session = sessionFor(request, config, new Date());
    if (!session) {
      return reply.code(401).send({ status: 'refused' });
    }
    if (!options) {
      return reply.code(503).send({ status: 'unavailable' });
    }
    if (!trustedRequest(request, config, options, session.orgId)) {
      return reply.code(403).send({ status: 'refused' });
    }
    try {
      const memberId = await options.feed.memberId(options.silo, config.issuerUrl, session.sub);
      if (!memberId) {
        throw new ProviderRefused();
      }
      if (request.method === 'POST') {
        return await write(request, reply, options, memberId);
      }
      return await read(request, reply, options, memberId);
    } catch (error) {
      const code = errorCode(error);
      const result = { status: code === 503 ? 'unavailable' : 'refused',
        ...(error instanceof ProviderUnpriced ? { reason: 'unknown_price' } : {}) };
      return reply.code(code).send(result);
    }
  }
}
function trustedRequest(request: FastifyRequest, config: AuthConfig,
  options: ProviderOptions, orgId: string | undefined) {
  if (!config.expectedOrgId || orgId !== config.expectedOrgId) {
    return false;
  }
  if (options.silo !== options.binding.silo) {
    return false;
  }
  if (request.method !== 'POST') {
    return true;
  }
  return request.headers.origin === new URL(config.redirectUri).origin;
}
function errorCode(error: unknown) {
  if (error instanceof z.ZodError) {
    return 400;
  }
  if (error instanceof ProviderRefused) {
    return 403;
  }
  if (error instanceof ProviderConflict) {
    return 409;
  }
  return 503;
}
async function write(request: FastifyRequest, reply: FastifyReply,
  options: ProviderOptions, memberId: string) {
  if (request.url.endsWith('/key')) {
    return reply.send(await saveKey(options, memberId, request.params, request.body));
  }
  if (request.url.endsWith('/verify')) {
    return verify(request, reply, options, memberId);
  }
  const body = z.record(z.string(), z.unknown()).parse(request.body);
  if (body['action'] !== 'create' && body['action'] !== 'models') {
    throw new z.ZodError([]);
  }
  const receipt = await providerCommand(options.store, options.binding, memberId, body);
  return reply.send(receipt);
}
async function verify(request: FastifyRequest, reply: FastifyReply,
  options: ProviderOptions, memberId: string) {
  const { providerId } = z.object({ providerId: id }).parse(request.params);
  const body = z.record(z.string(), z.unknown()).parse(request.body);
  if ('providerId' in body) {
    throw new z.ZodError([]);
  }
  const raw = providerVerificationSchema.parse({ ...body, providerId });
  if (raw.action === 'skip') {
    const result = await requestProviderVerification(options.store, options.binding, memberId, raw);
    return reply.send(result.receipt);
  }
  await providerAuthority(options.store, options.binding, memberId);
  if (!options.verification) {
    throw new Error('Verification unavailable');
  }
  const hash = createHash('sha256');
  hash.update(JSON.stringify(raw));
  const commandDigest = hash.digest('hex');
  const token = await options.verification.tokens.budget({ silo: options.silo,
    memberId, commandDigest });
  const headers = { authorization: `Bearer ${token.value}`, 'content-type': 'application/json' };
  const command = { method: 'POST', headers, body: JSON.stringify(raw),
    signal: AbortSignal.timeout(20_000) };
  const response = await fetch(`${options.verification.decisionUrl}/providers/verify`, command);
  const result: unknown = await response.json();
  return reply.code(response.status).send(result);
}
async function read(request: FastifyRequest, reply: FastifyReply,
  options: ProviderOptions, memberId: string) {
  const fresh = await providerAuthority(options.store, options.binding, memberId);
  const input = parameters.parse(request.params);
  if (input.providerId) {
    fresh.include(`provider-${input.providerId}`);
  }
  if (input.providerId && input.commandId) {
    const result = await readChange(options, input.providerId, input.commandId, fresh.deadline);
    await fresh();
    return reply.code(result.status === 'not_found' ? 404 : 200).send(result);
  }
  if (request.url.includes('/verify')) {
    const { model } = z.object({ model: z.string() }).strict().parse(request.query);
    const current = await providerHistory(options.store, options.silo,
      input.providerId!, fresh.deadline);
    if (!current.state) {
      throw new ProviderConflict();
    }
    const quote = providerTestQuote(current.state, model);
    await fresh();
    return reply.send(quote);
  }
  const rows = await readProviders(options.db, options.silo, input.providerId);
  const publicRows = rows.map(providerRow);
  await fresh();
  return reply.send({ rows: publicRows, loadedAt: new Date().toISOString(),
    access: { grantsAvailable: false, reason: 'p4_22_required' } });
}
async function readChange(options: ProviderOptions, providerId: string,
  commandId: string, deadline: number) {
  const current = await providerHistory(options.store, options.silo, providerId, deadline);
  function matches(row: (typeof current.rows)[number]) {
    return row.event.commandId === commandId;
  }
  const row = current.rows.find(matches);
  if (!row) {
    return { status: 'not_found' as const };
  }
  const checkpoint = await options.db.query<{ sequence: string }>(
    'SELECT sequence FROM projection_checkpoints WHERE name = $1', ['providers']);
  const content = Number(checkpoint.rows[0]?.sequence ?? 0) >= row.sequence ? 'current' : 'applying';
  let outcome: unknown;
  for (const item of current.rows) {
    const fact = z.record(z.string(), z.unknown()).parse(item.event.data);
    if (fact['attemptId'] === commandId) {
      outcome = fact['outcome'] ?? 'outcome_unknown';
    }
  }
  const position = row.sequence;
  function isKeyAtAttempt(item: (typeof current.rows)[number]) {
    return item.sequence <= position && item.event.type === 'provider.key_saved';
  }
  const keyAtAttempt = current.rows.findLast(isKeyAtAttempt);
  const valid = Boolean(keyAtAttempt && current.state?.saved?.changeId === keyAtAttempt.event.id);
  const auth = memberAuthorisation(options.binding);
  const created = current.rows[0];
  const applied = created ? await auth.applied(created.event.id) : false;
  const iam = applied ? 'current' : 'applying';
  return { ...providerReceipt(row), projection: { content, iam },
    currentRevision: current.state?.revision, verificationValid: valid, outcome };
}
async function saveKey(options: ProviderOptions, memberId: string, params: unknown, raw: unknown) {
  const { providerId } = z.object({ providerId: id }).parse(params);
  const input = z.object({ commandId: id, expectedRevision: z.int().positive(),
    key: z.string().min(1).max(4096).regex(/^[\x21-\x7e]+$/u) }).strict().parse(raw);
  const fresh = await providerAuthority(options.store, options.binding, memberId);
  fresh.include(`provider-${providerId}`);
  const { rows, state } = await providerHistory(options.store, options.silo,
    providerId, fresh.deadline);
  function matchesCommand(row: (typeof rows)[number]) {
    return row.event.commandId === input.commandId;
  }
  const previous = rows.find(matchesCommand);
  const secretRef = providerSecretRef(options.silo, providerId, input.commandId);
  const command = { action: 'key', providerId, commandId: input.commandId,
    expectedRevision: input.expectedRevision, secretRef };
  await providerPermission(options.binding, memberId, rows);
  if (!previous) {
    if (!state || state.revision !== input.expectedRevision) {
      throw new ProviderConflict();
    }
    if (!options.secrets) {
      throw new Error('Secret store unavailable');
    }
    await fresh();
    await options.secrets.save(secretRef, input.key);
  }
  const result = await providerCommand(options.store, options.binding, memberId, command, fresh);
  return { ...result, clearKey: true };
}
function providerRow(state: Awaited<ReturnType<typeof readProviders>>[number]) {
  let status = 'needs_key';
  if (state.saved) {
    status = 'saved_unverified';
  }
  if (state.reachable?.outcome === 'pass') {
    status = 'connected_not_tested';
  }
  if (state.modelAnswer?.outcome === 'pass' && state.reachable?.outcome === 'pass') {
    status = 'ready';
  }
  return { ...state, status };
}
