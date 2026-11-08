import { pendingBudgetStops, sendBudgetStops } from './bridge-budget-stops.ts';
import type { EventStore } from '@opencrane/event-store';
import { toolApprovalRequestedDataSchema } from '@opencrane/events';
import { history, readApproval, readOriginalCallStatus } from '@opencrane/models';
import { WebSocket } from 'ws';
import { z } from 'zod';

const waitingSchema = z.object({
  type: z.literal('approval_waiting'),
  approvalId: z.string().regex(/^[a-f0-9]{64}$/u),
  conversationId: z.string().min(1).max(200),
  turnId: z.string().min(1).max(200),
}).strict();
type Waiting = z.infer<typeof waitingSchema> & {
  approvalHead?: number;
  computerHead?: number;
  conversationHead?: number;
  participationHead?: number;
  policyHead?: number;
  serverId?: string;
  overallHead?: number;
  retryAt?: number;
  retryDelay?: number;
  expiresAt?: number;
  pending?: Promise<void> | undefined;
  outcomeSent?: boolean;
};

function matchesRequest(request: z.infer<typeof toolApprovalRequestedDataSchema>,
  entry: Waiting, assistantId: string) {
  return request.approvalId === entry.approvalId && request.assistantId === assistantId &&
    request.conversationId === entry.conversationId && request.turnId === entry.turnId;
}

function isSavedRetry(last: { type: string; source: string } | undefined,
  state: string) {
  return last?.type === 'approval.retry_requested' &&
    last.source === 'opencrane-server' && state === 'approved';
}

function shouldRead(entry: Waiting, positions: {
  approvalHead: number; computerHead: number; conversationHead: number;
  participationHead: number; policyHead: number | undefined;
}) {
  const expired = entry.expiresAt !== undefined && Date.now() >= entry.expiresAt;
  return entry.approvalHead !== positions.approvalHead ||
    entry.computerHead !== positions.computerHead ||
    entry.conversationHead !== positions.conversationHead ||
    entry.participationHead !== positions.participationHead ||
    entry.policyHead !== positions.policyHead || expired;
}

function rememberPositions(entry: Waiting, positions: {
  approvalHead: number; computerHead: number; conversationHead: number;
  participationHead: number; policyHead: number;
}, expiresAt: string) {
  entry.approvalHead = positions.approvalHead;
  entry.computerHead = positions.computerHead;
  entry.conversationHead = positions.conversationHead;
  entry.participationHead = positions.participationHead;
  entry.policyHead = positions.policyHead;
  entry.expiresAt = Date.parse(expiresAt);
}

async function hasSavedNonDispatch(store: EventStore, silo: string,
  entry: Waiting, deadline: number) {
  const original = await readOriginalCallStatus(store, silo, entry.approvalId,
    undefined, deadline);
  const attempt = original.status.attempts[0];
  return original.conversationId === entry.conversationId &&
    original.status.turnId === entry.turnId &&
    Date.parse(original.status.expiresAt) > Date.now() &&
    original.status.attempts.length === 1 &&
    attempt?.outcome === 'not_dispatched' &&
    (attempt.evidence === 'connection_refused' ||
      attempt.evidence === 'adapter_dispatch_refused');
}

