import { expect, it, onTestFinished } from 'vitest';
import { privateCallers } from '@opencrane/models/private-callers';
import { privateCatalogue, checkPrivateTurnTools } from './support/private-catalogue.ts';
import { buildPrivateTurnRecallTools, buildPrivateTurnRememberTools }
  from '../src/chat/turn-tools.ts';

type MemoryName = 'recall' | 'remember';
type AssemblyInput = Parameters<typeof buildPrivateTurnRecallTools>[0];

async function fixture(name: MemoryName, bound = true) {
  function dropped() { /* No proxy is needed to check catalogue approval. */ }
  const callers = privateCallers(dropped);
  onTestFinished(callers.close);
  const grant = { silo: 'test', requesterId: 'alice', assistantId: 'assistant',
    computerId: 'computer', turnId: 'turn', conversation: 'chat', thread: 'native-thread',
    generation: 1, inputGeneration: 1, expires: Date.now() + 60_000 };
  const registrationIdentity = { turnId: grant.turnId, conversation: grant.conversation,
    generation: grant.generation, inputGeneration: grant.inputGeneration, expires: grant.expires };
  const registration = callers.register(registrationIdentity);
  if (bound) registration.bind(grant.thread);
  const caller = registration.caller;
  const approved = await privateCatalogue(callers, caller, grant, name);
  const input: AssemblyInput = approved.input;
  const identity = { caller, grant: { ...grant } };
  return { ...approved, input, identity };
}

async function refusesSuppliedIdentity(name: MemoryName, field: string) {
  const test = await fixture(name);
  expect(checkPrivateTurnTools(test.tools, test.identity)).toBe(true);
  const grant = test.identity.grant;
  if (field === 'silo') grant.silo = 'another-silo';
  if (field === 'computer') grant.computerId = 'another-computer';
  if (field === 'expiry') grant.expires += 1000;
  if (field === 'caller') test.identity.caller = 'another-caller';
  expect(checkPrivateTurnTools(test.tools, test.identity)).toBe(false);
}
const suppliedCases: [MemoryName, string][] = [];
for (const name of ['recall', 'remember'] as const) {
  for (const field of ['silo', 'computer', 'expiry', 'caller']) suppliedCases.push([name, field]);
}
it.each(suppliedCases)('refuses %s approval for a different supplied %s', refusesSuppliedIdentity);

async function refusesList(name: MemoryName, change: string) {
  const test = await fixture(name);
  let tools = test.tools;
  if (change === 'copied list') tools = structuredClone(tools);
  if (change === 'changed definitions') tools[0]!.definitions = ['{"name":"shell"}'];
  if (change === 'changed mode') tools[0]!.modes[name] = 'ask';
  expect(checkPrivateTurnTools(tools, test.identity)).toBe(false);
}
const listCases: [MemoryName, string][] = [];
for (const name of ['recall', 'remember'] as const) {
  for (const change of ['copied list', 'changed definitions', 'changed mode']) {
    listCases.push([name, change]);
  }
}
it.each(listCases)('refuses %s approval on a %s', refusesList);

async function refusesChangedApprovalInput(name: MemoryName, change: string) {
  const test = await fixture(name);
  if (change === 'missing caller') test.input.caller = undefined;
  if (change === 'missing grant') test.input.grant = undefined;
  if (change === 'changed expiry') test.input.grant!.expires += 1000;
  expect(checkPrivateTurnTools(test.tools, test.identity)).toBe(false);
}
const inputCases: [MemoryName, string][] = [];
for (const name of ['recall', 'remember'] as const) {
  for (const change of ['missing caller', 'missing grant', 'changed expiry']) {
    inputCases.push([name, change]);
  }
}
it.each(inputCases)('refuses %s approval after %s in its original input', refusesChangedApprovalInput);

async function refusesUnbound(name: MemoryName) {
  const test = await fixture(name, false);
  expect(test.tools).toEqual([]);
  expect(checkPrivateTurnTools(test.tools, test.identity)).toBe(false);
}
it.each(['recall', 'remember'] as const)(
  'refuses %s assembly with a registered caller that has no bound native thread', refusesUnbound);

async function refusesAbsentInput(name: MemoryName, field: 'caller' | 'grant', stage: string) {
  const test = await fixture(name);
  const input = test.input;
  const readServer = input.readServer;
  function removeField() { input[field] = undefined; }
  async function readThenRemove(serverId: string) {
    const state = await readServer(serverId);
    removeField();
    return state;
  }
  if (stage === 'before assembly') removeField();
  else input.readServer = readThenRemove;
  let tools;
  if (name === 'recall') tools = await buildPrivateTurnRecallTools(input);
  else tools = await buildPrivateTurnRememberTools(input);
  expect(tools).toEqual([]);
}
const absentCases: [MemoryName, 'caller' | 'grant', string][] = [];
for (const name of ['recall', 'remember'] as const) {
  for (const field of ['caller', 'grant'] as const) {
    for (const stage of ['before assembly', 'during assembly']) absentCases.push([name, field, stage]);
  }
}
it.each(absentCases)('refuses %s when %s disappears %s', refusesAbsentInput);
