import { z } from 'zod';
import type { RawData, WebSocket } from 'ws';
import type { StoredEvent } from '@opencrane/event-store';
import { memoryContextRecordedEventSchema } from '@opencrane/events';
import { approvalActivity, decisionAuthorityFence, changesDecisionActivity, confirmDecisionAccess,
  history, memoryReferences, prepareLoadedMemory } from '@opencrane/models';
import { privateReplySchema } from '@opencrane/protocol';
import type { ChatOptions } from './access.ts';
import { readChatFacts } from './chat-summary.ts';

type Options = Pick<ChatOptions, 'silo' | 'store'> & Partial<Pick<ChatOptions, 'binding'>>;
type Subscriber = { store: ChatOptions['store']; silo: string; memberId: string;
  conversationId: string; socket: WebSocket; current(): boolean; confirm(): Promise<boolean> };
const subscribers = new Set<Subscriber>();
let retained = 0;
const identifier = z.string().regex(/^[\w-]{1,200}$/u);
const replySchema = z.strictObject({ type: z.literal('private_reply'),
  sequence: z.int().positive(), previousSequence: z.int().nonnegative(),
  conversationId: identifier, turnId: identifier, threadId: identifier,
  generation: z.int().positive(), inputGeneration: identifier, text: z.string().max(24 * 1024) });
type Reply = Omit<z.infer<typeof replySchema>, 'text'>;
type Pending = { reply: Reply; bytes: Buffer; recipients: Subscriber[]; clear(): void };

function messageBytes(raw: RawData) {
  if (Buffer.isBuffer(raw)) return raw;
  if (Array.isArray(raw)) return Buffer.concat(raw);
  return Buffer.from(raw);
}


export function subscribePrivateOutput(subscriber: Subscriber) {
  if (subscribers.size >= 4096) return;
  subscribers.add(subscriber);
  function remove() { subscribers.delete(subscriber); }
  subscriber.socket.once('close', remove);
}

// Keep no reply after its single release attempt. A fresh connection cannot recover this map.
export function privateOutput(options: Options, computer: { computerId: string; assistantId: string },
  socket: WebSocket) {
  function unavailablePosition() { return Infinity; }
  // Keep a slow position read from delaying Stop or other bridge controls.
  const readingPosition = options.store.head(undefined, performance.now() + 10_000);
  const openedPosition = readingPosition.catch(unavailablePosition);
  const pending = new Map<number, Pending>();
  function clear() {
    for (const entry of pending.values()) entry.clear();
  }
  socket.once('close', clear);
  function capture(raw: RawData) {
    const rawBytes = messageBytes(raw);
    const value: unknown = JSON.parse(rawBytes.toString());
    const candidate = z.object({ type: z.string() }).parse(value);
    if (candidate.type !== 'private_reply') {
      discardInterrupted(value, pending);
      return { value, bytes: rawBytes };
    }
    const parsed = replySchema.parse(value);
    const { text, ...reply } = parsed;
    if (Buffer.byteLength(text) > 24 * 1024 || pending.size >= 2 || retained >= 64 ||
        pending.has(reply.sequence)) throw new Error('Private reply limit');
    const bytes = Buffer.from(text);
    const recipients: Subscriber[] = [];
    for (const subscriber of subscribers) {
      if (subscriber.store === options.store && subscriber.silo === options.silo &&
          subscriber.conversationId === reply.conversationId && recipients.length < 32) {
        recipients.push(subscriber);
      }
    }
    function discard() {
      if (!pending.delete(reply.sequence)) return;
      bytes.fill(0);
      retained--;
      clearTimeout(timer);
      socket.off('close', discard);
      for (const recipient of recipients) recipient.socket.off('close', discard);
    }
    const timer = setTimeout(discard, 10_000);
    timer.unref();
    const entry = { reply, bytes, recipients, clear: discard };
    pending.set(reply.sequence, entry);
    retained++;
    socket.once('close', discard);
    for (const recipient of recipients) recipient.socket.once('close', discard);
    const loss = { type: 'agent.output_lost', sequence: reply.sequence,
      previousSequence: reply.previousSequence, conversationId: reply.conversationId,
      turnId: reply.turnId, assistantId: computer.assistantId };
    return { value: loss, bytes: rawBytes };
  }
  async function release(sequence: number, recorded: boolean) {
    const candidate = pending.get(sequence);
    if (!candidate) return;
    const entry: Pending = candidate;
    try {
      if (!recorded) return;
      const connectionPosition = await openedPosition;
      const binding = await savedBinding(options, computer, entry.reply, connectionPosition);
      for (const recipient of entry.recipients) {
        if (recipient.memberId !== binding.requesterId || !subscribers.has(recipient)) continue;
        function send() {
          if (pending.get(sequence) !== entry || socket.readyState !== socket.OPEN) return false;
          if (recipient.socket.readyState !== recipient.socket.OPEN ||
              recipient.socket.bufferedAmount !== 0) return false;
          const data = { text: entry.bytes.toString(), turnId: binding.turnId };
          const frame = { version: 1, topic: 'conversation', type: 'private_reply',
            conversationId: binding.conversationId, turnId: binding.turnId,
            threadId: binding.threadId, generation: binding.generation,
            inputGeneration: binding.inputGeneration, data };
          const encoded = JSON.stringify(privateReplySchema.parse(frame));
          if (Buffer.byteLength(encoded) > 64 * 1024 || !recipient.current()) return false;
          // Consume before sending. Neither a lost acknowledgement nor another tab can retry.
          entry.clear();
          recipient.socket.send(encoded);
          return true;
        }
        if (await confirmRelease(options, binding, recipient, send)) return;
      }
    } catch {
      // Keep failed checks and transport errors free of private content.
    } finally {
      entry.clear();
    }
  }
  return { capture, release };
}

