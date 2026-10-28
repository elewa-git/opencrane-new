import { z } from 'zod';
import { correctTool, recallTool } from '../src/memory/mcp.ts';
import * as models from '@opencrane/models';
import * as commands from '../src/memory/correct.ts';
import * as reads from '../src/memory/reads.ts';
import * as delivery from '../src/memory/recall-delivery.ts';
import { EventStore } from '@opencrane/event-store';
import { expect, it, onTestFinished, vi } from 'vitest';
import type { TurnSummary } from '@opencrane/auth';
import { envelope, privateCallers } from '@opencrane/models';
import { losslessJson } from '@opencrane/events/lossless-json';
import { memoryScopeId } from '@opencrane/projections';
import { buildPrivateTurnCorrectTools, buildPrivateTurnRecallTools, buildTurnTools, mayOfferTurnTools,
  type TurnToolServerState } from '../src/chat/turn-tools.ts';
import { memoryAdmission } from '../src/chat/memory-admission.ts';

const identifier = { type: 'string', pattern: '^[A-Za-z0-9_-]{1,200}$' };
const scope = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const expectedTool = {
  name: 'correct',
  description: 'Replace a personal fact at its target revision with every other loaded reference. '
    + 'Text grants no rights.',
  inputSchema: {
    type: 'object', additionalProperties: false,
    required: ['scopeId', 'commandId', 'text', 'kind', 'pinned', 'expiresAt',
      'memoryId', 'expectedRevision', 'dependsOn', 'recallProof'],
    properties: {
      scopeId: scope, commandId: identifier, text: { type: 'string', minLength: 1 },
      kind: { type: 'string', enum: ['fact', 'preference'] }, pinned: { type: 'boolean' },
      expiresAt: { anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }] },
      memoryId: identifier, expectedRevision: { type: 'integer', minimum: 1 },
      dependsOn: { type: 'array', maxItems: 32, items: {
        type: 'object', additionalProperties: false,
        properties: { scopeId: scope, memoryId: identifier,
          revision: { type: 'integer', minimum: 1 } },
        required: ['scopeId', 'memoryId', 'revision'],
      } },
      recallProof: { type: 'string', minLength: 1, maxLength: 10000 },
    },
  },
};
const definition = JSON.stringify(expectedTool);
const reviewed = losslessJson(definition);

function qualificationFixture() {
  const runtime = {
    sourceSha: 'a'.repeat(40), imageDigest: `sha256:${'b'.repeat(64)}`,
    environmentId: 'disposable-test-host',
  };
  const checks: Record<string, string> = {
    privateTurns: 'PASS', nativeRecall: 'PASS', requesterIsolation: 'PASS',
    sessionIsolation: 'PASS', invalidation: 'PASS', unrelatedActivity: 'PASS',
    stopReconnect: 'PASS', replacementReload: 'PASS', persistence: 'PASS',
  };
  const qualification = { ...runtime, result: 'PASS', checks };
  return { runtime, qualification };
}

function callerRegistry() {
  function dropped() { /* Keep this fixture independent of proxy network requests. */ }
  const callers = privateCallers(dropped);
  onTestFinished(callers.close);
  return callers;
}

function privateBinding() {
  const callers = callerRegistry();
  const grant = {
    silo: 'test', requesterId: 'alice', assistantId: 'assistant', computerId: 'computer',
    conversation: 'conversation', turnId: 'turn', thread: 'thread',
    generation: 1, inputGeneration: 1, expires: Date.now() + 60_000,
  };
  const registration = callers.register(grant);
  registration.bind(grant.thread);
  const data = {
    conversationId: 'conversation', turnId: 'turn', threadId: 'thread',
    requesterId: 'alice', assistantId: 'assistant', computerId: 'computer',
    task: 'chat_turn', executionMode: 'restricted',
  };
  const event = envelope('test', 'computer-assistant', 'computer.turn_started', data);
  event.source = 'opencrane-server';
  const turn: TurnSummary = {
    hasStart: true, firstStart: { sequence: 1, event }, firstClose: undefined,
  };
  return { callers, registration, grant, data, turn };
}

