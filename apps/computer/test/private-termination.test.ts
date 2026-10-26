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

async function clearsOnConnectionLoss(completed: boolean) {
  const test = await fixture();
  try {
    await start(test);
    output(test, 'private-before-loss');
    if (completed) test.finish('thread-1');
    await test.flush();
    test.start('ordinary');
    function ordinaryRunning() {
      expect(test.calls).toContain('turn/start:thread-2');
    }
    await vi.waitFor(ordinaryRunning);
    const beforeLoss = [...test.calls];
    const closed = new Promise<void>(function register(resolve) {
      test.socket.once('close', resolve);
    });
    test.socket.terminate();
    await closed;
    const reconnected = await test.connect();
    await test.flush(reconnected);
    expect.soft(test.grants.has('thread-1')).toBe(false);
    expect(test.grants.has('thread-2')).toBe(true);
    output(test, 'private-after-loss');
    test.channel.notification({ method: 'item/agentMessage/delta', params: {
      threadId: 'thread-2', itemId: 'ordinary-reply', delta: 'ordinary-after-loss' } });
    await test.flush(reconnected);
    expect.soft(JSON.stringify(test.frames)).not.toContain('private-after-loss');
    test.frames.length = 0;
    reconnected.send(JSON.stringify({ type: 'resume', since: 0 }));
    await test.flush(reconnected);
    expect.soft(JSON.stringify(test.frames)).not.toMatch(/private-before-loss|private-after-loss/u);
    expect(JSON.stringify(test.frames)).toContain('ordinary-after-loss');
    expect(test.calls).toEqual(beforeLoss);
    expect(readFileSync(test.driver.journal, 'utf8'))
      .not.toMatch(/private-before-loss|private-after-loss/u);
    function terminal(frame: Record<string, unknown>) {
      return frame['turnId'] === 'first' &&
        ['agent.turn_failed', 'agent.turn_completed'].includes(String(frame['type']));
    }
    let type = 'agent.turn_failed';
    if (completed) type = 'agent.turn_completed';
    expect.soft(test.frames.filter(terminal)).toMatchObject([{ type }]);
  } finally {
    await test.close();
  }
}
it.each([false, true])('clears private replies on disconnect, keeping ordinary recovery (completed: %s)',
  clearsOnConnectionLoss);

async function cancelsPreparationOnDisconnect() {
  const test = await fixture();
  const release = Promise.withResolvers<void>();
  const preparing = Promise.withResolvers<void>();
  const create = test.driver.privateSession!.bind(test.driver);
  async function privateSession() {
    preparing.resolve();
    await release.promise;
    return create();
  }
  test.driver.privateSession = privateSession;
  try {
    test.start('first', 'restricted');
    await preparing.promise;
    const closed = new Promise<void>(function register(resolve) {
      test.socket.once('close', resolve);
    });
    test.socket.terminate();
    await closed;
    const reconnected = await test.connect();
    await test.flush(reconnected);
    release.resolve();
    await test.flush(reconnected);
    expect.soft(test.calls).not.toContain('turn/start:thread-1');
    expect.soft(test.grants.size).toBe(0);
    function failed(frame: Record<string, unknown>) {
      return frame['turnId'] === 'first' && frame['type'] === 'agent.turn_failed';
    }
    expect.soft(test.frames.filter(failed)).toHaveLength(1);
  } finally {
    release.resolve();
    await test.close();
  }
}
it('cancels private preparation held across disconnect before it can install a grant',
  cancelsPreparationOnDisconnect);
