import { afterAll, beforeAll, expect, it } from 'vitest';
import { encodeSession } from '@opencrane/auth';
import { createStore, grantStream, memberAuthorisation } from '@opencrane/authz';
import { databases, openfga } from '@opencrane/authz/testing';
import { event, natsFixture } from '@opencrane/event-store/testing';
import { createLogger } from '@opencrane/observability';
import { history } from '@opencrane/models';
import { members, pgDb, ProjectionRunner } from '@opencrane/projections';
import { buildServer } from '../src/server.ts';
import { testAuthConfig } from './support/test-auth-config.ts';

const config = testAuthConfig({ expectedOrgId: 'org-acme' });
const subject = grantStream('mcp_server', 'fixture');
const path = '/api/org/integrations/fixture/access/changes';
let nats: Awaited<ReturnType<typeof natsFixture>>;
let fga: Awaited<ReturnType<typeof openfga>>;
let dbs: Awaited<ReturnType<typeof databases>>;
let app: ReturnType<typeof buildServer>;
let auth: ReturnType<typeof memberAuthorisation>;
let database: ReturnType<typeof pgDb>;
let runner: ProjectionRunner;
let counter = 0;

async function append(stream: string, type: string, data: unknown, silo = 'acme') {
  const record = { ...event(`access-fixture-${++counter}`, stream, type), silo, data };
  const expectedSequence = await nats.store.head(stream);
  const result = await nats.store.append({ event: record, expectedSequence });
  expect(result.status).toBe('appended');
  if (silo === 'acme' && auth.handler.eventTypes.includes(type)) {
    await auth.handler.handle(record, database);
  }
}

function memberId(_silo: string, _issuer: string, sub: string) {
  return Promise.resolve(sub);
}

async function initialise() {
  nats = await natsFixture();
  fga = await openfga();
  dbs = await databases();
  database = pgDb(dbs.queue);
  const binding = await createStore(fga.apiUrl, 'acme');
  auth = memberAuthorisation(binding);
  runner = new ProjectionRunner(database, nats.reader,
    createLogger('integration-access-test', { level: 'silent' }));
  await runner.initialise(members);
  for (const [id, role] of [['owner', 'owner'], ['bob', 'member'], ['admin', 'admin']]) {
    await append(`member-${id}`, 'member.joined', {
      memberId: id, role, email: `${id}@example.test`,
      displayName: id, invitationId: `invite-${id}`,
    });
  }
  await append('team-sales', 'team.created', {
    teamId: 'sales', name: 'Sales', createdBy: 'owner',
  });
  await append('assistant-helper', 'assistant.created', {
    assistantId: 'helper', kind: 'personal', ownerId: 'bob',
  });
  await append('mcp-fixture', 'mcp.server_registered', {
    serverId: 'fixture', kind: 'remote', locator: 'https://fixture.example.test/mcp',
    registeredBy: 'owner',
  });
  const modelAccess = { silo: 'acme', store: nats.store, db: database, binding,
    feed: { memberId } };
  app = buildServer(config, { modelAccess });
}

async function close() {
  await app?.close();
  await dbs?.close();
  await fga?.close();
  await nats?.close();
}
beforeAll(initialise, 120_000);
afterAll(close);

function headers(actor = 'owner', origin = 'https://app.example.test') {
  const session = { sub: actor, orgId: 'org-acme', roles: [],
    authTime: 1790856000, exp: 2000000000 };
  return { origin, cookie: `${config.cookieName}=${encodeSession(config, session)}` };
}

async function command(granteeKind = 'member', granteeId = 'bob', action = 'grant') {
  return { commandId: `change-${++counter}`, expectedSequence: await nats.store.head(subject),
    granteeKind, granteeId, action };
}

function post(payload: unknown, actor = 'owner', origin = 'https://app.example.test',
  url = path) {
  return app.inject({ method: 'POST', url, headers: headers(actor, origin), payload });
}

function get(commandId: string, actor = 'owner') {
  return app.inject({ method: 'GET', url: `${path}/${commandId}`, headers: headers(actor) });
}

async function savesOneGrantAndOriginalReceipt() {
  for (const [kind, id] of [['member', 'bob'], ['team', 'sales'], ['assistant', 'helper']]) {
    const input = await command(kind, id);
    const saved = await post(input);
    expect(saved.statusCode, saved.body).toBe(200);
    const rows = await history(nats.store, subject, 'acme');
    const original = rows.at(-1)!;
    const receipt = { status: 'appended', serverId: 'fixture', commandId: input.commandId,
      operation: 'grant.given', sequence: original.sequence, changeId: original.event.id };
    expect(saved.json()).toEqual(receipt);
    expect(original.event.data).toEqual({ resourceType: 'mcp_server', resourceId: 'fixture',
      granteeKind: kind, granteeId: id, grantedBy: 'owner' });
    expect((await post(input)).json()).toEqual(receipt);
    expect((await get(input.commandId)).json()).toMatchObject({
      ...receipt, projection: { content: 'applying', iam: 'applying' },
    });
    await runner.run(members);
    await auth.handler.handle(original.event, database);
    expect((await get(input.commandId)).json()).toEqual({
      ...receipt, currentSequence: original.sequence,
      projection: { content: 'current', iam: 'current' },
    });
    expect(await nats.store.head(subject)).toBe(original.sequence);
  }
}
it('saves one typed grant and returns its original receipt and separate progress',
  savesOneGrantAndOriginalReceipt);
