import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { expect } from 'vitest';
import { codexConnection } from '../../apps/computer/src/codex-connection.ts';
import { recallAnswerCheck } from './native-recall-checks.ts';

type Driver = Parameters<typeof recallAnswerCheck>[4];
type Observation = Awaited<ReturnType<Driver['read']>>;

export function fixture() {
  const answer: string = randomUUID();
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
    completed: true, early: false, otherTurnMessage: false, otherTurnDelta: false,
    answerDeltas: [] as string[],
    reads: 0, failRead: false, beforeRead() {}, afterLoaded() {} };
  function read() {
    state.reads += 1;
    state.beforeRead();
    if (state.failRead) {
      throw new Error(answer);
    }
    return Promise.resolve(structuredClone(observed));
  }
  function current() {
    return state.now;
  }
  function protectedHost() {
    return state.safe;
  }
  async function dispatch(input: string, loaded: () => Promise<boolean>,
    receive: (value: unknown) => void) {
    state.dispatches += 1;
    expect(input.includes(answer)).toBe(false);
    // Exercise the production decoder with scripted native notifications, never a model call.
    const outgoing = new PassThrough();
    const incoming = new PassThrough();
    function failed() {
    throw new Error('fixture_failed');
  }
    const handlers = { message: receive, failed };
    codexConnection(outgoing, incoming, handlers);
    try {
      const started = { threadId: state.nativeThread, turn: { id: state.nativeTurn } };
      incoming.write(JSON.stringify({ method: 'turn/started', params: started }) + '\n');
      if (state.early) {
        const params = { threadId: state.nativeThread, delta: state.reply };
        incoming.write(JSON.stringify({ method: 'item/agentMessage/delta', params }) + '\n');
      }
      if (state.save) {
        observed.references = [{ ...reference }];
      }
      if (!await loaded()) {
        return 'native-turn';
      }
      state.afterLoaded();
      if (state.otherTurnMessage) {
        const item = { id: 'other-reply', type: 'agentMessage', text: 'another turn' };
        const params = { threadId: state.nativeThread, turnId: 'other-turn', item };
        incoming.write(JSON.stringify({ method: 'item/completed', params }) + '\n');
      }
      if (state.otherTurnDelta) {
        const params = { threadId: state.nativeThread, turnId: 'other-turn',
          itemId: 'other-reply', delta: 'another turn' };
        incoming.write(JSON.stringify({ method: 'item/agentMessage/delta', params }) + '\n');
      }
      for (const delta of state.answerDeltas) {
        const params = { threadId: state.nativeThread, turnId: state.nativeTurn,
          itemId: 'reply', delta };
        incoming.write(JSON.stringify({ method: 'item/agentMessage/delta', params }) + '\n');
      }
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
  const check = recallAnswerCheck(binding, reference, answer, question, driver, []);
  return { answer, question, binding, reference, observed, state, driver, check };
}
