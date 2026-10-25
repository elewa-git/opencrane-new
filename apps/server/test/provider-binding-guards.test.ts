import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { encodeSession } from '@opencrane/auth';
import { createStore, memberAuthorisation, deleteStoreById } from '@opencrane/authz';
import * as authorisation from '@opencrane/authz';
import { databases, openfga } from '@opencrane/authz/testing';
import { event, natsFixture } from '@opencrane/event-store/testing';
import type { AppendCommand, AppendResult } from '@opencrane/event-store';
import { parseEventByType, type EventEnvelope } from '@opencrane/events';
import { applyProvider, pgDb, providers, routines, ProjectionRunner,
  rebuildProviderProjection } from '@opencrane/projections';
import { createLogger } from '@opencrane/observability';
import { providerDefaultHandler, providerHistory, providerSecretRef } from '@opencrane/models';
import { buildServer } from '../src/server.ts';
import { testAuthConfig } from './support/test-auth-config.ts';

const configOptions = { expectedOrgId: 'org-acme' };
const config = testAuthConfig(configOptions);
const loggerOptions = { level: 'silent' as const };
let nats: Awaited<ReturnType<typeof natsFixture>>;
let fga: Awaited<ReturnType<typeof openfga>>;
let dbs: Awaited<ReturnType<typeof databases>>;
let binding: Awaited<ReturnType<typeof createStore>>;
let auth: ReturnType<typeof memberAuthorisation>;
let app: ReturnType<typeof buildServer>;
let counter = 0;

async function services() {
  fga = await openfga();
  dbs = await databases();
}
beforeAll(services, 120_000);
async function closeServices() {
  await dbs?.close();
  await fga?.close();
}
afterAll(closeServices);

async function append(subject: string, type: string, data: unknown,
  commandId = `guard-${++counter}`, apply = true) {
  const record = { ...event(commandId, subject, type), commandId, silo: 'acme', data,
    correlation: {}, principal: { kind: 'human' as const, id: 'owner' } };
  const command = { event: record, expectedSequence: await nats.store.head(subject) };
  expect((await nats.store.append(command)).status).toBe('appended');
  if (apply && auth.handler.eventTypes.includes(type)) {
    await auth.handler.handle(record, pgDb(dbs.queue));
  }
  return record;
}
async function connection(providerId: string, enabled = ['gpt-6.1-sol'],
  provider = 'openai', createCommand?: string) {
  const common = { providerId, changedBy: 'owner' };
  const creation = { ...common, revision: 1, provider, name: providerId };
  const created = await append(`provider-${providerId}`, 'provider.created', creation, createCommand);
  const keyCommand = `key-${++counter}`;
  const key = { ...common, revision: 2,
    secretRef: providerSecretRef('acme', providerId, keyCommand) };
  await append(`provider-${providerId}`, 'provider.key_saved', key, keyCommand);
  const verification = { ...common, revision: 2, kind: 'reachability',
    attemptId: 'check', outcome: 'pass' };
  await append(`provider-${providerId}`, 'provider.verification_recorded', verification);
  const selection = { ...common, revision: 3, models: enabled };
  const trigger = await append(`provider-${providerId}`, 'provider.models_selected', selection);
  return { created, trigger };
}
async function initialise() {
  nats = await natsFixture();
  binding = await createStore(fga.apiUrl, 'acme');
  auth = memberAuthorisation(binding);
  for (const memberId of ['owner', 'admin']) {
    const role = memberId === 'owner' ? 'owner' : 'admin';
    const membership = { memberId, role, email: `${memberId}@example.test`,
      displayName: memberId, invitationId: 'invite' };
    await append(`member-${memberId}`, 'member.joined', membership);
  }
  for (const assistantId of ['one', 'two']) {
    const creation = { assistantId, ownerId: 'owner', kind: 'personal' };
    await append(`assistant-${assistantId}`, 'assistant.created', creation);
  }
  function memberId(_silo: string, _issuer: string, sub: string) {
    return Promise.resolve(sub);
  }
  const options = { silo: 'acme', binding, store: nats.store, db: pgDb(dbs.queue),
    feed: { memberId } };
  const serverOptions = { providers: options };
  app = buildServer(config, serverOptions);
  const runner = new ProjectionRunner(pgDb(dbs.queue), nats.reader,
    createLogger('binding-guards-setup', loggerOptions));
  await runner.initialise(providers);
  await runner.initialise(routines);
}
beforeEach(initialise, 30_000);
async function closeFixture() {
  vi.restoreAllMocks();
  await app?.close();
  await deleteStoreById(fga.apiUrl, binding.storeId);
  await nats?.close();
}
afterEach(closeFixture);
function request(method: 'GET' | 'POST', providerId: string, payload?: unknown,
  sub = 'owner', suffix = 'bindings') {
  const session = { sub, orgId: 'org-acme', roles: ['owner'], authTime: 1, exp: 2000000000 };
  const headers = { origin: 'https://app.example.test', 'content-type': 'application/json',
    cookie: `${config.cookieName}=${encodeSession(config, session)}` };
  let url = `/api/org/providers/${providerId}/${suffix}`;
  if (suffix === 'configuration') {
    url = '/api/org/providers';
  }
  const options = { method, url, headers,
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }) };
  return app.inject(options);
}
async function input(overrides: Record<string, unknown> = {}) {
  return { commandId: `select-${++counter}`,
    expectedProviderSequence: await nats.store.head('provider-*'), expectedRevision: 3,
    kind: 'assistant', dependantId: 'one', task: 'chat_turn', expectedBindingSequence: 0,
    action: 'select', model: 'gpt-6.1-sol', ...overrides };
}
async function storedBindings(providerId: string) {
  const rows = [];
  for await (const row of nats.store.readStream(`provider-${providerId}`)) {
    if (row.event.type === 'provider.model_binding_set') {
      rows.push(row);
    }
  }
  return rows;
}
async function refused(providerId: string, command: unknown, code = 403) {
  const before = await nats.store.head();
  const response = await request('POST', providerId, command);
  expect(response.statusCode).toBe(code);
  expect(await nats.store.head()).toBe(before);
}

