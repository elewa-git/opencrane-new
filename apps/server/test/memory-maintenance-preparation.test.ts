import { mkdtemp, rm } from 'node:fs/promises';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createStore, grantStream, memberAuthorisation } from '@opencrane/authz';
import { databases, openfga } from '@opencrane/authz/testing';
import { event, natsFixture } from '@opencrane/event-store/testing';
import { createLogger } from '@opencrane/observability';
import { BudgetActor, providerSecretRef, providerSecrets } from '@opencrane/models';
import { memoryKeys, memoryProjection, memoryScopeId, pgDb, ProjectionRunner }
  from '@opencrane/projections';
import { prepareNightlyMaintenance } from '../src/memory/maintenance-preparation.ts';
import { maintenanceStatus } from '../src/memory/maintenance.ts';

let nats: Awaited<ReturnType<typeof natsFixture>>;
let fga: Awaited<ReturnType<typeof openfga>>;
let storage: Awaited<ReturnType<typeof databases>>;
let directory: string;
let options: Parameters<typeof prepareNightlyMaintenance>[0];
let runner: ProjectionRunner;
let projection: ReturnType<typeof memoryProjection>;
let authorisation: ReturnType<typeof memberAuthorisation>;
let factPosition: number;
let factData: unknown;
let serial = 0;
const scopeId = memoryScopeId('acme', 'person', 'dreamer');
const nightId = 'a'.repeat(64);
const inputRevision = 'b'.repeat(64);
const date = '2026-10-12';
const savedEventShape = z.object({ type: z.string(), source: z.string() });
function firstNight() { return new Date('2026-10-12T02:05:00.000Z'); }
function secondNight() { return new Date('2026-10-13T02:05:00.000Z'); }
function thirdNight() { return new Date('2026-10-14T02:05:00.000Z'); }

async function append(subject: string, type: string, data: unknown) {
  const id = `night-prepare-${++serial}`;
  let source = 'test';
  let principal: { kind: 'human' | 'system'; id: string } =
    { kind: 'human', id: 'dreamer' };
  if (type === 'memory.maintenance_bound') {
    source = 'opencrane-server';
    principal = { kind: 'human', id: z.object({ memberId: z.string() }).parse(data).memberId };
  }
  if (type === 'memory.maintenance_recorded') {
    source = 'opencrane-nightly';
    principal = { kind: 'system', id: 'nightly-memory' };
  }
  const saved = { ...event(id, subject, type), silo: 'acme', data,
    source, commandId: id, principal, time: new Date().toISOString() };
  const command = { event: saved, expectedSequence: await nats.store.head(subject),
    historyChecked: true as const };
  expect((await nats.store.append(command)).status).toBe('appended');
  return saved;
}

async function setup() {
  nats = await natsFixture();
  fga = await openfga();
  storage = await databases();
  directory = await mkdtemp('/tmp/night-prepare-');
  const binding = await createStore(fga.apiUrl, 'acme');
  const auth = memberAuthorisation(binding);
  authorisation = auth;
  const keys = memoryKeys(directory);
  const db = pgDb(storage.queue);
  runner = new ProjectionRunner(db, nats.reader, createLogger('night-prepare'));
  projection = memoryProjection({ decrypt: keys.decrypt });
  await runner.initialise(projection);
  const member = await append('member-dreamer', 'member.joined', {
    memberId: 'dreamer', role: 'member', email: 'dreamer@example.test',
    displayName: 'Dreamer',
  });
  await auth.handler.handle(member, db);
  const team = await append('team-payer', 'team.created', {
    teamId: 'payer', name: 'Payer', createdBy: 'dreamer',
  });
  await auth.handler.handle(team, db);
  const membership = await append('team-payer', 'team.member_added', {
    teamId: 'payer', memberId: 'dreamer', addedBy: 'dreamer',
  });
  await auth.handler.handle(membership, db);
  const assistant = await append('assistant-dreamer-assistant', 'assistant.created', {
    assistantId: 'dreamer-assistant', kind: 'personal', ownerId: 'dreamer',
  });
  await auth.handler.handle(assistant, db);
  const identity = { silo: 'acme', scopeId, scopeKind: 'person' as const,
    ownerId: 'dreamer', memoryId: 'fact-one', revision: 1 };
  keys.provision(identity);
  const ciphertext = keys.encrypt(identity, 'Private test fact');
  const { silo: _silo, ...factIdentity } = identity;
  const fact = await append(`scope-${scopeId}`, 'memory.written', {
    schemaVersion: 1, ...factIdentity, kind: 'fact', pinned: false, expiresAt: null,
    sources: [], dependsOn: [], ...ciphertext,
  });
  factPosition = await nats.store.head(fact.subject);
  factData = fact.data;
  await append(`scope-${scopeId}`, 'memory.maintenance_bound', {
    scopeId, scopeKind: 'person', ownerId: 'dreamer', memberId: 'dreamer',
    assistantId: 'dreamer-assistant', payingGroupId: 'payer', enabled: true,
    acceptedCapCents: 100, revision: 1,
  });
  await append(`scope-${scopeId}`, 'memory.maintenance_recorded', {
    scopeId, nightId, batchKey: 'c'.repeat(64), inputRevision, date,
    bindingRevision: 1, memberId: 'dreamer', acceptedCapCents: 100,
    intendedAt: `${date}T02:00:00.000Z`, selectedAt: `${date}T02:00:01.000Z`,
    inputRefs: [{ memoryId: 'fact-one', revision: 1, position: factPosition,
      expiresAt: null }], action: 'refused', reason: 'qualification_blocked',
  });
  await runner.run(projection);
  function memberId() { return Promise.resolve('dreamer'); }
  options = { silo: 'acme', store: nats.store, db, binding,
    feed: { memberId } };
}

