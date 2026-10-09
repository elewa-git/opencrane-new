import { generateKeyPairSync } from 'node:crypto';
import { BudgetActor, envelope } from '@opencrane/models';
import { isEventStoreUnavailable } from '@opencrane/event-store';
import { tokenIssuer } from '@opencrane/auth';
import { createServer, IncomingMessage } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { WebSocket } from 'ws';
import { z } from 'zod';
import { expect, it, vi } from 'vitest';
import { until } from '@opencrane/authz/testing';
import { approvalHolds } from '../../computer/src/approval-holds.ts';
import { bridgeChannel } from '../../computer/src/channel.ts';

it('authenticates, overlaps conversations and replays a strict report sequence after disconnect', async () => {
  const directory = await mkdtemp(`${tmpdir()}/bridge-`), server = createServer();
  let calls = 0;
  const approvals = approvalHolds({ waiting: () => true, renew: async () => {} });
  const approvalResume = vi.spyOn(approvals, 'resume');
  const approvalSettled = vi.spyOn(approvals, 'settle');
  const turnModels: unknown[] = [];
  const channel = bridgeChannel(server, {
    rpc(method, input) {
      if (method === 'thread/start') return Promise.resolve({ thread: { id: `thread-${++calls}` } });
      if (method === 'turn/start') { turnModels.push(input['model']); }
      if (method === 'turn/start') channel.notification({ method: 'item/agentMessage/delta', params: { threadId: input['threadId'], itemId: 'reply', delta: 'Hello' } });
      return Promise.resolve({});
    },
    async grant() {},
    credential: () => ({ value: 'short-lived-test-capability', expiresAt: Date.now() + 60_000 }), journal: `${directory}/reports`,
  }, approvals);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No port');
  const url = `ws://127.0.0.1:${address.port}/bridge`;
  let socket: WebSocket | undefined;
  const reports: { sequence: number; conversationId: string; type: string }[] = [];
  const connect = async (since: number, supported = false) => {
    const ws = new WebSocket(url, { headers: { 'x-bridge-token': 'short-lived-test-capability' } });
    ws.on('message', raw => {
      const report = z.object({ sequence: z.number(), conversationId: z.string(), type: z.string() }).parse(JSON.parse(Buffer.isBuffer(raw) ? raw.toString() : '') as unknown);
      reports.push(report); ws.send(JSON.stringify({ type: 'ack', sequence: report.sequence, token: 'test-turn', expiresAt: Date.now()+120_000 }));
    });
    const opened = once(ws, 'open');
    const upgraded = once(ws, 'upgrade');
    const upgradeEvents: unknown[] = await upgraded;
    const response = upgradeEvents[0];
    if (!(response instanceof IncomingMessage)) throw new Error('Missing upgrade response');
    expect(response.headers['x-opencrane-approval-waiting']).toBe('true');
    await opened; ws.send(JSON.stringify({ type: 'resume', since, approvalWaiting: supported })); return ws;
  };
  try {
    const bad = new WebSocket(url); bad.on('error', () => undefined);
    await once(bad, 'unexpected-response'); bad.terminate();
    socket = await connect(0, true);
    for (const conversationId of ['alice', 'bob']) socket.send(JSON.stringify({ type: 'turn', id: conversationId, conversationId, assistantId: 'assistant', text: 'Hello', token: 'test-turn', expiresAt: Date.now()+60_000 }));
    await until(() => reports.filter(r => r.type === 'agent.message_delta').length === 2);
    expect(approvalResume).toHaveBeenLastCalledWith(true);
    const settlement = { type: 'approval_settled', approvalId: 'a'.repeat(64), state: 'approved' };
    socket.send(JSON.stringify(settlement));
    await until(() => approvalSettled.mock.calls.length === 1);
    expect(approvalSettled).toHaveBeenCalledWith(settlement.approvalId, 'approved');
    expect(calls).toBe(2);
    expect(turnModels).toEqual(['gpt-6.1-sol', 'gpt-6.1-sol']);
    channel.notification({ method: 'item/reasoning/summaryTextDelta', params: { threadId: 'thread-1', delta: 'Checking the request.' } });
    channel.notification({ method: 'item/completed', params: { threadId: 'thread-1', item: { type: 'commandExecution', command: 'echo safe', exitCode: 0 } } });
    await until(() => reports.some(r => r.type === 'agent.command_ran'));
    const last = reports.at(-1)!.sequence; socket.terminate(); await once(socket, 'close');
    channel.notification({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { status: 'completed' } } });
    channel.notification({ method: 'turn/completed', params: { threadId: 'thread-2', turn: { status: 'completed' } } });
    socket = await connect(last);
    await until(() => reports.filter(r => r.type === 'agent.turn_completed').length === 2);
    expect(approvalResume).toHaveBeenLastCalledWith(false);
    expect(reports.map(r => r.sequence)).toEqual(Array.from({ length: reports.length }, (_, i) => i+1));
    socket.send(JSON.stringify({ type: 'turn', id: 'alice', conversationId: 'alice', assistantId: 'assistant', text: 'Hello', token: 'test-turn', expiresAt: Date.now()+60_000 }));
    expect(calls).toBe(2);
  } finally { socket?.terminate(); await channel.close(); server.close(); await rm(directory, { recursive: true, force: true }); }
}, 30_000);

