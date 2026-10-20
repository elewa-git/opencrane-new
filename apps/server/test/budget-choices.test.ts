import { afterAll, beforeAll, expect, it } from 'vitest';
import { encodeSession } from '@opencrane/auth';
import { createStore, memberAuthorisation } from '@opencrane/authz';
import { databases, openfga } from '@opencrane/authz/testing';
import { event, natsFixture } from '@opencrane/event-store/testing';
import { getEventDefinition } from '@opencrane/events';
import { budgets, BudgetActor } from '@opencrane/models';
import { createLogger } from '@opencrane/observability';
import { budgetChoicesQuerySchema, budgetChoicesResponseSchema } from '@opencrane/protocol';
import { groups, members, modelAccess, pgDb, ProjectionRunner } from '@opencrane/projections';
import { buildServer } from '../src/server.ts';
import type { IntegrationOptions } from '../src/integrations/routes.ts';
import { testAuthConfig } from './support/test-auth-config.ts';

const config = testAuthConfig({ expectedOrgId: 'org-acme' });
let nats: Awaited<ReturnType<typeof natsFixture>>;
let fga: Awaited<ReturnType<typeof openfga>>;
let dbs: Awaited<ReturnType<typeof databases>>;
let options: IntegrationOptions;
let app: ReturnType<typeof buildServer>;
let runner: ProjectionRunner;
let serial = 0;
type Page = {
  rows: { id: string; displayName: string; sequence: number;
    cap: { status: string; ceilingCents?: number } }[];
  next: string | null;
  status: string;
};

async function append(subject: string, type: string, data: unknown, silo = 'acme') {
  const record = { ...event(`choice-${++serial}`, subject, type), silo, data,
    principal: { kind: 'human' as const, id: 'owner' }, correlation: {} };
  const result = await nats.store.append({
    event: record, expectedSequence: await nats.store.head(subject),
  });
  expect(result.status).toBe('appended');
  return record;
}
async function project() {
  for (const projection of [members, groups, modelAccess, budgets]) {
    await runner.run(projection);
  }
}
function memberId(_silo: string, _issuer: string, sub: string) {
  return Promise.resolve(sub);
}
function noCatalogue(): Promise<never> {
  return Promise.reject(new Error('Spending choices must not load tools'));
}
async function initialise() {
  nats = await natsFixture();
  fga = await openfga();
  dbs = await databases();
  const binding = await createStore(fga.apiUrl, 'acme');
  const database = pgDb(dbs.queue);
  runner = new ProjectionRunner(database, nats.reader,
    createLogger('budget-choices-test', { level: 'silent' }));
  for (const projection of [members, groups, modelAccess, budgets]) {
    await runner.initialise(projection);
  }
  options = { silo: 'acme', binding, store: nats.store, modelDb: database,
    feed: { memberId }, catalogue: { rows: noCatalogue, tools: noCatalogue } };
  const auth = memberAuthorisation(binding);
  for (const [id, role] of [['owner', 'owner'], ['admin', 'admin'],
    ['member', 'member'], ['removed', 'admin'], ['denied', 'admin']] as const) {
    const joined = await append(`member-${id}`, 'member.joined', {
      memberId: id, role, email: `${id}@example.test`, displayName: id,
    });
    if (id !== 'denied') await auth.handler.handle(joined, database);
  }
  await append('member-removed', 'member.removed', { memberId: 'removed', removedBy: 'owner' });
  for (let index = 0; index < 51; index++) {
    const id = `group-${String(index).padStart(2, '0')}`;
    await append(`team-${id}`, 'team.created', {
      teamId: id, name: `Group ${index}`, createdBy: 'owner',
    });
  }
  await append('team-foreign', 'team.created', {
    teamId: 'foreign', name: 'Foreign protected name', createdBy: 'owner',
  }, 'other');
  const actor = new BudgetActor(nats.store, 'acme');
  await actor.start(100, 1000, 'installation-default');
  await project();
  app = buildServer(config, { integrations: options });
}
async function close() {
  await app?.close();
  await dbs?.close();
  await fga?.close();
  await nats?.close();
}
function request(query = 'kind=paying_group', sub = 'owner', orgId = 'org-acme',
  server = app) {
  const session = { sub, orgId, roles: [], authTime: 1790856000, exp: 2000000000 };
  const headers = { cookie: `${config.cookieName}=${encodeSession(config, session)}` };
  return server.inject({ method: 'GET', url: `/api/org/models/scope-choices?${query}`, headers });
}
beforeAll(initialise, 120_000);
afterAll(close);

