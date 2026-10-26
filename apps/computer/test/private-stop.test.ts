import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { fixture } from './bridge-gate-fixture.ts';
import { reportJournal, wireReport } from '../src/report-journal.ts';

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
  const grant = test.driver.grant.bind(test.driver);
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
    test.send({ type: 'resume', since: 0 });
    await test.flush();
    expect.soft(JSON.stringify(test.frames)).not.toContain('alice-before-stop');
    expect.soft(JSON.stringify(test.frames)).not.toContain('alice-late-output');
    expect(JSON.stringify(test.frames)).toContain('bob-still-current');
    function lost(frame: Record<string, unknown>) {
      return frame['turnId'] === 'first' && frame['type'] === 'agent.output_lost';
    }
    expect.soft(test.frames.filter(lost)).toHaveLength(3);
    expect(test.calls).toEqual(beforeReconnect);
    test.frames.length = 0;
    const reconnected = await test.connect();
    await test.flush(reconnected);
    expect(JSON.stringify(test.frames)).not.toMatch(/alice-before-stop|alice-late-output/u);
    expect(JSON.stringify(test.frames)).not.toContain('bob-still-current');
    expect(test.grants.has('thread-2')).toBe(false);
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

async function clearsQueuedReplies() {
  const test = await fixture();
  try {
    await startPrivate(test, 'first', 'thread-1');
    for (let index = 0; index < 20; index++) {
      output(test, 'thread-1', 'queued-private-reply');
    }
    await test.flush();
    function hasText(frame: Record<string, unknown>) {
      return frame['text'] === 'queued-private-reply';
    }
    expect(test.frames.filter(hasText)).toHaveLength(32);
    test.send({ type: 'stop', turnId: 'first', conversationId: 'first' });
    await test.flush();
    const delivered = [...test.frames];
    test.frames.length = 0;
    for (const report of delivered) {
      test.send({ type: 'ack', sequence: report['sequence'] });
    }
    await test.flush();
    expect(test.frames).toHaveLength(28);
    for (const report of test.frames) {
      expect(report).toMatchObject({ type: 'agent.output_lost', turnId: 'first' });
      expect(report).not.toHaveProperty('text');
    }
  } finally {
    await test.close();
  }
}
it('replaces queued private bytes with unavailable status when acknowledgements free space',
  clearsQueuedReplies);

async function clearsFinishedReply() {
  const test = await fixture();
  try {
    await startPrivate(test, 'first', 'thread-1');
    output(test, 'thread-1', 'finished-private-reply');
    test.finish('thread-1');
    await test.flush();
    test.send({ type: 'stop', turnId: 'first', conversationId: 'first' });
    test.send({ type: 'stop', turnId: 'first', conversationId: 'first' });
    await test.flush();
    const beforeReplay = [...test.calls];
    test.frames.length = 0;
    test.send({ type: 'resume', since: 0 });
    await test.flush();
    expect(JSON.stringify(test.frames)).not.toContain('finished-private-reply');
    function completed(frame: Record<string, unknown>) {
      return frame['type'] === 'agent.turn_completed';
    }
    expect(test.frames.filter(completed)).toHaveLength(1);
    expect(test.calls).toEqual(beforeReplay);
    const restored = reportJournal(test.driver);
    restored.load();
    const coldReports = restored.reports.map(wireReport);
    expect(JSON.stringify(coldReports)).not.toContain('finished-private-reply');
    expect(coldReports.at(-1)?.type).toBe('agent.turn_completed');
  } finally {
    await test.close();
  }
}
it('clears a finished private reply on repeated Stop while preserving its saved completion',
  clearsFinishedReply);

async function preservesOtherReplies(mode: 'restricted' | 'memory_free') {
  const test = await fixture();
  try {
    if (mode === 'restricted') {
      await startPrivate(test, 'first', 'thread-1');
    } else {
      test.start('first');
      function started() {
        expect(test.calls).toContain('turn/start:thread-1');
      }
      await vi.waitFor(started);
    }
    output(test, 'thread-1', 'retained-reply');
    await test.flush();
    let conversationId = 'another-conversation';
    if (mode === 'memory_free') conversationId = 'first';
    test.send({ type: 'stop', turnId: 'first', conversationId });
    await test.flush();
    test.frames.length = 0;
    test.send({ type: 'resume', since: 0 });
    await test.flush();
    expect(JSON.stringify(test.frames)).toContain('retained-reply');
    if (mode === 'restricted') expect(test.grants.has('thread-1')).toBe(true);
  } finally {
    await test.close();
  }
}
it.each(['restricted', 'memory_free'] as const)(
  'preserves a reply outside the private Stop binding (%s)', preservesOtherReplies);

async function startsFreshAfterStop() {
  const test = await fixture();
  try {
    await startPrivate(test, 'first', 'thread-1');
    output(test, 'thread-1', 'old-private-reply');
    test.pauseAcks();
    function refused(error: unknown) {
      return error;
    }
    const renewal = test.channel.renew('thread-1').catch(refused);
    await test.flush();
    test.send({ type: 'stop', turnId: 'first', conversationId: 'first' });
    expect(await renewal).toEqual(new Error('Turn ended'));
    test.send({ type: 'ack', sequence: 1, token: 'late', expiresAt: Date.now() + 60_000 });
    await test.flush();
    output(test, 'thread-1', 'late-private-reply');
    test.finish('thread-1');
    await test.flush();
    expect(test.grants.has('thread-1')).toBe(false);
    expect(test.calls).not.toContain('thread/start:thread-2');
    const next = { type: 'turn', id: 'next', conversationId: 'first', requesterId: 'alice',
      assistantId: 'assistant', executionMode: 'restricted', text: 'Fresh request',
      token: 'initial', expiresAt: Date.now() + 60_000 };
    test.send(next);
    function nextStart() {
      function matches(frame: Record<string, unknown>) {
        return frame['type'] === 'agent.turn_started' && frame['turnId'] === 'next';
      }
      const report = test.frames.find(matches);
      expect(report).toBeDefined();
      return report!;
    }
    const start = await vi.waitFor(nextStart);
    test.send({ type: 'ack', sequence: start['sequence'], token: 'fresh',
      expiresAt: Date.now() + 60_000 });
    function nextRunning() {
      expect(test.calls).toContain('turn/start:thread-2');
    }
    await vi.waitFor(nextRunning);
    test.frames.length = 0;
    output(test, 'thread-1', 'late-private-reply');
    output(test, 'thread-2', 'new-private-reply');
    await test.flush();
    expect(JSON.stringify(test.frames)).not.toContain('late-private-reply');
    expect(JSON.stringify(test.frames)).toContain('new-private-reply');
    expect(test.grants.has('thread-2')).toBe(true);
  } finally {
    await test.close();
  }
}
it('refuses a held renewal and starts a fresh private thread only for an explicit new request',
  startsFreshAfterStop);
