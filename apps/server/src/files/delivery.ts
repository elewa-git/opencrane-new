import type { WebSocket } from 'ws';
import { z } from 'zod';
import { fileUploadedDataSchema } from '@opencrane/events';

export async function sendFile(socket: WebSocket, file: z.infer<typeof fileUploadedDataSchema>, bytes: Buffer) {
  return new Promise<'saved' | 'kept_existing'>((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('File delivery timed out')), 90_000);
    const closed = () => finish(new Error('File delivery disconnected'));
    function receipt(raw: unknown) {
      if (!Buffer.isBuffer(raw)) return;
      let value: unknown;
      try { value = JSON.parse(raw.toString()) as unknown; } catch { finish(new Error('Invalid file receipt')); socket.close(1008, 'Invalid file receipt'); return; }
      const parsed = z.object({ type: z.literal('file_received'), fileId: z.string(), sha256: z.string(), outcome: z.enum(['saved', 'kept_existing']).default('saved') }).safeParse(value);
      if (parsed.success && parsed.data.fileId === file.fileId) finish(parsed.data.sha256 === file.sha256 ? undefined : new Error('File digest mismatch'), parsed.data.outcome);
    }
    function finish(error?: Error, outcome: 'saved' | 'kept_existing' = 'saved') {
      clearTimeout(timer); socket.off('message', receipt); socket.off('close', closed);
      if (error) reject(error); else resolve(outcome);
    }
    socket.on('message', receipt); socket.once('close', closed);
    socket.send(JSON.stringify({ type: 'file_begin', ...file }));
    void (async () => {
      // Await each frame's flush so large uploads cannot overrun ws's output queue.
      for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
        await new Promise<void>((sent, failed) => socket.send(JSON.stringify({ type: 'file_chunk', offset,
          bytes: bytes.subarray(offset, offset + 64 * 1024).toString('base64') }), error => error ? failed(error) : sent()));
      }
      socket.send(JSON.stringify({ type: 'file_end' }));
    })().catch((error: unknown) => finish(error instanceof Error ? error : new Error('Delivery failed')));
  });
}
