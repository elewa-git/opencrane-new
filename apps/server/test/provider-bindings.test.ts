import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { encodeSession } from '@opencrane/auth';
import { createStore, grantStream, memberAuthorisation } from '@opencrane/authz';
import { databases, openfga } from '@opencrane/authz/testing';
import { event, natsFixture } from '@opencrane/event-store/testing';
import { pgDb, providers, routines, ProjectionRunner, rebuildProviderProjection, readProviders } from '@opencrane/projections';
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
  await runner.initialise(routines);
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
  let trigger: EventEnvelope | undefined;
  for await (const saved of nats.store.readStream('provider-secondary')) {
    if (saved.event.type === 'provider.models_selected') trigger = saved.event;
  }
  expect(trigger).toBeDefined();
  if (!trigger) throw new Error('Selection fixture was not saved');
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
  const originalRead = nats.store.readStream.bind(nats.store);
  let releaseRead: (() => void) | undefined;
  let readStarted: (() => void) | undefined;
  const started = new Promise<void>(resolve => { readStarted = resolve; });
  const release = new Promise<void>(resolve => { releaseRead = resolve; });
  async function* delayedRead(subject: string, from?: number, deadline?: number) {
    if (subject === 'assistant-*') {
      readStarted?.();
      await release;
    }
    yield* originalRead(subject, from, deadline);
  }
  const spy = vi.spyOn(nats.store, 'readStream').mockImplementation(delayedRead);
  const late = request('GET', 'primary', undefined, 'admin', undefined, undefined,
    'dependencies');
  await started;
  await append('member-admin', 'member.removed', { memberId: 'admin', removedBy: 'owner' }, false);
  releaseRead?.();
  expect((await late).statusCode).toBe(403);
  spy.mockRestore();
  await deniedRequest('admin', 'https://app.example.test', 'org-acme');
}
it('refuses a departed admin even before IAM catches up', hidesAfterRemoval);

async function previewsRetirementWithoutChangingHistory() {
  const saved = (await request('GET')).json<{ rows: { kind: string }[] }>();
  function isDefault(row: (typeof saved.rows)[number]) {
    return row.kind === 'silo_default';
  }
  if (!saved.rows.some(isDefault)) {
    const defaultChoice = await input({ kind: 'silo_default', dependantId: 'acme' });
    expect((await request('POST', 'primary', defaultChoice)).statusCode).toBe(200);
  }
  await append('assistant-preview', 'assistant.created',
    { assistantId: 'preview', ownerId: 'bob', kind: 'personal' });
  const ownChoice = await input({ dependantId: 'preview' });
  expect((await request('POST', 'primary', ownChoice)).statusCode).toBe(200);
  const before = await nats.store.head();
  const response = await request('GET', 'primary', undefined, 'owner', undefined, undefined,
    'dependencies');
  expect(response.statusCode).toBe(200);
  const preview = response.json<{ dependencies: { kind: string; dependantId: string;
    task: string; position: number }[]; canRetire: boolean; sources: {
    assistants: string; routines: string } }>();
  expect(preview).toMatchObject({ canRetire: false,
    sources: { assistants: 'complete', routines: 'complete' } });
  expect(preview.dependencies).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'silo_default', dependantId: 'acme', task: 'chat_turn' }),
    expect.objectContaining({ kind: 'assistant', dependantId: 'preview', task: 'chat_turn' }),
  ]));
  expect((await request('GET', 'primary', undefined, 'bob', undefined, undefined,
    'dependencies')).statusCode).toBe(403);
  function pauseChoice(row: (typeof preview.dependencies)[number]) {
    return { kind: row.kind, dependantId: row.dependantId, task: row.task,
      expectedBindingSequence: row.position, action: 'pause' };
  }
  const choices = preview.dependencies.map(pauseChoice);
  const position = await nats.store.head('provider-*');
  const proposed = { expectedProviderSequence: position, choices };
  const valid = await request('POST', 'primary', proposed, 'owner', undefined, undefined,
    'dependencies/preview');
  expect(valid.statusCode).toBe(200);
  expect(valid.json()).toMatchObject({ choicesValid: true, canRetire: false });
  const incomplete = { ...proposed, choices: choices.slice(1) };
  expect((await request('POST', 'primary', incomplete, 'owner', undefined, undefined,
    'dependencies/preview')).statusCode).toBe(409);
  const duplicate = { ...proposed, choices: [...choices, choices[0]] };
  expect((await request('POST', 'primary', duplicate, 'owner', undefined, undefined,
    'dependencies/preview')).statusCode).toBe(409);
  const stale = { ...proposed, expectedProviderSequence: position - 1 };
  expect((await request('POST', 'primary', stale, 'owner', undefined, undefined,
    'dependencies/preview')).statusCode).toBe(409);
  expect(await nats.store.head()).toBe(before);
}
it('shows exact saved dependencies only to a current admin without saving an event',
  previewsRetirementWithoutChangingHistory);

