import { expect, it, onTestFinished, vi } from 'vitest';
import { privateCallers } from '@opencrane/models/private-callers';
import { losslessJson } from '@opencrane/events/lossless-json';
import { privateCatalogue, privateToolOffer } from './support/private-catalogue.ts';
import { buildPrivateTurnMemoryTools, checkPrivateTurnTools } from '../src/chat/turn-tools.ts';

async function fixture() {
  function dropped() { /* No proxy is needed for server assembly. */ }
  const callers = privateCallers(dropped);
  onTestFinished(callers.close);
  const grant = { silo: 'test', requesterId: 'alice', assistantId: 'assistant',
    computerId: 'computer', conversation: 'chat', turnId: 'turn', thread: 'thread',
    generation: 1, inputGeneration: 1, expires: Date.now() + 60_000 };
  const registration = callers.register(grant);
  registration.bind(grant.thread);
  const prepared = await privateCatalogue(callers, registration.caller, grant, 'all');
  return { ...prepared, registration };
}

async function orderedCatalogue() {
  const { input, state } = await fixture();
  state.discoveryTools.reverse();
  state.policyTools.reverse();
  input.readServer = vi.fn(input.readServer);
  input.canUse = vi.fn(input.canUse);
  const tools = await buildPrivateTurnMemoryTools(input);
  expect(tools).toEqual(privateToolOffer('all'));
  expect(input.readServer).toHaveBeenCalledExactlyOnceWith('memory');
  expect(input.canUse).toHaveBeenCalledTimes(2);
  expect(input.canUse).toHaveBeenNthCalledWith(1, 'memory', 'person', 'alice');
  expect(input.canUse).toHaveBeenNthCalledWith(2, 'memory', 'assistant', 'assistant');
  expect(checkPrivateTurnTools(tools, { caller: input.caller, grant: input.grant })).toBe(true);
}
it('prepares all four exact definitions in fixed order with one pair of permission checks',
  orderedCatalogue);

async function omitsOperation(change: string) {
  const { input, state } = await fixture();
  const policy = state.policyTools[1]!;
  const discovered = state.discoveryTools[1]!;
  if (change === 'Ask') policy.mode = 'ask';
  if (change === 'Block') policy.mode = 'block';
  if (change === 'unreviewed') policy.reviewed = false;
  if (change === 'paid') policy.costCents = 1;
  if (change === 'missing cost') delete policy.costCents;
  if (change === 'absent policy') state.policyTools.splice(1, 1);
  if (change === 'absent definition') state.discoveryTools.splice(1, 1);
  if (change === 'duplicate policy') state.policyTools.push({ ...policy });
  if (change === 'duplicate definition') state.discoveryTools.push({ ...discovered });
  if (change === 'discovery revision') discovered.revision = 'changed';
  if (change === 'policy revision') policy.revision = 'changed';
  if (change === 'schema' || change === 'reviewed schema') {
    discovered.definition = discovered.definition!.replace('"additionalProperties":false',
      '"additionalProperties":true');
    if (change === 'reviewed schema') {
      discovered.revision = losslessJson(discovered.definition).digest;
      policy.revision = discovered.revision;
    }
  }
  const tools = await buildPrivateTurnMemoryTools(input);
  const expected = privateToolOffer('all');
  expected[0]!.definitions.splice(1, 1);
  delete expected[0]!.modes['remember'];
  expect(tools).toEqual(expected);
}
it.each(['Ask', 'Block', 'unreviewed', 'paid', 'missing cost', 'absent policy',
  'absent definition', 'duplicate policy', 'duplicate definition', 'discovery revision',
  'policy revision', 'schema', 'reviewed schema'])(
  'omits only the affected operation with %s', omitsOperation);

async function partialPolicies() {
  const { input, state } = await fixture();
  state.policyTools[0]!.mode = 'ask';
  state.policyTools[2]!.mode = 'block';
  const tools = await buildPrivateTurnMemoryTools(input);
  expect(tools[0]!.modes).toEqual({ remember: 'allow', forget: 'allow' });
  state.policyTools = [];
  expect(await buildPrivateTurnMemoryTools(input)).toEqual([]);
}
it('keeps permitted entries from partial policies and refuses an empty catalogue', partialPolicies);

async function refusesGrant(denied: 'person' | 'assistant') {
  const { input } = await fixture();
  function canUse(_server: string, kind: 'person' | 'assistant') {
    return Promise.resolve(kind !== denied);
  }
  input.canUse = vi.fn(canUse);
  expect(await buildPrivateTurnMemoryTools(input)).toEqual([]);
  expect(input.canUse).toHaveBeenCalledTimes(denied === 'person' ? 1 : 2);
}
it.each(['person', 'assistant'] as const)('offers nothing without the %s MCP grant', refusesGrant);

async function byteLimits() {
  const { input, tools, state } = await fixture();
  const bytes = Buffer.byteLength(JSON.stringify(tools), 'utf8');
  input.baseMessageBytes = 120 * 1024 - Buffer.byteLength(',"tools":[]') - bytes;
  expect(await buildPrivateTurnMemoryTools(input)).toEqual(tools);
  input.baseMessageBytes++;
  expect(await buildPrivateTurnMemoryTools(input)).toEqual([]);
  input.baseMessageBytes = 100;
  // Exercise the 48 KiB limit without changing the reviewed JSON definition.
  state.discoveryTools[0]!.definition += ' '.repeat(24 * 1024);
  state.discoveryTools[1]!.definition += ' '.repeat(24 * 1024);
  expect(await buildPrivateTurnMemoryTools(input)).toEqual([]);
}
it('enforces the combined turn byte boundary and the 48 KiB tool limit', byteLimits);

async function staleAfterWait(stage: 'catalogue' | 'person' | 'assistant', change: string) {
  const { input, state, registration } = await fixture();
  const reached = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  async function hold() {
    reached.resolve();
    await release.promise;
  }
  async function readServer() {
    if (stage === 'catalogue') await hold();
    return state;
  }
  async function canUse(_server: string, kind: 'person' | 'assistant') {
    if (stage === kind) await hold();
    return true;
  }
  input.readServer = readServer;
  input.canUse = canUse;
  const pending = buildPrivateTurnMemoryTools(input);
  await reached.promise;
  if (change === 'qualification') input.qualification.checks.persistence = 'FAIL';
  if (change === 'caller') registration.close();
  if (change === 'generation') input.grant.generation++;
  if (change === 'input generation') input.grant.inputGeneration++;
  release.resolve();
  expect(await pending).toEqual([]);
}
const waits: ['catalogue' | 'person' | 'assistant', string][] = [];
for (const stage of ['catalogue', 'person', 'assistant'] as const) {
  for (const change of ['qualification', 'caller', 'generation', 'input generation']) {
    waits.push([stage, change]);
  }
}
it.each(waits)('refuses changed %s preparation after %s changes', staleAfterWait);