async function savedBinding(options: Options, computer: { computerId: string; assistantId: string },
  reply: Reply, openedPosition: number) {
  const deadline = performance.now() + 10_000;
  const activity = await approvalActivity(options.store, options.silo, computer.assistantId,
    reply.conversationId, reply.turnId, deadline);
  const start = activity.computer.firstStart;
  const saved = requireAdmission(activity, computer, reply, openedPosition);
  const chat = await readChatFacts(options.store, options.silo, reply.conversationId, reply.turnId);
  if (chat.turnEnded || chat.conversationClosed || chat.memoryContext?.status !== 'loaded' ||
      chat.created?.['createdBy'] !== saved.requesterId || chat.created['contextKind']) {
    throw new Error('Reply refused');
  }
  const first = chat.memoryContext.events.values().next().value;
  const decoded: unknown = JSON.parse(first ?? 'null');
  const binding = memoryContextRecordedEventSchema.parse(decoded).data;
  const expected = { ...reply, ...computer, requesterId: saved.requesterId };
  const fields = ['inputGeneration', 'generation', 'threadId', 'requesterId',
    'computerId', 'assistantId', 'conversationId', 'turnId'] as const;
  for (const field of fields) {
    if (binding[field] !== expected[field]) throw new Error('Reply refused');
  }
  let losses = 0;
  for await (const row of options.store.readStream(`conversation-${reply.conversationId}`,
    start!.sequence, deadline)) {
    if (row.event.type !== 'agent.output_lost') continue;
    const data = z.object({ turnId: z.string() }).parse(row.event.data);
    if (data.turnId === reply.turnId) losses++;
  }
  if (losses !== 1) throw new Error('Reply consumed');
  return binding;
}

function requireAdmission(activity: Awaited<ReturnType<typeof approvalActivity>>,
  computer: { computerId: string; assistantId: string },
  reply: Pick<Reply, 'conversationId' | 'turnId' | 'threadId' | 'generation'>, openedPosition: number) {
  const start = activity.computer.firstStart;
  const admission = z.object({ requesterId: identifier, conversationId: z.literal(reply.conversationId),
    turnId: z.literal(reply.turnId), threadId: z.literal(reply.threadId),
    computerId: z.literal(computer.computerId), assistantId: z.literal(computer.assistantId),
    executionMode: z.literal('restricted'), sharingClass: z.never().optional() });
  const saved = admission.parse(start?.event.data);
  if (!start || start.sequence <= openedPosition || start.event.source !== 'opencrane-server' ||
      activity.computer.firstClose || activity.computer.control ||
      activity.computer.lifecycle?.event.type !== 'computer.ready') throw new Error('Reply refused');
  z.object({ computerId: z.literal(computer.computerId), generation: z.literal(reply.generation) })
    .parse(activity.computer.lifecycle?.event.data);
  return saved;
}

