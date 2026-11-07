import { once } from 'node:events';
import { createServer } from 'node:http';
import { WebSocket } from 'ws';
import { expect, it } from 'vitest';
import { bridgeSocket, type BridgeSocketState }
  from '../../computer/src/bridge-socket.ts';
import type { TurnDriver } from '../../computer/src/turn-runner.ts';
import { bridgeRetainedCalls } from '../src/chat/bridge-retained-call.ts';

const approvalId = 'a'.repeat(64);
const signal = { approvalId, callId: 'native-call',
  turnId: 'turn', conversationId: 'conversation', computerId: 'computer',
  generation: 1, serverId: 'server', connectionId: 'connection',
  toolName: 'write', expiresAt: new Date(Date.now() + 5_000).toISOString() };

async function readsOnlyThroughAuthenticatedBridge() {
  const server = createServer();
  const state: BridgeSocketState = { resumed: false };
  let omitReceipt = false;
  function credential() { return { value: 'bridge-secret', expiresAt: Date.now() + 60_000 }; }
  function rpc() { return Promise.resolve({}); }
  function grant() { return Promise.resolve(); }
  function retainedCall(id: string) {
    if (omitReceipt) throw new Error('Live read unavailable');
    return id === approvalId ? signal : undefined;
  }
  const driver: TurnDriver = { credential, rpc, grant, retainedCall, journal: 'unused' };
  function start() { return Promise.resolve(); }
  function interrupt() { return Promise.resolve(); }
  function stopBridge() { return Promise.resolve({}); }
  function connectionLost() {}
  function acknowledge() {}
  const runner = { gate: { closed: false }, start, prepareRoutine: rpc,
    interrupt, stopBridge, acknowledge, connectionLost };
  function reportCount() { return 0; }
  function replayReports() {}
  const bridge = bridgeSocket(server, driver, state, runner, reportCount, replayReports);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test port');
  const url = `ws://127.0.0.1:${address.port}/bridge`;
  let client: WebSocket | undefined;
  try {
    const refused = new WebSocket(url, { headers: { 'x-bridge-token': 'wrong' } });
    await once(refused, 'error');
    client = new WebSocket(url, { headers: { 'x-bridge-token': 'bridge-secret' } });
    await once(client, 'open');
    client.send(JSON.stringify({ type: 'resume', since: 0 }));
    const receipt = bridgeRetainedCalls(client, 'computer', 1);
    function receive(bytes: Buffer) {
      const value: unknown = JSON.parse(bytes.toString());
      receipt.receive(value);
    }
    client.on('message', receive);
    const tabs = await Promise.all([receipt.read(approvalId), receipt.read(approvalId)]);
    expect(tabs).toEqual([signal, signal]);
    expect(await receipt.read('b'.repeat(64))).toBeUndefined();
    const forgedGeneration = bridgeRetainedCalls(client, 'computer', 2);
    client.on('message', receiveForged);
    function receiveForged(bytes: Buffer) {
      const value: unknown = JSON.parse(bytes.toString());
      forgedGeneration.receive(value);
    }
    expect(await forgedGeneration.read(approvalId)).toBeUndefined();
    expect(JSON.stringify(tabs)).not.toContain('arguments');
    expect(JSON.stringify(tabs)).not.toContain('bridge-secret');
    omitReceipt = true;
    expect(await receipt.read(approvalId)).toBeUndefined();
  } finally {
    client?.terminate();
    await bridge.close();
    server.close();
  }
}
it('reads one private retained reference in two tabs over the authenticated bridge',
  readsOnlyThroughAuthenticatedBridge);
