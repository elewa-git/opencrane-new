import type { WebSocket } from 'ws';
import type { FastifyBaseLogger } from 'fastify';
import type { AuthConfig, SessionData } from '@opencrane/auth';
import { validChatSession } from './session-auth.ts';
import { activeChatMember, isChatRefused, type ChatOptions } from './access.ts';
import { personalContext } from './context.ts';

// Watch only this person's assignment until the workspace can create its first conversation.
export function contextSubscription(
  socket: WebSocket, session: SessionData, config: AuthConfig,
  logger: FastifyBaseLogger, options?: ChatOptions,
) {
  let running = false;
  let memberId: string | undefined;
  let previousAssistant: string | null | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  function stop(): void {
    clearInterval(timer);
  }
  socket.once('close', stop);

  function expire(): void {
    socket.close(1013, 'chat context unavailable');
  }
  async function update(): Promise<void> {
    if (running || socket.readyState !== socket.OPEN) {
      return;
    }
    running = true;
    const watchdog = setTimeout(expire, 1500);
    try {
      if (!options || !validChatSession(session, config, options)) {
        socket.close(1008, 'subscription refused');
        return;
      }
      memberId ??= await options.feed.memberId(options.silo, config.issuerUrl, session.sub);
      if (!memberId) {
        socket.close(1008, 'subscription refused');
        return;
      }
      await activeChatMember(options, memberId);
      const context = await personalContext(options, memberId);
      // Check removal again after reading content. A slow read must not deliver after closure.
      await activeChatMember(options, memberId);
      if (socket.readyState !== socket.OPEN) {
        return;
      }
      if (previousAssistant === context.assistantId) {
        return;
      }
      if (socket.bufferedAmount > 64 * 1024) {
        expire();
        return;
      }
      const frame = { type: 'context', topic: 'chat-context', data: context };
      const encodedFrame = JSON.stringify(frame);
      socket.send(encodedFrame);
      previousAssistant = context.assistantId;
    } catch (error) {
      if (isChatRefused(error)) {
        socket.close(1008, 'subscription refused');
      } else {
        logger.error({ err: error, operation: 'chat.context' }, 'chat context unavailable');
        expire();
      }
    } finally {
      clearTimeout(watchdog);
      running = false;
    }
  }
  function poll(): void {
    void update();
  }
  return function subscribe(): void {
    if (timer) {
      socket.close(1008, 'subscription refused');
      return;
    }
    timer = setInterval(poll, 250);
    timer.unref();
    poll();
  };
}
