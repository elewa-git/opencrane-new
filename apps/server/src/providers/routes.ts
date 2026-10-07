import { providerIdSchema, providerModelIdSchema, providerKeySchema } from '@opencrane/events';
import { memberAuthorisation } from '@opencrane/authz';
import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { isOrganisationSession, type AuthConfig, type tokenIssuer } from '@opencrane/auth';
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
    tokens: Pick<Awaited<ReturnType<typeof tokenIssuer>>, 'providerVerification'> };
}
const id = providerIdSchema;
const parameters = z.object({ providerId: id.optional() }).strict();
const providerParameters = z.object({ providerId: id }).strict();
const changeParameters = z.object({ providerId: id, commandId: id }).strict();
const quoteQuery = z.object({ model: providerModelIdSchema }).strict();
const commandBody = z.record(z.string(), z.unknown());
const keyInput = z.object({ commandId: id, expectedRevision: z.int().positive(),
  key: z.string().min(1).max(4096).regex(/^[\x21-\x7e]+$/u) }).strict();

export function registerProviderRoutes(app: FastifyInstance, config: AuthConfig,
  options?: ProviderOptions) {
  app.get('/api/org/providers', handlerFor(read));
  app.post('/api/org/providers', { bodyLimit: 8192 }, handlerFor(write));
  app.get('/api/org/providers/:providerId', handlerFor(read));
  app.get('/api/org/providers/:providerId/changes/:commandId', handlerFor(readStatus));
  app.post('/api/org/providers/:providerId/key', { bodyLimit: 8192 }, handlerFor(writeKey));
  app.get('/api/org/providers/:providerId/verify', handlerFor(readQuote));
  app.post('/api/org/providers/:providerId/verify', { bodyLimit: 8192 }, handlerFor(verify));
  function handlerFor(action: ProviderHandler) {
    return handler;
    async function handler(request: FastifyRequest, reply: FastifyReply) {
      reply.header('cache-control', 'no-store');
      const session = sessionFor(request, config, new Date());
      if (!session) {
        return reply.code(401).send({ status: 'refused' });
      }
      if (!options) {
        return reply.code(503).send({ status: 'unavailable' });
      }
      if (!trustedRequest(request, config, options, session)) {
        return reply.code(403).send({ status: 'refused' });
      }
      try {
        const memberId = await options.feed.memberId(options.silo, config.issuerUrl, session.sub);
        if (!memberId) {
          throw new ProviderRefused();
        }
        return await action(request, reply, options, memberId);
      } catch (error) {
        const code = errorCode(error);
        const result = { status: code === 503 ? 'unavailable' : 'refused',
          ...(error instanceof ProviderUnpriced ? { reason: 'unknown_price' } : {}) };
        return reply.code(code).send(result);
      }
    }
  }
}
type ProviderHandler = (request: FastifyRequest, reply: FastifyReply,
  options: ProviderOptions, memberId: string) => Promise<unknown>;