async function checksLiveReplacementGrants() {
  function isPreviewDependency(row: { dependantId: string }) {
    return row.dependantId === 'preview';
  }
  const saved = (await request('GET')).json<{ rows: { dependantId: string }[] }>();
  if (!saved.rows.some(isPreviewDependency)) {
    await append('assistant-preview', 'assistant.created',
      { assistantId: 'preview', ownerId: 'bob', kind: 'personal' });
    const choice = await input({ dependantId: 'preview' });
    expect((await request('POST', 'primary', choice)).statusCode).toBe(200);
  }
  const subject = grantStream('model', 'gpt-6.1-sol');
  for (const [granteeKind, granteeId] of [['member', 'bob'], ['assistant', 'preview']]) {
    await append(subject, 'grant.given', { resourceType: 'model', resourceId: 'gpt-6.1-sol',
      granteeKind, granteeId, grantedBy: 'owner' });
  }
  await append('provider-secondary', 'provider.verification_recorded', {
    providerId: 'secondary', changedBy: 'owner', revision: 3,
    kind: 'reachability', attemptId: 'retest', outcome: 'pass',
  });
  const withoutPayer = await request('GET', 'primary', undefined, 'owner', undefined, undefined,
    'dependencies');
  const missingPayer = withoutPayer.json<{ expectedProviderSequence: number;
    dependencies: { kind: string; dependantId: string; task: string; position: number;
      replacements: { providerId: string }[] }[] }>();
  const missingPayerRows = missingPayer.dependencies;
  const missingPayerChoice = missingPayerRows.find(isPreviewDependency);
  expect(missingPayerChoice?.replacements).toEqual([]);
  function proposedChoice(row: (typeof missingPayerRows)[number]) {
    const common = { kind: row.kind, dependantId: row.dependantId, task: row.task,
      expectedBindingSequence: row.position };
    if (row.dependantId === 'preview') {
      return { ...common, action: 'replace', targetProviderId: 'secondary',
        targetRevision: 3, model: 'gpt-6.1-sol' };
    }
    return { ...common, action: 'pause' };
  }
  const missingPayerProposal = { expectedProviderSequence: missingPayer.expectedProviderSequence,
    choices: missingPayerRows.map(proposedChoice) };
  expect((await request('POST', 'primary', missingPayerProposal, 'owner', undefined,
    undefined, 'dependencies/preview')).statusCode).toBe(409);
  await append('budget-acme', 'budget.ceiling_set', {
    scope: 'global', dailyCeilingCents: 0, ceilingCents: 0,
    setBy: 'owner', defaultPayingGroupId: 'personal',
  });
  const withoutBudget = await request('GET', 'primary', undefined, 'owner', undefined,
    undefined, 'dependencies');
  const unbudgeted = withoutBudget.json<typeof missingPayer>();
  const unbudgetedRows = unbudgeted.dependencies;
  const unbudgetedChoice = unbudgetedRows.find(isPreviewDependency);
  expect(unbudgetedChoice?.replacements).toEqual([]);
  const unbudgetedProposal = { expectedProviderSequence: unbudgeted.expectedProviderSequence,
    choices: unbudgetedRows.map(proposedChoice) };
  expect((await request('POST', 'primary', unbudgetedProposal, 'owner', undefined,
    undefined, 'dependencies/preview')).statusCode).toBe(409);
  await append('budget-acme', 'budget.ceiling_set', {
    scope: 'global', dailyCeilingCents: 2000, ceilingCents: 20000,
    setBy: 'owner', defaultPayingGroupId: 'personal',
  });
  const response = await request('GET', 'primary', undefined, 'owner', undefined, undefined,
    'dependencies');
  expect(response.statusCode).toBe(200);
  const preview = response.json<{ expectedProviderSequence: number; dependencies: {
    kind: string; dependantId: string; task: string; position: number;
    replacements: { providerId: string; revision: number; model: string }[] }[] }>();
  const own = preview.dependencies.find(isPreviewDependency);
  expect(own?.replacements).toContainEqual({ providerId: 'secondary', revision: 3,
    model: 'gpt-6.1-sol' });
  function replacementChoice(row: (typeof preview.dependencies)[number]) {
    const common = { kind: row.kind, dependantId: row.dependantId, task: row.task,
      expectedBindingSequence: row.position };
    if (row.dependantId === 'preview') {
      return { ...common, action: 'replace', targetProviderId: 'secondary',
        targetRevision: 3, model: 'gpt-6.1-sol' };
    }
    return { ...common, action: 'pause' };
  }
  const choices = preview.dependencies.map(replacementChoice);
  const proposed = { expectedProviderSequence: preview.expectedProviderSequence, choices };
  expect((await request('POST', 'primary', proposed, 'owner', undefined, undefined,
    'dependencies/preview')).json()).toMatchObject({ choicesValid: true, canRetire: false });
  await append(subject, 'grant.revoked', { resourceType: 'model', resourceId: 'gpt-6.1-sol',
    granteeKind: 'assistant', granteeId: 'preview', revokedBy: 'owner' });
  expect((await request('POST', 'primary', proposed, 'owner', undefined, undefined,
    'dependencies/preview')).statusCode).toBe(409);
}
it('checks saved model grants before offering and accepting a replacement',
  checksLiveReplacementGrants);

