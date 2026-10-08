import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { isOrganisationSession, type AuthConfig } from '@opencrane/auth';
import type { EventStore } from '@opencrane/event-store';
import { grantStream } from '@opencrane/authz';
import { models, providerAuthority, ProviderRefused } from '@opencrane/models';
import { providerModelIdSchema } from '@opencrane/events';
import { modelAccessCandidatesQuerySchema,
  modelAccessCandidatesResponseSchema, modelAccessResponseSchema } from '@opencrane/protocol';
import { readModelAccessCandidates, readModelGrantRows, type Query,
  type connectMemberFeed, type ModelGrantState } from '@opencrane/projections';
import { z } from 'zod';
import type { Binding } from '@opencrane/authz';
import { sessionFor } from '../members/routes.ts';

export interface ModelAccessOptions {
  silo: string;
  store: EventStore;
  db: Query;
  binding: Binding;
  feed: Pick<Awaited<ReturnType<typeof connectMemberFeed>>, 'memberId'>;
}

const parameters = z.object({ modelId: providerModelIdSchema }).strict();

export function registerModelAccessRoutes(app: FastifyInstance, config: AuthConfig,
  options?: ModelAccessOptions) {
  app.get('/api/org/models/:modelId/access', handleAccess);
  app.get('/api/org/models/:modelId/access/candidates', handleCandidates);

  async function handleAccess(request: FastifyRequest, reply: FastifyReply) {
    return handleRead(request, reply, readAccess);
  }

  async function handleCandidates(request: FastifyRequest, reply: FastifyReply) {
    return handleRead(request, reply, readCandidates);
  }

  async function handleRead(request: FastifyRequest, reply: FastifyReply,
    read: ModelAccessReader) {
    reply.header('cache-control', 'no-store');
    const session = sessionFor(request, config, new Date());
    if (!session) return reply.code(401).send({ status: 'refused' });
    if (!options) return reply.code(503).send({ status: 'unavailable' });
    if (!trustedRequest(config, options, session)) {
      return reply.code(403).send({ status: 'refused' });
    }
    try {
      const memberId = await options.feed.memberId(options.silo, config.issuerUrl, session.sub);
      if (!memberId) throw new ProviderRefused();
      // Check once before reading. A later membership change applies to the next request.
      await providerAuthority(options.store, options.binding, memberId);
      return await read(request, reply, options);
    } catch (error) {
      const status = readErrorStatus(error);
      return reply.code(status).send(readErrorBody(status));
    }
  }
}

type ModelAccessReader = (request: FastifyRequest, reply: FastifyReply,
  options: ModelAccessOptions) => Promise<unknown>;

function trustedRequest(config: AuthConfig, options: ModelAccessOptions,
  session: { sub: string; orgId: string }) {
  return isOrganisationSession(config, session) && options.silo === options.binding.silo;
}

async function readAccess(request: FastifyRequest, reply: FastifyReply,
  options: ModelAccessOptions) {
  const { modelId } = parseInput(parameters, request.params);
  const subject = grantStream('model', modelId);
  const expectedSequence = await options.store.head(subject);
  const position = await options.store.head();
  const checkpoint = await projectionCheckpoint(options.db);
  const grants = await readModelGrantRows(options.db, options.silo, modelId);
  const projection = projectionStatus(checkpoint, position);
  const grantRows: ReturnType<typeof publicGrantRow>[] = [];
  for (const row of grants.rows) {
    grantRows.push(publicGrantRow(row, checkpoint));
  }
  function supportsModel(model: (typeof models)[number]) {
    return model.id === modelId && !model.retired;
  }
  const supported = models.some(supportsModel);
  const response = modelAccessResponseSchema.parse({
    modelId,
    expectedSequence,
    loadedAt: new Date().toISOString(),
    // This route admits only Owners and Admins, so every successful response can manage grants.
    canManage: true,
    grants: grantRows,
    grantTotal: grants.total,
    explanations: { configuredUses: { status: 'not_available_yet' } },
    availability: {
      registrySupported: supported,
      selectedConnection: { status: 'not_available_yet' },
      enabledModel: { status: 'not_available_yet' },
      connection: { status: 'not_available_yet' },
      key: { status: 'not_available_yet' },
      verification: { status: 'not_available_yet' },
    },
    projection,
  });
  return reply.send(response);
}

async function readCandidates(request: FastifyRequest, reply: FastifyReply,
  options: ModelAccessOptions) {
  parseInput(parameters, request.params);
  const query = parseInput(modelAccessCandidatesQuerySchema, request.query);
  const position = await options.store.head();
  const checkpoint = await projectionCheckpoint(options.db);
  const candidates = await readModelAccessCandidates(options.db, options.silo,
    query.kind, query.after, query.limit);
  const hasMore = candidates.length > query.limit;
  const rows = hasMore ? candidates.slice(0, query.limit) : candidates;
  const next = hasMore ? rows.at(-1)?.id ?? null : null;
  const response = modelAccessCandidatesResponseSchema.parse({
    rows,
    next,
    loadedAt: new Date().toISOString(),
    projection: projectionStatus(checkpoint, position),
  });
  return reply.send(response);
}

function sourceFor(kind: 'member' | 'team' | 'assistant') {
  if (kind === 'member') return 'direct' as const;
  if (kind === 'team') return 'group' as const;
  return 'assistant' as const;
}

function publicGrantRow(row: ModelGrantState, checkpoint: number) {
  let projection: 'current' | 'applying';
  if (checkpoint >= row.position) {
    projection = 'current';
  } else {
    projection = 'applying';
  }
  return {
    granteeKind: row.granteeKind,
    granteeId: row.granteeId,
    displayName: row.displayName,
    source: sourceFor(row.granteeKind),
    state: row.state,
    eventId: row.eventId,
    eventTime: row.eventTime,
    projection,
    sequence: row.position,
  };
}

function readErrorStatus(error: unknown) {
  if (error instanceof BadReadInput) return 400;
  if (error instanceof ProviderRefused) return 403;
  return 503;
}

class BadReadInput extends Error {}

function parseInput<Schema extends z.ZodType>(schema: Schema, input: unknown): z.infer<Schema> {
  try {
    return schema.parse(input);
  } catch (error) {
    if (error instanceof z.ZodError) throw new BadReadInput();
    throw error;
  }
}

function readErrorBody(status: number) {
  if (status === 503) return { status: 'unavailable' as const };
  return { status: 'refused' as const };
}

async function projectionCheckpoint(db: Query) {
  // Use the slowest table. Show zero if a checkpoint is missing so the response stays applying.
  const result = await db.query<{ sequence: string | number; count: number }>(
    `SELECT MIN(sequence) AS sequence, COUNT(*)::int AS count FROM projection_checkpoints
      WHERE name = ANY($1::text[])`, [['members', 'groups', 'model-access']]);
  if (result.rows[0]?.count !== 3) return 0;
  return Number(result.rows[0]?.sequence ?? 0);
}

function projectionStatus(checkpoint: number, position: number) {
  return { content: checkpoint >= position ? 'current' as const : 'applying' as const,
    sequence: checkpoint };
}