async function concurrentRetries(changed: boolean) {
  await connection('primary');
  const first = await input();
  const second = { ...first, dependantId: changed ? 'two' : 'one' };
  const appendOriginal = nats.store.append.bind(nats.store);
  let arrivals = 0;
  const barrier = Promise.withResolvers<void>();
  async function waitForBoth(command: AppendCommand) {
    arrivals++;
    if (arrivals === 2) {
      barrier.resolve();
    }
    await barrier.promise;
    return appendOriginal(command);
  }
  const spy = vi.spyOn(nats.store, 'append');
  spy.mockImplementation(waitForBoth);
  const pending = [request('POST', 'primary', first), request('POST', 'primary', second)];
  const responses = await Promise.all(pending);
  spy.mockRestore();
  function status(response: (typeof responses)[number]) {
    return response.statusCode;
  }
  const statuses = responses.map(status);
  statuses.sort();
  expect(statuses).toEqual(changed ? [200, 409] : [200, 200]);
  const saved = await storedBindings('primary');
  expect(saved).toHaveLength(1);
  const row = saved[0]!;
  for (const response of responses) {
    if (response.statusCode === 200) {
      const receipt = { changeId: row.event.id, sequence: row.sequence };
      expect(response.json()).toMatchObject(receipt);
    }
  }
  if (!changed) {
    expect(responses[0]?.json()).toEqual(responses[1]?.json());
  }
}
async function identicalRetries() {
  await concurrentRetries(false);
}
async function changedRetries() {
  await concurrentRetries(true);
}
it('returns the saved event for concurrent identical retries behind an append barrier', identicalRetries);
it('refuses changed dependants using the same command id behind an append barrier', changedRetries);
async function mixedOperations(configurationFirst: boolean) {
  await connection('primary');
  const bindingCommand = await input();
  const configurationCommand = { action: 'models', providerId: 'primary',
    commandId: bindingCommand.commandId, expectedRevision: 3, models: ['gpt-6-luna'] };
  const appendOriginal = nats.store.append.bind(nats.store);
  const bothReady = Promise.withResolvers<void>();
  const firstSaved = Promise.withResolvers<void>();
  let arrivals = 0;
  async function saveInOrder(command: AppendCommand) {
    arrivals++;
    if (arrivals === 2) {
      bothReady.resolve();
    }
    await bothReady.promise;
    const parsed = parseEventByType(command.event);
    if (!parsed.success) {
      throw new Error('Invalid test append');
    }
    const isConfiguration = parsed.event.type === 'provider.models_selected';
    if (isConfiguration !== configurationFirst) {
      await firstSaved.promise;
      return appendOriginal(command);
    }
    const result = await appendOriginal(command);
    firstSaved.resolve();
    return result;
  }
  const spy = vi.spyOn(nats.store, 'append');
  spy.mockImplementation(saveInOrder);
  const pending = [request('POST', 'primary', bindingCommand),
    request('POST', 'primary', configurationCommand, 'owner', 'configuration')];
  const responses = await Promise.all(pending);
  spy.mockRestore();
  const expectedStatuses = configurationFirst ? [409, 200] : [200, 409];
  expect(arrivals).toBe(2);
  expect(responses[0]!.statusCode).toBe(expectedStatuses[0]);
  expect(responses[1]!.statusCode).toBe(expectedStatuses[1]);
  const current = await providerHistory(nats.store, 'acme', 'primary');
  function matchesCommand(row: (typeof current.rows)[number]) {
    return row.event.commandId === bindingCommand.commandId;
  }
  const saved = current.rows.filter(matchesCommand);
  expect(saved).toHaveLength(1);
  const row = saved[0]!;
  const receipt = { changeId: row.event.id, sequence: row.sequence,
    operation: row.event.type };
  const successfulResponse = configurationFirst ? responses[1]! : responses[0]!;
  expect(successfulResponse.json()).toMatchObject(receipt);
  const suffix = `changes/${bindingCommand.commandId}`;
  const status = await request('GET', 'primary', undefined, 'owner', suffix);
  expect(status.statusCode).toBe(200);
  expect(status.json()).toMatchObject(receipt);
  if (configurationFirst) {
    expect(current.state).toMatchObject({ revision: 4, enabledModels: ['gpt-6-luna'] });
    expect(await storedBindings('primary')).toHaveLength(0);
  } else {
    expect(current.state).toMatchObject({ revision: 3, enabledModels: ['gpt-6.1-sol'] });
    expect(await storedBindings('primary')).toHaveLength(1);
  }
  expect((await request('POST', 'primary', bindingCommand)).statusCode)
    .toBe(expectedStatuses[0]);
  expect((await request('POST', 'primary', configurationCommand, 'owner', 'configuration'))
    .statusCode).toBe(expectedStatuses[1]);
  expect(await nats.store.head('provider-primary')).toBe(row.sequence);
}
it.each([false, true])('recovers the real saved operation when configuration saves first: %s',
  mixedOperations);

