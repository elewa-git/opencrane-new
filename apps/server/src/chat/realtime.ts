import type { WebSocket } from 'ws';
import type { AuthConfig, SessionData } from '@opencrane/auth';
import { chatAccess, recordedChatMode, isChatRefused } from './access.ts';
import { chatRows, type ChatOptions } from './routes.ts';

export function conversationSubscription(
  socket: WebSocket, session: SessionData, config: AuthConfig, options?: ChatOptions,
) {
  let started = false;
  return subscribe;

  async function subscribe(conversationId: string, since: number, requestedGeneration?: number) {
    if (started || !options) {
      socket.close(1008);
      return;
    }
    started = true;
    const chat = options;
    let position = since;
    let generation = requestedGeneration ?? 0;
    let running = false;
    let ready = false;
    let state = '';
    function send(type: string, extra = {}) {
      if (socket.readyState !== socket.OPEN) return;
      const message = {
        version: 1, topic: 'conversation', conversationId, type, position, generation, ...extra,
      };
      socket.send(JSON.stringify(message));
    }
    function refuse() {
      send('refused');
      socket.close(1008);
    }
    function expire() {
      // Leave time for the polling interval and close handshake inside the two-second bound.
      socket.close(1013);
    }
    async function drain() {
      if (running || socket.readyState !== socket.OPEN) return;
      running = true;
      const deadline = performance.now() + 1500;
      const watchdog = setTimeout(expire, 1500);
      try {
        const memberId = await chat.feed.memberId(chat.silo, config.issuerUrl, session.sub);
        if (!validSession(session, config, chat) || !memberId) {
          refuse();
          return;
        }
        const fresh = await chatAccess(chat, memberId, conversationId, 'read', deadline);
        const mode = recordedChatMode(fresh);
        const result = await chatRows(chat, conversationId, mode, position);
        await fresh();
        if (socket.readyState !== socket.OPEN) return;
        if ((position > 0 && generation !== result.generation) || position > result.position) {
          generation = result.generation;
          position = 0;
          send('resync');
          socket.close(1013);
          return;
        }
        generation = result.generation;
        for (const row of result.rows) {
          if (socket.bufferedAmount > 64 * 1024) {
            send('resync');
            socket.close(1013);
            return;
          }
          position = row.position;
          const extra = { row };
          send('event', extra);
        }
        if (!ready || state !== result.computerState) {
          state = result.computerState;
          const extra = { computerState: state };
          send('ready', extra);
          ready = true;
        }
      } catch (error) {
        if (isChatRefused(error)) refuse();
        else socket.close(1011);
      } finally {
        clearTimeout(watchdog);
        running = false;
      }
    }
    function poll() {
      void drain();
    }
    const timer = setInterval(poll, 100);
    timer.unref();
    function stop() {
      clearInterval(timer);
    }
    socket.once('close', stop);
    await drain();
  }
}

function validSession(session: SessionData, config: AuthConfig, options: ChatOptions) {
  return session.orgId === config.expectedOrgId && session.exp * 1000 > Date.now() &&
    options.silo === options.binding.silo;
}
