import { createHash, randomUUID } from 'node:crypto';
import { memoryContextRecordedEventSchema, type MemoryContextRecord } from '@opencrane/events';
import { type memoryReferences, foldMemoryContext, type MemoryContext,
  type memoryRights, type MemoryContextState } from '@opencrane/models';
import { readChatFacts } from '../chat/chat-summary.ts';
import type { MemoryOptions } from './access.ts';
import { memorySnapshot, type listFacts } from './reads.ts';

type Rights = Awaited<ReturnType<typeof memoryRights>>;
type Snapshot = Awaited<ReturnType<typeof memorySnapshot>>;
type Page = Awaited<ReturnType<typeof listFacts>>;
function digest(value: string) {
  const hash = createHash('sha256');
  hash.update(value);
  return hash.digest('hex');
}
export async function readRecallContext(options: MemoryOptions, context: MemoryContext,
  isolate = false) {
  // Read history before starting the final short access checks.
  let prepared = false;
  async function* readStream(...args: Parameters<typeof options.store.readStream>) {
    if (prepared && args[1] === 1) throw new Error('Memory history unavailable');
    yield* options.store.readStream(...args);
  }
  const store = isolate ? { readStream } : options.store;
  function refresh() {
    return readChatFacts(store, options.silo, context.conversation, context.turn);
  }
  const chat = await refresh();
  prepared = true;
  if (chat.conversationClosed) {
    throw new Error('Memory turn ended');
  }
  const events = chat.memoryContext?.events.values();
  const encoded = events?.next().value;
  let saved: MemoryContextRecord | undefined;
  if (encoded !== undefined) {
    const decoded: unknown = JSON.parse(encoded);
    saved = memoryContextRecordedEventSchema.parse(decoded).data;
  }
  const inputGeneration = saved?.inputGeneration ?? randomUUID();
  return { chat, saved, inputGeneration, refresh };
}
function record(context: MemoryContext, state: Snapshot, inputGeneration: string) {
  const data: MemoryContextRecord = {
    conversationId: context.conversation, turnId: context.turn, requesterId: context.requester,
    assistantId: context.assistant, computerId: context.computer, generation: context.generation,
    threadId: context.thread, inputGeneration,
    projectionGeneration: state.generation, action: 'prepared', delivery: null,
    callDigest: null, dispatchDigest: null, additions: [], scopePositions: [],
    byteCount: 0, hasOmissions: false, reason: 'none',
  };
  return data;
}
async function appendRecord(options: MemoryOptions, context: MemoryContext,
  data: MemoryContextRecord, previous: MemoryContextState | undefined, sequence: number,
  checkedAt: number) {
  const id = randomUUID();
  const input = { id, commandId: id,
    silo: options.silo, subject: `conversation-${context.conversation}`,
    type: 'agent.memory_context_recorded', source: 'opencrane-server',
    principal: { kind: 'system', id: 'server' }, time: new Date(checkedAt).toISOString(),
    correlation: { conversation: context.conversation, turn: context.turn }, data };
  const event = memoryContextRecordedEventSchema.parse(input);
  const next = foldMemoryContext(previous, event);
  const remaining = context.exp * 1000 - Date.now();
  if (remaining <= 0) {
    throw new Error('Memory context expired');
  }
  const command = { event, expectedSequence: sequence, historyChecked: true as const,
    deadline: performance.now() + remaining };
  const result = await options.store.append(command);
  // Keep uncertain work consumed. A later read can recover evidence, never resend this reply.
  if (result.status !== 'appended') {
    throw new Error('Memory evidence unavailable');
  }
  return { state: next, sequence: result.sequence };
}

export async function recordRecall(options: MemoryOptions, context: MemoryContext,
  rights: Rights, snapshot: Snapshot, page: Page, byteCount: number,
  evidence: Awaited<ReturnType<typeof readRecallContext>>,
  references: ReturnType<typeof memoryReferences>) {
  const { inputGeneration } = evidence;
  // Include ordinary activity that arrived during access checks without changing the proof.
  const chat = await evidence.refresh();
  if (JSON.stringify(chat.memoryContext) !==
      JSON.stringify(evidence.chat.memoryContext)) {
    throw new Error('Memory input changed');
  }
  if (chat.turnEnded || chat.conversationClosed) {
    throw new Error('Memory turn ended');
  }
  const data = record(context, snapshot, inputGeneration);
  const position = { scopeId: rights.scope.scopeId, position: snapshot.position };
  data.scopePositions = [position];
  const additions: MemoryContextRecord['additions'] = [];
  let hasOmissions = page.nextCursor !== null;
  for (const fact of page.facts) {
    if ('reason' in fact) {
      hasOmissions = true;
      continue;
    }
    const reference = { scopeId: rights.scope.scopeId,
      memoryId: fact.memoryId, revision: fact.revision };
    additions.push(reference);
  }
  async function confirm() {
    await rights.confirm();
    const current = await memorySnapshot(options, rights.scope);
    const checkedAt = Date.now();
    if (current.position !== snapshot.position || current.generation !== snapshot.generation ||
        context.exp * 1000 <= checkedAt) {
      throw new Error('Memory changed before delivery');
    }
    for (const reference of additions) {
      if (references.current(reference, checkedAt) !== 'current') {
        throw new Error('Memory reference unavailable');
      }
    }
    return checkedAt;
  }
  let previous = chat.memoryContext;
  let sequence = chat.sequence;
  if (!previous) {
    const checkedAt = await confirm();
    const prepared = await appendRecord(options, context, data, previous, sequence, checkedAt);
    previous = prepared.state;
    sequence = prepared.sequence;
  }
  const loaded: MemoryContextRecord = { ...data, action: 'loaded', delivery: 'recall',
    callDigest: digest(context.callId), dispatchDigest: context.dispatch.permitDigest,
    additions, byteCount, hasOmissions };
  // Save the exact time used for every addition and dependency check.
  const checkedAt = await confirm();
  await appendRecord(options, context, loaded, previous, sequence, checkedAt);
  // Refuse delivery if the participation stream closed during the append.
  // Keep saved references as ended accounting when the summary reads that close.
  await confirm();
}
