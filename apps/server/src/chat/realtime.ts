import type { WebSocket } from 'ws';
import { isOrganisationSession, type AuthConfig, type SessionData } from '@opencrane/auth';
import { chatMessageSchema, type ChatRow } from '@opencrane/protocol';
import { AuthorityApplying } from '@opencrane/models';
import { chatSubscriptionAccess, isChatRefused } from './access.ts';
import { chatRows } from './history.ts';
import type { ChatOptions } from './access.ts';

type Mode = 'agent_session' | 'direct' | 'group';
interface Subscription {
  socket: WebSocket;
  session: SessionData;
  config: AuthConfig;
  options: ChatOptions;
  conversationId: string;
  position: number;
  generation: number;
  computerPosition?: number;
  mode?: Mode;
  running: boolean;
  ready: boolean;
  accessPassed: boolean;
  computerState: Awaited<ReturnType<typeof chatRows>>['computerState'] | '';
  computerRecovered: boolean;
  computerLostAt: string | undefined;
  checking: boolean;
  joinPosition?: number;
  accessVersion?: number;
  applyingSince?: number;
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
      ready: false, accessPassed: false, computerState: '', computerRecovered: false,
      computerLostAt: undefined,
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
    const access = await state.access(deadline);
    state.joinPosition = access.historyPosition;
    state.accessVersion = access.accessPosition;
    const mode = access.mode;
    state.accessPassed = true;
    delete state.applyingSince;
    return mode;
  } catch (error) {
    if (state.accessPassed && error instanceof AuthorityApplying) {
      closeAfterLongApplyWait(state);
      return;
    }
    if (isChatRefused(error)) refuse(state);
    else socket.close(1013);
    return;
  } finally {
    clearTimeout(watchdog);
    state.checking = false;
  }
}

function closeAfterLongApplyWait(state: Subscription) {
  const now = performance.now();
  if (state.applyingSince === undefined) {
    state.applyingSince = now;
    return;
  }
  if (now - state.applyingSince >= 5000) state.socket.close(1013);
}

async function drain(state: Subscription) {
  // Keep checking removals while a slow content read is still waiting.
  const mode = await pollAccess(state);
  if (!mode || state.running || state.socket.readyState !== state.socket.OPEN) return;
  state.running = true;
  try {
    const position = await conversationPosition(state.options, state.conversationId, mode);
    if (state.ready && state.mode === mode && state.position === position.position &&
        state.generation === position.generation &&
        state.computerPosition === position.computerPosition) {
      return;
    }
    while (state.socket.readyState === state.socket.OPEN) {
      const version = state.accessVersion;
      const result = await chatRows(state.options, state.conversationId, mode, state.position,
        state.joinPosition);
      const stops = await visibleBudgetStops(state, result.rows);
      const confirmed = await pollAccess(state);
      if (!confirmed || version !== state.accessVersion) return;
      if (state.socket.readyState !== state.socket.OPEN) return;
      state.mode = mode;
      state.computerPosition = position.computerPosition;
      sendRows(state, result, stops);
      if (result.rows.length < 100) return;
    }
  } catch {
    state.socket.close(1013);
  } finally {
    state.running = false;
  }
}

async function conversationPosition(options: ChatOptions, conversationId: string, mode: Mode) {
  const result = await options.db.query<{
    position: string | null; generation: string | null; computer_position: string | null;
  }>(
    `SELECT (SELECT max(position) FROM conversation_feed
        WHERE silo = $1 AND conversation_id = $2) AS position,
      (SELECT generation FROM projection_generations WHERE name = 'conversations') AS generation,
      (SELECT c.position FROM computers c JOIN conversation_feed f
        ON f.silo = c.silo AND f.data->>'assistantId' = c.assistant_id
        WHERE f.silo = $1 AND f.conversation_id = $2 AND f.type = 'conversation.created')
        AS computer_position`,
    [options.silo, conversationId]);
  return {
    position: Number(result.rows[0]?.position ?? 0),
    generation: Number(result.rows[0]?.generation ?? 0),
    computerPosition: mode === 'agent_session'
      ? Number(result.rows[0]?.computer_position ?? 0)
      : 0,
  };
}

function isBudgetStop(row: ChatRow) {
  return row.type === 'agent.turn_stop_requested' && row.data.reason === 'budget';
}

async function visibleBudgetStops(state: Subscription, rows: ChatRow[]) {
  const stops = rows.filter(isBudgetStop);
  const turns: string[] = [];
  for (const stop of stops) {
    if (stop.data.turnId) turns.push(stop.data.turnId);
  }
  const visible = new Set<string>();
  if (turns.length === 0) return visible;
  // Load original turn positions before checking access again. A later Stop must
  // not reveal a request from before this person's visible history.
  const result = await state.options.db.query<{
    event_id: string; position: string; author_kind: string;
  }>(
    `SELECT event_id, position, data->>'authorKind' AS author_kind
      FROM conversation_feed WHERE silo = $1 AND conversation_id = $2
      AND type = 'message.posted' AND event_id = ANY($3::text[])`,
    [state.options.silo, state.conversationId, turns]);
  for (const row of result.rows) {
    if (row.author_kind === 'human' && Number(row.position) >= (state.joinPosition ?? 0)) {
      visible.add(row.event_id);
    }
  }
  return visible;
}

function sendRows(state: Subscription, result: Awaited<ReturnType<typeof chatRows>>,
  visibleStops: Set<string>) {
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
    sendRow(state, row, visibleStops);
  }
  if (result.rows.length === 100) return;
  // All rows through this boundary were scanned, including hidden late reports.
  state.position = result.position;
  if (!state.ready || state.computerState !== result.computerState ||
      state.computerRecovered !== result.computerRecovered ||
      state.computerLostAt !== result.computerLostAt) {
    state.computerState = result.computerState;
    state.computerRecovered = result.computerRecovered;
    state.computerLostAt = result.computerLostAt;
    const extra = { computerState: state.computerState, computerRecovered: state.computerRecovered,
      computerLostAt: state.computerLostAt };
    send(state, 'ready', extra);
    state.ready = true;
  }
}

function sendRow(state: Subscription, row: ChatRow, visibleStops: Set<string>) {
  const budgetStop = isBudgetStop(row);
  const turnId = row.data.turnId;
  if (budgetStop && (!turnId || !visibleStops.has(turnId))) return;
  const extra = { row };
  send(state, 'event', extra);
  if (budgetStop) {
    const notification = { turnId };
    send(state, 'budget_stop', notification);
  }
}

function send(state: Subscription, type: string, extra = {}) {
  if (state.socket.readyState !== state.socket.OPEN) return;
  const message = {
    version: 1, topic: 'conversation', conversationId: state.conversationId,
    type, position: state.position, generation: state.generation, ...extra,
  };
  const checked = chatMessageSchema.parse(message);
  state.socket.send(JSON.stringify(checked));
}

function refuse(state: Subscription) {
  send(state, 'refused');
  state.socket.close(1008);
}

function validSession(session: SessionData, config: AuthConfig, options: ChatOptions) {
  return isOrganisationSession(config, session) && session.exp * 1000 > Date.now() &&
    options.silo === options.binding.silo;
}