function fixture() {
  const binding = privateBinding();
  const state: TurnToolServerState = {
    serverId: 'memory', connectionId: 'server', published: true, accountMode: 'none',
    serverInfo: { name: 'OpenCrane memory', version: '1' },
    discoveryTools: [{ name: 'correct', revision: reviewed.digest, definition }],
    policyTools: [{ name: 'correct', revision: reviewed.digest, reviewed: true,
      costCents: 0, mode: 'allow' }],
  };
  function read(_serverId: string) { return Promise.resolve(state); }
  function allow(_serverId: string, _kind: 'person' | 'assistant', _subject: string) {
    return Promise.resolve(true);
  }
  const input = {
    ...qualificationFixture(),
    silo: 'test', scopeId: memoryScopeId('test', 'person', 'alice'),
    requesterId: 'alice', assistantId: 'assistant', baseMessageBytes: 100,
    readServer: vi.fn(read), canUse: vi.fn(allow),
    turn: binding.turn as TurnSummary | undefined,
    grant: binding.grant as typeof binding.grant | undefined,
    caller: binding.registration.caller as string | undefined,
    callers: binding.callers,
  };
  return { state, input, binding };
}

const invalidQualifications = [
  'missing evidence', 'failed evidence', 'another image', 'another source', 'another host',
] as const;

async function refusesQualification(change: typeof invalidQualifications[number]) {
  const { input } = fixture();
  let qualification: unknown = input.qualification;
  if (change === 'missing evidence') qualification = undefined;
  if (change === 'failed evidence') input.qualification.result = 'FAIL';
  if (change === 'another image') input.qualification.imageDigest = `sha256:${'c'.repeat(64)}`;
  if (change === 'another source') input.qualification.sourceSha = 'd'.repeat(40);
  if (change === 'another host') input.qualification.environmentId = 'another-host';
  const request = { ...input, qualification };
  expect(await buildPrivateTurnCorrectTools(request)).toEqual([]);
  expect(input.readServer).not.toHaveBeenCalled();
  expect(input.canUse).not.toHaveBeenCalled();
}
it.each(invalidQualifications)('offers no correct with %s', refusesQualification);

async function refusesChangedQualification(stage: 'catalogue' | 'access') {
  const { input, state } = fixture();
  const started = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  async function readServer() {
    started.resolve();
    await resume.promise;
    return state;
  }
  async function canUse() {
    started.resolve();
    await resume.promise;
    return true;
  }
  if (stage === 'catalogue') input.readServer.mockImplementation(readServer);
  if (stage === 'access') input.canUse.mockImplementation(canUse);
  const assembling = buildPrivateTurnCorrectTools(input);
  await started.promise;
  input.qualification.checks['persistence'] = 'FAIL';
  resume.resolve();
  expect(await assembling).toEqual([]);
}
it.each(['catalogue', 'access'] as const)(
  'offers no correct when evidence fails during %s reads', refusesChangedQualification);

