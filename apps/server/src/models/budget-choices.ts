import { isOrganisationSession, type AuthConfig } from '@opencrane/auth';
import type { EventStore, StoredEvent } from '@opencrane/event-store';
import { assistantCreatedDataSchema, assistantSettingsChangedDataSchema,
  teamCreatedDataSchema } from '@opencrane/events';
import { MemberAccessRefused, readActiveMember, readBudget } from '@opencrane/models';
import { budgetChoicesQuerySchema, budgetChoicesResponseSchema } from '@opencrane/protocol';
import { readModelAccessCandidates, type Query } from '@opencrane/projections';
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
  const position = await options.store.head(undefined, deadline);
  const kind = query.kind === 'paying_group' ? 'team' : 'assistant';
  const checkpoints = await options.modelDb.query<{ name: string; sequence: string }>(
    'SELECT name, sequence FROM projection_checkpoints WHERE name = ANY($1::text[])',
    [['groups', 'model-access']]);
  const required = query.kind === 'paying_group' ? ['groups'] : ['groups', 'model-access'];
  function caughtUp(name: string) {
    function matches(row: { name: string; sequence: string }) {
      return row.name === name && Number(row.sequence) >= position;
    }
    return checkpoints.rows.some(matches);
  }
  const status = required.every(caughtUp) ? 'current' : 'applying';
  const candidates = await readModelAccessCandidates(options.modelDb, options.silo,
    kind, query.after, query.limit);
  const selected = candidates.slice(0, query.limit);
  const caps = await loadCaps(options, deadline);
  const rows: Page['rows'] = [];
  for (const candidate of selected) {
    let resource;
    if (query.kind === 'assistant') {
      resource = await loadAssistantChoice(options, candidate.id, deadline);
    } else {
      resource = await loadGroupChoice(options, candidate.id, deadline);
    }
    if (!resource) continue;
    function matchesCap(cap: NonNullable<typeof caps>[number]) {
      return cap.scope === query.kind && cap.scopeId === candidate.id;
    }
    const saved = caps?.find(matchesCap);
    let cap: Page['rows'][number]['cap'] = { status: 'unavailable' };
    if (caps) {
      cap = saved ? { status: 'set', ceilingCents: saved.ceilingCents }
        : { status: 'not_configured' };
    }
    rows.push({ ...resource, cap });
  }
  if (performance.now() > deadline) throw new Error('Choices read expired');
  const next = candidates.length > query.limit ? selected.at(-1)?.id ?? null : null;
  return { status, rows, next };
}

async function loadCaps(options: ReadOptions, deadline: number) {
  try {
    const position = await options.store.head(`budget-${options.silo}`, deadline);
    const budget = await readBudget(options.modelDb, options.silo);
    if (budget.sequence >= position) return budget.ceilings;
  } catch {
    // Keep a failed or incomplete cap read distinct from a confirmed absence.
  }
  return undefined;
}

async function readChoiceRecords(options: ReadOptions, subject: string, deadline: number) {
  const rows: StoredEvent[] = [];
  for await (const row of options.store.readStream(subject, 1, deadline)) {
    if (row.event.silo !== options.silo || row.event.subject !== subject ||
      rows.length >= 1000) throw new Error('Choices unavailable');
    rows.push(row);
  }
  return rows;
}

async function loadGroupChoice(options: ReadOptions, id: string, deadline: number) {
  const rows = await readChoiceRecords(options, `team-${id}`, deadline);
  for (const { event } of rows) {
    if (event.type !== 'team.created') continue;
    const saved = teamCreatedDataSchema.parse(event.data);
    if (saved.teamId !== id) throw new Error('Choices unavailable');
    return { id, displayName: saved.name, sequence: rows.at(-1)!.sequence };
  }
  return undefined;
}

async function loadAssistantChoice(options: ReadOptions, id: string, deadline: number) {
  const rows = await readChoiceRecords(options, `assistant-${id}`, deadline);
  let created: z.infer<typeof assistantCreatedDataSchema> | undefined;
  let active = true;
  for (const { event } of rows) {
    if (event.type === 'assistant.created') {
      created = assistantCreatedDataSchema.parse(event.data);
      if (created.assistantId !== id) throw new Error('Choices unavailable');
    }
    if (event.type === 'assistant.settings_changed') {
      const settings = assistantSettingsChangedDataSchema.parse(event.data);
      if (settings.assistantId !== id) throw new Error('Choices unavailable');
      if (settings.active !== undefined) active = settings.active;
    }
  }
  if (!created || created.kind !== 'team' || !active) return undefined;
  const computer = await readChoiceRecords(options, `computer-${id}`, deadline);
  for (const { event } of computer) {
    if (event.type === 'computer.retired') return undefined;
  }
  if (!await loadGroupChoice(options, created.ownerId, deadline)) return undefined;
  return { id, displayName: created.name ?? id, sequence: rows.at(-1)!.sequence };
}
