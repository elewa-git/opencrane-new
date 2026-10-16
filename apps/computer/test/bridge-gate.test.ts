import { once } from 'node:events';
import { expect, it, vi } from 'vitest';
import { until } from '@opencrane/authz/testing';
import { fixture } from './bridge-gate-fixture.ts';

async function stopsEveryConversation() {
  const test = await fixture();
  const gate = await test.signedGate();
  try {
    test.start('first');
    test.start('second', 'restricted');
    function bothRunning() { return test.calls.includes('turn/start:thread-2'); }
    await until(bothRunning);
    test.send(gate);
    function interrupted() { return test.calls.includes('turn/interrupt:thread-2'); }
    await until(interrupted, 2000);
    const accepted = test.frames.find(isAccepted);
    expect(accepted).toMatchObject({ type: 'bridge_gated', takeoverId: 'takeover',
      generation: 1, affectedTurnIds: ['first', 'second'] });
    expect(test.calls).toContain('turn/interrupt:thread-1');
    expect(test.grants.size).toBe(0);
    expect(test.catalogues.size).toBe(0);
    expect(test.receipt()).toBeUndefined();
    test.finish('thread-1');
    await test.flush();
    expect(test.receipt()).toBeUndefined();
    test.finish('thread-2');
    function quiet() { return Boolean(test.receipt()); }
    await until(quiet);
    expect(test.receipt()).toEqual({ type: 'bridge_quiet', takeoverId: 'takeover',
      generation: 1, affectedTurnIds: ['first', 'second'], epoch: test.receipt()?.['epoch'],
      interruptedTurnIds: ['first', 'second'], preparingTurnIds: [], runningTurnIds: [],
      loadedThreadIds: [], heldApprovalIds: [], executorProof: 'unavailable',
      browserProof: 'unavailable' });
    expect(test.loaded.size).toBe(0);
    const before = [...test.calls];
    test.start('late');
    test.send({ type: 'file_begin' });
    await test.flush();
    expect(test.calls).toEqual(before);
    test.send(await test.signedGate({ generation: 2 }));
    const closed: unknown[] = await once(test.socket, 'close');
    expect(closed[0]).toBe(1008);
  } finally { await test.close(); }
}
it('closes all work before waiting for every terminal completion and unloaded threads',
  stopsEveryConversation);

async function cancelsLoading() {
  const test = await fixture();
  const gate = await test.signedGate();
  const loading = Promise.withResolvers<unknown>();
  const original = test.driver.rpc.bind(test.driver);
  function rpc(method: string, params: Record<string, unknown>) {
    if (method === 'thread/start') return loading.promise;
    return original(method, params);
  }
  test.driver.rpc = rpc;
  try {
    test.start('first');
    await test.flush();
    test.send(gate);
    await test.flush();
    expect(test.catalogues.size).toBe(0);
    test.loaded.add('late-thread');
    loading.resolve({ thread: { id: 'late-thread' } });
    function quiet() { return Boolean(test.receipt()); }
    await until(quiet);
    expect(test.grants.size).toBe(0);
    expect(test.loaded.size).toBe(0);
    expect(test.calls).not.toContain('turn/start:late-thread');
  } finally { await test.close(); }
}
it('unloads a late preparation without granting or starting it', cancelsLoading);

async function repeatsAfterReconnect() {
  const test = await fixture();
  const gate = await test.signedGate();
  try {
    test.send(gate);
    function quiet() { return Boolean(test.receipt()); }
    await until(quiet);
    const epoch = test.receipt()?.['epoch'];
    test.frames.length = 0;
    test.loaded.add('unexpected-thread');
    const socket = await test.connect();
    socket.send(JSON.stringify(gate));
    await until(quiet);
    expect(test.receipt()?.['epoch']).toBe(epoch);
    expect(test.loaded.size).toBe(0);
    expect(test.calls).toContain('thread/unsubscribe:unexpected-thread');
    socket.send(JSON.stringify(await test.signedGate({ takeoverId: 'another' })));
    const closed: unknown[] = await once(socket, 'close');
    expect(closed[0]).toBe(1008);
  } finally { await test.close(); }
}
it('gates an idle computer and repeats inventory checks with the same epoch on reconnect',
  repeatsAfterReconnect);

