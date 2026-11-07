import { mkdtemp, rm } from 'node:fs/promises';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createStore, memberAuthorisation } from '@opencrane/authz';
import { databases, openfga } from '@opencrane/authz/testing';
import { event, natsFixture } from '@opencrane/event-store/testing';
import { createLogger } from '@opencrane/observability';
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
  if (type === 'memory.maintenance_bound') source = 'opencrane-server';
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
  await append('team-payer', 'team.created', {
    teamId: 'payer', name: 'Payer', createdBy: 'dreamer',
  });
  const membership = await append('team-payer', 'team.member_added', {
    teamId: 'payer', memberId: 'dreamer', addedBy: 'dreamer',
  });
  await auth.handler.handle(membership, db);
  await append('assistant-dreamer-assistant', 'assistant.created', {
    assistantId: 'dreamer-assistant', kind: 'personal', ownerId: 'dreamer',
  });
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
  const model = vi.fn();
  const tool = vi.fn();
  const originalAppend = nats.store.append.bind(nats.store);
  let lostReply = false;
  async function appendWithLostReply(command: Parameters<typeof nats.store.append>[0]) {
    const result = await originalAppend(command);
    const savedEvent = savedEventShape.safeParse(command.event);
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
  appendSpy.mockRestore();
  expect(first).toMatchObject({ outcome: 'unknown', nightId, dispatch: 'disabled' });
  const repeated = await prepareNightlyMaintenance(options, scopeId, nightId, firstNight);
  const restarted = await prepareNightlyMaintenance(options, scopeId, nightId, firstNight);
  expect(restarted).toEqual(repeated);
  expect(repeated).toMatchObject({ outcome: 'refused', reason: 'provider_unavailable',
    nightId, dispatch: 'disabled' });
  expect(model).not.toHaveBeenCalled();
  expect(tool).not.toHaveBeenCalled();
  await runner.run(projection);
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
  const after = await options.db.query<{ data: unknown }>(
    'SELECT data FROM memory_maintenance_runs WHERE silo=$1 AND scope_id=$2 ORDER BY position',
    ['acme', scopeId]);
  expect(after.rows).toEqual(before.rows);
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