async function refusesRoutineCreatedDuringPreparation() {
  const before = await request('GET', 'primary', undefined, 'owner', undefined, undefined,
    'dependencies');
  const preview = before.json<{ expectedProviderSequence: number; dependencies: {
    kind: string; dependantId: string; task: string; position: number }[] }>();
  function pauseChoice(row: (typeof preview.dependencies)[number]) {
    return { kind: row.kind, dependantId: row.dependantId, task: row.task,
      expectedBindingSequence: row.position, action: 'pause' };
  }
  const choices = preview.dependencies.map(pauseChoice);
  const proposal = { expectedProviderSequence: preview.expectedProviderSequence, choices };
  const originalRead = nats.store.readStream.bind(nats.store);
  const originalHead = nats.store.head.bind(nats.store);
  let releaseRead: (() => void) | undefined;
  let routineChecked: (() => void) | undefined;
  const release = new Promise<void>(resolve => { releaseRead = resolve; });
  const checked = new Promise<void>(resolve => { routineChecked = resolve; });
  let routineHeads = 0;
  async function* delayedRead(subject: string, from?: number, deadline?: number) {
    if (subject === 'assistant-*') await release;
    yield* originalRead(subject, from, deadline);
  }
  async function observedHead(subject?: string, deadline?: number) {
    const position = await originalHead(subject, deadline);
    if (subject === 'routine-*' && ++routineHeads === 2) routineChecked?.();
    return position;
  }
  const readSpy = vi.spyOn(nats.store, 'readStream').mockImplementation(delayedRead);
  const headSpy = vi.spyOn(nats.store, 'head').mockImplementation(observedHead);
  try {
    const pending = request('POST', 'primary', proposal, 'owner', undefined, undefined,
      'dependencies/preview');
    await checked;
    await append('routine-during-preview', 'routine.paused',
      { routineId: 'during-preview', pausedBy: 'owner' });
    await runner.run(routines);
    releaseRead?.();
    expect((await pending).statusCode).toBe(409);
  } finally {
    releaseRead?.();
    readSpy.mockRestore();
    headSpy.mockRestore();
  }
}
it('rejects a proposal when a routine appears during preparation',
  refusesRoutineCreatedDuringPreparation);

