import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { grantStream } from '@opencrane/authz';
import type { StoredEvent } from '@opencrane/event-store';
import { memoryContextRecordedEventSchema, type MemoryContextRecord } from '@opencrane/events';
import { approvalActivity, changesDecisionActivity, confirmDecisionAccess,
  decisionAuthorityFence, foldMemoryContext,
  history, LoadedMemoryRefused, memoryReferences, memoryRights, parseMemoryRequest, prepareLoadedMemory,
  type MemoryContext } from '@opencrane/models';
import { readChatFacts } from '../chat/chat-summary.ts';
import { creationEvent } from '../chat/private-session.ts';
import { readDeploymentQualification } from
  '../../../../scripts/private-memory-qualification/deployment.ts';
import { scopeFor, type MemoryOptions } from './access.ts';
import { initialMemoryAccess, refuseInitialMemory } from './initial-access.ts';
import { memorySnapshot } from './reads.ts';
import { turnMemoryPreview } from './turn-preview.ts';

type Identity = Pick<MemoryContext, 'silo' | 'requester' | 'assistant' | 'computer' |
  'generation' | 'conversation' | 'turn' | 'thread'>;
type RecordEvent = z.infer<typeof memoryContextRecordedEventSchema>;

async function requireQualification(silo: string, runId: string) {
  const current = await readDeploymentQualification(silo);
  if (current.runId !== runId) {
    throw new LoadedMemoryRefused();
  }
  return current.confirm;
}
function requestFor(identity: Identity, scopeId: string) {
  const metadata = { threadId: identity.thread, callId: 'initial-memory',
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientCapabilities': {} };
  const request = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
    name: 'recall', arguments: { scopeId }, _meta: metadata } };
  const headers = { 'mcp-method': 'tools/call', 'mcp-name': 'recall',
    'mcp-protocol-version': '2026-07-28' };
  return parseMemoryRequest(JSON.stringify(request), headers);
}
function recordEvent(silo: string, data: MemoryContextRecord) {
  const id = randomUUID();
  const input = { id, commandId: id, silo,
    subject: `conversation-${data.conversationId}`, type: 'agent.memory_context_recorded',
    source: 'opencrane-server', principal: { kind: 'system', id: 'server' },
    time: new Date().toISOString(), correlation: {}, data };
  return memoryContextRecordedEventSchema.parse(input);
}

// Keep the selected text only in this live preparation; replay cannot recreate its consumer.
export async function prepareInitialMemory(options: MemoryOptions, identity: Identity,
  ...unexpectedArguments: unknown[]) {
  const deadline = performance.now() + 10_000;
  try {
    const access = await initialMemoryAccess(options, identity.requester, deadline);
    if (unexpectedArguments.length !== 0) throw new LoadedMemoryRefused();
    const measured = await readDeploymentQualification(options.silo);
    const qualification = measured.runId;
    const scope = scopeFor(options.silo, 'person', identity.requester);
    const parsed = requestFor(identity, scope.scopeId);
    await memoryRights(options.store, options.binding, identity, parsed, deadline,
      undefined, undefined, access);
    const assistant = await creationEvent(options.store, options.silo,
      `assistant-${identity.assistant}`, 'assistant.created');
    const personal = z.object({ kind: z.literal('personal'), ownerId: z.literal(identity.requester) });
    personal.parse(assistant.data);
    const created = await creationEvent(options.store, options.silo,
      `conversation-${identity.conversation}`, 'conversation.created');
    const session = z.object({ contextKind: z.string().optional() }).parse(created.data);
    if (session.contextKind === 'shared_child') {
      throw new LoadedMemoryRefused();
    }
    const original = await readChatFacts(options.store, options.silo,
      identity.conversation, identity.turn);
    if (original.memoryContext) {
      throw new LoadedMemoryRefused();
    }
    const snapshot = await memorySnapshot(options, scope);
    const params = { conversationId: identity.conversation, turnId: identity.turn };
    const preview = await turnMemoryPreview(options, identity.requester, params, access);
    for (const reference of preview.references) {
      if (reference.scopeId !== scope.scopeId) {
        throw new LoadedMemoryRefused();
      }
    }
    const position = { scopeId: scope.scopeId, position: snapshot.position };
    const data: MemoryContextRecord = { conversationId: identity.conversation,
      turnId: identity.turn, requesterId: identity.requester, assistantId: identity.assistant,
      computerId: identity.computer, generation: identity.generation, threadId: identity.thread,
      inputGeneration: randomUUID(), projectionGeneration: snapshot.generation,
      scopePositions: [position], action: 'prepared', delivery: null, callDigest: null,
      dispatchDigest: null, additions: [], byteCount: 0, hasOmissions: false, reason: 'none' };
    const prepared = recordEvent(options.silo, data);
    const loadedData: MemoryContextRecord = { ...data, action: 'loaded', delivery: 'initial',
      additions: preview.references, byteCount: preview.bytes, hasOmissions: preview.hasOmissions };
    const loaded = recordEvent(options.silo, loadedData);
    const binding = structuredClone(identity);
    const selection = { scope, snapshot, loaded, qualification, binding };
    await appendInitialRecord(options, selection, prepared, access, deadline);
    const commands = initialCommands(options, selection, prepared.id, preview.block);
    preview.block = '';
    return commands;
  } catch (error) {
    return refuseInitialMemory(options, identity.requester, deadline, error);
  }
}

