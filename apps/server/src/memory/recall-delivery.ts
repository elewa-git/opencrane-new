import { createHash, randomUUID } from 'node:crypto';
import { memoryContextRecordedEventSchema, type MemoryContextRecord } from '@opencrane/events';
import { history, memoryReferences, type MemoryContext, type memoryRights } from '@opencrane/models';
import { memoryKeys } from '@opencrane/projections';
import { readChatFacts } from '../chat/chat-summary.ts';
import { foldMemoryContext, type MemoryContextState } from '../chat/memory-context-fold.ts';
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
export async function readRecallContext(options: MemoryOptions, context: MemoryContext) {
  // Read history before starting the final short access checks.
  const chat = await readChatFacts(options.store, options.silo, context.conversation, context.turn);
  if (chat.closed) {
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
  return { chat, saved, inputGeneration };
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
  data: MemoryContextRecord, previous: MemoryContextState | undefined, sequence: number) {
  const id = randomUUID();
  const input = { id, commandId: id,
    silo: options.silo, subject: `conversation-${context.conversation}`,
    type: 'agent.memory_context_recorded', source: 'opencrane-server',
    principal: { kind: 'system', id: 'server' }, time: new Date().toISOString(),
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
  evidence: Awaited<ReturnType<typeof readRecallContext>>) {
  const { chat, inputGeneration } = evidence;
  const rows = await history(options.store, `scope-${rights.scope.scopeId}`, options.silo,
    performance.now() + 10_000);
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
  if (!options.keyDirectory) {
    throw new Error('Memory keys unavailable');
  }
  const keys = memoryKeys(options.keyDirectory);
  const references = memoryReferences(rows, options.silo, rights.scope.scopeId, keys);
  async function confirm() {
    await rights.confirm();
    const current = await memorySnapshot(options, rights.scope);
    if (current.position !== snapshot.position || current.generation !== snapshot.generation ||
        context.exp * 1000 <= Date.now()) {
      throw new Error('Memory changed before delivery');
    }
    for (const reference of additions) {
      if (references.current(reference) !== 'current') {
        throw new Error('Memory reference unavailable');
      }
    }
  }
  let previous = chat.memoryContext;
  let sequence = chat.sequence;
  if (!previous) {
    await confirm();
    const prepared = await appendRecord(options, context, data, previous, sequence);
    previous = prepared.state;
    sequence = prepared.sequence;
  }
  const loaded: MemoryContextRecord = { ...data, action: 'loaded', delivery: 'recall',
    callDigest: digest(context.callId), dispatchDigest: context.dispatch.permitDigest,
    additions, byteCount, hasOmissions };
  await confirm();
  await appendRecord(options, context, loaded, previous, sequence);
  // Refuse delivery if the participation stream closed during the append.
  // Keep saved references as ended accounting when the summary reads that close.
  await confirm();
}