async function pagesStableDependencies() {
  for (let index = 0; index < 51; index++) {
    const assistantId = `page-${index}`;
    await append(`assistant-${assistantId}`, 'assistant.created',
      { assistantId, ownerId: 'bob', kind: 'personal' });
    await append('provider-primary', 'provider.model_binding_set', {
      providerId: 'primary', revision: 3, changedBy: 'owner',
      kind: 'assistant', dependantId: assistantId, task: 'chat_turn',
      expectedProviderSequence: await nats.store.head('provider-*'),
      previousBindingSequence: 0, state: 'active', model: 'gpt-6.1-sol',
    });
  }
  const first = await request('GET', 'primary', undefined, 'owner', undefined, undefined,
    'dependencies');
  const page = first.json<{ dependencies: { dependantId: string }[]; nextCursor: number;
    expectedProviderSequence: number; routinePosition: number }>();
  expect(page.dependencies).toHaveLength(50);
  const query = `dependencies?after=${page.nextCursor}&expectedProviderSequence=` +
    `${page.expectedProviderSequence}&expectedRoutinePosition=${page.routinePosition}`;
  const second = await request('GET', 'primary', undefined, 'owner', undefined, undefined, query);
  expect(second.statusCode).toBe(200);
  const secondRows = second.json<{ dependencies: { dependantId: string }[] }>().dependencies;
  expect(secondRows.some(row => page.dependencies.some(firstRow =>
    firstRow.dependantId === row.dependantId))).toBe(false);
  const staleQuery = query.replace(`expectedProviderSequence=${page.expectedProviderSequence}`,
    `expectedProviderSequence=${page.expectedProviderSequence - 1}`);
  expect((await request('GET', 'primary', undefined, 'owner', undefined, undefined,
    staleQuery)).statusCode).toBe(409);
}
it('returns bounded pages tied to the saved provider and routine positions',
  pagesStableDependencies, 120_000);

async function routineGaps() {
  await dbs.queue.query("DELETE FROM projection_checkpoints WHERE name = 'routines'");
  expect((await request('GET')).statusCode).toBe(503);
  const lag = await request('GET', 'primary', undefined, 'owner', undefined, undefined,
    'dependencies');
  expect(lag.json()).toMatchObject({ sources: { routines: 'unavailable' },
    canRetire: false });
  await runner.initialise(routines);
  await append('routine-old', 'routine.paused', { routineId: 'old', pausedBy: 'owner' });
  expect((await request('GET')).statusCode).toBe(503);
  await runner.run(routines);
  expect((await request('GET')).json()).toMatchObject({ routines: { status: 'unsupported' } });
  const old = await request('GET', 'primary', undefined, 'owner', undefined, undefined,
    'dependencies');
  expect(old.json()).toMatchObject({ sources: { routines: 'not_available' },
    unresolvedRoutines: [{ routineId: 'during-preview' }, { routineId: 'old' }],
    canRetire: false });
}
it('reports projection failure and legacy routine history without invented counts', routineGaps);



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

