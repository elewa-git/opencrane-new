import { expect, it, onTestFinished, vi } from 'vitest';
import { losslessJson } from '@opencrane/events/lossless-json';
import { buildRecallOffer, privateToolOffer, type TurnToolServerState }
  from '../../server/test/support/private-catalogue.ts';
import { privateRecall } from '../src/private-recall.ts';
import { parseTurn, type ToolServer } from '../src/turn-frame.ts';
import { preflightFixture } from './private-recall-preflight-fixture.ts';

vi.mock('node:net', { spy: true });

type ToolName = 'recall' | 'remember' | 'correct';
const permittedSubsets: { names: ToolName[] }[] = [
  { names: ['recall'] },
  { names: ['remember'] },
  { names: ['correct'] },
  { names: ['recall', 'remember'] },
  { names: ['recall', 'correct'] },
  { names: ['remember', 'correct'] },
  { names: ['recall', 'remember', 'correct'] },
];

async function selectedOffer(names: ToolName[], rememberPolicy = 'block') {
  const offer = privateToolOffer('all')[0]!;
  const state: TurnToolServerState = { serverId: 'memory', connectionId: 'server',
    published: true, accountMode: 'none', serverInfo: offer.serverInfo,
    discoveryTools: [], policyTools: [] };
  for (const name of ['recall', 'remember', 'correct', 'forget'] as const) {
    const definition = privateToolOffer(name)[0]!.definitions[0]!;
    const revision = losslessJson(definition).digest;
    const policy: TurnToolServerState['policyTools'][number] = {
      name, revision, reviewed: true, costCents: 0, mode: 'allow',
    };
    if (name !== 'forget' && !names.includes(name)) {
      policy.mode = 'block';
      if (name === 'remember' && rememberPolicy === 'ask') {
        policy.mode = 'ask';
      }
      if (name === 'remember' && rememberPolicy === 'unreviewed') {
        policy.mode = 'allow';
        policy.reviewed = false;
      }
    }
    const discovered = { name, revision, definition };
    state.discoveryTools.push(discovered);
    state.policyTools.push(policy);
  }
  function readServer() {
    return Promise.resolve(state);
  }
  function canUse() {
    return Promise.resolve(true);
  }
  const input = { rows: [], requesterId: 'alice', assistantId: 'assistant',
    baseMessageBytes: 100, readServer, canUse };
  return buildRecallOffer(input);
}

async function fixture(names: ToolName[], rememberPolicy?: string) {
  const native = await preflightFixture(undefined, undefined, names);
  onTestFinished(native.close);
  const { session, owner } = await native.open();
  const tools = await selectedOffer(names, rememberPolicy);
  const frame = { id: 'first', conversationId: 'chat', assistantId: 'assistant',
    requesterId: 'alice', executionMode: 'restricted', text: 'Hello', token: 'preparing',
    expiresAt: owner.expires, tools };
  const input = parseTurn(frame);
  const identity = { verifier: {}, issuer: 'fixture', silo: 'test', computer: 'computer',
    assistant: 'assistant', generation: 1, podUid: 'pod' };
  function prepare(offered = tools) {
    input.tools = offered;
    return privateRecall(input, owner, session, identity, native.loads);
  }
  return { native, tools, prepare };
}

async function loadsSelectedOffer(names: ToolName[], rememberPolicy?: string) {
  const test = await fixture(names, rememberPolicy);
  const expected: ToolServer = { ...privateToolOffer('recall')[0]!, definitions: [], modes: {} };
  for (const name of names) {
    expected.definitions.push(privateToolOffer(name)[0]!.definitions[0]!);
    expected.modes[name] = 'allow';
  }
  expect(test.tools).toEqual([expected]);
  const recall = test.prepare();
  const { receipt } = await recall.start();
  const load = { ...receipt, type: 'recall_load', tools: test.tools };
  const expectedReceipt = { ...receipt, type: 'recall_loaded' };
  await expect(recall.load(load)).resolves.toEqual(expectedReceipt);
  expect(test.native.mcp.size).toBe(1);
  expect(test.native.received).toContain('mcpServerStatus/list');
  expect(test.native.received).not.toContain('turn/start');
  for (const name of ['recall', 'remember', 'correct', 'forget'] as const) {
    const item = { type: 'mcpToolCall', server: expected.key, tool: name };
    const allowed = name !== 'forget' && names.includes(name);
    expect(recall.permitsItem(item)).toBe(allowed);
  }
}

async function loadsSubset(subset: typeof permittedSubsets[number]) {
  await loadsSelectedOffer(subset.names);
}
it.each(permittedSubsets)('loads exactly the server-selected subset $names', loadsSubset);

async function rememberUnavailable(policy: string) {
  await loadsSelectedOffer(['recall', 'correct'], policy);
}
it.each(['block', 'ask', 'unreviewed'])(
  'loads Recall and Correct when Remember is %s', rememberUnavailable);

const invalidOffers = ['empty', 'too many', 'wrong tool', 'reordered', 'duplicate',
  'ask', 'missing mode', 'extra mode'] as const;
async function refusesInitialOffer(reason: typeof invalidOffers[number]) {
  const test = await fixture(['recall', 'remember', 'correct']);
  const tools = test.tools;
  const server = tools[0]!;
  if (reason === 'empty') {
    server.definitions = [];
    server.modes = {};
  }
  if (reason === 'too many') {
    tools[0] = privateToolOffer('all')[0]!;
  }
  if (reason === 'wrong tool') {
    server.definitions[1] = privateToolOffer('forget')[0]!.definitions[0]!;
    delete server.modes['remember'];
    server.modes['forget'] = 'allow';
  }
  if (reason === 'reordered') {
    server.definitions.reverse();
  }
  if (reason === 'duplicate') {
    server.definitions[1] = server.definitions[0]!;
  }
  if (reason === 'ask') {
    server.modes['correct'] = 'ask';
  }
  if (reason === 'missing mode') {
    delete server.modes['correct'];
  }
  if (reason === 'extra mode') {
    server.modes['forget'] = 'allow';
  }
  function prepare() {
    test.prepare(tools);
  }
  expect(prepare).toThrow('Private recall refused');
  expect(test.native.received).toEqual(['initialize']);
  expect(test.native.mcp.size).toBe(0);
}
it.each(invalidOffers)('refuses an initial %s offer before opening a thread', refusesInitialOffer);