type Selection = { scope: ReturnType<typeof scopeFor>;
  snapshot: Awaited<ReturnType<typeof memorySnapshot>>; loaded: RecordEvent;
  qualification: string; binding: Identity };

function initialCommands(options: MemoryOptions, selection: Selection, preparedId: string,
  retainedBlock: string | undefined) {
  const { binding, loaded } = selection;
  let consumed = false;
  let loadedProved = false;
  async function load() {
    const loadDeadline = performance.now() + 10_000;
    try {
      if (consumed) {
        throw new LoadedMemoryRefused();
      }
      // Consume before awaiting anything. Unknown saves and lost replies cannot resend.
      consumed = true;
      const loadAccess = await initialMemoryAccess(options, binding.requester, loadDeadline);
      await appendInitialRecord(options, selection, loaded, loadAccess, loadDeadline, preparedId);
      loadedProved = true;
      return { status: 'loaded' as const, dispatch: 'disabled' as const };
    } catch (error) {
      retainedBlock = undefined;
      return refuseInitialMemory(options, binding.requester, loadDeadline, error);
    }
  }
  async function consume(consumer: (block: string) => void | Promise<void>) {
    const releaseDeadline = performance.now() + 10_000;
    const block = retainedBlock;
    // Remove the only reusable copy before waiting, including on a failed attempt.
    retainedBlock = undefined;
    try {
      if (!loadedProved || block === undefined) throw new LoadedMemoryRefused();
      const permissions = await initialMemoryAccess(options, binding.requester, releaseDeadline);
      await confirmInitialRelease(options, selection, permissions, releaseDeadline, block, consumer);
    } catch (error) {
      return refuseInitialMemory(options, binding.requester, releaseDeadline, error);
    }
  }
  return { load, consume };
}

async function appendInitialRecord(options: MemoryOptions, selection: Selection,
  event: RecordEvent, permissions: Awaited<ReturnType<typeof initialMemoryAccess>>,
  deadline: number, preparedId?: string) {
  const { binding, scope, snapshot, loaded, qualification } = selection;
  await requireQualification(options.silo, qualification);
  // Load conversation and supporting history before starting the short write check.
  const parsed = requestFor(binding, scope.scopeId);
  const activity = await approvalActivity(options.store, options.silo, binding.assistant,
    binding.conversation, binding.turn, deadline);
  const chat = await readChatFacts(options.store, options.silo, binding.conversation, binding.turn);
  if (chat.conversationClosed || chat.turnEnded) {
    throw new LoadedMemoryRefused();
  }
  if (preparedId === undefined) {
    if (chat.memoryContext) {
      throw new LoadedMemoryRefused();
    }
  } else if (chat.memoryContext?.events.size !== 1 ||
      !chat.memoryContext.events.has(preparedId)) {
    throw new LoadedMemoryRefused();
  }
  const next = foldMemoryContext(chat.memoryContext, event);
  const conversation = [...activity.conversation];
  const pending = { event, sequence: chat.sequence + 1 };
  conversation.push(pending);
  if (event.data.action === 'prepared') {
    foldMemoryContext(next, loaded);
    const pendingLoad = { event: loaded, sequence: chat.sequence + 2 };
    conversation.push(pendingLoad);
  }
  const memory = await prepareLoadedMemory(options.store, options.binding, binding,
    conversation, deadline, permissions);
  // Require recall access even when the selected personal block is empty.
  const rights = await memoryRights(options.store, options.binding, binding, parsed, deadline,
    undefined, undefined, permissions);
  const subjects = [`member-${binding.requester}`, `assistant-${binding.assistant}`, 'mcp-memory',
    grantStream('mcp_server', 'memory'), grantStream('memory_read', scope.scopeId)];
  const authority = await decisionAuthorityFence(options.store, performance.now(), subjects,
    binding.requester, binding.assistant);
  async function confirmAccess() {
    await confirmDecisionAccess(activity, authority, false);
  }
  const access = { include: authority.include, head: authority.head, deadline: authority.deadline };
  const fresh = Object.assign(confirmAccess, access);
  async function confirm() {
    await permissions.confirm();
    await requireQualification(options.silo, qualification);
    await rights.confirm(fresh.deadline);
    await memory.confirm(fresh);
    const current = await memorySnapshot(options, scope);
    if (current.position !== snapshot.position || current.generation !== snapshot.generation) {
      throw new LoadedMemoryRefused();
    }
    await fresh();
    await permissions.confirm();
    const confirmQualification = await requireQualification(options.silo, qualification);
    // Check access after the deployment read, then check its protected files without waiting.
    await permissions.confirm();
    await fresh();
    confirmQualification();
  }
  await confirm();
  event.time = new Date().toISOString();
  const command = { event, expectedSequence: chat.sequence, historyChecked: true as const,
    deadline: fresh.deadline };
  const result = await options.store.append(command);
  if (result.status !== 'appended') {
    throw new LoadedMemoryRefused();
  }
  await confirm();
}

