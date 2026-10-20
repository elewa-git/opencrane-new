import { z } from 'zod';
import { history, memoryReferences, MemoryToolRefused, type MemoryContext,
  type parseMemoryRequest } from '@opencrane/models';
import { checkRecallProof } from './recall-proof.ts';
import { MemoryRefused, type MemoryOptions } from './access.ts';
import type { readRecallContext } from './recall-delivery.ts';

const turnData = z.object({ turnId: z.string() });
type Evidence = Awaited<ReturnType<typeof readRecallContext>>;
type Reference = NonNullable<Evidence['chat']['memoryContext']>['references'][number];

function referenceKey(reference: Reference) {
  return JSON.stringify([reference.scopeId, reference.memoryId, reference.revision]);
}
function checkEvidence(context: MemoryContext, evidence: Evidence, dependencies: Reference[],
  target?: Reference) {
  const { saved, chat } = evidence;
  const state = chat.memoryContext;
  if (!saved || state?.status !== 'loaded' || state.references.length === 0) {
    throw new MemoryRefused();
  }
  const recorded = [saved.requesterId, saved.assistantId, saved.computerId, saved.generation,
    saved.conversationId, saved.turnId, saved.threadId];
  const current = [context.requester, context.assistant, context.computer, context.generation,
    context.conversation, context.turn, context.thread];
  if (JSON.stringify(recorded) !== JSON.stringify(current)) {
    throw new MemoryRefused();
  }
  const keys = dependencies.map(referenceKey);
  const supplied = new Set(keys);
  if (supplied.size !== dependencies.length) throw new MemoryRefused();
  if (target) {
    if (context.operation === 'correct') {
      for (const dependency of dependencies) {
        // Keep every revision of the target out of its replacement's dependencies.
        if (dependency.memoryId === target.memoryId) throw new MemoryRefused();
      }
      supplied.add(referenceKey(target));
    }
    if (!supplied.has(referenceKey(target))) throw new MemoryRefused();
  }
  if (supplied.size !== state.references.length) {
    throw new MemoryRefused();
  }
  for (const reference of state.references) {
    if (reference.scopeId !== context.scopes[0] || !supplied.has(referenceKey(reference))) {
      throw new MemoryRefused();
    }
  }
}

export function confirmAgentLineage(options: MemoryOptions, context: MemoryContext,
  evidence: Evidence, dependencies: Reference[], confirmRights: () => Promise<unknown>,
  deadline: number, target?: Reference) {
  checkEvidence(context, evidence, dependencies, target);
  async function confirm() {
    await confirmRights();
    // Read only changes since the saved evidence, including participation-stream closure.
    const rows = options.store.readStream(`conversation-${context.conversation}`,
      evidence.chat.sequence + 1, deadline, true);
    for await (const row of rows) {
      const event = row.event;
      const relevant = event.type === 'agent.memory_context_recorded' ||
        event.type === 'agent.turn_completed' || event.type === 'agent.turn_failed';
      if (event.silo !== options.silo || event.type === 'conversation.closed') {
        throw new MemoryRefused();
      }
      if (relevant) {
        const data = turnData.parse(event.data);
        if (data.turnId === context.turn) {
          throw new MemoryRefused();
        }
      }
    }
    // Recheck access because grants can change while the conversation tail is read.
    await confirmRights();
    if (Date.now() >= context.exp * 1000 || performance.now() >= deadline) {
      throw new MemoryRefused();
    }
  }
  return confirm;
}

type Change = Extract<NonNullable<ReturnType<typeof parseMemoryRequest>['input']>,
  { operation: 'correct' | 'forget' }>;
export async function refuseAgentChange(options: MemoryOptions, context: MemoryContext,
  evidence: Evidence, input: Change, secret: string, confirmRights: () => Promise<unknown>,
  deadline: number) {
  const target = { scopeId: input.scopeId, memoryId: input.memoryId,
    revision: input.expectedRevision };
  const loaded = evidence.chat.memoryContext?.references ?? [];
  const dependencies = input.operation === 'correct' ? input.dependsOn : loaded;
  const proved = [...dependencies, target];
  checkRecallProof(secret, context, input.recallProof, proved,
    evidence.inputGeneration, target);
  const confirm = confirmAgentLineage(options, context, evidence, dependencies,
    confirmRights, deadline, target);
  const rows = await history(options.store, `scope-${input.scopeId}`, options.silo, deadline);
  const references = memoryReferences(rows, options.silo, input.scopeId, 'event-only');
  for (const reference of proved) {
    if (references.current(reference) !== 'current') throw new MemoryRefused();
  }
  await confirm();
  throw new MemoryToolRefused('memory_tool_unavailable');
}
