import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { WebSocket } from 'ws';
import { z } from 'zod';
import { expect, it } from 'vitest';
import { until } from '@opencrane/authz/testing';
import { bridgeChannel } from '../../computer/test/server.ts';

async function keepsRequesterContextsSeparate() {
  const directory = await mkdtemp(`${tmpdir()}/shared-runtime-`);
  const server = createServer();
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const reports: { type: string; threadId?: string | undefined; turnId: string; sequence: number }[] = [];
  let threadCount = 0;
  function rpc(method: string, params: Record<string, unknown>) {
    calls.push({ method, params });
    if (method === 'thread/start') {
      threadCount++;
      return Promise.resolve({ thread: { id: `thread-${threadCount}` } });
    }
    if (method === 'thread/resume') {
      return Promise.resolve({ thread: { id: params['threadId'] } });
    }
    return Promise.resolve({});
  }
  async function grant() {}
  function credential() {
    return { value: 'computer-test', expiresAt: Date.now() + 60_000 };
  }
  const driver = { rpc, grant, credential, journal: `${directory}/reports` };
  const channel = bridgeChannel(server, driver);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing port');
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/bridge`, {
    headers: { 'x-bridge-token': 'computer-test' },
  });
  function collect(raw: unknown) {
    const text = z.instanceof(Buffer).parse(raw).toString();
    const schema = z.object({ type: z.string(), threadId: z.string().optional(),
      turnId: z.string(), sequence: z.number() });
    const report = schema.parse(JSON.parse(text));
    reports.push(report);
    const acknowledgement = { type: 'ack', sequence: report.sequence,
      token: `token-${report.turnId}`, expiresAt: Date.now() + 60_000 };
    socket.send(JSON.stringify(acknowledgement));
  }
  socket.on('message', collect);
  function send(requesterId: string, id: string, conversationId = 'private') {
    const input = { type: 'turn', id, conversationId, requesterId, assistantId: 'shared',
      text: 'Private work', token: 'preparing', expiresAt: Date.now() + 60_000 };
    socket.send(JSON.stringify(input));
  }
  function ranTwice() {
    function isTurnStart(call: typeof calls[number]) {
      return call.method === 'turn/start';
    }
    return calls.filter(isTurnStart).length === 2;
  }
  try {
    await once(socket, 'open');
    socket.send(JSON.stringify({ type: 'resume', since: 0 }));
    send('alice', 'alice-first');
    send('bob', 'bob-first', 'bob-private');
    await until(ranTwice);
    channel.notification({ method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { status: 'completed' } } });
    channel.notification({ method: 'turn/completed',
      params: { threadId: 'thread-2', turn: { status: 'completed' } } });
    send('bob', 'bob-switch');
    function hasSwitchedStart() {
      function isSwitchedStart(report: typeof reports[number]) {
        return report.turnId === 'bob-switch' && report.type === 'agent.turn_started';
      }
      return reports.some(isSwitchedStart);
    }
    await until(hasSwitchedStart);
    function isResume(call: typeof calls[number]) {
      return call.method === 'thread/resume';
    }
    expect(calls.filter(isResume)).toEqual([]);
    expect(threadCount).toBe(3);
  } finally {
    socket.terminate();
    await channel.close();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
}
it('overlaps private sessions and never resumes the previous requester when identity changes',
  keepsRequesterContextsSeparate);