async function pagesRealGroups() {
  const before = await nats.store.head();
  const found = new Set<string>();
  let after = '';
  for (const size of [20, 20, 11]) {
    const response = await request(`kind=paying_group${after}`);
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const page = response.json<Page>();
    expect(page.status).toBe('current');
    expect(page.rows).toHaveLength(size);
    for (const row of page.rows) {
      expect(found.has(row.id)).toBe(false);
      found.add(row.id);
      expect(row.sequence).toBe(await nats.store.head(`team-${row.id}`));
      expect(row.cap).toEqual({ status: 'not_configured' });
    }
    after = `&after=${page.next}`;
    if (size === 11) expect(page.next).toBeNull();
  }
  expect(found.size).toBe(51);
  expect(await nats.store.head()).toBe(before);
  expect(await nats.store.head('team-installation-default')).toBe(0);
}
it('pages 51 real groups as 20/20/11 with resource revisions and no writes', pagesRealGroups);

async function rejectsQuery(query: string) {
  const response = await request(query);
  expect(response.statusCode).toBe(400);
  expect(response.json()).toEqual({ status: 'refused' });
  expect(response.headers['cache-control']).toBe('no-store');
}
const invalidQueries = ['kind=personal', 'kind=paying_group&after=*',
  'kind=paying_group&limit=51', 'kind=paying_group&limit=0',
  'kind=paying_group&limit=1.5', 'kind=paying_group&extra=1'];
it.each(invalidQueries)('refuses invalid choices query %s', rejectsQuery);

async function hidesRows(sub: string, org = 'org-acme', server = app) {
  const response = await request('kind=paying_group', sub, org, server);
  expect(response.statusCode).toBe(403);
  expect(response.json()).toEqual({ status: 'refused' });
  expect(response.headers['cache-control']).toBe('no-store');
}
async function refusesCaller(sub: string) {
  await hidesRows(sub);
}
it.each(['member', 'removed', 'denied'])('hides names and rows from %s', refusesCaller);
async function refusesForeign() {
  await hidesRows('owner', 'org-other');
  const server = buildServer(config, { integrations: { ...options, silo: 'other' } });
  try {
    await hidesRows('owner', 'org-acme', server);
  } finally {
    await server.close();
  }
}
it('refuses a foreign organisation and mismatched silo binding', refusesForeign);

async function iamUnavailable() {
  const binding = { ...options.binding, apiUrl: 'http://127.0.0.1:1' };
  const server = buildServer(config, { integrations: { ...options, binding } });
  try {
    const response = await request('kind=paying_group', 'owner', 'org-acme', server);
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'unavailable' });
  } finally {
    await server.close();
  }
}
it('returns unavailable when IAM cannot be reached', iamUnavailable);

async function assistantPages() {
  for (const id of ['a-personal', 'b-inactive', 'c-retired', 'd-shared', 'e-shared']) {
    await append(`assistant-${id}`, 'assistant.created', {
      assistantId: id, kind: id === 'a-personal' ? 'personal' : 'team',
      ownerId: 'group-00', name: id,
    });
  }
  await append('assistant-b-inactive', 'assistant.settings_changed', {
    assistantId: 'b-inactive', active: false, changedBy: 'owner', changedFields: ['active'],
  });
  await append('computer-c-retired', 'computer.retired', {
    assistantId: 'c-retired', computerId: 'retired-computer',
  });
  await append('assistant-d-shared', 'assistant.settings_changed', {
    assistantId: 'd-shared', changedBy: 'owner', changedFields: ['model'],
  });
  await project();
  const ids: string[] = [];
  let after = '';
  do {
    const response = await request(`kind=assistant&limit=2${after}`);
    expect(response.statusCode).toBe(200);
    const page = response.json<Page>();
    for (const row of page.rows) {
      ids.push(row.id);
      expect(row.sequence).toBe(await nats.store.head(`assistant-${row.id}`));
    }
    after = page.next ? `&after=${page.next}` : '';
  } while (after);
  expect(ids).toEqual(['d-shared', 'e-shared']);
}
it('pages only active shared assistants and excludes personal and retired choices', assistantPages);