const invalidBindings = [
  'no registration', 'no caller', 'another turn caller', 'no grant',
  'another requester grant', 'another turn grant',
  'changed requester and scope', 'changed requester scope and grant', 'changed assistant',
  'changed silo and scope', 'no recorded turn', 'closed turn', 'ordinary turn', 'shared turn',
  'untrusted turn', 'another conversation grant', 'another thread grant', 'another computer grant',
  'another generation grant', 'another input generation grant', 'expired grant', 'closed caller',
  'replaced caller', 'ordinary execution',
] as const;
async function refusesBinding(change: typeof invalidBindings[number]) {
  const { input, binding } = fixture();
  const grant = binding.grant;
  if (change === 'no registration') input.callers = callerRegistry();
  if (change === 'no caller') input.caller = undefined;
  if (change === 'another turn caller') {
    const otherGrant = { ...grant, turnId: 'other-turn', thread: 'other-thread' };
    const otherCaller = binding.callers.register(otherGrant);
    otherCaller.bind(otherGrant.thread);
    input.caller = otherCaller.caller;
  }
  if (change === 'no grant') input.grant = undefined;
  if (change === 'another requester grant') grant.requesterId = 'bob';
  if (change === 'another turn grant') grant.turnId = 'other-turn';
  if (change === 'changed requester and scope' || change === 'changed requester scope and grant') {
    input.requesterId = 'bob';
    input.scopeId = memoryScopeId('test', 'person', 'bob');
  }
  if (change === 'changed requester scope and grant') grant.requesterId = 'bob';
  if (change === 'changed assistant') input.assistantId = 'other-assistant';
  if (change === 'changed silo and scope') {
    input.silo = 'elsewhere';
    input.scopeId = memoryScopeId('elsewhere', 'person', 'alice');
  }
  if (change === 'no recorded turn') input.turn = undefined;
  if (change === 'closed turn') binding.turn.firstClose = { sequence: 2, status: 'completed' };
  if (change === 'ordinary turn') {
    binding.turn.firstStart!.event.data = { ...binding.data, executionMode: 'memory_free' };
  }
  if (change === 'shared turn') {
    binding.turn.firstStart!.event.data = { ...binding.data, sharingClass: 'shared_only' };
  }
  if (change === 'untrusted turn') binding.turn.firstStart!.event.source = 'untrusted';
  if (change === 'another conversation grant') grant.conversation = 'other-conversation';
  if (change === 'another thread grant') grant.thread = 'other-thread';
  if (change === 'another computer grant') grant.computerId = 'other-computer';
  if (change === 'another generation grant') grant.generation = 2;
  if (change === 'another input generation grant') grant.inputGeneration = 2;
  if (change === 'expired grant') grant.expires = Date.now() - 1;
  if (change === 'closed caller') binding.registration.close();
  if (change === 'ordinary execution') {
    binding.turn.firstStart!.event.data = { ...binding.data, executionMode: undefined };
  }
  if (change === 'replaced caller') {
    binding.callers.close();
    input.callers = callerRegistry();
    const replacement = input.callers.register(grant);
    replacement.bind(grant.thread);
  }
  expect(await buildPrivateTurnCorrectTools(input)).toEqual([]);
  expect(input.readServer).not.toHaveBeenCalled();
  expect(input.canUse).not.toHaveBeenCalled();
}
it.each(invalidBindings)('offers no correct with %s', refusesBinding);

async function closesDuringAssembly(stage: 'catalogue' | 'access') {
  const { input, binding, state } = fixture();
  function readServer() {
    binding.registration.close();
    return Promise.resolve(state);
  }
  function canUse() {
    binding.registration.close();
    return Promise.resolve(true);
  }
  if (stage === 'catalogue') input.readServer.mockImplementation(readServer);
  if (stage === 'access') input.canUse.mockImplementation(canUse);
  expect(await buildPrivateTurnCorrectTools(input)).toEqual([]);
}
it.each(['catalogue', 'access'] as const)(
  'offers no correct when the caller closes during %s checks', closesDuringAssembly);

async function selectsCorrect() {
  const { state, input } = fixture();
  state.discoveryTools.push({ name: 'recall', revision: reviewed.digest, definition });
  state.policyTools.push({ name: 'recall', revision: reviewed.digest, reviewed: true,
    costCents: 0, mode: 'allow' });
  const correct = vi.spyOn(commands, 'correct');
  const facts = vi.spyOn(reads, 'listFacts');
  const context = vi.spyOn(delivery, 'readRecallContext');
  const append = vi.spyOn(EventStore.prototype, 'append');
  const dispatch = vi.spyOn(models, 'startDecision');
  function restoreSpies() { vi.restoreAllMocks(); }
  onTestFinished(restoreSpies);
  const tools = await buildPrivateTurnCorrectTools(input);
  expect(correct).not.toHaveBeenCalled();
  expect(facts).not.toHaveBeenCalled();
  expect(context).not.toHaveBeenCalled();
  expect(append).not.toHaveBeenCalled();
  expect(dispatch).not.toHaveBeenCalled();
  expect(tools).toHaveLength(1);
  expect(tools[0]).toMatchObject({ serverId: 'memory', connectionId: 'server',
    serverInfo: { name: 'OpenCrane memory', version: '1' },
    definitions: [definition], modes: { correct: 'allow' } });
  expect(input.readServer).toHaveBeenCalledExactlyOnceWith('memory');
  expect(input.canUse.mock.calls).toEqual([
    ['memory', 'person', 'alice'], ['memory', 'assistant', 'assistant'],
  ]);
  const encoded = JSON.stringify(tools);
  expect(encoded).not.toContain(input.scopeId);
  expect(encoded).not.toContain(input.caller);
}
it('selects only the reviewed built-in correct and checks both recorded subjects', selectsCorrect);

