import { expect, it, vi } from 'vitest';
import { fixture } from './bridge-gate-fixture.ts';

type Computer = Awaited<ReturnType<typeof fixture>>;
type Failure = 'capacity' | 'expired request' | 'expiry during startup' | 'open' | 'native start';

function preparation(expiresAt = Date.now() + 50_000) {
  return { type: 'routine_prepare', id: 'routine-turn', conversationId: 'routine-chat',
    assistantId: 'assistant', requesterId: 'carol', expiresAt };
}

async function startPrivate(computer: Computer, id: string, threadId: string) {
  const turn = { type: 'turn', id, conversationId: id, requesterId: id,
    assistantId: 'assistant', executionMode: 'restricted', text: 'Hello',
    token: 'initial', expiresAt: Date.now() + 60_000 };
  computer.send(turn);
  function running() {
    expect(computer.calls).toContain(`turn/start:${threadId}`);
  }
  await vi.waitFor(running);
  await computer.flush();
}

function isTurnStart(call: string) {
  return call.startsWith('turn/start:');
}

function isFailure(frame: Record<string, unknown>) {
  return frame['type'] === 'agent.turn_failed';
}

async function routineFixture(failure: Failure) {
  const sessions: { closed: boolean }[] = [];
  const nativeStart = Promise.withResolvers<void>();
  const releaseStart = Promise.withResolvers<void>();
  let failPreparation = false;
  function privateSession() {
    if (failPreparation && failure === 'open') {
      return Promise.reject(new Error('private-startup-canary'));
    }
    const lifetime = Promise.withResolvers<void>();
    const state = { closed: false };
    sessions.push(state);
    function close() {
      state.closed = true;
      lifetime.resolve();
    }
    async function rpc(method: string, params: Record<string, unknown>) {
      if (failPreparation && method === 'thread/start') {
        if (failure === 'native start') throw new Error('private-startup-canary');
        if (failure === 'expiry during startup') {
          nativeStart.resolve();
          await releaseStart.promise;
        }
      }
      return computer.driver.rpc(method, params);
    }
    return Promise.resolve({ rpc, close, closed: lifetime.promise });
  }
  const computer: Computer = await fixture(true, undefined, privateSession);
  function failNextPreparation() {
    failPreparation = true;
  }
  return { computer, sessions, nativeStart, releaseStart, failNextPreparation };
}

function isPreparationRefusal(frame: Record<string, unknown>) {
  return frame['type'] === 'routine_prepare_refused' && frame['id'] === 'routine-turn';
}

async function isolatesPreparationFailure(failure: Failure) {
  const test = await routineFixture(failure);
  const { computer, sessions, nativeStart, releaseStart } = test;
  try {
    await startPrivate(computer, 'alice', 'thread-1');
    const expectedGrants = ['thread-1'];
    if (failure === 'capacity') {
      await startPrivate(computer, 'bob', 'thread-2');
      expectedGrants.push('thread-2');
    }
    expect([...computer.grants]).toEqual(expectedGrants);
    test.failNextPreparation();
    const request = preparation();
    if (failure === 'expired request') request.expiresAt = Date.now() - 1;
    if (failure === 'expiry during startup') {
      // Advance only preparation's expiry timer; leave the real socket running.
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    }
    computer.send(request);
    if (failure === 'expiry during startup') {
      await nativeStart.promise;
      await vi.advanceTimersByTimeAsync(50_001);
      expect(sessions[1]?.closed).toBe(true);
      releaseStart.resolve();
      vi.useRealTimers();
    }
    function preparationSettled() {
      const received = computer.frames.some(isPreparationRefusal);
      expect(received || computer.socket.readyState === computer.socket.CLOSED).toBe(true);
    }
    await vi.waitFor(preparationSettled);
    expect.soft(computer.socket.readyState).toBe(computer.socket.OPEN);
    expect.soft([...computer.grants]).toEqual(expectedGrants);
    expect.soft(sessions[0]?.closed).toBe(false);
    if (failure === 'capacity') expect.soft(sessions[1]?.closed).toBe(false);
    if (failure === 'native start' || failure === 'expiry during startup') {
      expect.soft(sessions[1]?.closed).toBe(true);
    }
    expect.soft(computer.frames).toContainEqual({
      type: 'routine_prepare_refused', id: 'routine-turn' });
    expect(computer.calls.filter(isTurnStart)).toHaveLength(expectedGrants.length);
    expect(computer.frames.filter(isFailure)).toEqual([]);
    expect(JSON.stringify(computer.frames)).not.toContain('private-startup-canary');
    expect(computer.socket.readyState).toBe(computer.socket.OPEN);
    await computer.flush();
    for (const threadId of expectedGrants) {
      computer.channel.notification({ method: 'item/agentMessage/delta', params: {
        threadId, itemId: `reply-${threadId}`, delta: `still-running-${threadId}` } });
    }
    await computer.flush();
    for (const threadId of expectedGrants) {
      expect(JSON.stringify(computer.frames)).toContain(`still-running-${threadId}`);
    }
  } finally {
    vi.useRealTimers();
    releaseStart.resolve();
    await computer.close();
  }
}

const failures: Failure[] = ['capacity', 'expired request', 'expiry during startup',
  'open', 'native start'];
it.each(failures)('keeps unrelated private turns and the bridge open after %s refusal',
  isolatesPreparationFailure);
