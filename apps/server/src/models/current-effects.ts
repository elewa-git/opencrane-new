import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { isOrganisationSession, type AuthConfig } from '@opencrane/auth';
import type { EventStore } from '@opencrane/event-store';
import { MemberAccessRefused, readActiveMember, readCurrentEffects } from '@opencrane/models';
import { currentEffectsQuerySchema, currentEffectsResponseSchema,
  type CurrentEffectsQuery, type CurrentEffectsResponse } from '@opencrane/protocol';
import type { Query } from '@opencrane/projections';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { IntegrationOptions } from '../integrations/routes.ts';
import { sessionFor } from '../members/routes.ts';

class SpendingRestart extends Error {}
type ReadOptions = IntegrationOptions & { store: EventStore; modelDb: Query };

export function registerCurrentEffects(app: FastifyInstance, config: AuthConfig,
  options?: IntegrationOptions) {
  app.get('/api/org/spending/current-effects', handle);
  async function handle(request: FastifyRequest, reply: FastifyReply) {
    reply.header('cache-control', 'no-store');
    const session = sessionFor(request, config, new Date());
    if (!session) return reply.code(401).send({ status: 'refused' });
    if (!options?.store || !options.modelDb || !config.expectedOrgId) {
      return reply.code(503).send({ status: 'unavailable' });
    }
    if (!isOrganisationSession(config, session) || options.silo !== options.binding.silo) {
      return reply.code(403).send({ status: 'refused' });
    }
    const query = currentEffectsQuerySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ status: 'refused' });
    try {
      const memberId = await options.feed.memberId(options.silo, config.issuerUrl, session.sub);
      if (!memberId) throw new MemberAccessRefused();
      const ready = { ...options, store: options.store, modelDb: options.modelDb };
      const loading = loadPage(ready, query.data, config.cookieSecret);
      const [loaded] = await Promise.allSettled([loading]);
      // Check current access after loading, including failed reads and invalid continuations.
      await readActiveMember(options.store, options.binding, memberId, 'admin');
      if (loaded.status === 'rejected') throw loaded.reason;
      return reply.send(currentEffectsResponseSchema.parse(loaded.value));
    } catch (error) {
      if (error instanceof MemberAccessRefused) {
        return reply.code(403).send({ status: 'refused' });
      }
      if (error instanceof SpendingRestart) {
        return reply.code(409).send({ status: 'restart' });
      }
      return reply.code(503).send({ status: 'unavailable' });
    }
  }
}

function signature(secret: string, encoded: string) {
  const hmac = createHmac('sha256', secret);
  hmac.update(`spending-current-effects:${encoded}`);
  return hmac.digest();
}
function continuation(secret: string, silo: string, query: CurrentEffectsQuery) {
  const identity = [silo, query.limit];
  const hash = createHash('sha256');
  hash.update(JSON.stringify(identity));
  const binding = hash.digest('hex');
  const schema = z.tuple([z.literal(binding), z.int().nonnegative(), z.int().positive()]);
  let saved: z.infer<typeof schema> | undefined;
  if (query.continuation !== undefined) {
    try {
      const [encoded, supplied, extra] = query.continuation.split('.');
      if (!encoded || !supplied || extra !== undefined) throw new SpendingRestart();
      const expected = signature(secret, encoded);
      const actual = Buffer.from(supplied, 'base64url');
      if (actual.toString('base64url') !== supplied ||
          actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        throw new SpendingRestart();
      }
      const bytes = Buffer.from(encoded, 'base64url');
      const decoded: unknown = JSON.parse(bytes.toString());
      saved = schema.parse(decoded);
    } catch {
      throw new SpendingRestart();
    }
  }
  function next(generation: number, position: number) {
    const payload = [binding, generation, position];
    const bytes = Buffer.from(JSON.stringify(payload));
    const encoded = bytes.toString('base64url');
    const signed = signature(secret, encoded);
    const encodedSignature = signed.toString('base64url');
    return `${encoded}.${encodedSignature}`;
  }
  return { after: saved?.[2] ?? 0, generation: saved?.[1], next };
}

type CurrentEffect = Awaited<ReturnType<typeof readCurrentEffects>>['rows'][number];
function safeRow(record: CurrentEffect): CurrentEffectsResponse['rows'][number] {
  const { permitId, position, payingGroupId, assistantId, reservedAt, heldCents,
    settledCents, state, conflict, budgetPosition, effectPosition } = record;
  return { permitId, position, payingGroupId, assistantId, reservedAt, heldCents,
    settledCents, state, conflict, budgetPosition, effectPosition };
}
async function loadPage(options: ReadOptions, query: CurrentEffectsQuery, secret: string) {
  const deadline = performance.now() + 2000;
  const cursor = continuation(secret, options.silo, query);
  // Include effect streams and capture once; later activity does not change this read.
  const position = await options.store.head(undefined, deadline);
  const input = { after: cursor.after, limit: query.limit };
  const page = await readCurrentEffects(options.modelDb, options.silo, position, input, deadline);
  if (cursor.generation !== undefined && cursor.generation !== page.generation) {
    throw new SpendingRestart();
  }
  const rows = page.rows.map(safeRow);
  let next: string | null = null;
  if (page.next !== null) next = cursor.next(page.generation, page.next);
  return { rows, next, sequence: page.sequence, generation: page.generation };
}