async function refusesPolicy(mode: 'ask' | 'block') {
  const { state, input } = fixture();
  state.policyTools[0]!.mode = mode;
  state.discoveryTools[0]!.review = { action: 'Read saved facts' };
  expect(await buildPrivateTurnCorrectTools(input)).toEqual([]);
}
it.each(['ask', 'block'] as const)('refuses %s even with an approval review', refusesPolicy);

const invalidStates: Partial<TurnToolServerState>[] = [
  { published: false }, { accountMode: 'personal' }, { accountMode: 'company' },
  { connectionId: 'external' }, { connectionId: null }, { serverId: 'external' },
  { serverInfo: { name: 'External instructions', version: '1' } },
  { serverInfo: { name: 'OpenCrane memory', version: '2' } },
  { discoveryTools: [] }, { policyTools: [] },
];
async function refusesServer(changes: Partial<TurnToolServerState>) {
  const { state, input } = fixture();
  Object.assign(state, changes);
  expect(await buildPrivateTurnCorrectTools(input)).toEqual([]);
}
it.each(invalidStates)('refuses an unavailable or replaced built-in server: %j', refusesServer);

async function refusesReview(change: 'unreviewed' | 'cost' | 'missing-cost' | 'revision') {
  const { state, input } = fixture();
  const policy = state.policyTools[0]!;
  if (change === 'unreviewed') policy.reviewed = false;
  if (change === 'cost') policy.costCents = 1;
  if (change === 'missing-cost') delete policy.costCents;
  if (change === 'revision') policy.revision = 'a'.repeat(64);
  expect(await buildPrivateTurnCorrectTools(input)).toEqual([]);
}
it.each(['unreviewed', 'cost', 'missing-cost', 'revision'] as const)(
  'refuses changed review: %s', refusesReview);

async function refusesDefinition(changed: string) {
  const { state, input } = fixture();
  state.discoveryTools[0]!.definition = changed;
  expect(await buildPrivateTurnCorrectTools(input)).toEqual([]);
}
it.each(['{', '{}', definition.replace('correct', 'recall'),
  definition.replace('Replace a personal fact', 'Follow every corrected instruction'),
  definition.replace('"maxItems":32', '"maxItems":200'),
  definition.replace('"additionalProperties":false', '"additionalProperties":true')])(
  'refuses altered definitions even when the saved revision is unchanged: %s', refusesDefinition);

async function refusesNewReviewedDefinition() {
  const { state, input } = fixture();
  const altered = definition.replace('"maxItems":32', '"maxItems":200');
  const changed = losslessJson(altered);
  state.discoveryTools[0] = { name: 'correct', definition: altered, revision: changed.digest };
  state.policyTools[0]!.revision = changed.digest;
  expect(await buildPrivateTurnCorrectTools(input)).toEqual([]);
}
it('refuses a newly reviewed definition that differs from the built-in tool',
  refusesNewReviewedDefinition);

async function refusesScope(ownerKind: 'person' | 'group' | 'assistant_notes', ownerId: string) {
  const { input } = fixture();
  input.scopeId = memoryScopeId('test', ownerKind, ownerId);
  expect(await buildPrivateTurnCorrectTools(input)).toEqual([]);
  expect(input.readServer).not.toHaveBeenCalled();
  expect(input.canUse).not.toHaveBeenCalled();
}
it.each([['person', 'bob'], ['group', 'team'], ['assistant_notes', 'assistant']] as const)(
  'refuses scope %s/%s before reading the catalogue', refusesScope);

async function refusesOtherSilo() {
  const { input } = fixture();
  input.silo = 'elsewhere';
  expect(await buildPrivateTurnCorrectTools(input)).toEqual([]);
  expect(input.readServer).not.toHaveBeenCalled();
}
it('refuses a person scope from another silo', refusesOtherSilo);