it('recovers the server connector from the NATS report sequence without gaps or duplicate events', async () => {
  const { natsFixture } = await import('@opencrane/event-store/testing');
  const { conversationKeys } = await import('../src/chat/keys.ts');
  const { chatCommand, chatHistory } = await import('../src/chat/commands.ts');
  const { connectBridge } = await import('../src/chat/bridge.ts');
  const { reportPosition } = await import('../src/chat/reports.ts');
  const nats = await natsFixture(), directory = await mkdtemp(`${tmpdir()}/bridge-restart-`), server = createServer();
  const keys = conversationKeys(`${directory}/keys`); keys.provision('test', 'conversation');
  const options = { silo: 'test', store: nats.store, keys }, context = { silo: 'test', memberId: 'alice' };
  await chatCommand(nats.store, keys, context, { id: 'create', conversationId: 'conversation', assistantId: 'assistant' });
  await chatCommand(nats.store, keys, context, { id: 'message', conversationId: 'conversation', text: 'Hello' });
  const channel = bridgeChannel(server, { rpc: () => Promise.resolve({ thread: { id: 'thread' } }), grant: () => Promise.resolve(),
    credential: () => ({ value: 'short-lived-test', expiresAt: Date.now()+60_000 }), journal: `${directory}/reports` });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No port');
  const connection = { url: `ws://127.0.0.1:${address.port}/bridge`, computerId: 'computer', assistantId: 'assistant', bearer: 'short-lived-test' };
  const key = generateKeyPairSync('ec', { namedCurve: 'P-256', privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  await writeFile(`${directory}/key.pem`, key.privateKey, { mode: 0o600 });
  const tokens = await tokenIssuer({ privateKeyPath: `${directory}/key.pem`, issuer: 'https://bridge.test/' });
  let position = 0;
  for (const type of ['computer.claimed', 'computer.ready']) {
    const result = await nats.store.append({ expectedSequence: position, event: { id: type, commandId: type, type,
      silo: 'test', subject: 'computer-assistant', source: 'test', principal: { kind: 'system', id: 'test' }, time: new Date().toISOString(),
      data: { computerId: 'computer', assistantId: 'assistant', generation: 1, ...(type === 'computer.claimed' ? { tokenId: 'token:test' } : { podUid: 'pod' }) } } });
    if (result.status !== 'appended') throw new Error('Computer fixture failed'); position = result.sequence;
  }
  await new BudgetActor(nats.store, 'test').start(2000, 20000, 'personal-default');
  await nats.store.append({ expectedSequence: 0, event: envelope('test', 'assistant-assistant', 'assistant.created', { assistantId: 'assistant', ownerId: 'alice', kind: 'personal' }) });
  let link = await connectBridge(options, connection, tokens);
  let reconnect = false;
  function closed(code: number) {
    reconnect = code === 1011;
  }
  link.socket.on('close', closed);
  async function waitForPosition(expected: number) {
    async function reachedPosition() {
      try {
        // Match the production connector's next-poll recovery after unavailable persistence.
        if (reconnect) {
          await link.settled();
          link = await connectBridge(options, connection, tokens);
          link.socket.on('close', closed);
          reconnect = false;
        }
        return await reportPosition(nats.store, 'test', 'computer') === expected;
      } catch (error) {
        if (isEventStoreUnavailable(error)) {
          return false;
        }
        throw error;
      }
    }
    await until(reachedPosition);
  }
  try {
    link.socket.send(JSON.stringify({ type: 'turn', id: 'message', conversationId: 'conversation', assistantId: 'assistant', text: 'Hello', token: 'short-lived-turn', expiresAt: Date.now()+60_000 }));
    await waitForPosition(1);
    channel.notification({ method: 'item/agentMessage/delta', params: { threadId: 'thread', itemId: 'reply', delta: 'Hello back' } });
    await waitForPosition(2);
    link.socket.terminate(); await once(link.socket, 'close'); await link.settled();
    channel.notification({ method: 'item/completed', params: { threadId: 'thread', item: { type: 'agentMessage', id: 'reply', text: 'Hello back' } } });
    channel.notification({ method: 'turn/completed', params: { threadId: 'thread', turn: { status: 'completed' } } });
    link = await connectBridge(options, connection, tokens);
    link.socket.on('close', closed);
    await waitForPosition(4);
    const reports = (await chatHistory(nats.store, 'test', 'conversation')).flatMap(r => r.event.report ? [r.event.report.sequence] : []);
    expect(reports).toEqual([1, 2, 3, 4]);
  } finally { link.socket.terminate(); await channel.close(); server.close(); await nats.close(); await rm(directory, { recursive: true, force: true }); }
}, 30_000);

it('reconnects after 121 seconds and executes the pending message once with a fresh grant', async () => {
  const directory = await mkdtemp(`${tmpdir()}/bridge-refresh-`), server = createServer();
  const initial = Date.now(); let now = initial, runs = 0;
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  const channel = bridgeChannel(server, {
    rpc: method => { if (method === 'turn/start') runs++; return Promise.resolve({ thread: { id: 'thread' } }); },
    grant: (_thread, _conversation, token, expiry) => {
      if (token !== 'fresh' || expiry <= now) return Promise.reject(new Error('Expired grant'));
      return Promise.resolve();
    },
    credential: () => ({ value: 'computer', expiresAt: now + 600_000 }), journal: `${directory}/reports`,
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No port');
  const connect = async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/bridge`, { headers: { 'x-bridge-token': 'computer' } });
    await once(socket, 'open'); return socket;
  };
  let socket = await connect();
  try {
    const first = once(socket, 'message');
    socket.send(JSON.stringify({ type: 'resume', since: 0 }));
    const input = { type: 'turn', id: 'message', conversationId: 'conversation', assistantId: 'assistant', text: 'Hello', token: 'old', expiresAt: initial + 120_000 };
    socket.send(JSON.stringify(input)); await first;
    socket.terminate(); await once(socket, 'close');
    now += 121_000;
    socket = await connect();
    socket.send(JSON.stringify({ type: 'resume', since: 1 }));
    socket.send(JSON.stringify({ ...input, token: 'fresh', expiresAt: now + 120_000 }));
    socket.send(JSON.stringify({ type: 'ack', sequence: 1, token: 'fresh', expiresAt: now + 120_000 }));
    await until(() => runs === 1, 1000);
    expect(runs).toBe(1);
  } finally { clock.mockRestore(); socket.terminate(); await channel.close(); server.close(); await rm(directory, { recursive: true, force: true }); }
});

it('interrupts the requested Codex turn and retains the partial report', async () => {
  const directory = await mkdtemp(`${tmpdir()}/bridge-stop-`), server = createServer();
  const reports: { type: string; text?: string | undefined }[] = [];
  const channel = bridgeChannel(server, {
    rpc(method, params) {
      if (method === 'thread/start') return Promise.resolve({ thread: { id: 'thread' } });
      if (method === 'turn/start') {
        channel.notification({ method: 'item/agentMessage/delta', params: { threadId: 'thread', itemId: 'reply', delta: 'Partial' } });
        return Promise.resolve({ turn: { id: 'codex-turn' } });
      }
      expect(method).toBe('turn/interrupt'); expect(params).toEqual({ threadId: 'thread', turnId: 'codex-turn' });
      channel.notification({ method: 'turn/completed', params: { threadId: 'thread', turn: { status: 'interrupted' } } });
      return Promise.resolve({});
    },
    async grant() {}, credential: () => ({ value: 'test', expiresAt: Date.now() + 60_000 }), journal: `${directory}/reports`,
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No port');
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/bridge`, { headers: { 'x-bridge-token': 'test' } });
  socket.on('message', raw => {
    const row = z.object({ sequence: z.number(), type: z.string(), text: z.string().optional() }).parse(JSON.parse(Buffer.isBuffer(raw) ? raw.toString() : ''));
    reports.push(row); socket.send(JSON.stringify({ type: 'ack', sequence: row.sequence, token: 'turn', expiresAt: Date.now() + 60_000 }));
  });
  try {
    await once(socket, 'open'); socket.send(JSON.stringify({ type: 'resume', since: 0 }));
    socket.send(JSON.stringify({ type: 'turn', id: 'message', conversationId: 'conversation', assistantId: 'assistant', text: 'Hello', token: 'turn', expiresAt: Date.now() + 60_000 }));
    await until(() => reports.some(row => row.text === 'Partial'));
    socket.send(JSON.stringify({ type: 'stop', turnId: 'message', conversationId: 'conversation' }));
    await until(() => reports.some(row => row.type === 'agent.turn_failed'), 1500);
    expect(reports.find(row => row.type === 'agent.message_delta')?.text).toBe('Partial');
  } finally { socket.terminate(); await channel.close(); server.close(); await rm(directory, { recursive: true, force: true }); }
});

it('replays reports written before a channel restart without executing the turn again', async () => {
  const directory = await mkdtemp(`${tmpdir()}/bridge-restart-journal-`);
  const server = createServer();
  const journal = `${directory}/reports`;
  let starts = 0;
  const driver = {
    rpc(method: string, _params: Record<string, unknown>) {
      if (method === 'thread/start') {
        return Promise.resolve({ thread: { id: 'thread' } });
      }
      if (method === 'turn/start') {
        starts++;
        channel.notification({
          method: 'item/agentMessage/delta',
          params: { threadId: 'thread', delta: 'Saved' },
        });
      }
      return Promise.resolve({});
    },
    async grant() {},
    credential: testCredential,
    journal,
  };
  let channel = bridgeChannel(server, driver);
  const reports: BridgeReportSummary[] = [];
  let socket: WebSocket | undefined;
  try {
    socket = await openBridgeSocket(server);
    addReportCollector(socket, reports, acknowledgeReport);
    const initialResume = { type: 'resume', since: 0 };
    const firstTurn = { ...testTurn };
    socket.send(JSON.stringify(initialResume));
    socket.send(JSON.stringify(firstTurn));
    await until(reportContainsText(reports, 'Saved'));
    expect(starts).toBe(1);
    channel.notification({
      method: 'turn/completed',
      params: { threadId: 'thread', turn: { status: 'completed' } },
    });
    await until(reportContainsType(reports, 'agent.turn_completed'));
    socket.terminate();
    await once(socket, 'close');
    socket = undefined;
    await channel.close();

    channel = bridgeChannel(server, driver);
    reports.length = 0;
    socket = await openBridgeSocket(server);
    addReportCollector(socket, reports, acknowledgeReport);
    const replayResume = { type: 'resume', since: 1 };
    socket.send(JSON.stringify(replayResume));
    await until(reportContainsSequenceAndText(reports, 2, 'Saved'));
    const replayedReports = reports.filter(hasSecondSequence);
    expect(replayedReports).toEqual([
      { sequence: 2, type: 'agent.message_delta', text: 'Saved' },
    ]);
    expect(starts).toBe(1);
    const journalContents = await readFile(journal, 'utf8');
    const journalText = journalContents.trim();
    const journalRows = journalText.split('\n');
    expect(journalRows).toHaveLength(3);
  } finally {
    socket?.terminate();
    await channel.close();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it('marks an executing turn failed when the channel restarts', async () => {
  const directory = await mkdtemp(`${tmpdir()}/bridge-crash-recovery-`);
  const server = createServer();
  const journal = `${directory}/reports`;
  const startedReport = {
    sequence: 1,
    previousSequence: 0,
    conversationId: 'conversation',
    turnId: 'message',
    assistantId: 'assistant',
    type: 'agent.turn_started',
    threadId: 'thread',
  };
  const startedReportLine = `${JSON.stringify(startedReport)}\n`;
  await writeFile(journal, startedReportLine);
  await writeFile(`${journal}.executions`, 'message\n');
  const driver = {
    rpc: rejectUnexpectedExecution,
    async grant() {},
    credential: testCredential,
    journal,
  };
  const channel = bridgeChannel(server, driver);
  const reports: BridgeReportSummary[] = [];
  const socket = await openBridgeSocket(server);
  addReportCollector(socket, reports);
  try {
    const resume = { type: 'resume', since: 1 };
    socket.send(JSON.stringify(resume));
    await until(reportContainsType(reports, 'agent.turn_failed'));
    expect(reports).toEqual([{ sequence: 2, type: 'agent.turn_failed' }]);
    const journalContents = await readFile(journal, 'utf8');
    const journalText = journalContents.trim();
    const journalRows = journalText.split('\n');
    const reportTypes = journalRows.map(readReportType);
    expect(reportTypes).toEqual(['agent.turn_started', 'agent.turn_failed']);
  } finally {
    socket.terminate();
    await channel.close();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

function readReportType(line: string) {
  const reportSchema = z.object({ type: z.string() });
  const parsedLine = JSON.parse(line) as unknown;
  const report = reportSchema.parse(parsedLine);
  return report.type;
}

it('recovers a started turn from a legacy journal without execution markers', async () => {
  const directory = await mkdtemp(`${tmpdir()}/bridge-legacy-journal-`);
  const server = createServer();
  const journal = `${directory}/reports`;
  const legacyStartedReport = {
    sequence: 1,
    conversationId: 'conversation',
    turnId: 'message',
    assistantId: 'assistant',
    type: 'agent.turn_started',
    threadId: 'thread',
  };
  const legacyStartedPacket = `${JSON.stringify(legacyStartedReport)}\n`;
  await writeFile(journal, legacyStartedPacket);

  const channel = bridgeChannel(server, {
    rpc: rejectUnexpectedExecution,
    async grant() {},
    credential: testCredential,
    journal,
  });
  const reports: BridgeReportSummary[] = [];
  const socket = await openBridgeSocket(server);
  addReportCollector(socket, reports);
  try {
    const resumeAfterFirstReport = { type: 'resume', since: 1 };
    socket.send(JSON.stringify(resumeAfterFirstReport));
    await until(reportContainsType(reports, 'agent.turn_failed'));
    expect(reports).toEqual([{ sequence: 2, type: 'agent.turn_failed' }]);
  } finally {
    socket.terminate();
    await channel.close();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it('stops a turn while thread start is pending before it can execute', async () => {
  const directory = await mkdtemp(`${tmpdir()}/bridge-stop-preparing-`);
  const server = createServer();
  let releaseThreadStart!: (value: unknown) => void;
  let turnStarts = 0;
  function captureThreadStartRelease(resolve: (value: unknown) => void) {
    releaseThreadStart = resolve;
  }
  const threadStart = new Promise<unknown>(captureThreadStartRelease);
  const reports: BridgeReportSummary[] = [];
  const channel = bridgeChannel(server, {
    rpc(method) {
      if (method === 'thread/start') {
        return threadStart;
      }
      if (method === 'turn/start') {
        turnStarts++;
      }
      return Promise.resolve({});
    },
    async grant() {},
    credential: testCredential,
    journal: `${directory}/reports`,
  });
  const socket = await openBridgeSocket(server);
  addReportCollector(socket, reports, acknowledgeReport);
  try {
    socket.send(JSON.stringify({ type: 'resume', since: 0 }));
    socket.send(JSON.stringify(testTurn));
    socket.send(JSON.stringify(testStop));
    const socketClosed = once(socket, 'close');
    socket.send(JSON.stringify({ type: 'invalid' }));
    await socketClosed;
    releaseThreadStart({ thread: { id: 'thread' } });
    const resumedSocket = await openBridgeSocket(server);
    addReportCollector(resumedSocket, reports, acknowledgeReport);
    resumedSocket.send(JSON.stringify({ type: 'resume', since: 0 }));
    await until(reportContainsType(reports, 'agent.turn_failed'));
    expect(turnStarts).toBe(0);
  } finally {
    socket.terminate();
    await channel.close();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it('refuses a different turn delivered to an occupied conversation', async () => {
  const directory = await mkdtemp(`${tmpdir()}/bridge-occupied-conversation-`);
  const server = createServer();
  let releaseTurnStart!: (value: unknown) => void;
  let threadStarts = 0;
  function captureTurnStartRelease(resolve: (value: unknown) => void) {
    releaseTurnStart = resolve;
  }
  const turnStart = new Promise<unknown>(captureTurnStartRelease);
  const channel = bridgeChannel(server, {
    rpc(method) {
      if (method === 'thread/start') {
        threadStarts++;
        return Promise.resolve({ thread: { id: 'thread' } });
      }
      if (method === 'turn/start') {
        return turnStart;
      }
      return Promise.resolve({});
    },
    async grant() {},
    credential: testCredential,
    journal: `${directory}/reports`,
  });
  const reports: BridgeReportSummary[] = [];
  let socket = await openBridgeSocket(server);
  addReportCollector(socket, reports, acknowledgeReport);
  try {
    socket.send(JSON.stringify({ type: 'resume', since: 0 }));
    socket.send(JSON.stringify(testTurn));
    await until(reportContainsType(reports, 'agent.turn_started'));
    const otherTurn = { ...testTurn, id: 'other-message', text: 'Another request' };
    socket.send(JSON.stringify(otherTurn));
    const socketClosed = once(socket, 'close');
    socket.send(JSON.stringify({ type: 'invalid' }));
    await socketClosed;
    releaseTurnStart({ turn: { id: 'codex-turn' } });
    expect(threadStarts).toBe(1);
    channel.notification({
      method: 'turn/completed',
      params: { threadId: 'thread', turn: { status: 'completed' } },
    });
    socket = await openBridgeSocket(server);
    addReportCollector(socket, reports, acknowledgeReport);
    const replay = { type: 'resume', since: 0 };
    socket.send(JSON.stringify(replay));
    await until(reportContainsType(reports, 'agent.turn_completed'));
    expect(reports.some(isAdditionalTurnStartedReport)).toBe(false);
  } finally {
    socket.terminate();
    await channel.close();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it('refuses turn dispatch before the socket has resumed', async () => {
  const directory = await mkdtemp(`${tmpdir()}/bridge-dispatch-before-resume-`);
  const server = createServer();
  let rpcCalls = 0;
  const channel = bridgeChannel(server, {
    rpc() {
      rpcCalls++;
      return Promise.resolve({});
    },
    async grant() {},
    credential: testCredential,
    journal: `${directory}/reports`,
  });
  const socket = await openBridgeSocket(server);
  try {
    const closed = once(socket, 'close');
    socket.send(JSON.stringify(testTurn));
    await closed;
    expect(rpcCalls).toBe(0);
  } finally {
    socket.terminate();
    await channel.close();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

interface BridgeReportSummary {
  sequence: number;
  type: string;
  text?: string | undefined;
}

const testCredential = () => ({ value: 'test', expiresAt: Date.now() + 60_000 });

const testTurn = {
  type: 'turn',
  id: 'message',
  conversationId: 'conversation',
  assistantId: 'assistant',
  text: 'Hello',
  token: 'turn',
  expiresAt: Date.now() + 60_000,
};

const testStop = {
  type: 'stop',
  turnId: 'message',
  conversationId: 'conversation',
};

function rejectUnexpectedExecution() {
  return Promise.reject(new Error('Recovery must not execute a turn'));
}

async function openBridgeSocket(server: ReturnType<typeof createServer>) {
  if (!server.listening) {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
  }
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('No port');
  }
  const url = `ws://127.0.0.1:${address.port}/bridge`;
  const socket = new WebSocket(url, { headers: { 'x-bridge-token': 'test' } });
  await once(socket, 'open');
  return socket;
}

function addReportCollector(
  socket: WebSocket,
  reports: BridgeReportSummary[],
  acknowledge: (socket: WebSocket, report: BridgeReportSummary) => void = ignoreAcknowledgement,
) {
  const reportSchema = z.object({
    sequence: z.number(),
    type: z.string(),
    text: z.string().optional(),
  });
  function handleReport(raw: WebSocket.RawData) {
    const messageText = Buffer.isBuffer(raw) ? raw.toString() : '';
    const parsedMessage = JSON.parse(messageText) as unknown;
    const report = reportSchema.parse(parsedMessage);
    reports.push(report);
    acknowledge(socket, report);
  }
  socket.on('message', handleReport);
}

function acknowledgeReport(socket: WebSocket, report: BridgeReportSummary) {
  const acknowledgement = {
    type: 'ack',
    sequence: report.sequence,
    token: 'turn',
    expiresAt: Date.now() + 60_000,
  };
  socket.send(JSON.stringify(acknowledgement));
}

function ignoreAcknowledgement() {}

function reportContainsType(reports: BridgeReportSummary[], type: string) {
  function hasReportType(report: BridgeReportSummary) {
    return report.type === type;
  }
  return function containsReport() {
    return reports.some(hasReportType);
  };
}

function reportContainsText(reports: BridgeReportSummary[], text: string) {
  function hasReportText(report: BridgeReportSummary) {
    return report.text === text;
  }
  return function containsReportText() {
    return reports.some(hasReportText);
  };
}

function reportContainsSequenceAndText(
  reports: BridgeReportSummary[],
  sequence: number,
  text: string,
) {
  function hasSequenceAndText(report: BridgeReportSummary) {
    return report.sequence === sequence && report.text === text;
  }
  return function containsSequenceAndText() {
    return reports.some(hasSequenceAndText);
  };
}

function hasSecondSequence(report: BridgeReportSummary) {
  return report.sequence === 2;
}

function isAdditionalTurnStartedReport(report: BridgeReportSummary) {
  return report.type === 'agent.turn_started' && report.sequence > 1;
}

it('retries a failed Stop after turn/start returns, retaining the active turn and its reports', async () => {
  const directory = await mkdtemp(`${tmpdir()}/bridge-stop-race-`);
  const server = createServer();
  let releaseTurnStart!: (value: unknown) => void;
  let interrupts = 0;
  function captureTurnStartRelease(resolve: (value: unknown) => void) {
    releaseTurnStart = resolve;
  }
  const turnStart = new Promise<unknown>(captureTurnStartRelease);
  const reports: BridgeReportSummary[] = [];
  const channel = bridgeChannel(server, {
    rpc(method) {
      if (method === 'thread/start') {
        return Promise.resolve({ thread: { id: 'thread' } });
      }
      if (method === 'turn/start') {
        channel.notification({
          method: 'item/agentMessage/delta',
          params: { threadId: 'thread', itemId: 'reply', delta: 'Partial' },
        });
        return turnStart;
      }
      interrupts++;
      if (interrupts === 1) {
        return Promise.reject(new Error('Transport unavailable'));
      }
      channel.notification({
        method: 'turn/completed',
        params: { threadId: 'thread', turn: { status: 'interrupted' } },
      });
      return Promise.resolve({});
    },
    async grant() {},
    credential: testCredential,
    journal: `${directory}/reports`,
  });
  let socket = await openBridgeSocket(server);
  addReportCollector(socket, reports, acknowledgeReport);
  const stop = { ...testStop };
  try {
    const resume = { type: 'resume', since: 0 };
    const turn = { ...testTurn };
    socket.send(JSON.stringify(resume));
    socket.send(JSON.stringify(turn));
    await until(reportContainsText(reports, 'Partial'));
    socket.send(JSON.stringify(stop));
    // A subsequent replay response proves the preceding Stop frame was processed.
    const reportCountBeforeReplay = reports.length;
    const replayArrived = () => reports.length > reportCountBeforeReplay;
    const interruptSent = () => interrupts === 1;
    socket.send(JSON.stringify(resume));
    await until(replayArrived);
    releaseTurnStart({ turn: { id: 'codex-turn' } });
    await until(interruptSent);
    expect(reports.some(isFailedTurnReport)).toBe(false);
    socket.terminate();
    socket = await openBridgeSocket(server);
    addReportCollector(socket, reports, acknowledgeReport);
    socket.send(JSON.stringify(resume));
    channel.notification({
      method: 'item/agentMessage/delta',
      params: { threadId: 'thread', itemId: 'reply', delta: ' still running' },
    });
    await until(reportContainsText(reports, ' still running'));
    socket.send(JSON.stringify(stop));
    await until(reportContainsType(reports, 'agent.turn_failed'));
    expect(interrupts).toBe(2);
  } finally {
    socket.terminate();
    await channel.close();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

function isFailedTurnReport(report: BridgeReportSummary) {
  return report.type === 'agent.turn_failed';
}

async function keepsBridgeOpenAfterInvalidToolNotification() {
  const directory = await mkdtemp(`${tmpdir()}/bridge-invalid-tool-`);
  const server = createServer();
  let turnStarted = false;
  function rpc(method: string) {
    if (method === 'thread/start') {
      return Promise.resolve({ thread: { id: 'thread' } });
    }
    if (method === 'turn/start') turnStarted = true;
    return Promise.resolve({ turn: { id: 'codex-turn' } });
  }
  async function grant() {}
  async function catalogue() {}
  async function discovered() {}
  const driver = { rpc, grant, catalogue, discovered, credential: testCredential,
    journal: `${directory}/reports` };
  const channel = bridgeChannel(server, driver);
  const socket = await openBridgeSocket(server);
  const reports: BridgeReportSummary[] = [];
  addReportCollector(socket, reports, acknowledgeReport);
  try {
    const resume = { type: 'resume', since: 0 };
    const tool = { key: 'oc_0123456789', serverId: 'fixture', connectionId: 'installed',
      definitions: [], modes: {} };
    const turn = { ...testTurn, tools: [tool] };
    socket.send(JSON.stringify(resume));
    socket.send(JSON.stringify(turn));
    function started() { return turnStarted; }
    await until(started);
    const item = { type: 'mcpToolCall', id: 'call_1', server: tool.key,
      tool: 'x'.repeat(201), status: 'completed' };
    function notify(method: string, reportedItem: unknown) {
      const notification = { method, params: { threadId: 'thread', item: reportedItem } };
      channel.notification(notification);
    }
    notify('item/started', item);
    notify('item/completed', item);
    const valid = { ...item, id: 'functions.write:0', tool: 'write' };
    notify('item/started', valid);
    notify('item/completed', valid);
    const completed = { method: 'turn/completed',
      params: { threadId: 'thread', turn: { status: 'completed' } } };
    channel.notification(completed);
    await until(reportContainsType(reports, 'agent.turn_completed'));
    expect(reports).toEqual([
      { sequence: 1, type: 'agent.turn_started' },
      { sequence: 2, type: 'agent.tool_call_started' },
      { sequence: 3, type: 'agent.tool_call_finished' },
      { sequence: 4, type: 'agent.turn_completed' },
    ]);
    expect(socket.readyState).toBe(WebSocket.OPEN);
  } finally {
    socket.terminate();
    await channel.close();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
}
it('keeps the bridge open and reports later work after an invalid tool notification',
  keepsBridgeOpenAfterInvalidToolNotification);
