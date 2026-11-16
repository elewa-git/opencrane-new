import { expect, it, vi } from 'vitest';
import { fixture } from './bridge-gate-fixture.ts';
import { sessionRunnerFixture } from './support/session-runner-fixture.ts';

async function countsHeldPreparation() {
  const test = sessionRunnerFixture();
  const release = Promise.withResolvers<void>();
  const create = test.driver.privateSession!.bind(test.driver);
  async function heldSession() {
    const session = await create();
    await release.promise;
    return session;
  }
  test.driver.privateSession = heldSession;
  const first = test.runner.start(test.input('first'));
  const second = test.runner.start(test.input('second'));
  let third = Promise.resolve();
  try {
    expect(test.sessions).toHaveLength(2);
    third = test.runner.start(test.input('third'));
    expect(test.sessions).toHaveLength(2);
    expect(test.reports).toEqual([]);
    release.resolve();
    await Promise.all([first, second, third]);
    test.finish();
    await test.runner.start(test.input('third'));
    expect(test.sessions).toHaveLength(3);
    expect(test.reports).toContainEqual(expect.objectContaining({
      type: 'agent.turn_started', turnId: 'third',
    }));
  } finally {
    release.resolve();
    await Promise.all([first, second, third]);
    test.close();
  }
}
it('leaves a third private turn unreserved while two turns are preparing', countsHeldPreparation);

async function excludesPrivateWorkspaceArtifacts() {
  const test = sessionRunnerFixture();
  const snapshot = vi.fn().mockResolvedValue({ 'private.txt': 'canary' });
  const list = vi.fn().mockResolvedValue([]);
  Object.assign(test.driver, { artifactSnapshot: snapshot, artifactList: list });
  try {
    await test.runner.start(test.input('first'));
    test.finish();
    function completed() {
      expect(test.reports).toContainEqual(expect.objectContaining({
        type: 'agent.turn_completed', turnId: 'first',
      }));
    }
    await vi.waitFor(completed);
    expect(snapshot).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  } finally {
    test.close();
  }
}
it('completes a private turn without reading workspace snapshots or artifacts',
  excludesPrivateWorkspaceArtifacts);

async function isolatesFailedLateStop() {
  const test = sessionRunnerFixture();
  const lateStart = Promise.withResolvers<Record<string, unknown>>();
  const entered = Promise.withResolvers<void>();
  const create = test.driver.privateSession!.bind(test.driver);
  async function privateSession() {
    const session = await create();
    if (test.sessions.length !== 1) return session;
    function rpc(method: string, params: Record<string, unknown>) {
      if (method === 'turn/start') {
        entered.resolve();
        return lateStart.promise;
      }
      return session.rpc(method, params);
    }
    return { ...session, rpc };
  }
  test.driver.privateSession = privateSession;
  const starting = test.runner.start(test.input('first'));
  try {
    await entered.promise;
    await test.runner.start(test.input('second'));
    function grant(_thread: string, _conversation: string, token: string) {
      if (!token) return Promise.reject(new Error('Access removal unavailable'));
      return Promise.resolve();
    }
    test.driver.grant = grant;
    const stop = { turnId: 'first', conversationId: 'first' };
    await expect(test.runner.interrupt(stop)).rejects.toThrow('Access removal unavailable');
    expect(test.sessions[0]!.close).not.toHaveBeenCalled();
    lateStart.resolve({ turn: { id: 'native-thread-1' } });
    await starting;
    expect(test.sessions[0]!.close).toHaveBeenCalledTimes(1);
    expect(test.sessions[1]!.close).not.toHaveBeenCalled();
    expect(test.disconnected).not.toHaveBeenCalled();
    test.finish('thread-2');
    expect(test.reports).toContainEqual(expect.objectContaining({
      type: 'agent.turn_completed', turnId: 'second',
    }));
  } finally {
    test.driver.grant = test.grant;
    lateStart.resolve({ turn: { id: 'native-thread-1' } });
    await starting;
    test.close();
  }
}
it('closes only its private process after a late start reply and failed Stop access removal',
  isolatesFailedLateStop);

async function checksClearanceReceipts(kind: 'personal' | 'memory_free' | 'shared') {
  const computer = await fixture();
  try {
    const turn = { type: 'turn', id: 'first', conversationId: 'chat',
      assistantId: 'assistant', executionMode: 'restricted', text: 'Hello',
      token: 'initial', expiresAt: Date.now() + 60_000 };
    if (kind === 'memory_free') turn.executionMode = 'memory_free';
    const frame = kind === 'shared' ? { ...turn, sharingClass: 'shared_only' } : turn;
    computer.send(frame);
    function started() { expect(computer.calls).toContain('turn/start:thread-1'); }
    await vi.waitFor(started);
    const stop = { type: 'stop', turnId: 'first', conversationId: 'chat', threadId: 'thread-1' };
    computer.send(stop);
    await computer.flush();
    function interrupted() { expect(computer.calls).toContain('turn/interrupt:thread-1'); }
    await vi.waitFor(interrupted);
    await computer.flush();
    function isClearance(value: Record<string, unknown>) {
      return value['type'] === 'private_output_cleared';
    }
    const receipts = computer.frames.filter(isClearance);
    if (kind === 'personal') {
      expect(receipts).toEqual([{ type: 'private_output_cleared',
        turnId: 'first', conversationId: 'chat', threadId: 'thread-1' }]);
    } else {
      expect(receipts).toEqual([]);
    }
  } finally {
    await computer.close();
  }
}
it.each(['personal', 'memory_free', 'shared'] as const)(
  'sends personal output clearance only for a personal Stop (%s)', checksClearanceReceipts);

async function removesStoppedPrivateAccessOnce() {
  const test = sessionRunnerFixture();
  try {
    await test.runner.start(test.input('first'));
    test.grant.mockClear();
    await test.runner.interrupt({ turnId: 'first', conversationId: 'first' });
    expect(test.grant).toHaveBeenCalledTimes(1);
    test.finish();
    expect(test.grant).toHaveBeenCalledTimes(1);
  } finally {
    test.close();
  }
}
it('does not remove a completed private Stop grant again at terminal release',
  removesStoppedPrivateAccessOnce);

async function filtersPrivateCommandReports(executionMode: 'restricted' | 'memory_free') {
  const test = sessionRunnerFixture();
  try {
    await test.runner.start(test.input('first', executionMode));
    const item = { id: 'command', type: 'commandExecution',
      command: 'pwd', exitCode: 0, status: 'completed' };
    test.runner.complete({ method: 'item/completed', params: { threadId: 'thread-1', item } });
    function commandOutcome() {
      if (executionMode === 'memory_free') {
        expect(test.reports).toContainEqual(expect.objectContaining({
          type: 'agent.command_ran', turnId: 'first', exitCode: 0,
        }));
      } else {
        expect(test.reports).toContainEqual(expect.objectContaining({
          type: 'agent.turn_failed', turnId: 'first', reason: 'restricted_tool_refused',
        }));
        function isCommand(report: (typeof test.reports)[number]) {
          return report.type === 'agent.command_ran';
        }
        expect(test.reports.filter(isCommand)).toEqual([]);
      }
    }
    await vi.waitFor(commandOutcome);
  } finally {
    test.close();
  }
}
it.each(['restricted', 'memory_free'] as const)(
  'reports commands only for a turn with local tools enabled (%s)', filtersPrivateCommandReports);
