import type { WebSocket } from 'ws';
import type { AuthConfig, SessionData } from '@opencrane/auth';
import { AuthorityApplying } from '@opencrane/models';
import { chatSubscriptionAccess, isChatRefused } from './access.ts';
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
  accessPassed: boolean;
  computerState: string;
  checking: boolean;
  access?: Awaited<ReturnType<typeof chatSubscriptionAccess>>;
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
      generation: requestedGeneration ?? 0, running: false, checking: false,
      ready: false, accessPassed: false, computerState: '',
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

async function pollAccess(state: Subscription): Promise<Mode | undefined> {
  const { socket, options, conversationId, session, config } = state;
  if (state.checking || socket.readyState !== socket.OPEN) return;
  state.checking = true;
  const deadline = performance.now() + 1500;
  function expire() {
    // Leave time for polling and the close handshake inside the two-second removal bound.
    socket.close(1013);
  }
  const watchdog = setTimeout(expire, 1500);
  try {
    if (!validSession(session, config, options)) {
      refuse(state);
      return;
    }
    if (!state.access) {
      const memberId = await options.feed.memberId(options.silo, config.issuerUrl, session.sub);
      if (!memberId) {
        refuse(state);
        return;
      }
      state.access = await chatSubscriptionAccess(options, memberId, conversationId, deadline);
    }
    const mode = await state.access(deadline);
    state.accessPassed = true;
    return mode;
  } catch (error) {
    if (state.accessPassed && error instanceof AuthorityApplying) return;
    if (isChatRefused(error)) refuse(state);
    else socket.close(1013);
    return;
  } finally {
    clearTimeout(watchdog);
    state.checking = false;
  }
}

async function drain(state: Subscription) {
  // Keep checking removals while a slow content read is still waiting.
  const mode = await pollAccess(state);
  if (!mode || state.running || state.socket.readyState !== state.socket.OPEN) return;
  state.running = true;
  try {
    const result = await chatRows(state.options, state.conversationId, mode, state.position);
    if (state.socket.readyState !== state.socket.OPEN) return;
    sendRows(state, result);
  } catch {
    state.socket.close(1013);
  } finally {
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
