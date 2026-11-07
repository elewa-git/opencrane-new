import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { expect, it } from 'vitest';
import { codexConnection } from '../../apps/computer/src/codex-connection.ts';
import { recallAnswerCheck } from './native-recall-checks.ts';

type Driver = Parameters<typeof recallAnswerCheck>[4];
type Observation = Awaited<ReturnType<Driver['read']>>;

function fixture() {
  const answer = randomUUID();
  const question = 'Which destination did I save?';
  const binding = { sourceSha: 'a'.repeat(40), imageDigest: `sha256:${'b'.repeat(64)}`,
    siloId: `sha256:${'c'.repeat(64)}`, installationId: `sha256:${'d'.repeat(64)}`,
    challengeId: randomUUID(), requesterId: 'alice', conversationId: 'conversation',
    turnId: 'turn', threadId: 'thread', generation: 1, inputGeneration: 1,
    processId: '123:456' };
  const reference = { scopeId: 'own-person', memoryId: 'destination', revision: 1 };
  const observed: Observation = { binding: { ...binding }, current: { ...reference },
    references: [], active: true, fresh: true, expiresAt: 2000,
    nativeDigest: '1748767b230ebfc3d4ab7e4e254920d0c0ad9691fd8c11f190e7d44511a4a92e' };
  const state = { now: 1000, safe: true, dispatches: 0, native: true, save: true,
    reply: answer, nativeThread: binding.threadId, nativeTurn: 'native-turn',
    completed: true, reads: 0, failRead: false, beforeRead() {}, afterLoaded() {} };
  async function read() {
    state.reads += 1;
    state.beforeRead();
    if (state.failRead) throw new Error(answer);
    return structuredClone(observed);
  }
  function current() { return state.now; }
  function protectedHost() { return state.safe; }
  async function dispatch(input: string, loaded: () => Promise<boolean>,
    receive: (value: unknown) => void) {
    state.dispatches += 1;
    expect(input.includes(answer)).toBe(false);
    if (state.save) observed.references = [{ ...reference }];
    if (!await loaded()) return 'native-turn';
    state.afterLoaded();
    // Exercise the production decoder with scripted native notifications, never a model call.
    const outgoing = new PassThrough();
    const incoming = new PassThrough();
    function failed() { throw new Error('fixture_failed'); }
    const handlers = { message: receive, failed };
    codexConnection(outgoing, incoming, handlers);
    try {
      if (state.native) {
        const item = { id: 'reply', type: 'agentMessage', text: state.reply };
        const params = { threadId: state.nativeThread, turnId: state.nativeTurn, item };
        incoming.write(JSON.stringify({ method: 'item/completed', params }) + '\n');
        if (state.completed) {
          const turn = { id: state.nativeTurn, status: 'completed' };
          const params = { threadId: state.nativeThread, turn };
          incoming.write(JSON.stringify({ method: 'turn/completed', params }) + '\n');
        }
      }
    } finally {
      incoming.destroy();
      outgoing.destroy();
    }
    return 'native-turn';
  }
  const driver = { read, now: current, protectedHost, dispatch };
  const check = recallAnswerCheck(binding, reference, answer, question, driver);
  return { answer, question, binding, reference, observed, state, driver, check };
}
const partial = { result: 'PARTIAL', complete: false };
const refused = { result: 'FAIL', reason: 'journey_failed', complete: false };

async function acceptsNativeAnswer() {
  const test = fixture();
  expect(await test.check()).toEqual(partial);
  expect(test.state.dispatches).toBe(1);
  expect(await test.check()).toEqual(refused);
  expect(test.state.dispatches).toBe(1);
}
it('checks generated native output and saved own-person evidence once', acceptsNativeAnswer);

