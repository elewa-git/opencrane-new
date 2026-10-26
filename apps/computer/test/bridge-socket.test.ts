import { once } from 'node:events';
import { createServer } from 'node:http';
import { WebSocket } from 'ws';
import { expect, it } from 'vitest';
import { bridgeSocket, type BridgeSocketState } from '../src/bridge-socket.ts';
import type { BridgeReport } from '../src/report-journal.ts';
import type { TurnDriver } from '../src/turn-runner.ts';
import { record } from '../src/http.ts';

function report(sequence: number, text = 'partial'): BridgeReport {
  return { sequence, conversationId: 'chat', turnId: 'turn', assistantId: 'assistant',
    type: 'agent.message_delta', messageId: 'reply', text };
}

async function fixture() {
  const server = createServer();
  const state: BridgeSocketState = { resumed: false };
  const reports: BridgeReport[] = [];
  const sockets: WebSocket[] = [];
  function credential() { return { value: 'test', expiresAt: Date.now() + 60_000 }; }
  function rpc() { return Promise.resolve({}); }
  function grant() { return Promise.resolve(); }
  const driver: TurnDriver = { credential, rpc, grant, journal: 'unused' };
  function start() { return Promise.resolve(); }
  function interrupt() { return Promise.resolve(); }
  function stopBridge() { return Promise.resolve({}); }
  function connectionLost() {}
  function acknowledge() { /* Keep acknowledgements independent of the journal fixture. */ }
  const runner = { gate: { closed: false }, start, interrupt, stopBridge, acknowledge,
    connectionLost };
  function reportCount() { return reports.length; }
  function replayReports(since: number, send: (value: BridgeReport) => void) {
    for (const saved of reports) {
      if (saved.sequence > since) send(saved);
    }
  }
  const bridge = bridgeSocket(server, driver, state, runner, reportCount, replayReports);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture port');
  const url = `ws://127.0.0.1:${address.port}/bridge`;
  async function flush(socket: WebSocket) {
    const pong = once(socket, 'pong');
    socket.ping();
    await pong;
  }
  async function connect(since: number) {
    const socket = new WebSocket(url, { headers: { 'x-bridge-token': 'test' } });
    sockets.push(socket);
    const received: Record<string, unknown>[] = [];
    function receive(bytes: Buffer) {
      const parsed: unknown = JSON.parse(bytes.toString());
      received.push(record(parsed));
    }
    socket.on('message', receive);
    await once(socket, 'open');
    socket.send(JSON.stringify({ type: 'resume', since }));
    await flush(socket);
    return { socket, received };
  }
  async function close() {
    for (const socket of sockets) socket.terminate();
    await bridge.close();
    server.close();
  }
  return { bridge, reports, connect, flush, close };
}

async function doesNotSendAnInFlightSequenceTwice() {
  const computer = await fixture();
  try {
    const connection = await computer.connect(0);
    const first = report(1);
    computer.bridge.send(first);
    await computer.flush(connection.socket);
    expect(connection.received).toEqual([first]);
    computer.bridge.send(first);
    await computer.flush(connection.socket);
    expect(connection.received).toEqual([first]);
  } finally {
    await computer.close();
  }
}
it('does not send a sequence again while its acknowledgement is pending',
  doesNotSendAnInFlightSequenceTwice);

async function rebuildsAFullWindowFromTheAdvancedSavedPosition() {
  const computer = await fixture();
  try {
    for (let sequence = 1; sequence <= 33; sequence++) {
      computer.reports.push(report(sequence, 'p'.repeat(15_000)));
    }
    const first = await computer.connect(0);
    expect(first.received).toEqual(computer.reports.slice(0, 32));
    first.socket.terminate();
    await once(first.socket, 'close');
    for (let sequence = 34; sequence <= 70; sequence++) {
      computer.reports.push(report(sequence, 'n'.repeat(64_000)));
    }
    // Recover a lost acknowledgement: the server has saved even the old pending report.
    const second = await computer.connect(33);
    expect(second.received).toEqual(computer.reports.slice(33, 41));
    for (let index = 0; index < 37; index++) {
      const saved = second.received[index];
      expect(saved).toEqual(computer.reports[index + 33]);
      second.socket.send(JSON.stringify({ type: 'ack', sequence: saved!['sequence'] }));
      await computer.flush(second.socket);
    }
    expect(second.received).toEqual(computer.reports.slice(33));
  } finally {
    await computer.close();
  }
}
it('reconnects with a full window and replays only reports after the advanced saved position',
  rebuildsAFullWindowFromTheAdvancedSavedPosition);
