import { mkdtemp, rm } from 'node:fs/promises';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createStore, memberAuthorisation } from '@opencrane/authz';
import { databases, openfga } from '@opencrane/authz/testing';
import { event, natsFixture } from '@opencrane/event-store/testing';
import { BudgetActor } from '@opencrane/models';
import { createLogger } from '@opencrane/observability';
import { memoryKeys, memoryProjection, memoryScopeId, pgDb, ProjectionRunner }
  from '@opencrane/projections';
import { prepareNightlyMaintenance } from '../src/memory/maintenance-preparation.ts';

let nats: Awaited<ReturnType<typeof natsFixture>>;
let fga: Awaited<ReturnType<typeof openfga>>;
let storage: Awaited<ReturnType<typeof databases>>;
let actor: BudgetActor;
let directory: string;
let options: Parameters<typeof prepareNightlyMaintenance>[0];
let runner: ProjectionRunner;
let serial = 0;
const scopeId = memoryScopeId('acme', 'person', 'dreamer');
const nightId = 'a'.repeat(64);
const inputRevision = 'b'.repeat(64);
const date = '2026-10-12';

async function append(subject: string, type: string, data: unknown) {
  const id = `night-prepare-${++serial}`;
  const saved = { ...event(id, subject, type), silo: 'acme', data,
    commandId: id, principal: { kind: 'human' as const, id: 'dreamer' } };
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
  const projection = memoryProjection({ decrypt: keys.decrypt });
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
  const factPosition = await nats.store.head(fact.subject);
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
  actor = new BudgetActor(nats.store, 'acme');
  await actor.start(2000, 20000, 'payer');
  options = { silo: 'acme', store: nats.store, db, binding,
    feed: { memberId: async () => 'dreamer' } };
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
  const first = await prepareNightlyMaintenance(options, actor, scopeId, nightId);
  const repeated = await prepareNightlyMaintenance(options, actor, scopeId, nightId);
  expect(first).toMatchObject({ outcome: 'refused', reason: 'provider_unavailable',
    nightId, dispatch: 'disabled' });
  expect(repeated).toEqual(first);
  expect(actor.state.roots).toHaveLength(0);
  expect(model).not.toHaveBeenCalled();
  expect(tool).not.toHaveBeenCalled();
});