export function bridgeApprovals(store: EventStore, silo: string, assistantId: string,
  socket: Pick<WebSocket, 'readyState' | 'send'>, sentStops = new Map<string, number>(),
  beforeSettlement?: () => Promise<void>) {
  const waiting = new Map<string, Waiting>();

  function receive(value: unknown) {
    if (typeof value !== 'object' || value === null || !('type' in value)
      || value.type !== 'approval_waiting') return false;
    const parsed = waitingSchema.safeParse(value);
    // Treat a signal as a hint to read events. It cannot supply an approval decision.
    if (!parsed.success || waiting.has(parsed.data.approvalId)) return true;
    if (waiting.size >= 64) {
      sendSettlement(parsed.data.approvalId, 'outcome_unknown');
      return true;
    }
    waiting.set(parsed.data.approvalId, parsed.data);
    return true;
  }

  function sendSettlement(approvalId: string, state: string) {
    if (socket.readyState !== WebSocket.OPEN) return;
    const signal = { type: 'approval_settled', approvalId, state };
    socket.send(JSON.stringify(signal));
  }

  async function keepUncertain(entry: Waiting, deadline: number, positions: {
    approvalHead: number; computerHead: number; conversationHead: number;
    participationHead: number; policyHead: number;
  }, expiresAt: string) {
    if (!entry.outcomeSent) {
      await sendSavedStop(entry, deadline);
      sendSettlement(entry.approvalId, 'outcome_unknown');
      entry.outcomeSent = true;
    }
    // Release the watch at its original deadline. Unknown dispatch stays saved.
    if (Date.parse(expiresAt) <= Date.now()) {
      waiting.delete(entry.approvalId);
      return;
    }
    rememberPositions(entry, positions, expiresAt);
  }

  async function check(entry: Waiting) {
    const deadline = performance.now() + 10_000;
    const subject = `approval-${entry.approvalId}`;
    const approvalHead = await store.head(subject, deadline);
    const computerHead = await store.head(`computer-${assistantId}`, deadline);
    const conversationHead = await store.head(`conversation-${entry.conversationId}`, deadline);
    const participationHead = await store.head(`participation-${entry.conversationId}`, deadline);
    let policyHead: number | undefined;
    if (entry.serverId !== undefined) {
      policyHead = await store.head(`mcp-${entry.serverId}`, deadline);
    }
    const beforeRead = { approvalHead, computerHead, conversationHead,
      participationHead, policyHead };
    if (!shouldRead(entry, beforeRead)) return;
    const rows = await history(store, subject, silo, deadline);
    if (rows.length === 0) {
      waiting.delete(entry.approvalId);
      sendSettlement(entry.approvalId, 'outcome_unknown');
      return;
    }
    const request = toolApprovalRequestedDataSchema.parse(rows[0]?.event.data);
    // Check ownership before the reader can cancel or expire an unrelated approval.
    if (!matchesRequest(request, entry, assistantId)) {
      waiting.delete(entry.approvalId);
      return;
    }
    entry.serverId = request.serverId;
    const checkedPolicyHead = policyHead ?? await store.head(`mcp-${request.serverId}`, deadline);
    const result = await readApproval(store, silo, entry.approvalId, { deadline });
    if (socket.readyState !== WebSocket.OPEN) return;
    const last = rows.at(-1)?.event;
    if (isSavedRetry(last, result.state)) {
      if (!await hasSavedNonDispatch(store, silo, entry, deadline)) {
        waiting.delete(entry.approvalId);
        return;
      }
      await sendCheckedSettlement(entry, 'retry', computerHead, deadline);
      return;
    }
    const positions = { approvalHead, computerHead, conversationHead,
      participationHead, policyHead: checkedPolicyHead };
    if (result.state === 'outcome_unknown') {
      await keepUncertain(entry, deadline, positions, request.expiresAt);
      return;
    }
    if (result.state !== 'requested') {
      await sendCheckedSettlement(entry, result.state, computerHead, deadline);
      return;
    }
    // Keep the positions from before the read, so a concurrent change gets another look.
    rememberPositions(entry, positions, request.expiresAt);
  }

  async function sendCheckedSettlement(entry: Waiting, state: string,
    computerHead: number, deadline: number) {
    await sendSavedStop(entry, deadline);
    await beforeSettlement?.();
    // Retry if control changed during the read or gate delivery, before sending any wake.
    if (await store.head(`computer-${assistantId}`, deadline) !== computerHead) return;
    sendSettlement(entry.approvalId, state);
    waiting.delete(entry.approvalId);
  }

  async function sendSavedStop(entry: Waiting, deadline: number) {
    // Check after approval reads: a Stop may have been saved while they were waiting.
    const rows = await history(store, `conversation-${entry.conversationId}`, silo, deadline);
    const stops = pendingBudgetStops(rows, new Set());
    function isWaitingTurn(stop: typeof stops[number]) {
      return stop.turnId === entry.turnId;
    }
    const matchingStops = stops.filter(isWaitingTurn);
    if (socket.readyState !== WebSocket.OPEN) return;
    const link = { socket, sentStops };
    sendBudgetStops(link, matchingStops);
  }

  function start(entry: Waiting, overallHead: number) {
    if (entry.pending) return;
    const now = Date.now();
    if (entry.retryAt !== undefined) {
      if (now < entry.retryAt) return;
    } else {
      const expiryDue = entry.expiresAt !== undefined && now >= entry.expiresAt;
      if (entry.overallHead === overallHead && !expiryDue) return;
    }
    function retryLater() {
      // Space out unavailable reads per approval, even while unrelated events keep arriving.
      const delay = entry.retryDelay ?? 1000;
      entry.retryAt = Date.now() + delay;
      entry.retryDelay = Math.min(delay * 2, 30_000);
    }
    function checkedSuccessfully() {
      // Keep the earlier position so a change during the read gets another check.
      entry.overallHead = overallHead;
      delete entry.retryAt;
      delete entry.retryDelay;
    }
    function finished() {
      entry.pending = undefined;
    }
    const checked = check(entry);
    const handled = checked.then(checkedSuccessfully, retryLater);
    entry.pending = handled.finally(finished);
  }

  function poll(overallHead: number) {
    if (socket.readyState !== WebSocket.OPEN) {
      waiting.clear();
      return;
    }
    // Start each read independently. A slow approval must not hold up reports or other chats.
    for (const entry of waiting.values()) start(entry, overallHead);
  }

  async function settled() {
    const pending: Promise<void>[] = [];
    for (const entry of waiting.values()) {
      if (entry.pending) pending.push(entry.pending);
    }
    await Promise.all(pending);
  }

  return { receive, poll, settled, get size() { return waiting.size; } };
}
