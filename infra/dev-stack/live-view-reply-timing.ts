import type { Page, Request, WebSocket } from 'playwright';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function measureFirstReplyDelta(page: Page, conversationId: string) {
  let sentAt: number | undefined;
  let sentAtTime: string | undefined;
  let firstDeltaMs: number | undefined;
  const cleanups: (() => void)[] = [];

  function requestSent(request: Request) {
    const path = new URL(request.url()).pathname;
    if (request.method() !== 'POST' ||
        path !== `/api/conversations/${conversationId}/messages` || sentAt !== undefined) return;
    sentAt = performance.now();
    sentAtTime = new Date().toISOString();
  }

  function frameReceived(frame: { payload: string | Buffer }) {
    if (sentAt === undefined || firstDeltaMs !== undefined) return;
    let message: unknown;
    try {
      message = JSON.parse(String(frame.payload));
    } catch {
      return;
    }
    if (!isRecord(message) || message['conversationId'] !== conversationId) return;
    const row = message['row'];
    if (!isRecord(row) || row['type'] !== 'agent.message_delta') return;
    // Keep elapsed time only. Reply frames can contain private chat text.
    firstDeltaMs = Math.round(performance.now() - sentAt);
  }

  function socketOpened(socket: WebSocket) {
    const path = new URL(socket.url()).pathname;
    if (path !== '/ws') return;
    socket.on('framereceived', frameReceived);
    function cleanup() {
      socket.off('framereceived', frameReceived);
    }
    cleanups.push(cleanup);
  }

  page.on('request', requestSent);
  page.on('websocket', socketOpened);
  function stop() {
    page.off('request', requestSent);
    page.off('websocket', socketOpened);
    for (const cleanup of cleanups) cleanup();
    return { sentAtTime: sentAtTime ?? null, firstDeltaMs: firstDeltaMs ?? null };
  }
  return stop;
}
