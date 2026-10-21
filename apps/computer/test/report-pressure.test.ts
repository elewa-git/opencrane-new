import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { until } from '@opencrane/authz/testing';
import { record } from '../src/http.ts';
import { fixture } from './bridge-gate-fixture.ts';

async function stopsWhileReplayingAStreamingReply(piece: string) {
  const computer = await fixture();
  const saved = new Map<number, Record<string, unknown>>();
  const closed = Promise.withResolvers<void>();
  const timers = new Set<NodeJS.Timeout>();
  let streaming = true;
  let pieces = 0;
  let outstanding = 0;
  let outstandingBytes = 0;
  let streamingAtStop = false;
  let stopSent = false;
  const rpc = computer.driver.rpc.bind(computer.driver);
  function replyPiece() {
    if (!streaming) return;
    pieces++;
    const params = { threadId: 'thread-1', itemId: 'reply', delta: piece };
    computer.channel.notification({ method: 'item/agentMessage/delta', params });
  }
  function modelRpc(method: string, params: Record<string, unknown>) {
    if (method === 'turn/interrupt') {
      streaming = false;
      const turn = { id: 'codex-thread-1', status: 'interrupted' };
      const completed = { threadId: 'thread-1', turn };
      computer.channel.notification({ method: 'turn/completed', params: completed });
    }
    return rpc(method, params);
  }
  computer.driver.rpc = modelRpc;
  let producer: NodeJS.Timeout | undefined;
  try {
    computer.start('first');
    function started() { return computer.calls.includes('turn/start:thread-1'); }
    await until(started, 2000);
    computer.socket.terminate();
    await once(computer.socket, 'close');
    // Keep a real journal backlog and continue producing until Stop interrupts the model.
    for (let index = 0; index < 128; index++) replyPiece();
    producer = setInterval(replyPiece, 5);
    computer.pauseAcks();
    const socket = await computer.connect(false);
    function stop() {
      streamingAtStop = streaming;
      const frame = { type: 'stop', turnId: 'first', conversationId: 'first' };
      socket.send(JSON.stringify(frame));
    }
    function receive(bytes: Buffer) {
      const report = record(JSON.parse(bytes.toString()));
      const sequence = report['sequence'];
      if (typeof sequence !== 'number') return;
      outstanding++;
      outstandingBytes += bytes.length;
      // Match the server's bounded queue, with asynchronous persistence still in progress.
      if (outstanding > 64 || outstandingBytes > 1_048_576) {
        socket.close(1013, 'Report queue limit');
        return;
      }
      function persist() {
        timers.delete(timer);
        outstanding--;
        outstandingBytes -= bytes.length;
        if (socket.readyState !== socket.OPEN) return;
        saved.set(sequence, report);
        const ack = { type: 'ack', sequence, token: 'fresh', expiresAt: Date.now() + 60_000 };
        socket.send(JSON.stringify(ack));
        if (report['type'] === 'agent.turn_failed') closed.resolve();
      }
      const timer = setTimeout(persist, 25);
      timers.add(timer);
      if (!stopSent && report['type'] === 'agent.message_delta') {
        stopSent = true;
        setTimeout(stop, 10);
      }
    }
    socket.on('message', receive);
    const startedAt = performance.now();
    socket.send(JSON.stringify({ type: 'resume', since: 1 }));
    const expired = delay(2000);
    await Promise.race([closed.promise, expired]);
    expect(streamingAtStop).toBe(true);
    expect(streaming, 'Stop reaches the model while reports are being saved').toBe(false);
    function isClosure(report: Record<string, unknown>) {
      return report['type'] === 'agent.turn_failed';
    }
    expect([...saved.values()].some(isClosure)).toBe(true);
    expect(performance.now() - startedAt).toBeLessThan(2000);
    let partial = '';
    for (const report of saved.values()) {
      if (report['type'] === 'agent.message_delta') partial += String(report['text']);
    }
    expect(partial).toBe(piece.repeat(pieces));
  } finally {
    clearInterval(producer);
    for (const timer of timers) clearTimeout(timer);
    await computer.close();
  }
}

it.each(['partial ', 'p'.repeat(64_000)])(
  'closes a stopped turn within two seconds while replay and streaming reports arrive',
  stopsWhileReplayingAStreamingReply);
