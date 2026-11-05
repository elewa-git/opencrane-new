import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { EventStore } from '@opencrane/event-store';
import { history } from '@opencrane/models';
import type { MemoryContextRecord } from '@opencrane/events';
import { privateOutput, subscribePrivateOutput }
  from '../../apps/server/src/chat/private-output.ts';

type Socket = Parameters<typeof privateOutput>[2];
type Append = (subject: string, type: string, data: object) => Promise<unknown>;

// Observe server lifecycle callbacks without opening a browser or computer connection.
function recordedSocket(frames: unknown[]) {
  function send(value: unknown) {
    frames.push(value);
  }
  const properties = { OPEN: WebSocket.OPEN, readyState: WebSocket.OPEN,
    bufferedAmount: 0, send };
  const events = new EventEmitter();
  const socket = Object.assign(events, properties);
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Record only the socket operations used by privateOutput.
  return socket as Socket;
}

function disconnect(socket: Socket) {
  const closedState = { value: WebSocket.CLOSED, configurable: true };
  Object.defineProperty(socket, 'readyState', closedState);
  socket.emit('close');
}

function capturePending(output: ReturnType<typeof privateOutput>, frame: object, text: string) {
  const buffers: Buffer[] = [];
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Restore the exact static allocator.
  const original = Buffer.from;
  function allocate(target: typeof original, receiver: unknown, args: unknown[]) {
    const value: unknown = Reflect.apply(target, receiver, args);
    if (args[0] === text && Buffer.isBuffer(value)) {
      buffers.push(value);
    }
    return value;
  }
  const handler = { apply: allocate };
  // Observe only synchronous capture allocations, then restore the ordinary allocator.
  Buffer.from = new Proxy(original, handler);
  try {
    const encoded = JSON.stringify(frame);
    const raw = Buffer.from(encoded);
    const captured = output.capture(raw);
    const publicValue = JSON.stringify(captured.value);
    assert(!publicValue.includes(text), 'private_capture_exposed');
    assert.equal(buffers.length, 1);
    return buffers[0]!;
  } finally {
    Buffer.from = original;
  }
}

export async function checkReplacementOutput(store: EventStore, silo: string,
  prepared: MemoryContextRecord, append: Append) {
  const frames: unknown[] = [];
  const original = recordedSocket(frames);
  const viewer = recordedSocket(frames);
  const fresh = recordedSocket(frames);
  const replacement = recordedSocket(frames);
  const options = { store, silo };
  const computer = { assistantId: prepared.assistantId, computerId: prepared.computerId };
  const nextComputer = { ...computer, computerId: randomUUID() };
  const output = privateOutput(options, computer, original);
  function current() {
    return true;
  }
  function confirm() {
    return Promise.resolve(true);
  }
  const subscriber = { ...options, memberId: prepared.requesterId,
    conversationId: prepared.conversationId, socket: viewer, current, confirm };
  const text = randomUUID();
  const frame = { type: 'private_reply', sequence: 1, previousSequence: 0,
    conversationId: prepared.conversationId, turnId: prepared.turnId,
    threadId: prepared.threadId, generation: prepared.generation,
    inputGeneration: prepared.inputGeneration, text };
  const subject = `computer-${prepared.assistantId}`;
  const conversation = `conversation-${prepared.conversationId}`;
  try {
    subscribePrivateOutput(subscriber);
    const ready = { ...computer, generation: prepared.generation };
    await append(subject, 'computer.ready', ready);
    const start = { ...computer, conversationId: prepared.conversationId,
      turnId: prepared.turnId, threadId: prepared.threadId, requesterId: prepared.requesterId,
      task: 'chat_turn', executionMode: 'restricted' };
    await append(subject, 'computer.turn_started', start);
    const retained = capturePending(output, frame, text);
    assert(retained.toString() === text, 'private_capture_missing');
    const lost = { conversationId: prepared.conversationId, turnId: prepared.turnId };
    await append(conversation, 'agent.output_lost', lost);
    await append(subject, 'computer.lost', computer);
    const nextReady = { ...nextComputer, generation: prepared.generation + 1 };
    await append(subject, 'computer.ready', nextReady);
    disconnect(original);
    assert(retained.equals(Buffer.alloc(retained.length)), 'private_buffer_retained');
    disconnect(viewer);
    const newSubscriber = { ...subscriber, socket: fresh };
    subscribePrivateOutput(newSubscriber);
    await output.release(frame.sequence, true);
    assert.equal(frames.length, 0, 'private_reply_recovered');

    const nextOutput = privateOutput(options, nextComputer, replacement);
    const next = { ...prepared, computerId: nextComputer.computerId,
      generation: nextReady.generation, turnId: randomUUID(), threadId: randomUUID(),
      inputGeneration: randomUUID() };
    await refuseDelayed(nextOutput, next, append, frames, frame);
    const rows = await history(store, conversation, silo);
    const saved = JSON.stringify(rows);
    assert(!saved.includes(text), 'private_reply_saved');
    return next.turnId;
  } finally {
    for (const socket of [original, viewer, fresh, replacement]) {
      disconnect(socket);
    }
  }
}

async function refuseDelayed(output: ReturnType<typeof privateOutput>, next: MemoryContextRecord,
  append: Append, frames: unknown[], frame: { type: string; sequence: number;
    previousSequence: number; conversationId: string; turnId: string; threadId: string;
    generation: number; inputGeneration: string; text: string }) {
  const subject = `computer-${next.assistantId}`;
  const conversation = `conversation-${next.conversationId}`;
  const start = { assistantId: next.assistantId, computerId: next.computerId,
    conversationId: next.conversationId, turnId: next.turnId, threadId: next.threadId,
    requesterId: next.requesterId, task: 'chat_turn', executionMode: 'restricted' };
  await append(subject, 'computer.turn_started', start);
  await append(conversation, 'agent.memory_context_recorded', next);
  const loaded = { ...next, action: 'loaded', delivery: 'initial' };
  await append(conversation, 'agent.memory_context_recorded', loaded);
  const lost = { conversationId: next.conversationId, turnId: next.turnId };
  await append(conversation, 'agent.output_lost', lost);
  const nextFrame = { ...frame, turnId: next.turnId, threadId: next.threadId,
    generation: next.generation, inputGeneration: next.inputGeneration };
  const delayed = [frame, { ...nextFrame, generation: frame.generation },
    { ...nextFrame, inputGeneration: frame.inputGeneration }];
  for (const oldFrame of delayed) {
    const bytes = capturePending(output, oldFrame, frame.text);
    await output.release(oldFrame.sequence, true);
    assert(bytes.equals(Buffer.alloc(bytes.length)), 'private_buffer_retained');
    assert.equal(frames.length, 0, 'old_generation_sent');
  }
}