async function actorReuse() {
  await connection('primary');
  const command = await input();
  const saved = await request('POST', 'primary', command);
  expect(saved.statusCode).toBe(200);
  const before = await nats.store.head();
  const overrides = { commandId: command.commandId,
    expectedBindingSequence: saved.json<{ sequence: number }>().sequence };
  const reused = await input(overrides);
  expect((await request('POST', 'primary', reused, 'admin')).statusCode).toBe(409);
  expect(await nats.store.head()).toBe(before);
  const status = await request('GET', 'primary', undefined, 'admin', `changes/${command.commandId}`);
  expect(status.statusCode).toBe(200);
  expect(status.json()).toMatchObject(saved.json());
}
it('refuses another administrator reusing a saved command id', actorReuse);
async function internalIdentity() {
  const { trigger } = await connection('primary', undefined, undefined, 'initial-default');
  const handler = providerDefaultHandler(nats.store, binding);
  await handler.handle(trigger, pgDb(dbs.queue));
  const saved = await storedBindings('primary');
  expect(saved).toHaveLength(1);
  const reservedId = saved[0]!.event.commandId;
  const overrides = { commandId: reservedId };
  const command = await input(overrides);
  await refused('primary', command, 400);
  const before = await nats.store.head();
  await handler.handle(trigger, pgDb(dbs.queue));
  expect(await nats.store.head()).toBe(before);
}
it('records an automatic default after a human used initial-default and reserves its id', internalIdentity);
async function explicitInitialDefault() {
  await connection('first', ['gpt-6-luna']);
  const { trigger } = await connection('second');
  await providerDefaultHandler(nats.store, binding).handle(trigger, pgDb(dbs.queue));
  expect(await storedBindings('first')).toHaveLength(0);
  expect(await storedBindings('second')).toHaveLength(0);
  const overrides = { kind: 'silo_default', dependantId: 'acme' };
  const command = await input(overrides);
  expect((await request('POST', 'second', command)).statusCode).toBe(200);
  const before = await nats.store.head();
  await providerDefaultHandler(nats.store, binding).handle(trigger, pgDb(dbs.queue));
  expect(await nats.store.head()).toBe(before);
}
it('allows an explicit initial default on a later verified provider with the enabled chat model',
  explicitInitialDefault);