async function refusesLateGrant(renewal: boolean, installing: boolean) {
  const test = await fixture();
  const gate = await test.signedGate();
  const pending = Promise.withResolvers<void>();
  let delayed = !renewal && installing;
  let entered = false;
  const grant = test.driver.grant.bind(test.driver);
  async function install(thread: string, conversation: string, token: string, expires: number) {
    if (delayed && token) {
      entered = true;
      await pending.promise;
    }
    await grant(thread, conversation, token, expires);
  }
  test.driver.grant = install;
  try {
    if (!renewal && !installing) test.pauseAcks();
    test.start('first');
    function started() { return test.frames.length > 0; }
    await until(started);
    let refused: Promise<void> | undefined;
    if (renewal) {
      function running() { return test.calls.includes('turn/start:thread-1'); }
      await until(running);
      if (!installing) test.pauseAcks();
      delayed = installing;
      const renewing = test.channel.renew('thread-1');
      if (installing) refused = expect(renewing).resolves.toBeUndefined();
      else refused = expect(renewing).rejects.toThrow('Turn ended');
    }
    function grantPending() { return entered; }
    if (installing) await until(grantPending);
    test.send(gate);
    await test.flush();
    test.send({ type: 'ack', sequence: 1, token: 'late', expiresAt: Date.now() + 60_000 });
    await test.flush();
    if (installing) {
      test.channel.notification({ method: 'thread/closed', params: { threadId: 'thread-1' } });
    }
    pending.resolve();
    await refused;
    await test.flush();
    expect(test.grants.size).toBe(0);
    if (renewal && installing) return;
    if (renewal) test.finish('thread-1');
    function quiet() { return Boolean(test.receipt()); }
    await until(quiet);
  } finally { await test.close(); }
}
it.each([[false, false], [true, false], [false, true], [true, true]])(
  'refuses a late grant with renewal %s and installation %s', refusesLateGrant);

async function doesNotInferQuiet(cause: string) {
  const test = await fixture();
  const gate = await test.signedGate();
  try {
    test.start('first', 'restricted');
    function running() { return test.calls.includes('turn/start:thread-1'); }
    await until(running);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    test.send(gate);
    await test.flush();
    if (cause === 'thread/closed') {
      test.channel.notification({ method: cause, params: { threadId: 'thread-1' } });
    } else if (cause === 'eof') {
      test.exitPrivate();
    } else {
      test.socket.terminate();
      const reconnected = await test.connect();
      reconnected.send(JSON.stringify(gate));
      await test.flush(reconnected);
    }
    await vi.advanceTimersByTimeAsync(30_000);
    vi.useRealTimers();
    function unavailable() {
      return test.frames.some(isUnavailable);
    }
    function isUnavailable(frame: Record<string, unknown>) {
      return frame['type'] === 'bridge_unavailable';
    }
    await until(unavailable);
    expect(test.receipt()).toBeUndefined();
    if (cause !== 'socket') {
      test.start('late');
      await test.flush();
    }
    expect(test.calls).not.toContain('thread/start:thread-2');
  } finally {
    vi.useRealTimers();
    await test.close();
  }
}
it.each(['thread/closed', 'eof', 'socket'])(
  'returns unavailable at thirty seconds after %s without terminal proof',
  doesNotInferQuiet);

function isAccepted(frame: Record<string, unknown>) { return frame['type'] === 'bridge_gated'; }

async function acceptsBeforeResume() {
  const test = await fixture();
  try {
    test.start('first');
    function running() { return test.calls.includes('turn/start:thread-1'); }
    await until(running);
    const gate = await test.signedGate();
    let epoch: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      const socket = await test.connect(false);
      test.frames.length = 0;
      socket.send(JSON.stringify(gate));
      await test.flush(socket);
      const accepted = test.frames.find(isAccepted);
      expect(accepted).toMatchObject({ type: 'bridge_gated', takeoverId: 'takeover',
        generation: 1, affectedTurnIds: ['first', 'second'] });
      if (attempt === 0) epoch = accepted?.['epoch'];
      expect(accepted?.['epoch']).toBe(epoch);
      expect(test.receipt()).toBeUndefined();
      expect(test.frames).toHaveLength(1);
      expect(test.calls).toContain('turn/interrupt:thread-1');
      socket.terminate();
    }
  } finally {
    test.finish('thread-1');
    await test.close();
  }
}
it('acknowledges active work before resume on every reconnect, without claiming completion',
  acceptsBeforeResume);
