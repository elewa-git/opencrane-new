import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { WebSocket } from 'ws';
import type { RetainedCall } from '@opencrane/models';

const signalSchema = z.strictObject({
  approvalId: z.string().regex(/^[a-f0-9]{64}$/u),
  callId: z.string().min(1).max(200),
  turnId: z.string(),
  conversationId: z.string(),
  computerId: z.string(),
  generation: z.int().positive(),
  serverId: z.string(),
  connectionId: z.string(),
  toolName: z.string(),
  expiresAt: z.iso.datetime(),
});

export function bridgeRetainedCalls(socket: WebSocket,
  computerId: string, generation: number | undefined) {
  const pending = new Map<string, { approvalId: string;
    resolve: (signal: RetainedCall | undefined) => void; timer: NodeJS.Timeout }>();

  function read(approvalId: string) {
    if (socket.readyState !== socket.OPEN || !generation || pending.size >= 64) {
      return Promise.resolve(undefined);
    }
    return new Promise<RetainedCall | undefined>(resolve => {
      const readId = randomUUID();
      function timedOut() {
        pending.delete(readId);
        resolve(undefined);
      }
      const timer = setTimeout(timedOut, 1500);
      timer.unref();
      pending.set(readId, { approvalId, resolve, timer });
      try {
        socket.send(JSON.stringify({ type: 'retained_call_read', readId, approvalId }));
      } catch {
        clearTimeout(timer);
        pending.delete(readId);
        resolve(undefined);
      }
    });
  }

  function receive(value: unknown) {
    if (!value || typeof value !== 'object' || !('type' in value) ||
        value.type !== 'retained_call_status') return false;
    const receipt = value as Record<string, unknown>;
    const readId = receipt['readId'];
    if (typeof readId !== 'string') return true;
    const waiting = pending.get(readId);
    if (!waiting) return true;
    pending.delete(readId);
    clearTimeout(waiting.timer);
    const parsed = signalSchema.safeParse(receipt['signal']);
    const signal = parsed.success ? parsed.data : undefined;
    const matching = signal?.approvalId === waiting.approvalId &&
      signal.computerId === computerId && signal.generation === generation;
    waiting.resolve(matching ? signal : undefined);
    return true;
  }

  function close() {
    for (const waiting of pending.values()) {
      clearTimeout(waiting.timer);
      waiting.resolve(undefined);
    }
    pending.clear();
  }
  socket.once('close', close);
  return { read, receive };
}
