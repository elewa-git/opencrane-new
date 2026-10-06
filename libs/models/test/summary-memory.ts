import { setImmediate } from 'node:timers/promises';
import { readStreamSummary, type StoredEvent } from '@opencrane/event-store';
import { computerSummary, type ComputerSummary } from '@opencrane/auth';
import { decisionChatSummary } from '../src/decision-summary.ts';

// Measure retained caches with a synthetic reader, without retaining the source rows.
const [mode, countText, turnsText, perThreadText, unbounded] = process.argv.slice(2);
const streamCount = Number(countText);
const turns = Number(turnsText);
const perThread = Number(perThreadText);
let computerKind = computerSummary;
let chatKind = decisionChatSummary;
if (unbounded === 'unbounded') {
  computerKind = { ...computerKind };
  delete computerKind.budget;
  chatKind = { ...chatKind };
  delete chatKind.budget;
}
let lastReadFrom = 0;

function row(subject: string, sequence: number, type: string,
  data: Record<string, unknown>): StoredEvent {
  const id = `${subject}-${sequence}`;
  const event = { id, commandId: id, subject, type, silo: 'test',
    time: '2026-10-06T00:00:00Z', source: 'opencrane-server',
    principal: { kind: 'system' as const, id: 'turn-lifecycle' }, correlation: {}, data };
  return { sequence, event };
}

function* computerRows(subject: string, from: number) {
  for (let index = 0; index < turns; index++) {
    const turnId = `${subject}-turn-${index}`;
    const threadId = `${subject}-thread-${Math.floor(index / perThread)}`;
    const data = { assistantId: subject, computerId: subject, conversationId: threadId,
      turnId, threadId, requesterId: 'alice', task: 'chat_turn', executionMode: 'restricted' };
    const sequence = index * 2 + 1;
    if (sequence >= from) yield row(subject, sequence, 'computer.turn_started', data);
    if (sequence + 1 >= from) {
      yield row(subject, sequence + 1, 'computer.turn_closed', { ...data, status: 'completed' });
    }
  }
}
function ciphertext(subject: string, index: number) {
  const encoded = Buffer.from(`${subject}:${index}`).toString('base64');
  const prefix = encoded.replace(/=+$/u, '');
  const padding = 'x'.repeat(32000 - prefix.length);
  return `${prefix}${padding}`;
}
function* chatRows(subject: string, from: number) {
  for (let index = 0; index < turns; index++) {
    const sequence = index * 3 + 1;
    const message = { conversationId: subject, authorId: 'alice', authorKind: 'human',
      contentType: 'text', ciphertext: ciphertext(subject, index), keyId: 'key:1' };
    if (sequence >= from) yield row(subject, sequence, 'message.posted', message);
    const turn = { conversationId: subject, turnId: `${subject}-turn-${index}`,
      assistantId: 'assistant' };
    if (sequence + 1 >= from) yield row(subject, sequence + 1, 'agent.turn_started', turn);
    if (sequence + 2 >= from) {
      const completed = { conversationId: subject, turnId: turn.turnId };
      yield row(subject, sequence + 2, 'agent.turn_completed', completed);
    }
  }
}
async function* readStream(subject: string, from = 1) {
  await setImmediate();
  lastReadFrom = from;
  if (mode === 'computer') {
    yield* computerRows(subject, from);
    return;
  }
  yield* chatRows(subject, from);
}
function computerSize(summary: ComputerSummary) {
  return summary.turns.size + summary.threads.size + summary.startCommandCount;
}
function chatSize(summary: StoredEvent[]) {
  return summary.length;
}
let measuredStore: { readStream: typeof readStream } | undefined = { readStream };
async function read(subject: string, reader = measuredStore) {
  if (!reader) throw new Error('Measurement store was released');
  if (mode === 'computer') {
    return readStreamSummary(reader, 'test', subject, computerKind, Infinity, computerSize);
  }
  return readStreamSummary(reader, 'test', subject, chatKind, Infinity, chatSize);
}
async function warmEngine() {
  const temporaryStore = { readStream };
  await read('warm', temporaryStore);
}
async function heap() {
  await setImmediate();
  if (!globalThis.gc) throw new Error('Run Node with --expose-gc');
  globalThis.gc();
  globalThis.gc();
  return process.memoryUsage().heapUsed;
}
await warmEngine();
const before = await heap();
for (let index = 0; index < streamCount; index++) await read(`stream-${index}`);
const lastFacts = await read(`stream-${streamCount - 1}`);
const finalReadFrom = lastReadFrom;
const after = await heap();
// Release only the measured store; the difference excludes the loaded packages.
measuredStore = undefined;
const released = await heap();
console.info(JSON.stringify({ mode, streams: streamCount, turns, perThread,
  unbounded: unbounded === 'unbounded', retainedBytes: after - released, netGrowthBytes: after - before,
  heapBytes: after, lastFacts, lastReadFrom: finalReadFrom }));