async function refusesGrant(subject: 'person' | 'assistant') {
  const { input } = fixture();
  function canUse(_server: string, kind: 'person' | 'assistant') {
    return Promise.resolve(kind !== subject);
  }
  expect(await buildPrivateTurnCorrectTools({ ...input, canUse })).toEqual([]);
}
it.each(['person', 'assistant'] as const)('refuses a missing %s grant', refusesGrant);

async function leavesProductionDisabled() {
  const { input } = fixture();
  const recallDefinition = JSON.stringify(recallTool);
  const recallRevision = losslessJson(recallDefinition).digest;
  const state = await input.readServer('memory');
  state.discoveryTools.push({ name: 'recall', revision: recallRevision,
    definition: recallDefinition });
  state.policyTools.push({ name: 'recall', revision: recallRevision, reviewed: true,
    costCents: 0, mode: 'allow' });
  const recallInput = { ...input, ...qualificationFixture() };
  const qualifiedRecall = await buildPrivateTurnRecallTools(recallInput);
  expect(qualifiedRecall[0]?.definitions).toEqual([recallDefinition]);
  expect(qualifiedRecall[0]?.modes).toEqual({ recall: 'allow' });
  const rows = [{ serverId: 'memory' }];
  expect(await buildTurnTools({ ...input, rows })).toEqual([]);
  expect(mayOfferTurnTools('personal', 'restricted', true)).toBe(false);
  expect(memoryAdmission.state).toBe('disabled');
}
it('keeps production correct unavailable even with qualified personal recall', leavesProductionDisabled);

async function refusesAmbiguousCorrect(kind: 'definition' | 'policy') {
  const { state, input } = fixture();
  if (kind === 'definition') state.discoveryTools.push(state.discoveryTools[0]!);
  if (kind === 'policy') state.policyTools.push(state.policyTools[0]!);
  expect(await buildPrivateTurnCorrectTools(input)).toEqual([]);
}
it.each(['definition', 'policy'] as const)(
  'refuses duplicate correct %s entries', refusesAmbiguousCorrect);

function correctRequest(argumentsValue: Record<string, unknown>) {
  const metadata = { threadId: 'thread', callId: 'call',
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientCapabilities': {} };
  const body = { jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'correct', arguments: argumentsValue, _meta: metadata } };
  const headers = { 'mcp-protocol-version': '2026-07-28',
    'mcp-method': 'tools/call', 'mcp-name': 'correct' };
  return models.parseMemoryRequest(JSON.stringify(body), headers);
}
function checksCorrectInput() {
  const scopeId = memoryScopeId('test', 'person', 'alice');
  const input = { scopeId, commandId: 'save', text: 'Use UK English.', kind: 'preference',
    pinned: true, expiresAt: null, memoryId: 'target', expectedRevision: 2,
    dependsOn: [{ scopeId, memoryId: 'fact', revision: 1 }], recallProof: 'test-proof' };
  expect(correctTool).toEqual(expectedTool);
  const schema = z.fromJSONSchema(correctTool.inputSchema);
  expect(schema.safeParse(input).success).toBe(true);
  expect(correctRequest(input).input).toEqual({ operation: 'correct', ...input });
  for (const field of ['ownerId', 'operation', 'requesterId', 'sources', 'unexpected']) {
    const unsupported = { ...input, [field]: 'extra' };
    expect(schema.safeParse(unsupported).success).toBe(false);
    function parseUnsupported() { return correctRequest(unsupported); }
    expect(parseUnsupported).toThrow();
  }
  for (const field of expectedTool.inputSchema.required) {
    const missing = { ...input };
    Reflect.deleteProperty(missing, field);
    expect(schema.safeParse(missing).success).toBe(false);
    function parseMissing() { return correctRequest(missing); }
    expect(parseMissing).toThrow();
  }
  const extraDependency = { ...input.dependsOn[0], text: 'unsupported' };
  expect(schema.safeParse({ ...input, dependsOn: [extraDependency] }).success).toBe(false);
}
it('describes the existing strict correct input without accepting extra fields', checksCorrectInput);
