import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { encodeSession } from '@opencrane/auth';
import { createStore, memberAuthorisation } from '@opencrane/authz';
import { databases, openfga } from '@opencrane/authz/testing';
import { event, natsFixture } from '@opencrane/event-store/testing';
import { createLogger } from '@opencrane/observability';
import { groups, members, pgDb, ProjectionRunner } from '@opencrane/projections';
import { buildServer } from '../src/server.ts';
import { testAuthConfig } from './support/test-auth-config.ts';

const config = testAuthConfig({ expectedOrgId: 'org-acme' });
let nats: Awaited<ReturnType<typeof natsFixture>>;
let fga: Awaited<ReturnType<typeof openfga>>;
let dbs: Awaited<ReturnType<typeof databases>>;
let db: ReturnType<typeof pgDb>;
let auth: ReturnType<typeof memberAuthorisation>;
let app: ReturnType<typeof buildServer>;
let count = 0;

async function append(subject: string, type: string, data: unknown, apply = true) {
  const record = { ...event(`owning-read-${++count}`, subject, type), silo: 'acme', data,
    principal: { kind: 'human' as const, id: 'owner' } };
  const expectedSequence = await nats.store.head(subject);
  const result = await nats.store.append({ event: record, expectedSequence });
  expect(result.status).toBe('appended');
  if (apply && auth.handler.eventTypes.includes(type)) {
    await auth.handler.handle(record, db);
  }
  return record;
}

function resolveMemberId() {
  return Promise.resolve('admin');
}

async function initialise() {
  nats = await natsFixture();
  fga = await openfga();
  dbs = await databases();
  db = pgDb(dbs.queue);
  const binding = await createStore(fga.apiUrl, 'acme');
  auth = memberAuthorisation(binding);
  const logger = createLogger('owning-reads-test', { level: 'silent' });
  const runner = new ProjectionRunner(db, nats.reader, logger);
  await runner.initialise(members);
  await runner.initialise(groups);
  for (const [memberId, role] of [['owner', 'owner'], ['admin', 'admin']] as const) {
    const joined = { memberId, role, displayName: memberId,
      email: `${memberId}@example.test` };
    await append(`member-${memberId}`, 'member.joined', joined);
  }
  await append('ownership-acme', 'ownership.seeded', { ownerIds: ['owner'] });
  await append('ownership-acme', 'ownership.transferred', {
    memberId: 'owner', transferredBy: 'owner', awaitingConfirmation: true,
  });
  await append('team-sales', 'team.created', {
    teamId: 'sales', name: 'Sales', createdBy: 'owner',
  });
  await runner.run(members);
  await runner.run(groups);
  const options = { silo: 'acme', store: nats.store, db, binding,
    feed: { memberId: resolveMemberId } };
  app = buildServer(config, { groups: options, ownership: options });
}
beforeAll(initialise, 120_000);

async function close() {
  vi.restoreAllMocks();
  await app?.close();
  await dbs?.close();
  await fga?.close();
  await nats?.close();
}
afterAll(close);

interface ReadCase {
  url: string;
  historySubject?: string;
  expected: object;
}
const routes: ReadCase[] = [
  { url: '/api/groups', expected: { rows: [{ groupId: 'sales', name: 'Sales' }] } },
  { url: '/api/groups/sales', expected: { rows: [{ groupId: 'sales', name: 'Sales' }] } },
  { url: '/api/groups/sales/changes/owning-read-5', historySubject: 'team-sales',
    expected: { status: 'appended', groupId: 'sales' } },
  { url: '/api/ownership', historySubject: 'member-owner',
    expected: { status: 'current', owners: [{ memberId: 'owner', displayName: 'owner' }],
      viewer: { memberId: 'admin', role: 'admin' } } },
  { url: '/api/ownership/changes/owning-read-4', historySubject: 'ownership-acme',
    expected: { status: 'appended', commandId: 'owning-read-4',
      projection: { content: 'applying', iam: 'applying' } } },
];

function request(url: string) {
  const session = { sub: 'idp-admin', orgId: 'org-acme', roles: [],
    authTime: 1790856000, exp: 2000000000 };
  const cookie = `${config.cookieName}=${encodeSession(config, session)}`;
  return app.inject({ method: 'GET', url, headers: { cookie } });
}