async function confirmInitialRelease(options: MemoryOptions, selection: Selection,
  permissions: Awaited<ReturnType<typeof initialMemoryAccess>>, deadline: number,
  block: string, consumer: (block: string) => void | Promise<void>) {
  const { binding, scope, loaded, qualification } = selection;
  const activity = await approvalActivity(options.store, options.silo, binding.assistant,
    binding.conversation, binding.turn, deadline);
  const chat = await readChatFacts(options.store, options.silo, binding.conversation, binding.turn);
  if (chat.conversationClosed || chat.turnEnded || !chat.memoryContext?.initialLoaded ||
      !chat.memoryContext.events.has(loaded.id)) throw new LoadedMemoryRefused();
  const memory = await prepareLoadedMemory(options.store, options.binding, binding,
    activity.conversation, deadline, permissions);
  const parsed = requestFor(binding, scope.scopeId);
  const watched = new Set([`ownership-${binding.silo}`, `member-${binding.requester}`]);
  function include(...subjects: string[]) {
    for (const subject of subjects) watched.add(subject);
  }
  const rights = await memoryRights(options.store, options.binding, binding, parsed, deadline,
    include, undefined, permissions);
  const rows = await history(options.store, `scope-${scope.scopeId}`, options.silo, deadline);
  const subjects = [`member-${binding.requester}`, `assistant-${binding.assistant}`, 'mcp-memory',
    grantStream('mcp_server', 'memory'), grantStream('memory_read', scope.scopeId)];
  const authority = await decisionAuthorityFence(options.store, performance.now(), subjects,
    binding.requester, binding.assistant, undefined, deadline);
  include(...subjects);
  function includeAccess(...subjects: string[]) {
    include(...subjects);
    authority.include(...subjects);
  }
  async function confirmAccess() {
    await confirmDecisionAccess(activity, authority, false, true);
  }
  const access = { include: includeAccess, head: authority.head, deadline: authority.deadline };
  const fresh = Object.assign(confirmAccess, access);
  let before = await options.store.head(undefined, fresh.deadline);
  while (true) {
    const confirmQualification = await requireQualification(options.silo, qualification);
    await permissions.confirm();
    await rights.confirm(fresh.deadline);
    await memory.confirm(fresh);
    const after = await options.store.head(undefined, fresh.deadline);
    const changed = after !== before && await releaseChanges(options, selection, watched,
      rows, before, after, fresh.deadline);
    if (changed) {
      // Repeat only for changes to this access or turn, within the original deadline.
      before = after;
      continue;
    }
    confirmQualification();
    if (performance.now() >= fresh.deadline) throw new LoadedMemoryRefused();
    // Check expiry synchronously so the final await cannot carry an expired fact into input.
    const references = memoryReferences(rows, options.silo, scope.scopeId, 'event-only');
    for (const reference of loaded.data.additions) {
      if (references.current(reference, Date.now()) !== 'current') throw new LoadedMemoryRefused();
    }
    try {
      await consumer(block);
    } catch {
      // Keep private text out of errors, including an error that imitates an access refusal.
      throw new LoadedMemoryRefused();
    }
    return;
  }
}

async function releaseChanges(options: MemoryOptions, selection: Selection,
  accessSubjects: Set<string>, scopeRows: StoredEvent[], from: number, to: number,
  deadline: number) {
  const { binding, scope } = selection;
  const conversation = `conversation-${binding.conversation}`;
  const computer = `computer-${binding.assistant}`;
  const memory = `scope-${scope.scopeId}`;
  const subjects = [...accessSubjects, conversation, computer, memory];
  async function readChanges(subject: string) {
    const rows: StoredEvent[] = [];
    const includeCloses = subject === conversation;
    for await (const row of options.store.readStream(subject, from + 1, deadline, includeCloses)) {
      if (row.sequence > to) break;
      rows.push(row);
    }
    return { subject, rows };
  }
  // Read only relevant stream tails through the captured position. Other chats
  // can keep writing without making this validation wait for a quiet store.
  const reads = subjects.map(readChanges);
  const changes = await Promise.all(reads);
  let changed = false;
  for (const change of changes) {
    if (change.subject === memory) {
      scopeRows.push(...change.rows);
      continue;
    }
    for (const row of change.rows) {
      if (change.subject === conversation || change.subject === computer) {
        changed ||= changesDecisionActivity(row.event, binding.turn, false, true);
      } else {
        changed = true;
      }
    }
  }
  return changed;
}
