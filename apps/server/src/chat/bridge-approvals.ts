import type { EventStore } from '@opencrane/event-store';
import { toolApprovalRequestedDataSchema } from '@opencrane/events';
import { history, readApproval } from '@opencrane/models';
import { WebSocket } from 'ws';
import { z } from 'zod';

const waitingSchema = z.object({
  type: z.literal('approval_waiting'),
  approvalId: z.string().regex(/^[a-f0-9]{64}$/u),
  conversationId: z.string().min(1).max(200),
  turnId: z.string().min(1).max(200),
}).strict();
type Waiting = z.infer<typeof waitingSchema> & {
  approvalHead?: number;
  conversationHead?: number;
  expiresAt?: number;
  pending?: Promise<void> | undefined;
};

export function bridgeApprovals(store: EventStore, silo: string, assistantId: string,
  socket: Pick<WebSocket, 'readyState' | 'send'>) {
  const waiting = new Map<string, Waiting>();

  function receive(value: unknown) {
    if (typeof value !== 'object' || value === null || !('type' in value)
      || value.type !== 'approval_waiting') return false;
    const parsed = waitingSchema.safeParse(value);
    // Treat a signal as a hint to read events. It cannot supply an approval decision.
    if (!parsed.success || waiting.has(parsed.data.approvalId) || waiting.size >= 64) return true;
    waiting.set(parsed.data.approvalId, parsed.data);
    return true;
  }

  async function check(entry: Waiting) {
    const deadline = performance.now() + 10_000;
    const subject = `approval-${entry.approvalId}`;
    const approvalHead = await store.head(subject, deadline);
    const conversationHead = await store.head(`conversation-${entry.conversationId}`, deadline);
    const expired = entry.expiresAt !== undefined && Date.now() >= entry.expiresAt;
    if (entry.approvalHead === approvalHead && entry.conversationHead === conversationHead
      && !expired) return;
    const rows = await history(store, subject, silo, deadline);
    const request = toolApprovalRequestedDataSchema.parse(rows[0]?.event.data);
    // Check ownership before the reader can cancel or expire an unrelated approval.
    if (request.approvalId !== entry.approvalId || request.assistantId !== assistantId
      || request.conversationId !== entry.conversationId || request.turnId !== entry.turnId) {
      waiting.delete(entry.approvalId);
      return;
    }
    const result = await readApproval(store, silo, entry.approvalId, { deadline });
    if (socket.readyState !== WebSocket.OPEN) return;
    if (result.state !== 'requested') {
      const signal = { type: 'approval_settled', approvalId: entry.approvalId, state: result.state };
      socket.send(JSON.stringify(signal));
      waiting.delete(entry.approvalId);
      return;
    }
    // Keep the positions from before the read, so a concurrent change gets another look.
    entry.approvalHead = approvalHead;
    entry.conversationHead = conversationHead;
    entry.expiresAt = Date.parse(request.expiresAt);
  }

  function start(entry: Waiting) {
    if (entry.pending) return;
    function retryLater() {
      // Leave failed reads in the map so the next pass tries without needing a new event.
    }
    function finished() { entry.pending = undefined; }
    const checked = check(entry);
    const handled = checked.catch(retryLater);
    entry.pending = handled.finally(finished);
  }

  function poll() {
    if (socket.readyState !== WebSocket.OPEN) {
      waiting.clear();
      return;
    }
    // Start each read independently. A slow approval must not hold up reports or other chats.
    for (const entry of waiting.values()) start(entry);
  }

  async function settled() {
    const pending: Promise<void>[] = [];
    for (const entry of waiting.values()) {
      if (entry.pending) pending.push(entry.pending);
    }
    await Promise.all(pending);
  }

  return { receive, poll, settled, get size() { return waiting.size; } };
}