type Fixture = ReturnType<typeof fixture>;
const faults: [string, (test: Fixture) => void][] = [
  ['question only', function questionOnly(test) { test.state.reply = test.question; }],
  ['echo', function echo(test) { test.state.reply = `You asked: ${test.question}`; }],
  ['no native output', function absent(test) { test.state.native = false; }],
  ['unfinished native turn', function unfinished(test) { test.state.completed = false; }],
  ['missing saved reference', function missing(test) { test.state.save = false; }],
  ['foreign requester', function foreign(test) { test.observed.binding.requesterId = 'bob'; }],
  ['replaced thread', function replaced(test) { test.observed.binding.threadId = 'replacement'; }],
  ['stopped thread', function stopped(test) { test.observed.active = false; }],
  ['used thread', function used(test) { test.observed.fresh = false; }],
  ['stale grant', function stale(test) { test.observed.expiresAt = test.state.now; }],
  ['wrong revision', function revision(test) { test.observed.current!.revision += 1; }],
  ['forgotten fact', function forgotten(test) { test.observed.current = undefined; }],
  ['replaced native', function native(test) { test.observed.nativeDigest = 'replaced'; }],
  ['foreign native thread', function foreignNative(test) { test.state.nativeThread = 'other'; }],
  ['foreign native turn', function foreignTurn(test) { test.state.nativeTurn = 'other'; }],
  ['lost evidence append', function lost(test) { test.state.failRead = true; }],
  ['late answer', function late(test) {
    test.state.afterLoaded = function expire() { test.state.now = 2000; };
  }],
  ['changed protection', function protection(test) {
    test.state.afterLoaded = function change() { test.state.safe = false; };
  }],
  ['wrong loaded reference', function wrong(test) {
    test.state.beforeRead = function change() {
      if (test.state.reads === 2) test.observed.references[0]!.memoryId = 'foreign';
    };
  }],
  ['changed revision after delivery', function revisionAfter(test) {
    test.state.afterLoaded = function change() { test.observed.current!.revision += 1; };
  }],
];
async function refusesFault(_name: string, mutate: (test: Fixture) => void) {
  const test = fixture();
  mutate(test);
  expect(await test.check()).toEqual(refused);
  expect(await test.check()).toEqual(refused);
  expect(test.state.dispatches <= 1).toBe(true);
}
it.each(faults)('refuses %s without redispatch or private diagnostics', refusesFault);

const identities = ['sourceSha', 'imageDigest', 'siloId', 'installationId', 'challengeId',
  'conversationId', 'turnId', 'processId'] as const;
async function refusesCopied(identity: typeof identities[number]) {
  const test = fixture();
  test.observed.binding[identity] = 'copied';
  expect(await test.check()).toEqual(refused);
  expect(test.state.dispatches).toBe(0);
}
it.each(identities)('binds the check to %s', refusesCopied);

async function refusesConcurrent() {
  const test = fixture();
  const first = test.check();
  expect(await test.check()).toEqual(refused);
  expect(await first).toEqual(refused);
  expect(test.state.dispatches).toBe(0);
}
it('refuses overlapping use without dispatching again', refusesConcurrent);

async function separatesCallers() {
  const alice = fixture();
  const bob = fixture();
  bob.binding.requesterId = 'bob';
  bob.observed.binding.requesterId = 'bob';
  const bobCheck = recallAnswerCheck(bob.binding, bob.reference, bob.answer,
    bob.question, bob.driver);
  alice.state.reply = bob.answer;
  bob.state.reply = alice.answer;
  const outcomes = await Promise.all([alice.check(), bobCheck()]);
  expect(outcomes).toEqual([refused, refused]);
  expect(alice.state.dispatches).toBe(1);
  expect(bob.state.dispatches).toBe(1);
}
it('refuses swapped answers from concurrent requesters', separatesCallers);

async function correctedNewTurn() {
  const test = fixture();
  test.reference.revision = 2;
  test.observed.current = { ...test.reference };
  test.binding.threadId = 'fresh-thread';
  test.observed.binding = { ...test.binding };
  const check = recallAnswerCheck(test.binding, test.reference, test.answer,
    test.question, test.driver);
  test.state.nativeThread = test.binding.threadId;
  expect(await check()).toEqual(partial);
  expect(await test.check()).toEqual(refused);
}
it('uses the corrected revision in a new thread and refuses the old expectation', correctedNewTurn);

async function refusesLeakedQuestion() {
  const test = fixture();
  const check = recallAnswerCheck(test.binding, test.reference, test.answer,
    test.answer, test.driver);
  expect(await check()).toEqual(refused);
  expect(test.state.dispatches).toBe(0);
}
it('refuses a question containing the saved answer', refusesLeakedQuestion);
