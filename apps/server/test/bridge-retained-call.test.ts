import { once } from 'node:events';
import { createServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { expect, it } from 'vitest';
import { bridgeRetainedCalls } from '../src/chat/bridge-retained-call.ts';

const approvalId = 'a'.repeat(64);
const signal = { approvalId, callId: 'native-call',
  turnId: 'turn', conversationId: 'conversation', computerId: 'computer',
  generation: 1, serverId: 'server', connectionId: 'connection',
  toolName: 'write', expiresAt: new Date(Date.now() + 5_000).toISOString() };

async function matchesOnlyTheRequestedLiveReference() {
  const server = createServer();
  const peers = new WebSocketServer({ server });
  let omitReceipt = false;
  function answer(socket: WebSocket, bytes: Buffer) {
    const request: unknown = JSON.parse(bytes.toString());
    if (!request || typeof request !== 'object' ||
      !('readId' in request) || typeof request.readId !== 'string' ||
      !('approvalId' in request) || typeof request.approvalId !== 'string') return;
    if (omitReceipt) return;
    const retained = request.approvalId === approvalId ? signal : undefined;
    socket.send(JSON.stringify({ type: 'retained_call_status', readId: request.readId,
      signal: retained }));
  }
  function connected(socket: WebSocket) {
    function receive(bytes: Buffer) { answer(socket, bytes); }
    socket.on('message', receive);
  }
  peers.on('connection', connected);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test port');
  const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
  try {
    await once(client, 'open');
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
    function receiveForged(bytes: Buffer) {
      const value: unknown = JSON.parse(bytes.toString());
      forgedGeneration.receive(value);
    }
    client.on('message', receiveForged);
    expect(await forgedGeneration.read(approvalId)).toBeUndefined();
    expect(JSON.stringify(tabs)).not.toContain('arguments');
    omitReceipt = true;
    expect(await receipt.read(approvalId)).toBeUndefined();
  } finally {
    client.terminate();
    peers.close();
    server.close();
  }
}
it('matches one live retained reference for two readers and loses a missing receipt',
  matchesOnlyTheRequestedLiveReference);
