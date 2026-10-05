import type { WebSocket } from 'ws';
import type { AuthConfig, SessionData } from '@opencrane/auth';
import { conversationAccessFence } from '@opencrane/models';
import { chatAccess, recordedChatMode, isChatRefused } from './access.ts';
import { chatRows, type ChatOptions } from './routes.ts';

type Mode = 'agent_session' | 'direct';
interface Subscription {
  socket: WebSocket;
  session: SessionData;
  config: AuthConfig;
  options: ChatOptions;
  conversationId: string;
  position: number;
  generation: number;
  running: boolean;
  ready: boolean;
  computerState: string;
  access?: { memberId: string; memberHead: number; conversationHead: number; mode: Mode };
}

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
    const state: Subscription = {
      socket, session, config, options, conversationId, position: since,
      generation: requestedGeneration ?? 0, running: false, ready: false, computerState: '',
    };
    function poll() {
      void drain(state);
    }
    const timer = setInterval(poll, 100);
    timer.unref();
    function stop() {
      clearInterval(timer);
    }
    socket.once('close', stop);
    await drain(state);
  }
}

async function drain(state: Subscription) {
  const { socket, options, conversationId, session, config } = state;
  if (state.running || socket.readyState !== socket.OPEN) return;
  state.running = true;
  const deadline = performance.now() + 1500;
  function expire() {
    // Leave time for polling and the close handshake inside the two-second removal bound.
    socket.close(1013);
  }
  const watchdog = setTimeout(expire, 1500);
  try {
    const memberId = await options.feed.memberId(options.silo, config.issuerUrl, session.sub);
    if (!validSession(session, config, options) || !memberId) {
      refuse(state);
      return;
    }
    const subjects = [`member-${memberId}`, `conversation-${conversationId}`];
    const fresh = await conversationAccessFence(options.store, performance.now(), subjects, deadline);
    const memberHead = await options.store.head(subjects[0], deadline);
    const conversationHead = await options.store.head(subjects[1], deadline);
    const previous = state.access;
    if (!previous || previous.memberId !== memberId || previous.memberHead !== memberHead ||
        previous.conversationHead !== conversationHead) {
      const request = { memberId, conversationId, deadline, fresh };
      const access = await chatAccess(options, request);
      state.access = { memberId, memberHead, conversationHead, mode: recordedChatMode(access) };
    }
    const mode = state.access!.mode;
    const result = await chatRows(options, conversationId, mode, state.position);
    await fresh();
    if (socket.readyState !== socket.OPEN) return;
    sendRows(state, result);
  } catch (error) {
    if (isChatRefused(error)) refuse(state);
    else socket.close(1013);
  } finally {
    clearTimeout(watchdog);
    state.running = false;
  }
}

function sendRows(state: Subscription, result: Awaited<ReturnType<typeof chatRows>>) {
  if ((state.position > 0 && state.generation !== result.generation) ||
      state.position > result.position) {
    state.generation = result.generation;
    state.position = 0;
    send(state, 'resync');
    state.socket.close(1013);
    return;
  }
  state.generation = result.generation;
  for (const row of result.rows) {
    if (state.socket.bufferedAmount > 64 * 1024) {
      send(state, 'resync');
      state.socket.close(1013);
      return;
    }
    state.position = row.position;
    const extra = { row };
    send(state, 'event', extra);
  }
  if (!state.ready || state.computerState !== result.computerState) {
    state.computerState = result.computerState;
    const extra = { computerState: state.computerState };
    send(state, 'ready', extra);
    state.ready = true;
  }
}

function send(state: Subscription, type: string, extra = {}) {
  if (state.socket.readyState !== state.socket.OPEN) return;
  const message = {
    version: 1, topic: 'conversation', conversationId: state.conversationId,
    type, position: state.position, generation: state.generation, ...extra,
  };
  state.socket.send(JSON.stringify(message));
}

function refuse(state: Subscription) {
  send(state, 'refused');
  state.socket.close(1008);
}

function validSession(session: SessionData, config: AuthConfig, options: ChatOptions) {
  return session.orgId === config.expectedOrgId && session.exp * 1000 > Date.now() &&
    options.silo === options.binding.silo;
}
