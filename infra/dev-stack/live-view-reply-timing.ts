import type { Request, WebSocket } from 'playwright';
import type { BrowserObservation } from './live-view-timings.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface ReplyTiming {
  sentAtTime: string;
  firstDeltaMs: number | null;
}

export function measureFirstReplyDelta(page: BrowserObservation) {
  const replies = new Map<string, ReplyTiming & { sentAt: number }>();
  const cleanups: (() => void)[] = [];

  function requestSent(request: Request) {
    if (request.method() !== 'POST') return;
    const path = new URL(request.url()).pathname;
    const chatId = /^\/api\/conversations\/([\w-]+)\/messages$/u.exec(path)?.[1];
    if (!chatId || replies.has(chatId)) return;
    const timing = { sentAt: performance.now(), sentAtTime: new Date().toISOString(),
      firstDeltaMs: null };
    replies.set(chatId, timing);
  }

  function frameReceived(frame: { payload: string | Buffer }) {
    let message: unknown;
    try {
      message = JSON.parse(String(frame.payload));
    } catch {
      return;
    }
    if (!isRecord(message) || typeof message['conversationId'] !== 'string') return;
    const reply = replies.get(message['conversationId']);
    if (!reply || reply.firstDeltaMs !== null) return;
    const row = message['row'];
    if (!isRecord(row) || row['type'] !== 'agent.message_delta') return;
    // Keep elapsed time only. Reply frames can contain private chat text.
    reply.firstDeltaMs = Math.round(performance.now() - reply.sentAt);
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
    const timings = new Map<string, ReplyTiming>();
    for (const [chatId, { sentAtTime, firstDeltaMs }] of replies) {
      timings.set(chatId, { sentAtTime, firstDeltaMs });
    }
    return timings;
  }
  return stop;
}