function objectId(type: string, ...ids: string[]) {
  const identity = JSON.stringify(['acme', ...ids]);
  const bytes = Buffer.from(identity);
  const encoded = bytes.toString('base64url');
  return `${type}:${encoded}`;
}
async function removeTuple(user: string, relation: string, object: string) {
  const tuple = { user, relation, object };
  const body = { deletes: { tuple_keys: [tuple] } };
  const options = { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body) };
  const response = await fetch(`${binding.apiUrl}/stores/${binding.storeId}/write`, options);
  expect(response.status).toBe(200);
}
async function removeManage(providerId: string) {
  const silo = objectId('silo');
  await removeTuple(silo, 'silo', objectId('provider', providerId));
  expect((await auth.provider('owner', providerId, 'manage')).allowed).toBe(false);
  expect((await auth.check('owner', 'admin')).allowed).toBe(true);
}
async function sourceGuard(receipt: boolean) {
  const source = await connection('source');
  await connection('target');
  const saved = await request('POST', 'source', await input());
  expect(saved.statusCode).toBe(200);
  if (receipt) {
    const silo = objectId('silo');
    await removeTuple(silo, 'applied', objectId('projection_event', source.created.id));
    expect(await auth.applied(source.created.id)).toBe(false);
    expect((await auth.provider('owner', 'source', 'manage')).allowed).toBe(true);
  } else {
    await removeManage('source');
    expect(await auth.applied(source.created.id)).toBe(true);
  }
  expect((await auth.provider('owner', 'target', 'manage')).allowed).toBe(true);
  const overrides = { expectedSourceRevision: 3,
    expectedBindingSequence: saved.json<{ sequence: number }>().sequence };
  const move = await input(overrides);
  await refused('target', move);
}
async function sourceManage() {
  await sourceGuard(false);
}
async function sourceReceipt() {
  await sourceGuard(true);
}
it('checks source management separately from target management on a move', sourceManage);
it('checks the source creation receipt even when source management allows a move', sourceReceipt);
async function targetManage() {
  const target = await connection('target');
  await removeManage('target');
  expect(await auth.applied(target.created.id)).toBe(true);
  await refused('target', await input());
}
it('checks target management even when its creation receipt is applied', targetManage);

async function wrongKey(commandMismatch: boolean) {
  await connection('primary');
  const commandId = 'replacement-key';
  let referenceCommand = commandId;
  let silo = 'foreign';
  if (commandMismatch) {
    referenceCommand = 'older-key';
    silo = 'acme';
  }
  const common = { providerId: 'primary', changedBy: 'owner', revision: 4 };
  const key = { ...common, secretRef: providerSecretRef(silo, 'primary', referenceCommand) };
  await append('provider-primary', 'provider.key_saved', key, commandId);
  const verification = { ...common, kind: 'reachability', attemptId: 'new-check', outcome: 'pass' };
  await append('provider-primary', 'provider.verification_recorded', verification);
  const overrides = { expectedRevision: 4 };
  await refused('primary', await input(overrides));
}
async function foreignKey() {
  await wrongKey(false);
}
async function oldKeyCommand() {
  await wrongKey(true);
}
it('refuses a key reference belonging to another silo with current verification', foreignKey);
it('refuses a key reference that disagrees with the last key command', oldKeyCommand);
async function unsupportedModel(model: string) {
  await connection('primary', [model]);
  const overrides = { model };
  await refused('primary', await input(overrides));
}
it.each(['made-up', 'gpt-5-nano'])('refuses enabled unknown or retired registry model %s',
  unsupportedModel);
