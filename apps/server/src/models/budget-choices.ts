import { isOrganisationSession, type AuthConfig } from '@opencrane/auth';
import type { EventStore } from '@opencrane/event-store';
import { MemberAccessRefused, readActiveMember, readBudget, readBudgetResource } from '@opencrane/models';
import { budgetChoicesQuerySchema, budgetChoicesResponseSchema } from '@opencrane/protocol';
import { readModelAccessCandidates, QueryDeadlineExceeded, type Query } from '@opencrane/projections';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import type { IntegrationOptions } from '../integrations/routes.ts';
import { sessionFor } from '../members/routes.ts';

type ChoiceQuery = z.infer<typeof budgetChoicesQuerySchema>;
type Page = z.infer<typeof budgetChoicesResponseSchema>;
type ReadOptions = IntegrationOptions & { store: EventStore; modelDb: Query };

export function registerBudgetChoices(app: FastifyInstance, config: AuthConfig,
  options?: IntegrationOptions) {
  app.get('/api/org/models/scope-choices', handle);
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
    const query = budgetChoicesQuerySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ status: 'refused' });
    try {
      const memberId = await options.feed.memberId(options.silo, config.issuerUrl, session.sub);
      if (!memberId) throw new MemberAccessRefused();
      const ready = { ...options, store: options.store, modelDb: options.modelDb };
      const [loaded] = await Promise.allSettled([loadPage(ready, query.data)]);
      // Check current access after loading, including when a dependency failed.
      await readActiveMember(options.store, options.binding, memberId, 'admin');
      if (loaded?.status !== 'fulfilled') {
        return reply.code(503).send({ status: 'unavailable' });
      }
      return reply.send(budgetChoicesResponseSchema.parse(loaded.value));
    } catch (error) {
      if (error instanceof MemberAccessRefused) {
        return reply.code(403).send({ status: 'refused' });
      }
      return reply.code(503).send({ status: 'unavailable' });
    }
  }
}

async function loadPage(options: ReadOptions, query: ChoiceQuery): Promise<Page> {
  const deadline = performance.now() + 10_000;
  const bounded = { ...options, modelDb: queryBeforeDeadline(options.modelDb, deadline) };
  const position = await options.store.head(undefined, deadline);
  const status = await loadStatus(bounded.modelDb, query.kind, position);
  const candidates = await selectCandidates(bounded, query);
  const caps = await loadCaps(bounded, deadline);
  const rows = await buildRows(bounded, query.kind, candidates.selected, caps, deadline);
  if (performance.now() >= deadline) throw new Error('Choices read expired');
  return { status, rows, next: candidates.next };
}

function queryBeforeDeadline(database: Query, deadline: number): Query {
  const readOptions = { deadline };
  async function query<Row extends Record<string, unknown>>(sql: string, parameters?: unknown[]) {
    if (performance.now() >= deadline) throw new Error('Choices read expired');
    return database.query<Row>(sql, parameters, readOptions);
  }
  return { query };
}

async function loadStatus(database: Query, kind: ChoiceQuery['kind'], position: number) {
  const required = kind === 'paying_group' ? ['groups'] : ['groups', 'model-access'];
  const checkpoints = await database.query<{ name: string; sequence: string }>(
    'SELECT name, sequence FROM projection_checkpoints WHERE name = ANY($1::text[])',
    [required]);
  function caughtUp(name: string) {
    function matches(row: { name: string; sequence: string }) {
      return row.name === name && Number(row.sequence) >= position;
    }
    return checkpoints.rows.some(matches);
  }
  return required.every(caughtUp) ? 'current' : 'applying';
}

async function selectCandidates(options: ReadOptions, query: ChoiceQuery) {
  const kind = query.kind === 'paying_group' ? 'team' : 'assistant';
  const candidates = await readModelAccessCandidates(options.modelDb, options.silo,
    kind, query.after, query.limit);
  const selected = candidates.slice(0, query.limit);
  let next: string | null = null;
  if (candidates.length > query.limit) next = selected.at(-1)?.id ?? null;
  return { selected, next };
}

type Caps = Awaited<ReturnType<typeof loadCaps>>;
function capFor(caps: Caps, kind: ChoiceQuery['kind'], id: string): Page['rows'][number]['cap'] {
  if (!caps) return { status: 'unavailable' };
  function matches(cap: NonNullable<Caps>[number]) {
    return cap.scope === kind && cap.scopeId === id;
  }
  const saved = caps.find(matches);
  if (!saved) return { status: 'not_configured' };
  return { status: 'set', ceilingCents: saved.ceilingCents };
}

async function buildRows(options: ReadOptions, kind: ChoiceQuery['kind'],
  candidates: { id: string }[], caps: Caps, deadline: number) {
  const rows: Page['rows'] = [];
  try {
    for (const candidate of candidates) {
      const resource = await readBudgetResource(options.store, options.silo,
        kind, candidate.id, deadline);
      if (!resource) continue;
      const cap = capFor(caps, kind, candidate.id);
      const row = { ...resource, cap };
      rows.push(row);
    }
  } catch (cause) {
    // Treat corrupt resource history as unavailable, separately from caller access.
    throw new Error('Choices unavailable', { cause });
  }
  return rows;
}

async function loadCaps(options: ReadOptions, deadline: number) {
  try {
    const position = await options.store.head(`budget-${options.silo}`, deadline);
    const budget = await readBudget(options.modelDb, options.silo);
    if (budget.sequence >= position) return budget.ceilings;
  } catch (error) {
    if (error instanceof QueryDeadlineExceeded) throw error;
    // Keep a failed or incomplete cap read distinct from a confirmed absence.
  }
  return undefined;
}
