import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { fixture } from './bridge-gate-fixture.ts';

type Computer = Awaited<ReturnType<typeof fixture>>;

async function startPrivate(test: Computer, id: string, thread: string, requesterId = 'alice') {
  const frame = { type: 'turn', id, conversationId: id, requesterId,
    assistantId: 'assistant', executionMode: 'restricted', text: 'Hello',
    token: 'initial', expiresAt: Date.now() + 60_000 };
  test.send(frame);
  function started() {
    expect(test.calls).toContain(`turn/start:${thread}`);
  }
  await vi.waitFor(started);
  await test.flush();
}

function output(test: Computer, threadId: string, text: string) {
  test.channel.notification({ method: 'item/agentMessage/delta',
    params: { threadId, itemId: 'reply', delta: text } });
  test.channel.notification({ method: 'item/reasoning/summaryTextDelta',
    params: { threadId, delta: text } });
  test.channel.notification({ method: 'item/completed', params: {
    threadId, item: { id: 'reply', type: 'agentMessage', text } } });
}

async function clearsBeforeRemovalFinishes() {
  const test = await fixture();
  const removing = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const grant = test.driver.grant;
  async function heldRemoval(...input: Parameters<typeof grant>) {
    await grant(...input);
    if (input[0] === 'thread-1' && !input[2]) {
      removing.resolve();
      await release.promise;
    }
  }
  try {
    await startPrivate(test, 'first', 'thread-1');
    await startPrivate(test, 'second', 'thread-2', 'bob');
    output(test, 'thread-1', 'alice-before-stop');
    output(test, 'thread-2', 'bob-still-current');
    await test.flush();
    test.driver.grant = heldRemoval;
    test.send({ type: 'stop', turnId: 'first', conversationId: 'first' });
    await removing.promise;
    expect(test.grants.has('thread-1')).toBe(false);
    expect(test.grants.has('thread-2')).toBe(true);
    expect(test.calls).not.toContain('turn/interrupt:thread-1');

    test.frames.length = 0;
    output(test, 'thread-1', 'alice-late-output');
    await test.flush();
    expect.soft(JSON.stringify(test.frames)).not.toContain('alice-late-output');

    const beforeReconnect = [...test.calls];
    test.frames.length = 0;
    const reconnected = await test.connect();
    await test.flush(reconnected);
    expect.soft(JSON.stringify(test.frames)).not.toContain('alice-before-stop');
    expect.soft(JSON.stringify(test.frames)).not.toContain('alice-late-output');
    expect(JSON.stringify(test.frames)).toContain('bob-still-current');
    function lost(frame: Record<string, unknown>) {
      return frame['turnId'] === 'first' && frame['type'] === 'agent.output_lost';
    }
    expect.soft(test.frames.filter(lost)).toHaveLength(3);
    expect(test.calls).toEqual(beforeReconnect);
    const disk = readFileSync(test.driver.journal, 'utf8');
    expect(disk).not.toContain('alice-before-stop');
    expect(disk).not.toContain('alice-late-output');
    expect(disk).not.toContain('bob-still-current');
  } finally {
    release.resolve();
    await test.close();
  }
}
it('clears only the stopped private reply before access removal finishes and rejects late output',
  clearsBeforeRemovalFinishes);
