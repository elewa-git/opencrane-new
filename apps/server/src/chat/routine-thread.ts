import type { WebSocket, RawData } from 'ws';
import { z } from 'zod';

type Identity = { id: string; conversationId: string; assistantId: string;
  requesterId: string; expiresAt: number };
const replySchema = z.object({ type: z.literal('routine_prepared'), id: z.string(),
  conversationId: z.string(), assistantId: z.string(), requesterId: z.string(),
  threadId: z.string().min(1).max(200) });

export function prepareRoutineThread(socket: WebSocket, input: Identity) {
  const identity = { ...input };
  function wait(resolve: (threadId: string) => void, reject: (error: Error) => void) {
    const timer = setTimeout(refused, 10_000);
    function cleanup() {
      clearTimeout(timer);
      socket.off('message', received);
      socket.off('close', refused);
    }
    function refused() {
      cleanup();
      cancelRoutineThread(socket, identity.id, identity.conversationId);
      reject(new Error('Routine thread unavailable'));
    }
    function received(raw: RawData) {
      try {
        let bytes: Buffer;
        if (Buffer.isBuffer(raw)) bytes = raw;
        else if (Array.isArray(raw)) bytes = Buffer.concat(raw);
        else bytes = Buffer.from(raw);
        const parsed = replySchema.safeParse(JSON.parse(bytes.toString()));
        if (!parsed.success || parsed.data.id !== identity.id) return;
        const reply = parsed.data;
        if (reply.conversationId !== identity.conversationId
          || reply.assistantId !== identity.assistantId
          || reply.requesterId !== identity.requesterId || identity.expiresAt <= Date.now()) {
          refused();
          return;
        }
        cleanup();
        resolve(reply.threadId);
      } catch {
        refused();
      }
    }
    socket.on('message', received);
    socket.once('close', refused);
    if (socket.readyState !== socket.OPEN) {
      refused();
      return;
    }
    socket.send(JSON.stringify({ type: 'routine_prepare', ...identity }));
  }
  return new Promise<string>(wait);
}

export function cancelRoutineThread(socket: WebSocket, turnId: string, conversationId: string) {
  if (socket.readyState !== socket.OPEN) return;
  socket.send(JSON.stringify({ type: 'stop', turnId, conversationId }));
}
