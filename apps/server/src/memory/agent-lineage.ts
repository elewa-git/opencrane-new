import { z } from 'zod';
import type { MemoryContext } from '@opencrane/models';
import { MemoryRefused, type MemoryOptions } from './access.ts';
import type { readRecallContext } from './recall-delivery.ts';

const turnData = z.object({ turnId: z.string() });
type Evidence = Awaited<ReturnType<typeof readRecallContext>>;
type Reference = NonNullable<Evidence['chat']['memoryContext']>['references'][number];

function referenceKey(reference: Reference) {
  return JSON.stringify([reference.scopeId, reference.memoryId, reference.revision]);
}
function checkEvidence(context: MemoryContext, evidence: Evidence, dependencies: Reference[]) {
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
  if (supplied.size !== dependencies.length || supplied.size !== state.references.length) {
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
  deadline: number) {
  checkEvidence(context, evidence, dependencies);
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
    if (Date.now() >= context.exp * 1000 || performance.now() >= deadline) {
      throw new MemoryRefused();
    }
  }
  return confirm;
}
