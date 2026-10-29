import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { grantStream } from '@opencrane/authz';
import { memoryContextRecordedEventSchema, type MemoryContextRecord } from '@opencrane/events';
import { approvalActivity, confirmDecisionAccess, decisionAuthorityFence, foldMemoryContext,
  LoadedMemoryRefused, memoryRights, parseMemoryRequest, prepareLoadedMemory,
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
  if (await readDeploymentQualification(silo) !== runId) {
    throw new LoadedMemoryRefused();
  }
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

// Record evidence only. This workflow cannot return text or authorise bridge release.
export async function prepareInitialMemory(options: MemoryOptions, identity: Identity,
  ...unexpectedArguments: unknown[]) {
  const deadline = performance.now() + 10_000;
  try {
    const access = await initialMemoryAccess(options, identity.requester, deadline);
    if (unexpectedArguments.length !== 0) throw new LoadedMemoryRefused();
    const qualification = await readDeploymentQualification(options.silo);
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
    let consumed = false;
    async function load() {
      const loadDeadline = performance.now() + 10_000;
      try {
        if (consumed) {
          throw new LoadedMemoryRefused();
        }
        // Consume before awaiting anything. Unknown saves and lost replies cannot resend.
        consumed = true;
        const loadAccess = await initialMemoryAccess(options, binding.requester, loadDeadline);
        await appendInitialRecord(options, selection, loaded, loadAccess, loadDeadline, prepared.id);
        return { status: 'loaded' as const, dispatch: 'disabled' as const };
      } catch (error) {
        return refuseInitialMemory(options, binding.requester, loadDeadline, error);
      }
    }
    return { load };
  } catch (error) {
    return refuseInitialMemory(options, identity.requester, deadline, error);
  }
}

type Selection = { scope: ReturnType<typeof scopeFor>;
  snapshot: Awaited<ReturnType<typeof memorySnapshot>>; loaded: RecordEvent;
  qualification: string; binding: Identity };

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
    await requireQualification(options.silo, qualification);
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
