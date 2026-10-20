import { afterAll, beforeAll, expect, it } from 'vitest';
import { encodeSession } from '@opencrane/auth';
import { createStore, memberAuthorisation } from '@opencrane/authz';
import { databases, openfga } from '@opencrane/authz/testing';
import { event, natsFixture } from '@opencrane/event-store/testing';
import { budgets, BudgetActor } from '@opencrane/models';
import { createLogger } from '@opencrane/observability';
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
async function noRows() {
  return [];
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
    feed: { memberId }, catalogue: { rows: noRows, tools: noRows } };
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
