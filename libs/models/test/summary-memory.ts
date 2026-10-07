import { setImmediate } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { readStreamSummary, type StoredEvent } from '@opencrane/event-store';
import { computerSummary, type ComputerSummary } from '@opencrane/auth';
import { decisionChatSummary } from '../src/decision-summary.ts';

// Measure retained caches with a synthetic reader, without retaining the source rows.
const [mode, countText, turnsText, perThreadText, unbounded] = process.argv.slice(2);
const streamCount = Number(countText);
const turns = Number(turnsText);
const perThread = Number(perThreadText);
const measuresComputer = mode === 'computer' || mode === 'computer-open';
let computerKind = computerSummary;
let chatKind = decisionChatSummary;
if (unbounded === 'unbounded') {
  computerKind = { ...computerKind };
  delete computerKind.budget;
  chatKind = { ...chatKind };
  delete chatKind.budget;
}
let lastReadFrom = 0;
let peakHeapBytes = 0;

function sampleHeap() {
  peakHeapBytes = Math.max(peakHeapBytes, process.memoryUsage().heapUsed);
}
function uuid(value: string) {
  const hash = createHash('sha256');
  hash.update(value);
  const hex = hash.digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-` +
    `8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
const silo = uuid('silo');
const requesterId = uuid('requester');
const assistantId = uuid('assistant');

function row(subject: string, sequence: number, type: string,
  data: Record<string, unknown>): StoredEvent {
  const id = uuid(`${subject}-${sequence}`);
  const correlation = { request: uuid(`${id}-request`),
    conversation: uuid(subject), turn: uuid(`${id}-turn`) };
  const event = { id, commandId: id, subject, type, silo,
    time: '2026-10-06T00:00:00Z', source: 'opencrane-server',
    principal: { kind: 'system' as const, id: 'turn-lifecycle' }, correlation, data };
  // Copy strings as a decoded event would, rather than measuring shared fixture strings.
  return structuredClone({ sequence, event });
}

function* computerRows(subject: string, from: number) {
  for (let index = Math.floor((from - 1) / 2); index < turns; index++) {
    const turnId = uuid(`${subject}-turn-${index}`);
    const threadId = uuid(`${subject}-thread-${Math.floor(index / perThread)}`);
    const data = { assistantId: subject, computerId: subject, conversationId: threadId,
      turnId, threadId, requesterId, task: 'chat_turn', executionMode: 'restricted' };
    const sequence = index * 2 + 1;
    if (sequence >= from) yield row(subject, sequence, 'computer.turn_started', data);
    if (mode !== 'computer-open' && sequence + 1 >= from) {
      const closed = { ...data, status: 'completed' };
      yield row(subject, sequence + 1, 'computer.turn_closed', closed);
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
  for (let index = Math.floor((from - 1) / 3); index < turns; index++) {
    const sequence = index * 3 + 1;
    const message = { conversationId: subject, authorId: requesterId, authorKind: 'human',
      contentType: 'text', ciphertext: ciphertext(subject, index), keyId: 'key:1' };
    if (sequence >= from) yield row(subject, sequence, 'message.posted', message);
    const turn = { conversationId: subject, turnId: uuid(`${subject}-turn-${index}`),
      assistantId };
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
  const rows = measuresComputer ? computerRows(subject, from) : chatRows(subject, from);
  let count = 0;
  for (const stored of rows) {
    yield stored;
    count++;
    if (count % 100 === 0) sampleHeap();
  }
  sampleHeap();
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
  if (measuresComputer) {
    return readStreamSummary(reader, silo, subject, computerKind, Infinity, computerSize);
  }
  return readStreamSummary(reader, silo, subject, chatKind, Infinity, chatSize);
}
async function warmEngine() {
  const temporaryStore = { readStream };
  await read(uuid('warm'), temporaryStore);
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
peakHeapBytes = before;
for (let index = 0; index < streamCount; index++) await read(uuid(`stream-${index}`));
const peakDuringBuildBytes = peakHeapBytes;
const lastFacts = await read(uuid(`stream-${streamCount - 1}`));
const finalReadFrom = lastReadFrom;
const after = await heap();
// Release only the measured store; the difference excludes the loaded packages.
measuredStore = undefined;
const released = await heap();
const measurement = { mode, streams: streamCount, turns, perThread,
  unbounded: unbounded === 'unbounded', retainedBytes: after - released, netGrowthBytes: after - before,
  heapBytes: after, peakHeapBytes: peakDuringBuildBytes, lastFacts, lastReadFrom: finalReadFrom };
console.info(JSON.stringify(measurement));
