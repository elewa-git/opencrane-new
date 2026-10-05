import type { WebSocket } from 'ws';
import type { AuthConfig, SessionData } from '@opencrane/auth';
import { GroupRefused } from '../members/groups.ts';
import { authorityFence, PayingGroupRefused } from '@opencrane/models';
import { memberAuthorisation } from '@opencrane/authz';
import { chatRows, type ChatOptions } from './routes.ts';

export function conversationSubscription(socket: WebSocket, session: SessionData, config: AuthConfig, options?: ChatOptions) {
  let started = false;
  return async (conversationId: string, since: number, requestedGeneration?: number) => {
    if (started || !options) { socket.close(1008); return; } started = true;
    const auth = memberAuthorisation(options.binding);
    let position = since, generation = requestedGeneration ?? 0, running = false, ready = false, state = '';
    const send = (type: string, extra = {}) => socket.send(JSON.stringify({ version: 1, topic: 'conversation', conversationId, type, position, generation, ...extra }));
    const drain = async () => {
      if (running || socket.readyState !== socket.OPEN) return; running = true;
      try {
        const fresh = await authorityFence(options.store, performance.now(),
          [`conversation-${conversationId}`]);
        const memberId = await options.feed.memberId(options.silo, config.issuerUrl, session.sub);
        if (!validSession(session, config, memberId) ||
            !(await auth.conversation(memberId, conversationId, 'read')).allowed) {
          send('refused'); socket.close(1008); return;
        }
        fresh.include(`member-${memberId}`);
        const result = await chatRows(options, memberId, conversationId, position, fresh);
        if ((position > 0 && generation !== result.generation) || position > result.position) {
          generation = result.generation; position = 0; send('resync'); socket.close(1013); return;
        }
        generation = result.generation;
        for (const row of result.rows) {
          if (socket.bufferedAmount > 64 * 1024) { send('resync'); socket.close(1013); return; }
          position = row.position; send('event', { row });
        }
        if (!ready || state !== result.computerState) { state = result.computerState; send('ready', { computerState: state }); ready = true; }
      } catch (error) {
        if (isPrivateRefusal(error)) {
          send('refused');
          socket.close(1008);
        } else {
          socket.close(1011);
        }
      } finally { running = false; }
    };
    const timer = setInterval(() => { void drain(); }, 100);
    timer.unref(); socket.once('close', () => clearInterval(timer));
    await drain();
  };
}

function validSession(session: SessionData, config: AuthConfig,
  memberId: string | undefined): memberId is string {
  return session.orgId === config.expectedOrgId && session.exp * 1000 > Date.now()
    && Boolean(memberId);
}

function isPrivateRefusal(error: unknown) {
  return error instanceof GroupRefused || error instanceof PayingGroupRefused;
}