function trustedRequest(request: FastifyRequest, config: AuthConfig,
  options: ProviderOptions, session: { sub: string; orgId: string }) {
  if (!isOrganisationSession(config, session)) {
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
  const body = commandBody.parse(request.body);
  if (body['action'] !== 'create' && body['action'] !== 'models') {
    throw new z.ZodError([]);
  }
  const receipt = await providerCommand(options.store, options.binding, memberId, body);
  return reply.send(receipt);
}
async function verify(request: FastifyRequest, reply: FastifyReply,
  options: ProviderOptions, memberId: string) {
  const { providerId } = providerParameters.parse(request.params);
  const body = commandBody.parse(request.body);
  if ('providerId' in body) {
    throw new z.ZodError([]);
  }
  const commandInput = { ...body, providerId };
  const raw = providerVerificationSchema.parse(commandInput);
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
  const capability = { silo: options.silo, memberId, commandDigest };
  const token = await options.verification.tokens.providerVerification(capability);
  const headers = { authorization: `Bearer ${token.value}`, 'content-type': 'application/json' };
  // Never follow a redirect: it would send the check token and the command to another server.
  const command: RequestInit = { method: 'POST', headers, body: JSON.stringify(raw),
    redirect: 'manual', signal: AbortSignal.timeout(20_000) };
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
  const rows = await readProviders(options.db, options.silo, input.providerId);
  const publicRows = rows.map(providerRow);
  await fresh();
  return reply.send({ rows: publicRows, loadedAt: new Date().toISOString(),
    access: { grantsAvailable: false, reason: 'p4_22_required' } });
}
async function writeKey(request: FastifyRequest, reply: FastifyReply,
  options: ProviderOptions, memberId: string) {
  const receipt = await saveKey(options, memberId, request.params, request.body);
  return reply.send(receipt);
}
async function readStatus(request: FastifyRequest, reply: FastifyReply,
  options: ProviderOptions, memberId: string) {
  const fresh = await providerAuthority(options.store, options.binding, memberId);
  const input = changeParameters.parse(request.params);
  fresh.include(`provider-${input.providerId}`);
  const result = await readChange(options, input.providerId, input.commandId, fresh.deadline);
  await fresh();
  return reply.code(result.status === 'not_found' ? 404 : 200).send(result);
}
async function readQuote(request: FastifyRequest, reply: FastifyReply,
  options: ProviderOptions, memberId: string) {
  const fresh = await providerAuthority(options.store, options.binding, memberId);
  const { providerId } = providerParameters.parse(request.params);
  const { model } = quoteQuery.parse(request.query);
  fresh.include(`provider-${providerId}`);
  const current = await providerHistory(options.store, options.silo, providerId, fresh.deadline);
  if (!current.state) {
    throw new ProviderConflict();
  }
  const quote = providerTestQuote(current.state, model);
  await fresh();
  return reply.send(quote);
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
  const appliedSequence = Number(checkpoint.rows[0]?.sequence ?? 0);
  const content = appliedSequence >= row.sequence ? 'current' : 'applying';
  let outcome: unknown;
  for (const item of current.rows) {
    const fact = commandBody.parse(item.event.data);
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
  const { providerId } = providerParameters.parse(params);
  const input = keyInput.parse(raw);
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
      await cleanProviderSecrets(options, providerId, secretRef, input.expectedRevision);
      throw new ProviderConflict();
    }
    if (!options.secrets) {
      throw new Error('Secret store unavailable');
    }
    await fresh();
    await options.secrets.save(secretRef, input.key);
  }
  try {
    const result = await providerCommand(options.store, options.binding, memberId, command, fresh);
    await cleanProviderSecrets(options, providerId, secretRef, input.expectedRevision);
    return { ...result, clearKey: true };
  } catch (error) {
    // If the append reply was lost, read the event history before deciding
    // whether this secret was saved. Keep it when history is unavailable so a
    // later retry can check again.
    await cleanProviderSecrets(options, providerId, secretRef, input.expectedRevision);
    throw error;
  }
}
async function cleanProviderSecrets(options: ProviderOptions, providerId: string,
  candidate: string, expectedRevision: number) {
  if (!options.secrets) {
    return;
  }
  const current = await providerHistory(options.store, options.silo, providerId);
  const references = new Set([candidate]);
  for (const row of current.rows) {
    if (row.event.type === 'provider.key_saved') {
      references.add(providerKeySchema.parse(row.event.data).secretRef);
    }
  }
  const revision = current.state?.revision;
  const candidateIsPending = revision !== undefined && revision <= expectedRevision;
  for (const reference of references) {
    if (reference === current.state?.secretRef) {
      continue;
    }
    // Another retry can still append at this revision, even after this caller is refused.
    if (reference === candidate && candidateIsPending) {
      continue;
    }
    await options.secrets.remove(reference);
  }
}
function providerRow(state: Awaited<ReturnType<typeof readProviders>>[number]) {
  let status = 'needs_key';
  if (state.saved) {
    status = 'saved_unverified';
  }
  if (state.reachable?.outcome === 'pass') {
    status = 'connected_not_tested';
  }
  if (state.reachable?.outcome === 'pass' && state.modelAnswer) {
    const outcome = state.modelAnswer.outcome;
    if (outcome === 'pass') {
      status = 'ready';
    } else if (outcome !== 'skipped') {
      status = `model_test_${outcome}`;
    }
  }
  return { ...state, status };
}
