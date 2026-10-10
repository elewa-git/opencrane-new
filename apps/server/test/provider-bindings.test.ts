import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { encodeSession } from '@opencrane/auth';
import { createStore, memberAuthorisation } from '@opencrane/authz';
import { databases, openfga } from '@opencrane/authz/testing';
import { event, natsFixture } from '@opencrane/event-store/testing';
import { pgDb, providers, ProjectionRunner, rebuildProviderProjection, readProviders } from '@opencrane/projections';
import { createLogger } from '@opencrane/observability';
import type { EventEnvelope } from '@opencrane/events';
import { providerDefaultHandler, providerSecretRef } from '@opencrane/models';
import { buildServer } from '../src/server.ts';
import { testAuthConfig } from './support/test-auth-config.ts';
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
    createLogger('bindings', { level: 'silent' }));
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
  sub = 'owner', origin = 'https://app.example.test', orgId = 'org-acme', suffix = 'bindings') {
  const session = { sub, orgId, roles: ['owner'], authTime: 1, exp: 2000000000 };
  const headers = { origin, 'content-type': 'application/json', cookie: `${config.cookieName}=${encodeSession(config, session)}` };
  const options = { method, url: `/api/org/providers/${providerId}/${suffix}`, headers, ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }) };
  return app.inject(options);
}
async function input(overrides: Record<string, unknown> = {}) {
  return { commandId: `select-${++counter}`, expectedProviderSequence:
    await nats.store.head('provider-*'), expectedRevision: 3, kind: 'assistant',
    dependantId: 'one', task: 'chat_turn', expectedBindingSequence: 0,
    action: 'select', model: 'gpt-6.1-sol', ...overrides };
}
async function refusalCase(overrides: Record<string, unknown>, providerId: string, code: number) {
  const before = await nats.store.head();
  const response = await request('POST', providerId, await input(overrides));
  expect(response.statusCode).toBe(code);
  expect(await nats.store.head()).toBe(before);
}
it.each([
  [{ expectedRevision: 2 }, 'primary', 409],
  [{ expectedBindingSequence: 99 }, 'primary', 409],
  [{ expectedProviderSequence: 0 }, 'primary', 409],
  [{ model: 'gpt-6-luna' }, 'primary', 403],
  [{ model: 'made-up' }, 'primary', 403],
  [{ dependantId: 'foreign' }, 'primary', 403],
  [{ kind: 'silo_default', dependantId: 'foreign' }, 'primary', 403],
  [{ kind: 'routine' }, 'primary', 400],
  [{ task: 'other' }, 'primary', 400],
  [{ silo: 'foreign' }, 'primary', 400],
  [{ action: 'pause', model: undefined }, 'primary', 409],
  [{}, 'unverified', 403], [{}, 'unapplied', 403], [{}, 'foreign', 403],
] as const)('refuses unsafe configuration %j on %s', refusalCase);
async function deniedRequest(sub: string, origin: string, orgId: string) {
  const before = await nats.store.head();
  expect((await request('POST', 'primary', await input(), sub, origin, orgId)).statusCode).toBe(403);
  expect((await request('GET', 'primary', undefined, sub, origin, orgId)).statusCode)
    .toBe(sub === 'owner' && orgId === 'org-acme' ? 200 : 403);
  expect(await nats.store.head()).toBe(before);
}
it.each([['bob', 'https://app.example.test', 'org-acme'],
  ['owner', 'https://foreign.test', 'org-acme'],
  ['owner', 'https://app.example.test', 'foreign']])('checks current authority and Origin', deniedRequest);
async function seedsFirstVerified() {
  const trigger: EventEnvelope = { ...event('seed', 'provider-secondary', 'provider.models_selected'),
    silo: 'acme', data: { providerId: 'secondary', revision: 3, changedBy: 'owner',
      models: ['gpt-6.1-sol'] } };
  const handler = providerDefaultHandler(nats.store, binding);
  await handler.handle(trigger, pgDb(dbs.queue));
  const saved = await request('GET');
  expect(saved.json()).toMatchObject({ rows: [{ providerId: 'primary', kind: 'silo_default' }] });
  const position = await nats.store.head();
  await handler.handle(trigger, pgDb(dbs.queue));
  expect(await nats.store.head()).toBe(position);
}
it('records the first verified provider once, even when another provider triggers the reaction', seedsFirstVerified);
async function savesAndReconciles() {
  const dependency = (await request('GET')).json<{ rows: { position: number }[] }>();
  const command = await input({ kind: 'silo_default', dependantId: 'acme',
    expectedBindingSequence: dependency.rows[0]?.position ?? 0 });
  const response = await request('POST', 'primary', command);
  expect(response.statusCode).toBe(200);
  expect((await request('POST', 'primary', command)).json()).toEqual(response.json());
  expect((await request('POST', 'primary', { ...command, model: 'gpt-6-luna' })).statusCode)
    .toBe(409);
  const status = await request('GET', 'primary', undefined, 'owner', undefined, undefined,
    `changes/${command.commandId}`);
  expect(status.json()).toMatchObject({ operation: 'provider.model_binding_set' });
  const dependencies = await request('GET');
  expect(dependencies.json()).toMatchObject({ ordinaryCallsAvailable: false,
    rows: [{ kind: 'silo_default', assistantCount: 2 }], routines: { status: 'absent' } });
  await runner.run(providers);
  const before = await dbs.queue.query('SELECT * FROM model_bindings');
  await rebuildProviderProjection(pgDb(dbs.queue), nats.reader,
    createLogger('binding-replay', { level: 'silent' }), { verify: true });
  expect((await dbs.queue.query('SELECT * FROM model_bindings')).rows).toEqual(before.rows);
}
it('records the first verified default, recovers its original id and replays without calls',
  savesAndReconciles);
