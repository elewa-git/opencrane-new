import { createServer } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { WebSocketServer, type RawData } from 'ws';
import { expect, it, vi } from 'vitest';
import * as eventSchemas from '@opencrane/events';
import { natsFixture } from '@opencrane/event-store/testing';
import { connectBridge } from '../src/chat/bridge.ts';
import { conversationKeys } from '../src/chat/keys.ts';
import { recordReport, recordReports, reportPosition } from '../src/chat/reports.ts';
import { chatCommand } from '../src/chat/commands.ts';

it('saves 2700 streaming reports through the bridge within ten seconds', async () => {
  const nats = await natsFixture();
  const directory = await mkdtemp(`${tmpdir()}/bridge-throughput-`);
  const keys = conversationKeys(directory);
  const server = createServer();
  const sockets = new WebSocketServer({ server });
  keys.provision('test', 'long');
  const context = { silo: 'test', memberId: 'alice' };
  await chatCommand(nats.store, keys, context,
    { id: 'create-long', conversationId: 'long', assistantId: 'assistant' });
  await chatCommand(nats.store, keys, context,
    { id: 'request-long', conversationId: 'long', text: 'Long reply' });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  const connection = once(sockets, 'connection');
  const link = await connectBridge({ silo: 'test', store: nats.store, keys }, {
    url: `ws://127.0.0.1:${address.port}`, computerId: 'computer',
    assistantId: 'assistant', bearer: 'test',
  });
  await connection;
  const socket = [...sockets.clients][0]!;
  const finished = Promise.withResolvers<void>();
  let sent = 0;
  let acknowledged = 0;
  function reportFor(sequence: number, text = 'word ') {
    return { sequence, previousSequence: sequence - 1,
      conversationId: 'long', turnId: 'request-long', assistantId: 'assistant',
      type: 'agent.message_delta', messageId: 'reply', text };
  }
  function sendReport() {
    sent++;
    socket.send(JSON.stringify(reportFor(sent)));
  }
  function receive(raw: RawData) {
    const value = JSON.parse(raw.toString()) as { type: string; sequence?: number };
    if (value.type !== 'ack') return;
    acknowledged++;
    if (sent < 2700) sendReport();
    if (acknowledged === 2700) finished.resolve();
  }
  socket.on('message', receive);
  function closed(code: number) {
    finished.reject(new Error(`Bridge closed with ${code} after ${acknowledged} reports`));
  }
  socket.once('close', closed);
  const metrics = { reads: 0, readMs: 0, appends: 0, appendMs: 0, requests: 0,
    requestMs: 0, encryptMs: 0, validationMs: 0, jsonMs: 0 };
  const read = nats.store.readStream.bind(nats.store);
  async function* timedRead(...args: Parameters<typeof read>) {
    const began = performance.now();
    metrics.reads++;
    try { yield* read(...args); }
    finally { metrics.readMs += performance.now() - began; }
  }
  nats.store.readStream = timedRead;
  let stopMs = 0;
  let stopped: ReturnType<typeof chatCommand> | undefined;
  async function checkStopAccess() {
    await delay(100);
    return performance.now() + 2000;
  }
  const append = nats.store.append.bind(nats.store);
  async function timedAppend(...args: Parameters<typeof append>) {
    const began = performance.now();
    metrics.appends++;
    if (metrics.appends === 5) {
      const stopStarted = performance.now();
      const stop = { id: 'stop-long', conversationId: 'long', stopTurnId: 'request-long' };
      async function stopWhileStreaming() {
        const result = await chatCommand(nats.store, keys, context, stop, checkStopAccess);
        stopMs = performance.now() - stopStarted;
        return result;
      }
      stopped = stopWhileStreaming();
    }
    try { return await append(...args); }
    finally { metrics.appendMs += performance.now() - began; }
  }
  nats.store.append = timedAppend;
  const request = nats.connection.request.bind(nats.connection);
  async function timedRequest(...args: Parameters<typeof request>) {
    const began = performance.now();
    metrics.requests++;
    try { return await request(...args); }
    finally { metrics.requestMs += performance.now() - began; }
  }
  nats.connection.request = timedRequest;
  const encrypt = keys.encrypt.bind(keys);
  function timedEncrypt(...args: Parameters<typeof encrypt>) {
    const began = performance.now();
    try { return encrypt(...args); }
    finally { metrics.encryptMs += performance.now() - began; }
  }
  keys.encrypt = timedEncrypt;
  const parseEvent = eventSchemas.parseEventByType;
  function timedValidation(...args: Parameters<typeof parseEvent>) {
    const began = performance.now();
    try { return parseEvent(...args); }
    finally { metrics.validationMs += performance.now() - began; }
  }
  const validation = vi.spyOn(eventSchemas, 'parseEventByType').mockImplementation(timedValidation);
  const parseJson = JSON.parse;
  function timedJson(raw: string) {
    const began = performance.now();
    try { return parseJson(raw) as unknown; }
    finally { metrics.jsonMs += performance.now() - began; }
  }
  const json = vi.spyOn(JSON, 'parse').mockImplementation(timedJson);
  const started = performance.now();
  try {
    // Keep a bounded window like a streaming computer, without overflowing its bridge queue.
    for (let index = 0; index < 32; index++) sendReport();
    await finished.promise;
    const elapsedMs = performance.now() - started;
    process.stdout.write(`${JSON.stringify({ reports: acknowledged, elapsedMs, stopMs, metrics })}\n`);
    expect((await stopped)?.status).toBe('appended');
    expect(elapsedMs).toBeLessThan(10_000);
    expect(stopMs).toBeLessThan(2000);
    expect(await reportPosition(nats.store, 'test', 'computer')).toBe(2700);
    let savedText = '';
    for await (const row of nats.store.readStream('conversation-long')) {
      if (row.event.type === 'agent.message_delta') {
        savedText += keys.decrypt('test', 'long', row.event.data);
      }
    }
    expect(savedText).toBe('word '.repeat(2700));
    const reportContext = { silo: 'test', assistantId: 'assistant', computerId: 'computer' };
    const mismatches = [{ turnId: 'other' }, { conversationId: 'other' },
      { assistantId: 'other' }, { messageId: 'other' }, { threadId: 'other' },
      { requesterId: 'other' }, { executionMode: 'restricted' }, { previousSequence: 99 }];
    for (const mismatch of mismatches) {
      const values = [reportFor(2701), { ...reportFor(2702), ...mismatch }];
      await expect(recordReports(nats.store, keys, reportContext, values))
        .rejects.toThrow('Report batch mismatch');
    }
    for (const sequence of [1, 12, 31, 1350, 2700]) {
      expect(await recordReport(nats.store, keys, reportContext, reportFor(sequence)))
        .toBe('duplicate');
      await expect(recordReport(nats.store, keys, reportContext, reportFor(sequence, 'changed')))
        .rejects.toThrow('Report sequence reused');
    }
  } finally {
    validation.mockRestore();
    json.mockRestore();
    socket.off('close', closed);
    link.socket.terminate();
    socket.terminate();
    await link.settled();
    sockets.close();
    server.close();
    await nats.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);