function interceptLoading(route: ReadCase, afterLoading: () => Promise<void>) {
  const originalRead = nats.store.readStream.bind(nats.store);
  const originalQuery = db.query.bind(db);
  const originalCheck = auth.check.bind(auth);
  let loaded = false;
  let accessReadBeforeLoading = false;
  async function finishLoading() {
    if (loaded) return;
    loaded = true;
    await afterLoading();
  }
  async function* read(...args: Parameters<typeof originalRead>) {
    const subject = args[0];
    yield* originalRead(...args);
    if (subject === route.historySubject) await finishLoading();
  }
  async function query<Row extends Record<string, unknown>>(
    sql: string, parameters?: unknown[],
  ) {
    const result = await originalQuery<Row>(sql, parameters);
    if (!route.historySubject && sql.includes('FROM groups WHERE')) await finishLoading();
    return result;
  }
  function check(...args: Parameters<typeof originalCheck>) {
    if (!loaded) accessReadBeforeLoading = true;
    return originalCheck(...args);
  }
  const reads = vi.spyOn(nats.store, 'readStream').mockImplementation(read);
  const queries = vi.spyOn(db, 'query').mockImplementation(query);
  const checks = vi.spyOn(auth, 'check').mockImplementation(check);
  function verify() {
    expect(loaded).toBe(true);
    expect(accessReadBeforeLoading).toBe(false);
    for (const [subject, , deadline] of reads.mock.calls) {
      expect(subject).not.toMatch(/[* >]/u);
      expect(Number.isFinite(deadline)).toBe(true);
    }
  }
  function restore() {
    reads.mockRestore();
    queries.mockRestore();
    checks.mockRestore();
  }
  return { verify, restore };
}

async function slowRead(route: ReadCase) {
  const realNow = performance.now.bind(performance);
  let elapsed = 0;
  function now() {
    return realNow() + elapsed;
  }
  function delayHistory() {
    elapsed = 2100;
    return Promise.resolve();
  }
  const clock = vi.spyOn(performance, 'now').mockImplementation(now);
  const loading = interceptLoading(route, delayHistory);
  const heads = vi.spyOn(nats.store, 'head');
  try {
    const response = await request(route.url);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject(route.expected);
    expect(response.headers['cache-control']).toBe('no-store');
    loading.verify();
    expect(heads).not.toHaveBeenCalled();
  } finally {
    heads.mockRestore();
    loading.restore();
    clock.mockRestore();
  }
}
it.each(routes)('returns $url after history takes more than two seconds', slowRead);

async function revokeDuringRead(route: ReadCase) {
  let removal: Awaited<ReturnType<typeof append>> | undefined;
  async function revoke() {
    removal = await append('member-admin', 'member.removed', {
      memberId: 'admin', removedBy: 'owner',
    }, false);
  }
  const loading = interceptLoading(route, revoke);
  try {
    const response = await request(route.url);
    expect(removal).toBeDefined();
    expect((await auth.check('admin', 'admin')).allowed).toBe(true);
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ status: 'refused' });
    expect(response.body).not.toContain('Sales');
    expect(response.body).not.toContain('displayName');
    expect(response.headers['cache-control']).toBe('no-store');
    loading.verify();
  } finally {
    loading.restore();
    if (removal) {
      await auth.handler.handle(removal, db);
      await append('member-admin', 'member.joined', { memberId: 'admin', role: 'admin',
        displayName: 'admin', email: 'admin@example.test' });
    }
  }
}
it.each(routes)('denies $url when removal lands during loading, before IAM catches up',
  revokeDuringRead);

async function chatDuringRead(route: ReadCase) {
  async function postMessage() {
    await append('conversation-unrelated', 'message.posted', {
      conversationId: 'unrelated', authorId: 'owner', authorKind: 'human',
      ciphertext: Buffer.from('unrelated chat').toString('base64'),
      keyId: 'key:test', contentType: 'text',
    }, false);
  }
  const loading = interceptLoading(route, postMessage);
  try {
    const response = await request(route.url);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject(route.expected);
    loading.verify();
  } finally {
    loading.restore();
  }
}
it.each(routes)('returns $url while an unrelated chat changes', chatDuringRead);