async function movesAndPauses() {
  const own = await input();
  const saved = await request('POST', 'primary', own, 'admin');
  expect(saved.statusCode).toBe(200);
  const sequence = saved.json<{ sequence: number }>().sequence;
  await refusalCase({ expectedBindingSequence: sequence }, 'secondary', 409);
  await refusalCase({ expectedBindingSequence: sequence, expectedSourceRevision: 2 }, 'secondary', 409);
  const move = await input({ expectedBindingSequence: sequence, expectedSourceRevision: 3 });
  const moved = await request('POST', 'secondary', move);
  expect(moved.statusCode).toBe(200);
  const pause = await input({ expectedBindingSequence: moved.json<{ sequence: number }>().sequence,
    action: 'pause', model: undefined });
  expect((await request('POST', 'secondary', pause)).statusCode).toBe(200);
  expect((await request('GET')).json()).toMatchObject({ rows: [{ assistantCount: 1 }] });
}
it('checks both revisions on a move and keeps paused assistants out of default counts', movesAndPauses);
async function racesAndExpires() {
  const command = await input({ dependantId: 'two' });
  const appendSpy = vi.spyOn(nats.store, 'append');
  const commands = [request('POST', 'primary', command), request('POST', 'secondary', command)];
  const responses = await Promise.all(commands);
  function status(response: (typeof responses)[number]) { return response.statusCode; }
  const statuses = responses.map(status);
  statuses.sort();
  expect(statuses).toEqual([200, 409]);
  const appended = appendSpy.mock.calls[0]?.[0];
  expect(appended).toMatchObject({ expectedSubject: 'provider-*', historyChecked: true });
  expect(Number.isFinite(appended?.deadline)).toBe(true);
  appendSpy.mockRestore();
  const expiredCommand = await input();
  const clock = vi.spyOn(performance, 'now');
  clock.mockReturnValue(100);
  const head = nats.store.head.bind(nats.store);
  const headSpy = vi.spyOn(nats.store, 'head');
  async function expireAuthority(subject?: string, deadline?: number) {
    const position = await head(subject, deadline);
    if (subject === undefined) clock.mockReturnValue(3000);
    return position;
  }
  headSpy.mockImplementation(expireAuthority);
  expect((await request('POST', 'primary', expiredCommand)).statusCode).toBe(503);
  headSpy.mockRestore();
  clock.mockRestore();
}
it('orders concurrent choices and refuses an expired authority check', racesAndExpires);
async function hidesAfterRemoval() {
  await append('member-admin', 'member.removed', { memberId: 'admin', removedBy: 'owner' }, false);
  await deniedRequest('admin', 'https://app.example.test', 'org-acme');
}
it('refuses a departed admin even before IAM catches up', hidesAfterRemoval);

async function routineGaps() {
  const read = nats.store.readStream.bind(nats.store);
  const spy = vi.spyOn(nats.store, 'readStream');
  function fails(subject: string, from?: number, deadline?: number) {
    if (subject === 'routine-*') throw new Error('reader failed');
    return read(subject, from, deadline);
  }
  spy.mockImplementation(fails);
  expect((await request('GET')).statusCode).toBe(503);
  spy.mockRestore();
  await append('routine-old', 'routine.paused', { routineId: 'old', pausedBy: 'owner' });
  expect((await request('GET')).json()).toMatchObject({ routines: { status: 'unsupported' } });
  async function* lags(subject: string, from?: number, deadline?: number) {
    if (subject !== 'routine-*') yield* read(subject, from, deadline);
  }
  vi.spyOn(nats.store, 'readStream').mockImplementation(lags);
  expect((await request('GET')).statusCode).toBe(503);
  vi.restoreAllMocks();
}
it('reports reader failure and legacy routine history without invented counts', routineGaps);


async function replaysRecordedSwitchOn() {
  const db = pgDb(dbs.queue);
  await runner.run(providers);
  const before = (await readProviders(db, 'acme', 'primary'))[0];
  if (!before) throw new Error('Missing fixture provider');
  const expectedProviderSequence = await nats.store.head('provider-*');
  await append('budget-acme', 'provider.managed_calls_enabled', {
    providerId: 'primary', revision: before.revision, changedBy: 'owner', expectedProviderSequence,
  });
  await runner.run(providers);
  const saved = await readProviders(db, 'acme', 'primary');
  expect(saved[0]).toMatchObject({
    ...before, position: await nats.store.head('provider-primary'), managedCallsEnabled: true,
  });
  const logger = createLogger('switch-replay', { level: 'silent' });
  await rebuildProviderProjection(db, nats.reader, logger, { verify: true });
  expect(await readProviders(db, 'acme', 'primary')).toEqual(saved);
}
it('rebuilds the recorded switch-on without changing keys, models or verification',
  replaysRecordedSwitchOn);
