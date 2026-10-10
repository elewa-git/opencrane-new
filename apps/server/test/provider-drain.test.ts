import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { encodeSession } from '@opencrane/auth';
import { createStore, memberAuthorisation } from '@opencrane/authz';
import { databases, openfga } from '@opencrane/authz/testing';
import { event, natsFixture } from '@opencrane/event-store/testing';
import { pgDb, providers, ProjectionRunner, rebuildProviderProjection } from '@opencrane/projections';
import { createLogger } from '@opencrane/observability';
import { providerSecretRef } from '@opencrane/models';
import { buildServer } from '../src/server.ts';
import { testAuthConfig } from './support/test-auth-config.ts';
afterEach(vi.restoreAllMocks);
const config = testAuthConfig({ expectedOrgId: 'org-acme' });
let nats: Awaited<ReturnType<typeof natsFixture>>;
let fga: Awaited<ReturnType<typeof openfga>>;
let dbs: Awaited<ReturnType<typeof databases>>;
let binding: Awaited<ReturnType<typeof createStore>>;
let auth: ReturnType<typeof memberAuthorisation>;
let app: ReturnType<typeof buildServer>;
let runner: ProjectionRunner;
let counter = 0;
async function append(subject: string, type: string, data: unknown, apply = true) {
  const record = { ...event(`binding-${++counter}`, subject, type), silo: 'acme', data,
    correlation: {}, principal: { kind: 'human' as const, id: 'owner' } };
  const command = { event: record, expectedSequence: await nats.store.head(subject) };
  expect((await nats.store.append(command)).status).toBe('appended');
  if (apply && auth.handler.eventTypes.includes(type)) {
    await auth.handler.handle(record, pgDb(dbs.queue));
  }
}
async function connection(providerId: string, verified = true, apply = true) {
  const common = { providerId, changedBy: 'owner' };
  await append(`provider-${providerId}`, 'provider.created',
    { ...common, revision: 1, provider: 'openai', name: providerId }, apply);
  await append(`provider-${providerId}`, 'provider.key_saved', { ...common, revision: 2,
    secretRef: providerSecretRef('acme', providerId, `binding-${counter + 1}`) });
  if (verified) {
    await append(`provider-${providerId}`, 'provider.verification_recorded',
      { ...common, revision: 2, kind: 'reachability', attemptId: 'check', outcome: 'pass' });
  }
  await append(`provider-${providerId}`, 'provider.models_selected',
    { ...common, revision: 3, models: ['gpt-6.1-sol'] });
}
async function initialise() {
  nats = await natsFixture();
  fga = await openfga();
  dbs = await databases();
  binding = await createStore(fga.apiUrl, 'acme');
  auth = memberAuthorisation(binding);
  for (const [memberId, role] of [['owner', 'owner'], ['admin', 'admin'], ['bob', 'member']]) {
    await append(`member-${memberId}`, 'member.joined', { memberId, role,
      email: `${memberId}@example.test`, displayName: memberId, invitationId: 'invite' });
  }
  for (const assistantId of ['one', 'two']) {
    await append(`assistant-${assistantId}`, 'assistant.created',
      { assistantId, ownerId: 'bob', kind: 'personal' });
  }
  await connection('primary');
  await connection('secondary');
  await connection('unverified', false);
  await connection('unapplied', true, false);
  function memberId(_silo: string, _issuer: string, sub: string) {
    return Promise.resolve(sub);
  }
  const options = { silo: 'acme', binding, store: nats.store, db: pgDb(dbs.queue),
    feed: { memberId } };
  app = buildServer(config, { providers: options });
  runner = new ProjectionRunner(pgDb(dbs.queue), nats.reader,
    createLogger('provider-drain', { level: 'silent' }));
  await runner.initialise(providers);
}
beforeAll(initialise, 120_000);
async function close() {
  await app?.close();
  await dbs?.close();
  await fga?.close();
  await nats?.close();
}
afterAll(close);
function request(method: 'GET' | 'POST', providerId = 'primary', payload?: unknown,
  sub = 'owner', origin = 'https://app.example.test', orgId = 'org-acme', suffix = 'drain') {
  const session = { sub, orgId, roles: ['owner'], authTime: 1, exp: 2000000000 };
  const cookie = `${config.cookieName}=${encodeSession(config, session)}`;
  const headers = { origin, 'content-type': 'application/json', cookie };
  const options = { method, url: `/api/org/providers/${providerId}/${suffix}`, headers,
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }) };
  return app.inject(options);
}
async function input(action = 'start', overrides: Record<string, unknown> = {}) {
  const response = await request('GET');
  const current = response.json<{ sequence: number }>();
  return {
    commandId: `drain-${++counter}`, action, expectedRevision: 3,
    expectedProviderSequence: await nats.store.head('provider-*'),
    expectedDrainSequence: current.sequence, ...overrides,
  };
}
async function recordsAndRecovers() {
  const command = await input();
  const before = await nats.store.head();
  const saved = await request('POST', 'primary', command);
  expect(saved.statusCode).toBe(200);
  expect(saved.json()).toMatchObject({ operation: 'provider.managed_calls_drain_set' });
  expect(await nats.store.head()).toBe(before + 1);
  const position = await nats.store.head();
  expect((await request('GET')).json()).toMatchObject({ draining: true, enabled: false });
  expect((await request('POST', 'primary', command)).json()).toEqual(saved.json());
  expect((await request('POST', 'primary', command, 'admin')).statusCode).toBe(409);
  const status = await request('GET', 'primary', undefined, 'owner',
    'https://app.example.test', 'org-acme', `changes/${command.commandId}`);
  expect(status.statusCode).toBe(200);
  expect(status.json()).toMatchObject(saved.json());
  expect(await nats.store.head()).toBe(position);
  const changed = { ...command, action: 'cancel' };
  expect((await request('POST', 'primary', changed)).statusCode).toBe(409);
  const cancel = await input('cancel');
  expect((await request('POST', 'primary', cancel, 'admin')).statusCode).toBe(200);
  expect(await nats.store.head()).toBe(position + 1);
  expect((await request('GET')).json()).toMatchObject({ draining: false, enabled: false });
  // Recover the original start without silently starting another drain.
  expect((await request('POST', 'primary', command)).json()).toEqual(saved.json());
  expect((await request('GET')).json()).toMatchObject({ draining: false });
  await runner.run(providers);
  const original = await dbs.queue.query('SELECT * FROM providers');
  const options = { verify: true };
  await rebuildProviderProjection(pgDb(dbs.queue), nats.reader,
    createLogger('provider-drain-replay', { level: 'silent' }), options);
  expect((await dbs.queue.query('SELECT * FROM providers')).rows).toEqual(original.rows);
  expect(await nats.store.head()).toBe(position + 1);
}
it('records one event per drain change and recovers old replies without repeating a change',
  recordsAndRecovers);

