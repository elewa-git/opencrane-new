import type { WebSocket } from 'ws';
import type { AuthConfig, SessionData } from '@opencrane/auth';
import { GroupRefused, readActiveMember } from '../members/groups.ts';
import { AuthorityApplying, PayingGroupRefused } from '@opencrane/models';
import { memberAuthorisation } from '@opencrane/authz';
import { chatContent, type ChatOptions } from './routes.ts';
import { privateSessionCreation, requirePrivateReader } from './private-session.ts';

async function subscriptionAccess(options: ChatOptions, memberId: string,
  conversationId: string) {
  // Keep creation events for this socket. Messages cannot change their owner or payer.
  const session = await privateSessionCreation(options, conversationId);
  const subjects = [`ownership-${options.silo}`, `member-${memberId}`,
    `assistant-${session.created.assistantId}`];
  if (session.assistant.kind === 'team') subjects.push(`team-${session.assistant.ownerId}`);
  let previousHeads: number[] | undefined;
  let conversationHead: number | undefined;
  const auth = memberAuthorisation(options.binding);
  async function readHead(subject: string) {
    return options.store.head(subject);
  }
  async function check() {
    const headReads = subjects.map(readHead);
    const heads = await Promise.all(headReads);
    const currentConversationHead = await options.store.head(`conversation-${conversationId}`);
    const authorityChanged = !previousHeads || heads.some(headMoved);
    function headMoved(head: number, index: number) {
      return head !== previousHeads?.[index];
    }
    if (authorityChanged) {
      await readActiveMember(options.store, options.binding, memberId);
      await requirePrivateReader(options, memberId, session);
    }
    if (authorityChanged || currentConversationHead !== conversationHead) {
      const permission = await auth.conversation(memberId, conversationId, 'read');
      if (!permission.allowed) throw new GroupRefused('Conversation refused');
    }
    previousHeads = heads;
    conversationHead = currentConversationHead;
  }
  return check;
}

export function conversationSubscription(socket: WebSocket, session: SessionData,
  config: AuthConfig, options?: ChatOptions) {
  let started = false;
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
    let access: Awaited<ReturnType<typeof subscriptionAccess>> | undefined;
    function send(type: string, extra = {}) {
      const message = { version: 1, topic: 'conversation', conversationId,
        type, position, generation, ...extra };
      socket.send(JSON.stringify(message));
    }
    async function drain() {
      if (running || socket.readyState !== socket.OPEN) return;
      running = true;
      try {
        if (!access) {
          const memberId = await chat.feed.memberId(chat.silo, config.issuerUrl, session.sub);
          if (!validSession(session, config, memberId)) throw new GroupRefused('Session refused');
          access = await subscriptionAccess(chat, memberId, conversationId);
        }
        if (session.exp * 1000 <= Date.now()) throw new GroupRefused('Session expired');
        await access();
        const result = await chatContent(chat, conversationId, position);
        if (needsResync(position, generation, result)) {
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
          send('event', { row });
        }
        if (!ready || state !== result.computerState) {
          state = result.computerState;
          send('ready', { computerState: state });
          ready = true;
        }
      } catch (error) {
        if (error instanceof AuthorityApplying) {
          socket.close(1013);
        } else if (isPrivateRefusal(error)) {
          send('refused');
          socket.close(1008);
        } else {
          socket.close(1011);
        }
      } finally {
        running = false;
      }
    }
    function poll() {
      void drain();
    }
    const timer = setInterval(poll, 100);
    function stopPolling() {
      clearInterval(timer);
    }
    timer.unref();
    socket.once('close', stopPolling);
    await drain();
  }
  return subscribe;
}

function validSession(session: SessionData, config: AuthConfig,
  memberId: string | undefined): memberId is string {
  return session.orgId === config.expectedOrgId && session.exp * 1000 > Date.now()
    && Boolean(memberId);
}

function isPrivateRefusal(error: unknown) {
  return error instanceof GroupRefused || error instanceof PayingGroupRefused;
}

function needsResync(position: number, generation: number,
  result: { position: number; generation: number }) {
  return (position > 0 && generation !== result.generation) || position > result.position;
}