async function capsAreExplicit() {
  await append('budget-acme', 'budget.ceiling_set', {
    scope: 'paying_group', scopeId: 'group-00', ceilingCents: 0, setBy: 'owner',
  });
  await project();
  const response = await request();
  const page = budgetChoicesResponseSchema.parse(response.json());
  expect(page.rows[0]?.cap).toEqual({ status: 'set', ceilingCents: 0 });
  expect(page.rows[1]?.cap).toEqual({ status: 'not_configured' });
  const cap = { status: 'set', ceilingCents: Number.MAX_SAFE_INTEGER + 1 };
  const invalid = { ...page, rows: [{ ...page.rows[0], cap }] };
  expect(budgetChoicesResponseSchema.safeParse(invalid).success).toBe(false);
  expect(budgetChoicesResponseSchema.safeParse({ ...page, total: 51 }).success).toBe(false);
  expect(budgetChoicesQuerySchema.safeParse({ kind: 'assistant', extra: true }).success).toBe(false);
  await append('budget-acme', 'budget.ceiling_set', {
    scope: 'paying_group', scopeId: 'group-00', ceilingCents: 100, setBy: 'owner',
  });
  const lagging = await request();
  expect(lagging.json<Page>().rows[0]?.cap).toEqual({ status: 'unavailable' });
  await project();
}
it('distinguishes absent, zero and lagging caps and rejects unsafe money', capsAreExplicit);

async function failedBudgetRead() {
  const database = options.modelDb!;
  const original = database.query.bind(database);
  async function query<Row extends Record<string, unknown>>(sql: string, values?: unknown[]) {
    if (sql.includes('FROM model_budgets')) throw new Error('Protected upstream reply');
    return original<Row>(sql, values);
  }
  database.query = query;
  try {
    const response = await request();
    expect(response.statusCode).toBe(200);
    for (const row of response.json<Page>().rows) {
      expect(row.cap).toEqual({ status: 'unavailable' });
    }
    await hidesRows('member');
  } finally {
    database.query = original;
  }
}
it('never substitutes zero or no cap when the budget read fails', failedBudgetRead);

async function applyingIsNotEmpty() {
  await append('team-z-new', 'team.created', {
    teamId: 'z-new', name: 'New group', createdBy: 'owner',
  });
  const response = await request('kind=paying_group&after=group-50');
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ status: 'applying', rows: [], next: null });
  await project();
  const current = await request('kind=paying_group&after=group-50');
  expect(current.json<Page>().rows[0]?.displayName).toBe('New group');
}
it('reports applying rather than a complete empty list when projections lag', applyingIsNotEmpty);

async function changesDuringLoad(demote: boolean) {
  const database = options.modelDb!;
  const original = database.query.bind(database);
  const loaded = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  async function query<Row extends Record<string, unknown>>(sql: string, values?: unknown[]) {
    if (sql.includes('WITH selected_groups')) {
      loaded.resolve();
      await resume.promise;
    }
    return original<Row>(sql, values);
  }
  database.query = query;
  const pending = request('kind=paying_group', 'admin');
  try {
    await loaded.promise;
    if (demote) {
      await append('member-admin', 'member.role_changed', {
        memberId: 'admin', previousRole: 'admin', newRole: 'member', changedBy: 'owner',
      });
    } else {
      for (const type of ['conversation.created', 'file.uploaded']) {
        await append('conversation-conv_1', type, getEventDefinition(type)!.example);
      }
    }
    const beforeReply = await nats.store.head();
    resume.resolve();
    const response = await pending;
    expect(response.statusCode).toBe(demote ? 403 : 200);
    if (demote) expect(response.json()).toEqual({ status: 'refused' });
    expect(await nats.store.head()).toBe(beforeReply);
  } finally {
    resume.resolve();
    database.query = original;
  }
}
it.each([false, true])('checks access after blocked load; demotion=%s', changesDuringLoad);