type Binding = Awaited<ReturnType<typeof savedBinding>>;
async function confirmRelease(options: Options, binding: Binding, recipient: Subscriber,
  release: () => boolean) {
  const deadline = performance.now() + 10_000;
  const activity = await approvalActivity(options.store, options.silo, binding.assistantId,
    binding.conversationId, binding.turnId, deadline);
  requireAdmission(activity, binding, binding, 0);
  const claims = { silo: options.silo, requester: binding.requesterId, assistant: binding.assistantId,
    computer: binding.computerId, generation: binding.generation, conversation: binding.conversationId,
    turn: binding.turnId, thread: binding.threadId };
  for (const row of activity.conversation) {
    if (row.event.type === 'agent.turn_stop_requested' &&
        z.object({ turnId: z.string() }).parse(row.event.data).turnId === binding.turnId) {
      throw new Error('Reply stopped');
    }
  }
  const memory = await prepareLoadedMemory(options.store, options.binding, claims,
    activity.conversation, deadline);
  const chat = await readChatFacts(options.store, options.silo, binding.conversationId, binding.turnId);
  if (chat.turnEnded || chat.conversationClosed || activity.computer.firstClose) {
    throw new Error('Reply ended');
  }
  const references = chat.memoryContext?.references ?? [];
  const scopes = await scopeHistories(options, references, deadline);
  const watched = new Set([`member-${binding.requesterId}`, `assistant-${binding.assistantId}`]);
  const authority = await decisionAuthorityFence(options.store, performance.now(), [...watched],
    binding.requesterId, binding.assistantId);
  function include(...subjects: string[]) {
    for (const subject of subjects) watched.add(subject);
    authority.include(...subjects);
  }
  async function confirm() { await confirmDecisionAccess(activity, authority, false, true); }
  const fresh = Object.assign(confirm, { include, head: authority.head, deadline: authority.deadline });
  const before = await options.store.head(undefined, fresh.deadline);
  if (!await recipient.confirm()) throw new Error('Reader refused');
  await memory.confirm(fresh);
  let checkedPosition = before;
  while (true) {
    const currentPosition = await options.store.head(undefined, fresh.deadline);
    await releaseChanges(options, binding, watched, scopes, checkedPosition, fresh.deadline);
    const after = await options.store.head(undefined, fresh.deadline);
    if (after === currentPosition) {
      await releaseChanges(options, binding, watched, scopes, currentPosition, fresh.deadline);
      break;
    }
    checkedPosition = currentPosition;
  }
  if (performance.now() >= fresh.deadline) throw new Error('Reply expired');
  for (const reference of references) {
    const rows = scopes.get(reference.scopeId)!;
    const validator = memoryReferences(rows, options.silo, reference.scopeId, 'event-only');
    if (validator.current(reference, Date.now()) !== 'current') throw new Error('Memory changed');
  }
  return release();
}

async function releaseChanges(options: Options, binding: Binding, watched: Set<string>,
  scopes: Map<string, StoredEvent[]>, before: number, deadline: number) {
  // Read changes after the last access await, without replaying conversation history.
  const subjects = [...watched, `conversation-${binding.conversationId}`,
    `computer-${binding.assistantId}`];
  for (const scope of scopes.keys()) subjects.push(`scope-${scope}`);
  for (const subject of subjects) {
    for await (const row of options.store.readStream(subject, before + 1, deadline,
      subject === `conversation-${binding.conversationId}`)) {
      const scope = scopes.get(subject.slice('scope-'.length));
      if (scope) {
        if (row.sequence > (scope.at(-1)?.sequence ?? 0)) scope.push(row);
      }
      else if (watched.has(subject) ||
          changesDecisionActivity(row.event, binding.turnId, false, true)) {
        throw new Error('Reply changed');
      }
    }
  }
}

async function scopeHistories(options: Options, references: Binding['additions'], deadline: number) {
  const scopes = new Map<string, StoredEvent[]>();
  for (const reference of references) {
    if (scopes.has(reference.scopeId)) continue;
    const rows = await history(options.store, `scope-${reference.scopeId}`, options.silo, deadline);
    scopes.set(reference.scopeId, rows);
  }
  return scopes;
}

function discardInterrupted(value: unknown, pending: Map<number, Pending>) {
  const report = z.object({ type: z.enum(['agent.turn_failed', 'agent.turn_started']),
    conversationId: z.string(), turnId: z.string() }).safeParse(value);
  if (!report.success) return;
  for (const entry of pending.values()) {
    if (entry.reply.conversationId !== report.data.conversationId) continue;
    const sameTurn = entry.reply.turnId === report.data.turnId;
    if (report.data.type === 'agent.turn_failed' && sameTurn) entry.clear();
    if (report.data.type === 'agent.turn_started' && !sameTurn) entry.clear();
  }
}