beforeAll(setup, 120_000);
afterAll(async function cleanup() {
  await storage?.close();
  await fga?.close();
  await nats?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

it('keeps one original night when managed admission is unavailable', async function originalNight() {
  // Observe outbound HTTP and every append through the real preparation options.
  // Catch a network call or saved root, allowance, charge or computer start.
  const outbound = vi.spyOn(globalThis, 'fetch');
  outbound.mockResolvedValue(new Response('{}'));
  const appendedTypes: string[] = [];
  const originalAppend = nats.store.append.bind(nats.store);
  let lostReply = false;
  async function appendWithLostReply(command: Parameters<typeof nats.store.append>[0]) {
    const result = await originalAppend(command);
    const savedEvent = savedEventShape.safeParse(command.event);
    if (savedEvent.success) appendedTypes.push(savedEvent.data.type);
    if (!lostReply && savedEvent.success &&
        savedEvent.data.type === 'memory.maintenance_recorded' &&
        savedEvent.data.source === 'opencrane-server') {
      lostReply = true;
      throw new Error('Reply lost after append');
    }
    return result;
  }
  const appendSpy = vi.spyOn(nats.store, 'append').mockImplementation(appendWithLostReply);
  const first = await prepareNightlyMaintenance(options, scopeId, nightId, firstNight);
  expect(first).toMatchObject({ outcome: 'unknown', nightId, dispatch: 'disabled' });
  const repeated = await prepareNightlyMaintenance(options, scopeId, nightId, firstNight);
  const restarted = await prepareNightlyMaintenance(options, scopeId, nightId, firstNight);
  expect(restarted).toEqual(repeated);
  expect(repeated).toMatchObject({ outcome: 'refused', reason: 'provider_unavailable',
    nightId, dispatch: 'disabled' });
  await runner.run(projection);
  expect(outbound).not.toHaveBeenCalled();
  outbound.mockRestore();
  const scope = { scopeId, scopeKind: 'person' as const, ownerId: 'dreamer' };
  const status = await maintenanceStatus(options, scope, 'dreamer');
  expect(status).toMatchObject({ status: 'refused', dispatch: 'disabled' });
  expect(status.history[0]).toMatchObject({ reason: 'provider_unavailable',
    acceptedCapCents: 100 });
  await expect(maintenanceStatus(options, scope, 'intruder')).rejects.toThrow();
  const before = await options.db.query<{ data: unknown }>(
    'SELECT data FROM memory_maintenance_runs WHERE silo=$1 AND scope_id=$2 ORDER BY position',
    ['acme', scopeId]);
  await runner.rebuild(projection);
  expect(appendedTypes).toEqual(['memory.maintenance_recorded']);
  appendSpy.mockRestore();
  const after = await options.db.query<{ data: unknown }>(
    'SELECT data FROM memory_maintenance_runs WHERE silo=$1 AND scope_id=$2 ORDER BY position',
    ['acme', scopeId]);
  expect(after.rows).toEqual(before.rows);
});

it('admits one eligible night with one exact root and allowance', async function eligibleNight() {
  const actor = new BudgetActor(nats.store, 'acme', firstNight);
  await actor.start(2000, 20000, 'payer');
  const ownerId = 'eligible-owner';
  const assistantId = 'eligible-assistant';
  const eligibleScopeId = memoryScopeId('acme', 'person', ownerId);
  const member = await append(`member-${ownerId}`, 'member.joined', {
    memberId: ownerId, role: 'member', email: 'eligible@example.test',
    displayName: 'Eligible',
  });
  await authorisation.handler.handle(member, options.db);
  const membership = await append('team-payer', 'team.member_added', {
    teamId: 'payer', memberId: ownerId, addedBy: 'dreamer',
  });
  await authorisation.handler.handle(membership, options.db);
  const assistant = await append(`assistant-${assistantId}`, 'assistant.created', {
    assistantId, kind: 'personal', ownerId,
  });
  await authorisation.handler.handle(assistant, options.db);
  const identity = { silo: 'acme', scopeId: eligibleScopeId, scopeKind: 'person' as const,
    ownerId, memoryId: 'eligible-fact', revision: 1 };
  const keys = memoryKeys(directory);
  keys.provision(identity);
  const ciphertext = keys.encrypt(identity, 'Eligible private fact');
  const { silo: _silo, ...factIdentity } = identity;
  await append(`scope-${eligibleScopeId}`, 'memory.written', {
    schemaVersion: 1, ...factIdentity, kind: 'fact', pinned: false, expiresAt: null,
    sources: [], dependsOn: [], ...ciphertext,
  });
  const position = await nats.store.head(`scope-${eligibleScopeId}`);
  await append(`scope-${eligibleScopeId}`, 'memory.maintenance_bound', {
    scopeId: eligibleScopeId, scopeKind: 'person', ownerId, memberId: ownerId,
    assistantId, payingGroupId: 'payer', enabled: true, acceptedCapCents: 100, revision: 1,
  });
  const grantKinds = ['model', 'memory_read', 'memory_write'];
  for (const kind of grantKinds) {
    const resourceId = kind === 'model' ? 'gpt-6-luna' : eligibleScopeId;
    for (const granteeKind of ['member', 'assistant']) {
      const granteeId = granteeKind === 'member' ? ownerId : assistantId;
      const grant = await append(grantStream(kind, resourceId), 'grant.given', {
        resourceType: kind, resourceId, granteeKind, granteeId, grantedBy: ownerId,
      });
      await authorisation.handler.handle(grant, options.db);
    }
  }
  await append(`computer-${assistantId}`, 'computer.ready', {
    assistantId, computerId: 'dream-computer', generation: 1,
  });
  await append('provider-primary', 'provider.created', {
    providerId: 'primary', provider: 'openai', name: 'Primary', revision: 1,
    changedBy: ownerId,
  });
  const keyCommand = `night-prepare-${serial + 1}`;
  const reference = providerSecretRef('acme', 'primary', keyCommand);
  const secrets = providerSecrets(`${directory}/providers`);
  await secrets.save(reference, 'test-only-key');
  await append('provider-primary', 'provider.key_saved', {
    providerId: 'primary', revision: 2, changedBy: ownerId, secretRef: reference,
  });
  await append('provider-primary', 'provider.models_selected', {
    providerId: 'primary', revision: 3, changedBy: ownerId, models: ['gpt-6-luna'],
  });
  await append('provider-primary', 'provider.model_binding_set', {
    providerId: 'primary', revision: 4, changedBy: ownerId,
    expectedProviderSequence: 0, previousBindingSequence: 0,
    kind: 'assistant', dependantId: assistantId, task: 'chat_turn',
    state: 'active', model: 'gpt-6-luna',
  });
  await append('budget-acme', 'provider.managed_calls_enabled', {
    providerId: 'primary', revision: 5, changedBy: ownerId,
    expectedProviderSequence: 0,
  });
  const eligibleId = '6'.repeat(64);
  await append(`scope-${eligibleScopeId}`, 'memory.maintenance_recorded', {
    scopeId: eligibleScopeId, nightId: eligibleId, batchKey: '7'.repeat(64),
    inputRevision: '8'.repeat(64), date: '2026-10-19', bindingRevision: 1,
    memberId: ownerId, acceptedCapCents: 100,
    intendedAt: '2026-10-19T02:00:00.000Z', selectedAt: '2026-10-19T02:00:01.000Z',
    inputRefs: [{ memoryId: 'eligible-fact', revision: 1, position, expiresAt: null }],
    action: 'due', reason: null,
  });
  function eligibleTime() { return new Date('2026-10-19T02:05:00.000Z'); }
  const first = await prepareNightlyMaintenance(options, eligibleScopeId, eligibleId,
    eligibleTime, { actor, secrets });
  const repeated = await prepareNightlyMaintenance(options, eligibleScopeId, eligibleId,
    eligibleTime, { actor, secrets });
  expect(first).toMatchObject({ outcome: 'prepared', nightId: eligibleId,
    allowanceCents: 100, dispatch: 'disabled' });
  expect(repeated).toEqual(first);
  const roots = actor.state.roots.filter(function matchingRoot(root) {
    return root.requesterId === ownerId && root.assistantId === assistantId;
  });
  expect(roots).toHaveLength(1);
  expect(roots[0]).toMatchObject({ payingGroupId: 'payer', allowanceCents: 100 });
  expect(actor.state.reservations).toHaveLength(0);
});

async function claimNight(claimDate: string, claimId: string, bindingRevision: number,
  action: 'due' | 'refused' = 'refused') {
  await append(`scope-${scopeId}`, 'memory.maintenance_recorded', {
    scopeId, nightId: claimId, batchKey: 'e'.repeat(64), inputRevision,
    date: claimDate, bindingRevision, memberId: 'dreamer', acceptedCapCents: 100,
    intendedAt: `${claimDate}T02:00:00.000Z`,
    selectedAt: `${claimDate}T02:00:01.000Z`,
    inputRefs: [{ memoryId: 'fact-one', revision: 1, position: factPosition,
      expiresAt: null }], action,
    reason: action === 'due' ? null : 'qualification_blocked',
  });
}

it('checks the binding revision and later binding change separately', async function bindingChecks() {
  const revisionNightId = '4'.repeat(64);
  await claimNight('2026-10-17', revisionNightId, 99);
  function revisionNight() { return new Date('2026-10-17T02:05:00.000Z'); }
  const revisionResult = await prepareNightlyMaintenance(options, scopeId,
    revisionNightId, revisionNight);
  expect(revisionResult).toMatchObject({ outcome: 'refused', reason: 'binding_changed' });

  const changedNightId = '5'.repeat(64);
  await claimNight('2026-10-18', changedNightId, 1);
  await append(`scope-${scopeId}`, 'memory.maintenance_bound', {
    scopeId, scopeKind: 'person', ownerId: 'dreamer', memberId: 'dreamer',
    assistantId: 'dreamer-assistant', payingGroupId: 'payer', enabled: true,
    acceptedCapCents: 100, revision: 1,
  });
  function changedNight() { return new Date('2026-10-18T02:05:00.000Z'); }
  const changedResult = await prepareNightlyMaintenance(options, scopeId,
    changedNightId, changedNight);
  expect(changedResult).toMatchObject({ outcome: 'refused', reason: 'binding_changed' });
});

it('refuses a changed same-night binding and input before any call', async function changedNight() {
  const bindingNightId = 'd'.repeat(64);
  await claimNight('2026-10-13', bindingNightId, 1);
  await append(`scope-${scopeId}`, 'memory.maintenance_bound', {
    scopeId, scopeKind: 'person', ownerId: 'dreamer', memberId: 'dreamer',
    assistantId: 'dreamer-assistant', payingGroupId: 'payer', enabled: true,
    acceptedCapCents: 100, revision: 2,
  });
  const bindingResult = await prepareNightlyMaintenance(options, scopeId,
    bindingNightId, secondNight);
  expect(bindingResult).toMatchObject({ outcome: 'refused', reason: 'binding_changed' });
  const inputNightId = 'f'.repeat(64);
  await claimNight('2026-10-14', inputNightId, 2);
  await append(`scope-${scopeId}`, 'memory.written', factData);
  const inputResult = await prepareNightlyMaintenance(options, scopeId,
    inputNightId, thirdNight);
  expect(inputResult).toMatchObject({ outcome: 'refused', reason: 'input_changed' });
});

it('saves the original window result and refuses an occupied scope', async function timing() {
  const missedNightId = '1'.repeat(64);
  await claimNight('2026-10-15', missedNightId, 2);
  function afterWindow() { return new Date('2026-10-15T02:16:00.000Z'); }
  const missed = await prepareNightlyMaintenance(options, scopeId, missedNightId, afterWindow);
  expect(missed).toMatchObject({ outcome: 'refused', reason: 'window_missed' });
  const repeated = await prepareNightlyMaintenance(options, scopeId, missedNightId, afterWindow);
  expect(repeated).toEqual(missed);

  const occupiedNightId = '2'.repeat(64);
  await claimNight('2026-10-16', occupiedNightId, 2);
  await claimNight('2026-10-16', '3'.repeat(64), 2, 'due');
  function duringWindow() { return new Date('2026-10-16T02:05:00.000Z'); }
  const occupied = await prepareNightlyMaintenance(options, scopeId, occupiedNightId,
    duringWindow);
  expect(occupied).toMatchObject({ outcome: 'refused', reason: 'scope_occupied' });
});