async function refuses(overrides: Record<string, unknown>, code: number) {
  const command = await input('start', overrides);
  const before = await nats.store.head();
  expect((await request('POST', 'primary', command)).statusCode).toBe(code);
  expect(await nats.store.head()).toBe(before);
}
it.each([
  [{ expectedRevision: 2 }, 409], [{ expectedProviderSequence: 0 }, 409],
  [{ expectedDrainSequence: 999999 }, 409], [{ action: 'cancel' }, 409],
  [{ action: 'enable' }, 400], [{ silo: 'foreign' }, 400],
] as const)('refuses a stale or invalid drain change %j', refuses);

async function denied(sub: string, origin: string, orgId: string, providerId: string) {
  const command = await input();
  const before = await nats.store.head();
  const response = await request('POST', providerId, command, sub, origin, orgId);
  expect(response.statusCode).toBe(403);
  expect(await nats.store.head()).toBe(before);
}
it.each([
  ['bob', 'https://app.example.test', 'org-acme', 'primary'],
  ['owner', 'https://foreign.test', 'org-acme', 'primary'],
  ['owner', 'https://app.example.test', 'foreign', 'primary'],
  ['owner', 'https://app.example.test', 'org-acme', 'unapplied'],
  ['owner', 'https://app.example.test', 'org-acme', 'foreign'],
])('checks current authority, Origin and the connection receipt', denied);

async function recoversLostAppendReply() {
  const command = await input();
  const before = await nats.store.head();
  const appendOriginal = nats.store.append.bind(nats.store);
  async function loseReply(request: Parameters<typeof appendOriginal>[0]): Promise<never> {
    await appendOriginal(request);
    throw new Error('Test lost append reply');
  }
  const fault = vi.spyOn(nats.store, 'append');
  fault.mockImplementationOnce(loseReply);
  expect((await request('POST', 'primary', command)).statusCode).toBe(503);
  expect(await nats.store.head()).toBe(before + 1);
  expect((await request('POST', 'primary', command)).statusCode).toBe(200);
  expect(await nats.store.head()).toBe(before + 1);
  const cancel = await input('cancel');
  expect((await request('POST', 'primary', cancel)).statusCode).toBe(200);
}
it('recovers a saved drain after the append reply is lost without another append',
  recoversLostAppendReply);

async function concurrentStarts() {
  const primary = await input();
  const secondary = { ...primary, commandId: `drain-${++counter}` };
  const before = await nats.store.head();
  const responses = await Promise.all([
    request('POST', 'primary', primary), request('POST', 'secondary', secondary),
  ]);
  function status(response: (typeof responses)[number]) {
    return response.statusCode;
  }
  const statuses = responses.map(status);
  statuses.sort();
  expect(statuses).toEqual([200, 409]);
  expect(await nats.store.head()).toBe(before + 1);
  const cancel = await input('cancel');
  expect((await request('POST', 'primary', cancel)).statusCode).toBe(200);
}
it('orders concurrent drain starts across different provider connections', concurrentStarts);

async function refusesSilentRollback() {
  const data = { providerId: 'primary', revision: 3, changedBy: 'owner',
    expectedProviderSequence: await nats.store.head('provider-*') };
  await append('provider-primary', 'provider.managed_calls_enabled', data);
  const command = await input();
  const before = await nats.store.head();
  expect((await request('POST', 'primary', command)).statusCode).toBe(403);
  expect(await nats.store.head()).toBe(before);
  expect((await request('GET')).json()).toMatchObject({ enabled: true });
}
it('refuses drain commands after switch-on rather than returning to the deployment key',
  refusesSilentRollback);
