import { randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import type { StoredEvent } from '@opencrane/event-store';
import { readChatFacts } from '../src/chat/chat-summary.ts';

// Measure the real chat summary without keeping source events in the fixture.
const [streamsText, turnsText, chunksText] = process.argv.slice(2);
const streams = Number(streamsText);
const turns = Number(turnsText);
const chunks = Number(chunksText);
const silo = randomUUID();
const assistantId = randomUUID();
const authorId = randomUUID();
let peakHeapBytes = 0;
let lastReadFrom = 0;

function row(subject: string, sequence: number, type: string,
  data: Record<string, unknown>): StoredEvent {
  const id = randomUUID();
  const correlation = { request: randomUUID(), conversation: randomUUID(), turn: randomUUID() };
  const event = { id, commandId: id, subject, type, silo, source: 'computer-bridge',
    time: '2026-10-06T00:00:00Z', principal: { kind: 'agent' as const, id: assistantId },
    correlation, data };
  return structuredClone({ sequence, event });
}
async function* readStream(subject: string, from = 1) {
  await setImmediate();
  lastReadFrom = from;
  let sequence = 1;
  const created = { conversationId: subject, assistantId, createdBy: authorId,
    mode: 'agent_session' };
  if (from <= sequence) yield row(subject, sequence, 'conversation.created', created);
  let reportSequence = 0;
  for (let turn = 0; turn < turns; turn++) {
    const turnId = randomUUID();
    const message = { conversationId: subject, authorId, executionMode: 'restricted',
      authorKind: 'human', contentType: 'text', ciphertext: 'x'.repeat(32000), keyId: 'key:1' };
    sequence++;
    if (sequence >= from) yield row(subject, sequence, 'message.posted', message);
    for (let chunk = 0; chunk < chunks + 1; chunk++) {
      sequence++;
      reportSequence++;
      if (sequence < from) continue;
      let type = 'agent.message_delta';
      if (chunk === chunks) type = 'agent.turn_completed';
      let data: Record<string, unknown> = { conversationId: subject, turnId };
      if (chunk < chunks) {
        data = { ...data, messageId: turnId, contentType: 'text',
          ciphertext: 'x'.repeat(128), keyId: 'key:1' };
      }
      const stored = row(subject, sequence, type, data);
      stored.event.report = { computerId: assistantId, sequence: reportSequence,
        digest: 'a'.repeat(64) };
      yield stored;
      if (sequence % 100 === 0) {
        peakHeapBytes = Math.max(peakHeapBytes, process.memoryUsage().heapUsed);
      }
    }
  }
  peakHeapBytes = Math.max(peakHeapBytes, process.memoryUsage().heapUsed);
}
async function heap() {
  await setImmediate();
  if (!globalThis.gc) throw new Error('Run Node with --expose-gc');
  globalThis.gc();
  globalThis.gc();
  return process.memoryUsage().heapUsed;
}
let store: { readStream: typeof readStream } | undefined = { readStream };
function read(chat: string, computerId?: string, reportSequence?: number) {
  if (!store) throw new Error('Measurement store was released');
  return readChatFacts(store, silo, chat, 'unused', computerId, reportSequence);
}
const chats: string[] = [];
const before = await heap();
peakHeapBytes = before;
for (let index = 0; index < streams; index++) {
  const chat = randomUUID();
  chats.push(chat);
  await read(chat);
}
const lastChat = chats.at(-1);
if (!lastChat) throw new Error('Supply at least one chat');
const peakDuringBuildBytes = peakHeapBytes;
const facts = await read(lastChat, assistantId, 1);
const finalReadFrom = lastReadFrom;
const after = await heap();
store = undefined;
const released = await heap();
const measurement = { streams, turns, chunks, retainedBytes: after - released,
  netGrowthBytes: after - before, heapBytes: after, peakHeapBytes: peakDuringBuildBytes,
  lastReportSequence: facts.lastReportSequence, lastReadFrom: finalReadFrom };
console.info(JSON.stringify(measurement));
