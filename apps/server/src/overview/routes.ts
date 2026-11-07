import { z } from 'zod';
import { toolPolicySchema } from '@opencrane/protocol';
import { isToolPolicyAvailable } from '@opencrane/projections';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { isOrganisationSession, type AuthConfig } from '@opencrane/auth';
import { MemberAccessRefused, readActiveMember } from '@opencrane/models';
import type { Query } from '@opencrane/projections';
import type { GroupOptions } from '../members/group-routes.ts';
import type { IntegrationOptions } from '../integrations/routes.ts';
import { sessionFor } from '../members/routes.ts';
import { buildOverview, type OverviewName, type OverviewPriority,
  type OverviewRow, type OverviewSource } from './rows.ts';

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional(),
  cursor: z.string().min(1).max(1000).optional(),
}).strict();

type ReadOptions = GroupOptions & { modelDb: Query | undefined };
type AvailableName = 'people' | 'providers' | 'integrations' | 'spending';
const checkpointNames: Record<AvailableName, string> = {
  people: 'members', providers: 'providers', integrations: 'mcp catalogue',
  spending: 'model-budgets',
};
type SavedProvider = { providerId: string; revision: number; position: number;
  reachable?: { outcome: string; time: string; changeId: string; revision: number };
  modelAnswer?: { outcome: string; time: string; changeId: string; revision: number } };

function overviewRow(source: OverviewName, id: string, sourceId: string,
  priority: OverviewPriority, eventAt: string | null, revision: number,
  action: OverviewRow['action'], href: string): OverviewRow {
  return { source, id, sourceId, priority, eventAt, revision, action, href };
}

function peopleRow(record: { member_id: string; status: string }): OverviewRow | null {
  if (record.status !== 'invited') return null;
  return overviewRow('people', record.member_id, `member:${record.member_id}`,
    'needs_input', null, 0, 'view_invitation_links', '/org/people');
}

function latestProviderFact(provider: SavedProvider) {
  let latest = provider.reachable;
  if (provider.modelAnswer && (!latest || provider.modelAnswer.time >= latest.time)) {
    latest = provider.modelAnswer;
  }
  return latest;
}

function isUnknownProviderOutcome(outcome: string): boolean {
  return outcome === 'unknown' || outcome === 'outcome_unknown';
}

function isFailedProviderOutcome(outcome: string): boolean {
  return outcome === 'fail' || outcome === 'budget_refused';
}

function currentProviderIssue(fact: SavedProvider['reachable'],
  revision: number): 'unknown' | 'failure' | null {
  if (!fact || fact.revision !== revision) return null;
  if (isUnknownProviderOutcome(fact.outcome)) return 'unknown';
  if (isFailedProviderOutcome(fact.outcome)) return 'failure';
  return null;
}

function providerPriority(provider: SavedProvider): OverviewPriority {
  const reachable = provider.reachable;
  const modelAnswer = provider.modelAnswer;
  const reachabilityIssue = currentProviderIssue(reachable, provider.revision);
  const modelIssue = currentProviderIssue(modelAnswer, provider.revision);
  if (reachabilityIssue === 'unknown' || modelIssue === 'unknown') return 'unknown';
  if (reachabilityIssue === 'failure' || modelIssue === 'failure') return 'failure';
  // Require both checks for the current configuration, even if one passed later.
  if (!reachable || !modelAnswer) return 'needs_input';
  if (reachable.revision !== provider.revision ||
      modelAnswer.revision !== provider.revision) return 'needs_input';
  if (reachable.outcome === 'pass' && modelAnswer.outcome === 'pass') return 'ready';
  return 'needs_input';
}

export function providerRow(record: { state: SavedProvider }): OverviewRow {
  const provider = record.state;
  const latest = latestProviderFact(provider);
  const priority = providerPriority(provider);
  return overviewRow('providers', provider.providerId,
    latest?.changeId ?? `provider:${provider.providerId}`, priority,
    latest?.time ?? null, provider.revision, 'view_evidence',
    `/org/providers/${encodeURIComponent(provider.providerId)}`);
}

function integrationRow(record: { server_id: string; lifecycle: string;
  changed_at: string; position: string; policy: unknown }): OverviewRow {
  const parsed = toolPolicySchema.safeParse(record.policy);
  let priority: OverviewPriority = 'needs_input';
  let eventAt = record.changed_at;
  let revision = Number(record.position);
  if (record.lifecycle === 'rejected' || parsed.success && parsed.data.rejected === true) {
    priority = 'failure';
  } else if (parsed.success && isToolPolicyAvailable(parsed.data)) {
    priority = 'ready';
    eventAt = parsed.data.checkedAt ?? record.changed_at;
    revision = parsed.data.policyRevision;
  }
  return overviewRow('integrations', record.server_id, `mcp:${record.server_id}`,
    priority, eventAt, revision, 'review_tools',
    `/org/integrations/${encodeURIComponent(record.server_id)}`);
}

function spendingRow(record: { permit_id: string; position: string;
  data: { reservedAt: string; state: string } }): OverviewRow | null {
  if (record.data.state === 'settled' || record.data.state === 'released') return null;
  return overviewRow('spending', record.permit_id, `effect:${record.permit_id}`,
    'unknown', record.data.reservedAt, Number(record.position), 'view_evidence',
    `/api/org/effects/${encodeURIComponent(record.permit_id)}`);
}