async function replaysRetiredBindings() {
  const source = 'retirement-source';
  const common = { providerId: source, changedBy: 'owner' };
  await append(`provider-${source}`, 'provider.created', {
    ...common, revision: 1, provider: 'openai', name: 'Retirement source',
  });
  await append(`provider-${source}`, 'provider.key_saved', {
    ...common, revision: 2, secretRef: providerSecretRef('acme', source, 'source-key'),
  });
  await append(`provider-${source}`, 'provider.models_selected', {
    ...common, revision: 3, models: ['gpt-6.1-sol'],
  });
  await append(`provider-${source}`, 'provider.model_binding_set', {
    ...common, revision: 3, kind: 'assistant', dependantId: 'one', task: 'chat_turn',
    expectedProviderSequence: 0, previousBindingSequence: 0,
    state: 'active', model: 'gpt-6.1-sol',
  });
  const bindingPosition = await nats.store.head(`provider-${source}`);
  const choices = [{ kind: 'assistant', dependantId: 'one', task: 'chat_turn',
    old: { providerId: source, model: 'gpt-6.1-sol', bindingSequence: bindingPosition },
    next: { state: 'active', providerId: 'secondary', model: 'gpt-6.1-sol', revision: 3 } }];
  await append(`provider-${source}`, 'provider.retired', {
    ...common, revision: 3, expectedProviderSequence: bindingPosition, choices,
  });
  await runner.run(providers);
  const before = await dbs.queue.query('SELECT * FROM model_bindings WHERE silo = $1 AND '
    + 'dependant_id = $2', ['acme', 'one']);
  expect(before.rows[0]).toMatchObject({ state: { providerId: 'secondary',
    state: 'active', model: 'gpt-6.1-sol' } });
  expect((await readProviders(pgDb(dbs.queue), 'acme', source))[0]).toMatchObject({
    retired: { revision: 3, choices },
  });
  const logger = createLogger('retirement-replay', { level: 'silent' });
  await rebuildProviderProjection(pgDb(dbs.queue), nats.reader, logger, { verify: true });
  const after = await dbs.queue.query('SELECT * FROM model_bindings WHERE silo = $1 AND '
    + 'dependant_id = $2', ['acme', 'one']);
  expect(after.rows).toEqual(before.rows);
  expect((await request('POST', source, {}, 'owner', undefined, undefined, 'retire'))
    .statusCode).toBe(404);
}
it('replays retirement choices without opening the mutation route', replaysRetiredBindings);

async function boundsReplacementPreparation() {
  const candidateModels = [
    'gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna', 'gpt-6-sol',
    'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5',
    'gpt-5.5-pro', 'gpt-5.4', 'gpt-5.4-pro',
  ];
  for (let index = 0; index < 20; index++) {
    const providerId = `extra-${index}`;
    const subject = `provider-${providerId}`;
    const common = { providerId, changedBy: 'owner' };
    await append(subject, 'provider.created',
      { ...common, revision: 1, provider: 'openai', name: providerId });
    await append(subject, 'provider.key_saved', { ...common, revision: 2,
      secretRef: providerSecretRef('acme', providerId, `binding-${counter + 1}`) });
    await append(subject, 'provider.models_selected',
      { ...common, revision: 3, models: candidateModels });
    await append(subject, 'provider.verification_recorded', {
      ...common, revision: 3, kind: 'reachability', attemptId: 'check', outcome: 'pass',
    });
  }
  const response = await request('GET', 'primary', undefined, 'owner', undefined,
    undefined, 'dependencies');
  expect(response.statusCode).toBe(200);
  const preview = response.json<{ sources: { assistants: string }; dependencies: {
    replacements: { providerId: string }[] }[] }>();
  expect(preview.sources.assistants).toBe('unavailable');
  let candidates = 0;
  for (const row of preview.dependencies) candidates += row.replacements.length;
  expect(candidates).toBeLessThanOrEqual(200);
}
it('bounds replacement work and reports incomplete candidate checks',
  boundsReplacementPreparation, 120_000);
