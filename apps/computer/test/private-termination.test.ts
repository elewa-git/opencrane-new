import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { fixture } from './bridge-gate-fixture.ts';
import { reportJournal, wireReport } from '../src/report-journal.ts';

type Computer = Awaited<ReturnType<typeof fixture>>;
type Termination = 'failed notification' | 'thread/closed' | 'session EOF'
  | 'turn/start timeout' | 'restricted tool';

function output(test: Computer, text: string) {
  const threadId = 'thread-1';
  test.channel.notification({ method: 'item/agentMessage/delta',
    params: { threadId, itemId: 'reply', delta: text } });
  test.channel.notification({ method: 'item/reasoning/summaryTextDelta',
    params: { threadId, delta: text } });
  test.channel.notification({ method: 'item/completed', params: {
    threadId, item: { id: 'reply', type: 'agentMessage', text } } });
}

async function start(test: Computer) {
  test.start('first', 'restricted');
  function running() {
    expect(test.calls).toContain('turn/start:thread-1');
  }
  await vi.waitFor(running);
  await test.flush();
}

function holdStartReply(test: Computer) {
  const response = Promise.withResolvers<unknown>();
  const createSession = test.driver.privateSession!.bind(test.driver);
  async function privateSession() {
    const session = await createSession();
    async function rpc(method: string, params: Record<string, unknown>) {
      const result = await session.rpc(method, params);
      if (method === 'turn/start') return response.promise;
      return result;
    }
    return { ...session, rpc };
  }
  test.driver.privateSession = privateSession;
  return response;
}

function terminate(test: Computer, cause: Termination, startReply: ReturnType<typeof holdStartReply>) {
  if (cause === 'session EOF') {
    test.exitPrivate();
  } else if (cause === 'turn/start timeout') {
    startReply.reject(new Error('RPC timeout'));
  } else if (cause === 'thread/closed') {
    test.channel.notification({ method: cause, params: { threadId: 'thread-1' } });
  } else if (cause === 'restricted tool') {
    test.channel.notification({ method: 'item/started', params: {
      threadId: 'thread-1', item: { type: 'commandExecution', command: 'refused' } } });
  } else {
    test.channel.notification({ method: 'turn/completed', params: {
      threadId: 'thread-1', turn: { id: 'codex-thread-1', status: 'failed' } } });
  }
}

async function acknowledgeDelivered(test: Computer) {
  const delivered = test.frames.splice(0);
  for (const frame of delivered) {
    test.send({ type: 'ack', sequence: frame['sequence'] });
  }
  await test.flush();
}

async function clearsFailedReply(cause: Termination) {
  const test = await fixture();
  const removal = Promise.withResolvers<void>();
  const grant = test.driver.grant.bind(test.driver);
  const startReply = holdStartReply(test);
  if (cause !== 'turn/start timeout') startReply.resolve({ turn: { id: 'codex-thread-1' } });
  async function heldRemoval(...input: Parameters<typeof grant>) {
    await grant(...input);
    if (!input[2]) await removal.promise;
  }
  try {
    await start(test);
    for (let index = 0; index < 20; index++) output(test, 'private-before-ending');
    await test.flush();
    expect(test.frames).toHaveLength(33);
    test.driver.grant = heldRemoval;
    terminate(test, cause, startReply);
    await test.flush();
    expect.soft(test.grants.has('thread-1')).toBe(false);
    output(test, 'private-after-ending');
    await acknowledgeDelivered(test);
    expect.soft(JSON.stringify(test.frames)).not.toMatch(/private-before-ending|private-after-ending/u);
    function lost(frame: Record<string, unknown>) {
      return frame['type'] === 'agent.output_lost';
    }
    expect.soft(test.frames.filter(lost)).toHaveLength(28);
    await acknowledgeDelivered(test);
    removal.resolve();
    test.finish('thread-1');
    await test.flush();
    const beforeReplay = [...test.calls];
    test.frames.length = 0;
    const reconnected = await test.connect();
    await test.flush(reconnected);
    expect.soft(JSON.stringify(test.frames)).not.toMatch(/private-before-ending|private-after-ending/u);
    expect(test.calls).toEqual(beforeReplay);
    const cold = reportJournal(test.driver);
    cold.load();
    const replay = cold.reports.map(wireReport);
    expect(JSON.stringify(replay)).not.toMatch(/private-before-ending|private-after-ending/u);
    expect(readFileSync(test.driver.journal, 'utf8'))
      .not.toMatch(/private-before-ending|private-after-ending/u);
    let reason = 'model_error';
    if (cause === 'restricted tool') reason = 'restricted_tool_refused';
    expect(replay.at(-1)).toMatchObject({ type: 'agent.turn_failed', reason });
    expect(test.grants.has('thread-1')).toBe(false);
  } finally {
    removal.resolve();
    startReply.resolve({ turn: { id: 'codex-thread-1' } });
    await test.close();
  }
}

const terminations: Termination[] = ['failed notification', 'thread/closed', 'session EOF',
  'turn/start timeout', 'restricted tool'];
it.each(terminations)('clears queued private text and refuses later output after %s',
  clearsFailedReply);