export async function loadSource<T extends Record<string, unknown>>(name: AvailableName, db: Query,
  silo: string, head: number, deadline: number, sql: string,
  convert: (record: T) => OverviewRow | null): Promise<OverviewSource> {
  const checkedAt = new Date().toISOString();
  let checkpoint: number | null = null;
  try {
    const progress = await db.query<{ sequence: string }>(
      'SELECT sequence FROM projection_checkpoints WHERE name = $1',
      [checkpointNames[name]], { deadline });
    checkpoint = progress.rows[0] ? Number(progress.rows[0].sequence) : null;
    if (checkpoint === null) {
      return { name, status: 'unavailable', checkpoint, checkedAt, rows: [] };
    }
    const result = await db.query<T>(sql, [silo], { deadline });
    const rows: OverviewRow[] = [];
    for (const record of result.rows.slice(0, 50)) {
      const row = convert(record);
      if (row) rows.push(row);
    }
    let status: OverviewSource['status'] = 'current';
    if (checkpoint < head) status = 'applying';
    if (result.rows.length > 50) status = 'unavailable';
    return { name, status, checkpoint, checkedAt, rows };
  } catch {
    return { name, status: 'unavailable', checkpoint, checkedAt, rows: [] };
  }
}

async function loadOverview(options: ReadOptions, deadline: number): Promise<OverviewSource[]> {
  const head = await options.store.head(undefined, deadline);
  const silo = options.silo;
  const people = loadSource('people', options.db, silo, head, deadline,
    'SELECT member_id, status FROM members WHERE silo = $1 ORDER BY member_id LIMIT 51',
    peopleRow);
  const providers = loadSource('providers', options.db, silo, head, deadline,
    'SELECT state FROM providers WHERE silo = $1 ORDER BY provider_id LIMIT 51',
    providerRow);
  const integrations = loadSource('integrations', options.db, silo, head, deadline,
    `SELECT server_id, lifecycle, changed_at, position, policy FROM mcp_catalogue
      WHERE silo = $1 ORDER BY server_id LIMIT 51`, integrationRow);
  let spending: Promise<OverviewSource>;
  if (options.modelDb) {
    spending = loadSource('spending', options.modelDb, silo, head, deadline,
      `SELECT permit_id, position, data FROM model_current_effects
        WHERE silo = $1 ORDER BY permit_id LIMIT 51`,
      spendingRow);
  } else {
    spending = Promise.resolve({ name: 'spending', status: 'unavailable', checkpoint: null,
      checkedAt: new Date().toISOString(), rows: [] });
  }
  const loaded = await Promise.all([people, providers, integrations, spending]);
  const checkedAt = new Date().toISOString();
  for (const name of ['publication', 'memory', 'routines'] as const) {
    loaded.push({ name, status: 'unavailable', checkpoint: null, checkedAt, rows: [] });
  }
  return loaded;
}

export function registerOverviewRoutes(app: FastifyInstance, config: AuthConfig,
  options?: GroupOptions, integrations?: IntegrationOptions, historyAvailable = false) {
  app.get('/api/org/overview', handle);
  async function handle(request: FastifyRequest, reply: FastifyReply) {
    reply.header('cache-control', 'no-store');
    const session = sessionFor(request, config, new Date());
    if (!session) return reply.code(401).send({ status: 'refused' });
    if (!options || !config.expectedOrgId) return reply.code(503).send({ status: 'unavailable' });
    if (!trustedRead(config, options, integrations, session)) {
      return reply.code(403).send({ status: 'refused' });
    }
    const parsed = querySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ status: 'refused' });
    try {
      const memberId = await options.feed.memberId(options.silo, config.issuerUrl, session.sub);
      if (!memberId) throw new MemberAccessRefused();
      const ready = { ...options, modelDb: integrations?.modelDb };
      const deadline = performance.now() + 2000;
      const loading = loadOverview(ready, deadline);
      const loaded = (await Promise.allSettled([loading]))[0];
      // Check current access once after loading, even when a source read fails.
      const role = await readActiveMember(options.store, options.binding, memberId, 'admin');
      if (loaded.status !== 'fulfilled') {
        return reply.code(503).send({ status: 'unavailable' });
      }
      const overview = buildOverview(loaded.value, parsed.data.limit, parsed.data.cursor);
      const capabilities = {
        people: { read: true, manage: true },
        ownership: { manage: role === 'owner' },
        providers: { read: true, manage: true },
        integrations: { read: Boolean(integrations), manage: Boolean(integrations) },
        spending: { read: Boolean(integrations?.modelDb), manage: Boolean(integrations?.modelDb) },
        routines: { readOwn: true },
        changeHistory: { read: historyAvailable },
      };
      return reply.send({ ...overview, viewer: { role }, capabilities });
    } catch (error) {
      if (error instanceof MemberAccessRefused) {
        return reply.code(403).send({ status: 'refused' });
      }
      if (error instanceof Error && error.message === 'Invalid overview cursor') {
        return reply.code(400).send({ status: 'refused' });
      }
      return reply.code(503).send({ status: 'unavailable' });
    }
  }
}

function trustedRead(config: AuthConfig, options: GroupOptions,
  integrations: IntegrationOptions | undefined, session: { sub: string; orgId: string }) {
  return isOrganisationSession(config, session) && options.silo === options.binding.silo &&
    (!integrations || integrations.silo === options.silo);
}
