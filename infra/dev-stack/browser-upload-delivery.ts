import assert from 'node:assert/strict';
import type { Page, WebSocketRoute } from 'playwright';
import { serverMessageSchema } from '@opencrane/protocol';

/** Hold the real delivery and later frames in order until the composer has been checked. */
export async function holdUploadDelivery(page: Page) {
  let holding = true;
  const delivered = Promise.withResolvers<void>();
  const held: { socket: WebSocketRoute; message: string | Buffer }[] = [];
  function connect(socket: WebSocketRoute) {
    const server = socket.connectToServer();
    function receive(message: string | Buffer) {
      const parsed: unknown = JSON.parse(message.toString());
      const result = serverMessageSchema.safeParse(parsed);
      const delivery = result.success && result.data.type === 'event'
        && result.data.topic === 'conversation' && result.data.row?.type === 'file.delivered';
      if (holding && (held.length > 0 || delivery)) {
        held.push({ socket, message });
        delivered.resolve();
        return;
      }
      socket.send(message);
    }
    server.onMessage(receive);
  }
  await page.routeWebSocket('**/ws', connect);
  // Replace the existing connection so this journey controls the next upload's frames.
  await page.reload();
  async function release() {
    await delivered.promise;
    assert(held.length > 0, 'The real delivery event was held before Ready');
    holding = false;
    for (const frame of held) frame.socket.send(frame.message);
    held.length = 0;
  }
  return release;
}