async function providerKind() {
  await connection('primary', undefined, 'anthropic');
  await refused('primary', await input());
}
it('refuses an unsupported provider kind with an enabled registry model', providerKind);
async function wrongPauseProvider() {
  await connection('source');
  await connection('target');
  const saved = await request('POST', 'source', await input());
  expect(saved.statusCode).toBe(200);
  const overrides = { action: 'pause', model: undefined, expectedSourceRevision: 3,
    expectedBindingSequence: saved.json<{ sequence: number }>().sequence };
  const command = await input(overrides);
  await refused('target', command, 409);
}
it('refuses a pause naming a different provider even with both revisions correct', wrongPauseProvider);

async function finalAuthority(expired: boolean, retry = false) {
  await connection('primary');
  const command = await input();
  if (retry) {
    expect((await request('POST', 'primary', command)).statusCode).toBe(200);
  }
  const appendSpy = vi.spyOn(nats.store, 'append');
  const clock = vi.spyOn(performance, 'now');
  clock.mockReturnValue(100);
  const original = authorisation.memberAuthorisation;
  function interruptAfterManage(currentBinding: authorisation.Binding) {
    const permissions = original(currentBinding);
    async function provider(memberId: string, providerId: string, relation: 'read' | 'manage') {
      const result = await permissions.provider(memberId, providerId, relation);
      if (expired) {
        clock.mockReturnValue(2200);
      } else {
        const removal = { memberId: 'owner', removedBy: 'admin' };
        await append('member-owner', 'member.removed', removal, undefined, false);
      }
      return result;
    }
    return { ...permissions, provider };
  }
  const authoritySpy = vi.spyOn(authorisation, 'memberAuthorisation');
  authoritySpy.mockImplementation(interruptAfterManage);
  expect((await request('POST', 'primary', command)).statusCode).toBe(503);
  expect(await storedBindings('primary')).toHaveLength(retry ? 1 : 0);
  if (expired || retry) {
    function bindingAppend(call: [AppendCommand]) {
      const parsed = parseEventByType(call[0].event);
      return parsed.success && parsed.event.type === 'provider.model_binding_set';
    }
    expect(appendSpy.mock.calls.filter(bindingAppend)).toHaveLength(0);
  }
}
async function finalExpiry() {
  await finalAuthority(true);
}
async function finalRevocation() {
  await finalAuthority(false);
}
it('rechecks authority expiry after provider permission and before append', finalExpiry);
it('rechecks authority after revocation following provider permission', finalRevocation);
async function retryAuthority(expired: boolean) {
  await finalAuthority(expired, true);
}
it.each([false, true])('rechecks authority on an identical retry when expired: %s', retryAuthority);

async function failedAppend(status: 'unavailable' | 'rejected') {
  await connection('primary');
  const command = await input();
  const before = await nats.store.head();
  const result: AppendResult = status === 'unavailable'
    ? { status: 'unavailable', cause: new Error('Test append unavailable') }
    : { status: 'rejected', reason: 'invalid_event' };
  const spy = vi.spyOn(nats.store, 'append');
  spy.mockResolvedValue(result);
  expect((await request('POST', 'primary', command)).statusCode).toBe(503);
  expect(await nats.store.head()).toBe(before);
  expect(await storedBindings('primary')).toHaveLength(0);
}
it.each(['unavailable', 'rejected'] as const)('refuses a binding append that is %s', failedAppend);

type SavedFault = 'missing' | 'silo' | 'subject' | 'command id' |
  'principal kind' | 'principal id' | 'event type';
