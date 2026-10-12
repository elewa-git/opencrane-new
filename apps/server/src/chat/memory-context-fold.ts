import { memoryContextRecordedEventSchema, type MemoryContextRecord,
  type EventEnvelope } from '@opencrane/events';

type Reference = MemoryContextRecord['additions'][number];
export type MemoryContextState = {
  binding: string;
  status: MemoryContextRecord['action'];
  references: Reference[];
  scopePositions: MemoryContextRecord['scopePositions'];
  recallCalls: number;
  recallBytes: number;
  initialLoaded: boolean;
  initialBytes: number;
  reason: MemoryContextRecord['reason'];
  hasOmissions: boolean;
  events: Map<string, string>;
  calls: Set<string>;
  dispatches: Set<string>;
  executionAvailable: false;
};
function binding(silo: string, data: MemoryContextRecord) {
  return JSON.stringify([silo, data.conversationId, data.turnId, data.requesterId,
    data.assistantId, data.computerId, data.generation, data.threadId,
    data.inputGeneration, data.projectionGeneration]);
}
function addReferences(previous: Reference[], data: MemoryContextRecord) {
  const references = [...previous];
  const additions = new Set<string>();
  for (const reference of data.additions) {
    const key = JSON.stringify([reference.scopeId, reference.memoryId]);
    function sameFact(saved: Reference) {
      return saved.scopeId === reference.scopeId && saved.memoryId === reference.memoryId;
    }
    const saved = references.find(sameFact);
    if (additions.has(key) || (saved && saved.revision !== reference.revision)) {
      throw new Error('Memory reference changed or repeated');
    }
    additions.add(key);
    if (!saved) {
      references.push(reference);
    }
  }
  if (references.length > 32) {
    throw new Error('Memory reference limit exceeded');
  }
  return references;
}
function positions(previous: MemoryContextState['scopePositions'], data: MemoryContextRecord) {
  const saved = new Map<string, number>();
  for (const position of previous) {
    saved.set(position.scopeId, position.position);
  }
  const supplied = new Set<string>();
  for (const position of data.scopePositions) {
    if (supplied.has(position.scopeId) || position.position < (saved.get(position.scopeId) ?? 0)) {
      throw new Error('Memory scope position changed or repeated');
    }
    supplied.add(position.scopeId);
    saved.set(position.scopeId, position.position);
  }
  for (const reference of data.additions) {
    if (!supplied.has(reference.scopeId)) {
      throw new Error('Memory scope position missing');
    }
  }
  if (saved.size > 3) {
    throw new Error('Memory scope limit exceeded');
  }
  const result = [];
  for (const [scopeId, position] of saved) {
    const savedPosition = { scopeId, position };
    result.push(savedPosition);
  }
  return result;
}
function load(state: MemoryContextState, data: MemoryContextRecord) {
  if (data.delivery === 'initial') {
    if (state.initialLoaded || state.recallCalls > 0) {
      throw new Error('Initial memory already loaded');
    }
    state.initialLoaded = true;
    state.initialBytes = data.byteCount;
  } else {
    if (state.calls.has(data.callDigest!) || state.dispatches.has(data.dispatchDigest!)) {
      throw new Error('Memory call already recorded');
    }
    state.calls.add(data.callDigest!);
    state.dispatches.add(data.dispatchDigest!);
    state.recallCalls++;
    state.recallBytes += data.byteCount;
    if (state.recallCalls > 4 || state.recallBytes > 65536) {
      throw new Error('Memory recall limit exceeded');
    }
  }
  state.references = addReferences(state.references, data);
  state.hasOmissions ||= data.hasOmissions;
}

function requireTransition(previous: MemoryContextState | undefined, data: MemoryContextRecord) {
  if ((!previous && data.action !== 'prepared') || (previous && data.action === 'prepared')) {
    throw new Error('Memory preparation missing or repeated');
  }
  if (previous?.status === 'ended' ||
      (previous?.status === 'invalidated' && data.action !== 'ended')) {
    throw new Error('Memory context ended');
  }
}

// Rebuild evidence only. Saved references never recreate a dispatch pass or a live process.
export function foldMemoryContext(previous: MemoryContextState | undefined,
  input: EventEnvelope): MemoryContextState {
  const event = memoryContextRecordedEventSchema.parse(input);
  const data = event.data;
  const identity = binding(event.silo, data);
  const encoded = JSON.stringify(event);
  if (previous && previous.binding !== identity) {
    throw new Error('Memory context changed');
  }
  const duplicate = previous?.events.get(event.id);
  if (duplicate !== undefined) {
    if (duplicate !== encoded) {
      throw new Error('Memory evidence changed');
    }
    return previous!;
  }
  requireTransition(previous, data);
  const state: MemoryContextState = previous ? structuredClone(previous) : {
    binding: identity, status: 'prepared', references: [], scopePositions: [],
    recallCalls: 0, recallBytes: 0, initialLoaded: false, initialBytes: 0, reason: 'none',
    hasOmissions: false,
    events: new Map(), calls: new Set(), dispatches: new Set(), executionAvailable: false,
  };
  state.scopePositions = positions(state.scopePositions, data);
  if (data.action === 'loaded') {
    load(state, data);
  }
  state.status = data.action;
  state.reason = data.reason;
  state.events.set(event.id, encoded);
  return state;
}
