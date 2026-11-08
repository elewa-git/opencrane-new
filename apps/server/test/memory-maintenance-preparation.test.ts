import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createStore, grantStream, memberAuthorisation } from '@opencrane/authz';
import { databases, openfga } from '@opencrane/authz/testing';
import { event, natsFixture } from '@opencrane/event-store/testing';
import { budgetRootAllowanceSetDataSchema, type EventEnvelope } from '@opencrane/events';
import { createLogger } from '@opencrane/observability';
import { BudgetActor, providerSecretRef, providerSecrets, readToolPolicy,
  losslessJson } from '@opencrane/models';
import { catalogueDigest, toolReviewDigest } from '@opencrane/events/mcp-catalogue';
import { maintenanceOrChildRoute } from '../../../libs/models/src/decision-maintenance.ts';
import { memoryPrepareHandler } from '../../ops/src/memory-prepare.ts';
import { memoryKeys, memoryProjection, memoryScopeId, pgDb, ProjectionRunner,
  type Query }
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
type CandidateChange = { skipGrant?: string; skipReceipt?: string;
  payingGroupId?: string; model?: string };
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

async function candidateNight(digit: string, change: CandidateChange = {}) {
  const ownerId = `candidate-${digit}`;
  const assistantId = `candidate-assistant-${digit}`;
  const candidateScopeId = memoryScopeId('acme', 'person', ownerId);
  const member = await append(`member-${ownerId}`, 'member.joined', {
    memberId: ownerId, role: 'member', email: `${ownerId}@example.test`,
    displayName: ownerId,
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
  const identity = { silo: 'acme', scopeId: candidateScopeId, scopeKind: 'person' as const,
    ownerId, memoryId: 'candidate-fact', revision: 1 };
  const keys = memoryKeys(directory);
  keys.provision(identity);
  const ciphertext = keys.encrypt(identity, 'Candidate private fact');
  const { silo: _silo, ...factIdentity } = identity;
  await append(`scope-${candidateScopeId}`, 'memory.written', {
    schemaVersion: 1, ...factIdentity, kind: 'fact', pinned: false, expiresAt: null,
    sources: [], dependsOn: [], ...ciphertext,
  });
  const position = await nats.store.head(`scope-${candidateScopeId}`);
  await append(`scope-${candidateScopeId}`, 'memory.maintenance_bound', {
    scopeId: candidateScopeId, scopeKind: 'person', ownerId, memberId: ownerId,
    assistantId, payingGroupId: change.payingGroupId ?? 'payer', enabled: true,
    acceptedCapCents: 100, revision: 1,
  });
  const grants: [string, string][] = [['model', 'gpt-6-luna'], ['mcp_server', 'memory'],
    ['memory_read', candidateScopeId], ['memory_write', candidateScopeId]];
  for (const [kind, resourceId] of grants) {
    if (kind === change.skipGrant) continue;
    for (const granteeKind of ['member', 'assistant']) {
      const granteeId = granteeKind === 'member' ? ownerId : assistantId;
      const grant = await append(grantStream(kind, resourceId), 'grant.given', {
        resourceType: kind, resourceId, granteeKind, granteeId, grantedBy: ownerId,
      });
      if (kind !== change.skipReceipt || granteeKind !== 'member') {
        await authorisation.handler.handle(grant, options.db);
      }
    }
  }
  await append(`computer-${assistantId}`, 'computer.ready', {
    assistantId, computerId: `computer-${digit}`, generation: 1,
  });
  await append('provider-primary', 'provider.model_binding_set', {
    providerId: 'primary', revision: 3, changedBy: ownerId,
    expectedProviderSequence: 0, previousBindingSequence: 0,
    kind: 'assistant', dependantId: assistantId, task: 'chat_turn',
    state: 'active', model: change.model ?? 'gpt-6-luna',
  });
  const candidateNightId = digit.repeat(64);
  const due = await append(`scope-${candidateScopeId}`, 'memory.maintenance_recorded', {
    scopeId: candidateScopeId, nightId: candidateNightId,
    batchKey: 'c'.repeat(64), inputRevision: 'd'.repeat(64), date: '2026-10-19',
    bindingRevision: 1, memberId: ownerId, acceptedCapCents: 100,
    intendedAt: '2026-10-19T02:00:00.000Z', selectedAt: '2026-10-19T02:00:01.000Z',
    inputRefs: [{ memoryId: 'candidate-fact', revision: 1, position, expiresAt: null }],
    action: 'due', reason: null,
  });
  return { ownerId, assistantId, scopeId: candidateScopeId,
    nightId: candidateNightId, due };
}

function candidateTime() { return new Date('2026-10-19T02:05:00.000Z'); }

async function expectCandidateRefusal(candidate: Awaited<ReturnType<typeof candidateNight>>,
  admission: NonNullable<Parameters<typeof prepareNightlyMaintenance>[4]>, reason: string) {
  const result = await prepareNightlyMaintenance(options, candidate.scopeId,
    candidate.nightId, candidateTime, admission);
  expect(result).toMatchObject({ outcome: 'refused', reason, dispatch: 'disabled' });
  const roots = admission.actor.state.roots.filter(function matches(candidateRoot) {
    return candidateRoot.requesterId === candidate.ownerId;
  });
  expect(roots).toHaveLength(0);
}

async function checkAccessAndProviderRefusals(
  admission: NonNullable<Parameters<typeof prepareNightlyMaintenance>[4]>,
  secrets: ReturnType<typeof providerSecrets>, reference: string,
  correctionRevision: string) {
  const missing = await candidateNight('a', { skipGrant: 'model' });
  await expectCandidateRefusal(missing, admission, 'access_denied');
  const behind = await candidateNight('b', { skipReceipt: 'model' });
  await expectCandidateRefusal(behind, admission, 'access_unavailable');
  const wrongPayer = await candidateNight('c', { payingGroupId: 'wrong-payer' });
  await expectCandidateRefusal(wrongPayer, admission, 'access_denied');
  const revoked = await candidateNight('d');
  const revokedEvent = await append(grantStream('model', 'gpt-6-luna'), 'grant.revoked', {
    resourceType: 'model', resourceId: 'gpt-6-luna', granteeKind: 'member',
    granteeId: revoked.ownerId, revokedBy: revoked.ownerId,
  });
  await authorisation.handler.handle(revokedEvent, options.db);
  await expectCandidateRefusal(revoked, admission, 'access_denied');
  const unsupported = await candidateNight('e', { model: 'gpt-6-astra' });
  await expectCandidateRefusal(unsupported, admission, 'provider_unavailable');
  const unpriced = await candidateNight('7', { model: 'unpriced-model' });
  await expectCandidateRefusal(unpriced, admission, 'price_unavailable');
  await secrets.remove(reference);
  const missingKey = await candidateNight('f');
  await expectCandidateRefusal(missingKey, admission, 'provider_unavailable');
  await secrets.save(reference, 'test-only-key');
  await append('mcp-memory', 'mcp.tool_mode_set', {
    serverId: 'memory', connectionId: 'server', toolName: 'correct',
    toolRevision: correctionRevision, mode: 'ask', setBy: 'dreamer',
  });
  const ask = await candidateNight('1');
  await expectCandidateRefusal(ask, admission, 'access_denied');
  await append('mcp-memory', 'mcp.tool_mode_set', {
    serverId: 'memory', connectionId: 'server', toolName: 'correct',
    toolRevision: correctionRevision, mode: 'allow', setBy: 'dreamer',
  });
  await append('mcp-memory', 'mcp.server_published', {
    serverId: 'memory', publishedBy: 'dreamer',
  });
  const deploymentKey = await candidateNight('9');
  await expectCandidateRefusal(deploymentKey, { ...admission, managedCalls: false },
    'provider_unavailable');
  const unqualified = await candidateNight('0');
  function missingQualification() {
    return Promise.reject(new Error('Test qualification unavailable'));
  }
  await expectCandidateRefusal(unqualified,
    { ...admission, qualification: missingQualification }, 'access_unavailable');
}

async function checkBudgetRefusals(
  admission: NonNullable<Parameters<typeof prepareNightlyMaintenance>[4]>,
  firstRoot: BudgetActor['state']['roots'][number]) {
  const { actor } = admission;
  const global = await candidateNight('2');
  await actor.configure({ scope: 'global', dailyCeilingCents: 99,
    ceilingCents: 99, setBy: 'dreamer' });
  await expectCandidateRefusal(global, admission, 'budget_unavailable');
  await actor.configure({ scope: 'global', dailyCeilingCents: 2000,
    ceilingCents: 20000, setBy: 'dreamer' });
  const group = await candidateNight('3');
  await actor.configure({ scope: 'paying_group', scopeId: 'payer',
    ceilingCents: 99, setBy: 'dreamer' });
  await expectCandidateRefusal(group, admission, 'budget_unavailable');
  await actor.configure({ scope: 'paying_group', scopeId: 'payer',
    ceilingCents: 20000, setBy: 'dreamer' });
  const assistant = await candidateNight('4');
  await actor.configure({ scope: 'assistant', scopeId: assistant.assistantId,
    ceilingCents: 99, setBy: 'dreamer' });
  await expectCandidateRefusal(assistant, admission, 'budget_unavailable');

  const race = await candidateNight('5');
  await actor.configure({ scope: 'global', dailyCeilingCents: 100,
    ceilingCents: 100, setBy: 'dreamer' });
  const originalSet = actor.setRootAllowance.bind(actor);
  let reserved = false;
  function fresh() { return Promise.resolve(); }
  async function reserveBeforeAllocation(...args: Parameters<typeof actor.setRootAllowance>) {
    if (!reserved) {
      reserved = true;
      const maintenance = firstRoot.maintenance!;
      const call = { requesterId: firstRoot.requesterId,
        assistantId: firstRoot.assistantId, payingGroupId: firstRoot.payingGroupId,
        conversationId: firstRoot.conversationId, turnId: firstRoot.turnId,
        threadId: firstRoot.threadId, computerId: firstRoot.computerId,
        generation: firstRoot.generation, model: maintenance.model,
        priceTableId: maintenance.priceTableId, providerId: maintenance.providerId,
        bindingSequence: maintenance.bindingSequence, requestId: 'competing-hold',
        contextDigest: '0'.repeat(64) };
      await actor.reserve(call, 1, fresh, firstRoot.position, firstRoot.rootId);
    }
    return originalSet(...args);
  }
  const setSpy = vi.spyOn(actor, 'setRootAllowance').mockImplementation(reserveBeforeAllocation);
  try {
    await expectCandidateRefusal(race, admission, 'budget_unavailable');
  } finally {
    setSpy.mockRestore();
  }
  expect(actor.state.reservations).toHaveLength(1);
  await actor.configure({ scope: 'global', dailyCeilingCents: 2000,
    ceilingCents: 20000, setBy: 'dreamer' });
}

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
  await append('provider-primary', 'provider.created', {
    providerId: 'primary', provider: 'openai', name: 'Primary', revision: 1,
    changedBy: 'dreamer',
  });
  const keyCommand = `night-prepare-${serial + 1}`;
  const reference = providerSecretRef('acme', 'primary', keyCommand);
  const secrets = providerSecrets(`${directory}/providers`);
  await secrets.save(reference, 'test-only-key');
  await append('provider-primary', 'provider.key_saved', {
    providerId: 'primary', revision: 2, changedBy: 'dreamer', secretRef: reference,
  });
  await append('provider-primary', 'provider.models_selected', {
    providerId: 'primary', revision: 3, changedBy: 'dreamer', models: ['gpt-6-luna'],
  });
  await append('budget-acme', 'provider.managed_calls_enabled', {
    providerId: 'primary', revision: 3, changedBy: 'dreamer',
    expectedProviderSequence: 0,
  });
  const definition = losslessJson(JSON.stringify({ name: 'correct',
    inputSchema: { type: 'object' }, annotations: {
      readOnlyHint: false, destructiveHint: false } }));
  const tool = { name: 'correct', revision: definition.digest, reviewed: true,
    readOnly: false, destructive: false, costCents: 0,
    review: { action: 'Correct a saved fact', consequence: 'Replace one fact',
      targetArgument: 'memoryId', fields: ['memoryId'], stepUp: false },
    definition: definition.canonical };
  await append('mcp-memory', 'mcp.server_registered', { serverId: 'memory',
    kind: 'hosted', locator: `registry.example.test/opencrane/server@sha256:${'a'.repeat(64)}`,
    registeredBy: 'dreamer' });
  const checkedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 300_000).toISOString();
  await append('mcp-memory', 'mcp.server_discovered', { serverId: 'memory',
    connectionId: 'server', accountMode: 'none', tools: [tool], toolCount: 1,
    schemaDigest: catalogueDigest([tool]), checkedAt, expiresAt });
  const policy = await readToolPolicy(nats.store, 'acme', 'memory');
  await append('mcp-memory', 'mcp.server_reviewed', { serverId: 'memory',
    catalogueDigest: catalogueDigest([tool]), connectionId: 'server',
    accountMode: 'none', policyRevision: policy.policyRevision, reviewedBy: 'dreamer',
    tools: [{ name: 'correct', revision: tool.revision,
      reviewDigest: toolReviewDigest(tool), mode: 'allow' }] });
  await append('mcp-memory', 'mcp.server_published', {
    serverId: 'memory', publishedBy: 'dreamer',
  });
  const eligible = await candidateNight('6');
  const { ownerId, assistantId, scopeId: eligibleScopeId,
    nightId: eligibleId, due } = eligible;
  function eligibleTime() { return new Date('2026-10-19T02:05:00.000Z'); }
  function stillQualified() {}
  function qualified() { return Promise.resolve({ confirm: stillQualified }); }
  const admission = { actor, secrets, managedCalls: true, qualification: qualified };
  const originalAppend = nats.store.append.bind(nats.store);
  let rootReplyLost = false;
  let replyLost = false;
  async function losePreparedReply(command: Parameters<typeof nats.store.append>[0]) {
    const result = await originalAppend(command);
    const savedEvent = savedEventShape.safeParse(command.event);
    if (!rootReplyLost && savedEvent.success &&
        savedEvent.data.type === 'budget.root_allowance_set') {
      rootReplyLost = true;
      throw new Error('Root reply lost after append');
    }
    if (!replyLost && savedEvent.success &&
        savedEvent.data.type === 'memory.maintenance_recorded' &&
        savedEvent.data.source === 'opencrane-server') {
      replyLost = true;
      throw new Error('Reply lost after append');
    }
    return result;
  }
  const appendSpy = vi.spyOn(nats.store, 'append').mockImplementation(losePreparedReply);
  function prepare(receivedScope: string, receivedNight: string) {
    return prepareNightlyMaintenance(options, receivedScope, receivedNight,
      eligibleTime, admission);
  }
  const httpIdentity = { jwks: { keys: [] }, issuer: 'test' };
  function receive(request: Parameters<typeof maintenanceOrChildRoute>[0],
    response: Parameters<typeof maintenanceOrChildRoute>[1]) {
    void maintenanceOrChildRoute(request, response, 'acme', httpIdentity, undefined, prepare);
  }
  const server = createServer(receive);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server unavailable');
    const handler = memoryPrepareHandler(`http://127.0.0.1:${address.port}`);
    const transaction: Query = { query() { throw new Error('Unexpected database query'); } };
    await expect(handler.handle(due as EventEnvelope, transaction)).rejects.toThrow();
  } finally {
    server.close();
    await once(server, 'close');
  }
  expect(rootReplyLost).toBe(true);
  const afterLostRoot = await prepareNightlyMaintenance(options, eligibleScopeId, eligibleId,
    eligibleTime, admission);
  expect(afterLostRoot).toMatchObject({ outcome: 'unknown', nightId: eligibleId });
  const repeatReads = [
    prepareNightlyMaintenance(options, eligibleScopeId, eligibleId, eligibleTime, admission),
    prepareNightlyMaintenance(options, eligibleScopeId, eligibleId, eligibleTime, admission),
  ];
  const [repeated, concurrent] = await Promise.all(repeatReads);
  expect(repeated).toMatchObject({ outcome: 'prepared', nightId: eligibleId,
    allowanceCents: 100, dispatch: 'disabled' });
  expect(concurrent).toEqual(repeated);
  appendSpy.mockRestore();
  const restartedActor = new BudgetActor(nats.store, 'acme', firstNight);
  await restartedActor.start(2000, 20000, 'payer');
  const restarted = await prepareNightlyMaintenance(options, eligibleScopeId, eligibleId,
    eligibleTime, { ...admission, actor: restartedActor });
  expect(restarted).toEqual(repeated);
  const roots = actor.state.roots.filter(function matchingRoot(root) {
    return root.requesterId === ownerId && root.assistantId === assistantId;
  });
  expect(roots).toHaveLength(1);
  expect(roots[0]).toMatchObject({ payingGroupId: 'payer', allowanceCents: 100 });
  const rootPayload = budgetRootAllowanceSetDataSchema.strip().parse(roots[0]);
  const { rootId: _rootId, ...rootBinding } = rootPayload;
  await expect(actor.setRootAllowance({ ...rootBinding, allowanceCents: 101 }, 1))
    .rejects.toThrow('Invalid maintenance allowance');
  await expect(actor.setRootAllowance({ ...rootBinding, allowanceCents: 100.5 }, 1))
    .rejects.toThrow('Invalid root allowance');
  expect(actor.state.reservations).toHaveLength(0);
  expect(restartedActor.state.roots).toHaveLength(1);
  expect(restartedActor.state.reservations).toHaveLength(0);
  await runner.run(projection);
  const scope = { scopeId: eligibleScopeId, scopeKind: 'person' as const, ownerId };
  const status = await maintenanceStatus(options, scope, ownerId);
  expect(status).toMatchObject({ status: 'preparing', dispatch: 'disabled' });
  expect(status.history[0]).toMatchObject({ action: 'prepared', rootId: roots[0]!.rootId,
    acceptedCapCents: 100 });
  const before = await options.db.query<{ data: unknown }>(
    'SELECT data FROM memory_maintenance_runs WHERE silo=$1 AND scope_id=$2 ORDER BY position',
    ['acme', eligibleScopeId]);
  await runner.rebuild(projection);
  const after = await options.db.query<{ data: unknown }>(
    'SELECT data FROM memory_maintenance_runs WHERE silo=$1 AND scope_id=$2 ORDER BY position',
    ['acme', eligibleScopeId]);
  expect(after.rows).toEqual(before.rows);
  const currentAdmission = { ...admission, actor: restartedActor };
  await checkAccessAndProviderRefusals(currentAdmission, secrets, reference, tool.revision);
  await checkBudgetRefusals(currentAdmission, restartedActor.state.roots[0]!);
  const outboundDuringReplay = vi.spyOn(globalThis, 'fetch');
  outboundDuringReplay.mockRejectedValue(new Error('External call during replay'));
  try {
    const replayActor = new BudgetActor(nats.store, 'acme', firstNight);
    await replayActor.start(2000, 20000, 'payer');
    await runner.rebuild(projection);
    expect(replayActor.state.roots).toHaveLength(1);
    expect(replayActor.state.reservations).toHaveLength(1);
    expect(replayActor.state.reservations[0]).toMatchObject({ amountCents: 1 });
    expect(outboundDuringReplay).not.toHaveBeenCalled();
  } finally {
    outboundDuringReplay.mockRestore();
  }
  const retired = await candidateNight('8');
  const expectedProviderSequence = await nats.store.head('provider-primary');
  await append('provider-primary', 'provider.retired', {
    providerId: 'primary', revision: 3, changedBy: 'dreamer',
    expectedProviderSequence, choices: [],
  });
  await expectCandidateRefusal(retired, currentAdmission, 'provider_unavailable');
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

it('refuses a correction or forgetting after the saved intent', async function changedFact() {
  const correctedNightId = '9'.repeat(64);
  await claimNight('2026-10-20', correctedNightId, 2);
  const oldFact = z.object({ ciphertext: z.string(), keyId: z.string() }).parse(factData);
  await append(`scope-${scopeId}`, 'memory.corrected', {
    scopeId, memoryId: 'fact-one', ...oldFact,
  });
  function correctionNight() { return new Date('2026-10-20T02:05:00.000Z'); }
  const correction = await prepareNightlyMaintenance(options, scopeId,
    correctedNightId, correctionNight);
  expect(correction).toMatchObject({ outcome: 'refused', reason: 'input_changed' });

  const forgottenNightId = '0'.repeat(64);
  await claimNight('2026-10-21', forgottenNightId, 2);
  await append(`scope-${scopeId}`, 'memory.forgotten', { scopeId, memoryId: 'fact-one' });
  function forgettingNight() { return new Date('2026-10-21T02:05:00.000Z'); }
  const forgotten = await prepareNightlyMaintenance(options, scopeId,
    forgottenNightId, forgettingNight);
  expect(forgotten).toMatchObject({ outcome: 'refused', reason: 'input_changed' });
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