function changeSavedEnvelope(record: EventEnvelope, fault: SavedFault): EventEnvelope {
  switch (fault) {
    case 'silo':
      return { ...record, silo: 'foreign' };
    case 'subject':
      return { ...record, subject: 'provider-foreign' };
    case 'command id':
      return { ...record, commandId: 'foreign' };
    case 'principal kind':
      return { ...record, principal: { kind: 'agent', id: 'owner' } };
    case 'principal id':
      return { ...record, principal: { kind: 'human', id: 'admin' } };
    case 'event type':
      return { ...record, type: 'provider.models_selected' };
    case 'missing':
      return record;
  }
}
async function savedEnvelope(fault: SavedFault) {
  await connection('primary');
  const command = await input();
  const readOriginal = nats.store.readStream.bind(nats.store);
  async function* incorrectSavedEvent(subject: string, from?: number, deadline?: number) {
    for await (const row of readOriginal(subject, from, deadline)) {
      if (subject === 'provider-primary' && from === row.sequence &&
        row.event.type === 'provider.model_binding_set') {
        if (fault !== 'missing') {
          const changed = { ...row, event: changeSavedEnvelope(row.event, fault) };
          yield changed;
        }
        return;
      }
      yield row;
    }
  }
  const spy = vi.spyOn(nats.store, 'readStream');
  spy.mockImplementation(incorrectSavedEvent);
  const response = await request('POST', 'primary', command);
  expect(response.statusCode).toBe(fault === 'missing' ? 503 : 409);
  spy.mockRestore();
  expect(await storedBindings('primary')).toHaveLength(1);
  const status = await request('GET', 'primary', undefined, 'owner', `changes/${command.commandId}`);
  expect(status.statusCode).toBe(200);
}
it.each(['missing', 'silo', 'subject', 'command id', 'principal kind', 'principal id',
  'event type'] as const)('refuses a binding receipt with an incorrect saved %s', savedEnvelope);

async function historyOrder() {
  await connection('primary');
  const command = await input();
  const readOriginal = nats.store.readStream.bind(nats.store);
  const headOriginal = nats.store.head.bind(nats.store);
  const clock = vi.spyOn(performance, 'now');
  clock.mockReturnValue(100);
  let authorityStarted = false;
  async function head(subject?: string, deadline?: number) {
    if (subject === undefined) {
      authorityStarted = true;
    }
    return headOriginal(subject, deadline);
  }
  async function* slowHistory(subject: string, from?: number, deadline?: number) {
    if (subject === 'provider-*' || subject === 'assistant-one') {
      expect(authorityStarted).toBe(false);
      clock.mockReturnValue(performance.now() + 2500);
    }
    yield* readOriginal(subject, from, deadline);
  }
  const headSpy = vi.spyOn(nats.store, 'head');
  headSpy.mockImplementation(head);
  const readSpy = vi.spyOn(nats.store, 'readStream');
  readSpy.mockImplementation(slowHistory);
  expect((await request('POST', 'primary', command)).statusCode).toBe(200);
}
it('finishes slow provider and assistant histories before starting the access deadline', historyOrder);

async function reactionSilo() {
  const { trigger } = await connection('primary');
  const foreign = { ...trigger, silo: 'foreign' };
  const before = await nats.store.head();
  await expect(providerDefaultHandler(nats.store, binding).handle(foreign, pgDb(dbs.queue)))
    .rejects.toThrow();
  expect(await nats.store.head()).toBe(before);
}
it('refuses a default reaction triggered by another silo', reactionSilo);
async function reactionEnabled() {
  const { trigger } = await connection('first', ['gpt-6-luna']);
  const handler = providerDefaultHandler(nats.store, binding);
  const before = await nats.store.head();
  await handler.handle(trigger, pgDb(dbs.queue));
  expect(await nats.store.head()).toBe(before);
  const selection = { providerId: 'first', changedBy: 'owner', revision: 4,
    models: ['gpt-6.1-sol'] };
  const enabled = await append('provider-first', 'provider.models_selected', selection);
  await handler.handle(enabled, pgDb(dbs.queue));
  expect(await storedBindings('first')).toHaveLength(1);
}
it('waits for the first verified provider to enable the chat model', reactionEnabled);
async function pausedReplay() {
  const { trigger } = await connection('primary');
  const selectedOverrides = { kind: 'silo_default', dependantId: 'acme' };
  const selected = await input(selectedOverrides);
  const saved = await request('POST', 'primary', selected);
  expect(saved.statusCode).toBe(200);
  const pauseOverrides = { kind: 'silo_default', dependantId: 'acme', action: 'pause',
    model: undefined, expectedBindingSequence: saved.json<{ sequence: number }>().sequence };
  const pause = await input(pauseOverrides);
  expect((await request('POST', 'primary', pause)).statusCode).toBe(200);
  const before = await nats.store.head();
  await providerDefaultHandler(nats.store, binding).handle(trigger, pgDb(dbs.queue));
  expect(await nats.store.head()).toBe(before);
  const runner = new ProjectionRunner(pgDb(dbs.queue), nats.reader,
    createLogger('binding-guards', loggerOptions));
  await runner.initialise(providers);
  await runner.run(providers);
  const original = await dbs.queue.query('SELECT * FROM model_bindings');
  expect(original.rows).toHaveLength(1);
  expect(original.rows[0]).toMatchObject({ state: { state: 'paused' } });
  const replayOptions = { verify: true };
  await rebuildProviderProjection(pgDb(dbs.queue), nats.reader,
    createLogger('binding-guards-replay', loggerOptions), replayOptions);
  expect((await dbs.queue.query('SELECT * FROM model_bindings')).rows).toEqual(original.rows);
  expect(await nats.store.head()).toBe(before);
}
it('preserves a paused default through reaction redelivery and provider rebuild', pausedReplay);
async function historyLag() {
  await connection('primary');
  const healthy = await request('GET', 'primary');
  expect(healthy.statusCode).toBe(200);
  expect(healthy.json()).toMatchObject({ routines: { status: 'absent', position: 0 } });
  const readOriginal = nats.store.readStream.bind(nats.store);
  async function* lag(subject: string, from?: number, deadline?: number) {
    if (subject !== 'assistant-*') {
      yield* readOriginal(subject, from, deadline);
    }
  }
  const readSpy = vi.spyOn(nats.store, 'readStream');
  readSpy.mockImplementation(lag);
  expect((await request('GET', 'primary')).statusCode).toBe(503);
}
it('refuses assistant history behind its checked position', historyLag);
async function historyChanges(subjectToChange: string) {
  await connection('primary');
  const healthy = await request('GET', 'primary');
  expect(healthy.statusCode).toBe(200);
  expect(healthy.json()).toMatchObject({ routines: { status: 'absent', position: 0 } });
  const readOriginal = nats.store.readStream.bind(nats.store);
  async function* change(subject: string, from?: number, deadline?: number) {
    yield* readOriginal(subject, from, deadline);
    if (subject === subjectToChange) {
      if (subject === 'assistant-*') {
        const creation = { assistantId: 'new', ownerId: 'owner', kind: 'personal' };
        await append('assistant-new', 'assistant.created', creation);
      } else {
        await connection('new');
      }
    }
  }
  const readSpy = vi.spyOn(nats.store, 'readStream');
  readSpy.mockImplementation(change);
  expect((await request('GET', 'primary')).statusCode).toBe(503);
}
it.each(['assistant-*', 'provider-*'])('refuses dependency history changing during %s reads',
  historyChanges);
async function lostStatusAuthority() {
  await connection('primary');
  const command = await input();
  expect((await request('POST', 'primary', command, 'admin')).statusCode).toBe(200);
  const suffix = `changes/${command.commandId}`;
  expect((await request('GET', 'primary', undefined, 'admin', suffix)).statusCode).toBe(200);
  const roleChange = { memberId: 'admin', previousRole: 'admin',
    newRole: 'member', changedBy: 'owner' };
  await append('member-admin', 'member.role_changed', roleChange, undefined, false);
  expect((await request('GET', 'primary', undefined, 'admin', suffix)).statusCode).toBe(403);
}
it('checks current authority on binding status reads after an administrator loses their role',
  lostStatusAuthority);
async function foldRevision() {
  const { created } = await connection('primary');
  let state = applyProvider(undefined, created, 1);
  for await (const row of nats.store.readStream('provider-primary')) {
    if (row.event.id !== created.id) {
      state = applyProvider(state, row.event, row.sequence);
    }
  }
  const data = { providerId: 'primary', changedBy: 'owner', revision: 2, kind: 'assistant',
    dependantId: 'one', task: 'chat_turn', state: 'active', model: 'gpt-6.1-sol',
    expectedProviderSequence: state.position, previousBindingSequence: 0 };
  const record: EventEnvelope = { ...event('bad-revision', 'provider-primary',
    'provider.model_binding_set'), silo: 'acme', data };
  function applyOldRevision() {
    applyProvider(state, record, state.position + 1);
  }
  expect(applyOldRevision).toThrow('Invalid binding configuration revision');
  const valid = { ...record, data: { ...data, revision: 3 } };
  expect(applyProvider(state, valid, state.position + 1).revision).toBe(3);
}
it('requires binding events to keep the current provider configuration revision', foldRevision);
