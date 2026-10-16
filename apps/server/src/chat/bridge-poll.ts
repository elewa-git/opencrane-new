import { z } from 'zod';
import { setTimeout as delay } from 'node:timers/promises';
import { readComputerControl } from '@opencrane/auth';
import type { bridgeControl } from './bridge-control.ts';
import type { Logger } from '@opencrane/observability';
import { history } from '../../../ops/src/lifecycle.ts';
import { creationEvent } from './private-session.ts';
import { chatHistory } from './commands.ts';
import { agentSession } from './reports.ts';
import { pendingBudgetStops, sendBudgetStops } from './bridge-budget-stops.ts';
import {
  assistantSnapshot, processConversation, type ConversationProgress,
  type WatchOptions, type AgentSession,
} from './bridge-conversation.ts';

type Tokens = Parameters<typeof processConversation>[1];
type Snapshot = ReturnType<typeof assistantSnapshot>;
type Progress = ConversationProgress & {
  head: number;
  computerEventId: string | undefined;
  kind: string | undefined;
};
type ConversationLink = Awaited<ReturnType<Parameters<typeof processConversation>[5]>>;
type Connection = (computerId: string, assistantId: string) =>
  Promise<ConversationLink & { control: ReturnType<typeof bridgeControl> }>;
const computerData = z.object({ computerId: z.string() });
const assistantKindData = z.object({ kind: z.enum(['personal', 'team']) });

export function assistantProcessor(options: WatchOptions, tokens: Tokens, refused: Set<string>,
  connection: Connection,
  connectionId: (assistantId: string) => number | undefined, logger: Logger) {
  const seen = new Map<string, Progress>();
  let watchedAssistants = new Set<string>();
  const readingSnapshots = new Map<string, Promise<Snapshot>>();
  const kinds = new Map<string, string>();
  const snapshots = new Map<string, { head: number; assistant: Snapshot }>();
  const creationReadFailures = new Set<string>();
  const computerHistoryReadFailures = new Set<string>();

  function recordReadFailure(failures: Set<string>, assistantId: string, error: unknown,
    message: string) {
    if (failures.has(assistantId)) return;
    failures.add(assistantId);
    const details = { err: error, assistantId };
    logger.error(details, message);
  }

  async function readSnapshot(assistantId: string) {
    let kind = kinds.get(assistantId);
    if (!kind) {
      try {
        const created = await creationEvent(options.store, options.silo,
          `assistant-${assistantId}`, 'assistant.created');
        const details = assistantKindData.parse(created.data);
        kind = details.kind;
        kinds.set(assistantId, kind);
        creationReadFailures.delete(assistantId);
      } catch (error) {
        recordReadFailure(creationReadFailures, assistantId, error,
          'Assistant creation unavailable; waiting for a later check');
      }
    }
    const subject = `computer-${assistantId}`;
    const head = await options.store.head(subject);
    const previous = snapshots.get(assistantId);
    if (previous?.head === head) {
      computerHistoryReadFailures.delete(assistantId);
      if (previous.assistant.kind === kind) return previous.assistant;
      const assistant = { ...previous.assistant, kind };
      const cached = { head, assistant };
      snapshots.set(assistantId, cached);
      return assistant;
    }
    const lifecycle = await history(options.store, subject);
    computerHistoryReadFailures.delete(assistantId);
    const assistant = assistantSnapshot(lifecycle, kind, options.silo);
    // Save the earlier position so events arriving during the read get another pass.
    const cached = { head, assistant };
    snapshots.set(assistantId, cached);
    return assistant;
  }

  function snapshot(assistantId: string) {
    const reading = readingSnapshots.get(assistantId);
    if (reading) return reading;
    function finished() {
      readingSnapshots.delete(assistantId);
    }
    // Share computer reads between the independent gate and conversation checks.
    const pending = readSnapshot(assistantId).finally(finished);
    readingSnapshots.set(assistantId, pending);
    return pending;
  }

  async function process(conversation: AgentSession, assistant: Snapshot,
    computerHistoryUnavailable = false, checkControl?: () => Promise<boolean>) {
    try {
      const conversationId = conversation.conversationId;
      const head = await options.store.head(`conversation-${conversationId}`);
      const previous = seen.get(conversationId);
      const linkClosed = previous?.connectionId !== undefined &&
        previous.connectionId !== connectionId(conversation.assistantId);
      const computerEventId = assistant.current?.id;
      const sameComputer = previous?.computerEventId === computerEventId;
      const sameKind = previous?.kind === assistant.kind;
      if (!computerHistoryUnavailable && previous?.head === head && sameComputer && sameKind &&
        !previous.retry && !linkClosed) {
        return previous.pending;
      }
      const result = await processConversation(options, tokens, conversation,
        assistant, refused, connection, computerHistoryUnavailable, checkControl);
      const progress = { ...result, head, computerEventId, kind: assistant.kind };
      seen.set(conversationId, progress);
      return result.pending;
    } catch {
      // Retry after a failed read even when no new event arrives.
      return true;
    }
  }

  async function processAssistant(sessions: AgentSession[]) {
    const assistantId = sessions[0]!.assistantId;
    let assistant: Snapshot;
    let computerHistoryUnavailable = false;
    try {
      assistant = await snapshot(assistantId);
    } catch (error) {
      computerHistoryUnavailable = true;
      recordReadFailure(computerHistoryReadFailures, assistantId, error,
        'Assistant computer history unavailable; waiting for a later check');
      // Read the chats to find waiting messages, without sending to an unknown computer.
      assistant = assistantSnapshot([], kinds.get(assistantId), options.silo);
    }
    async function checkControl() {
      // Check the position again after slow reads; reuse history until the computer changes.
      const current = await snapshot(assistantId);
      return current.controlPending;
    }
    function processSession(conversation: AgentSession) {
      return process(conversation, assistant, computerHistoryUnavailable, checkControl);
    }
    const processing = sessions.map(processSession);
    const results = await Promise.all(processing);
    return results.includes(true);
  }

  async function processControl(assistantId: string) {
    const assistant = await snapshot(assistantId);
    if (assistant.controlPending && assistant.current?.type === 'computer.ready') {
      const computer = computerData.parse(assistant.current.data);
      const control = await readComputerControl(options.store, options.silo, assistantId);
      if (control?.phase === 'requested' && !refused.has(computer.computerId)) {
        const link = await connection(computer.computerId, assistantId);
        await link.control.send();
      }
    }
  }

  async function pollStops(sessions: AgentSession[]) {
    try {
      const assistantId = sessions[0]!.assistantId;
      const assistant = await snapshot(assistantId);
      if (!assistant.kind || assistant.current?.type !== 'computer.ready') return;
      const computer = computerData.parse(assistant.current.data);
      if (refused.has(computer.computerId)) return;
      async function sendStops(conversation: AgentSession) {
        const head = await options.store.head(`conversation-${conversation.conversationId}`);
        const previous = seen.get(conversation.conversationId);
        if (previous?.head === head && !previous.retry) return;
        const rows = await chatHistory(options.store, options.silo, conversation.conversationId);
        agentSession(rows);
        function isClosed(row: typeof rows[number]) {
          return row.event.type === 'conversation.closed';
        }
        if (rows.some(isClosed)) return;
        const stops = pendingBudgetStops(rows, assistant.closed);
        if (!stops.length) return;
        const link = await connection(computer.computerId, assistantId);
        sendBudgetStops(link, stops);
      }
      const sending = sessions.map(sendStops);
      await Promise.all(sending);
    } catch {
      // Leave saved Stops for the next poll when history or the connection is unavailable.
    }
  }

  async function watchControls(signal: AbortSignal) {
    const checking = new Map<string, Promise<void>>();
    function failed() {
      logger.warn('Bridge control check unavailable; retrying next poll');
    }
    function start(assistantId: string) {
      if (checking.has(assistantId)) return;
      function finished() {
        checking.delete(assistantId);
      }
      const checked = processControl(assistantId).catch(failed);
      checking.set(assistantId, checked.finally(finished));
    }
    try {
      while (!signal.aborted) {
        for (const assistantId of watchedAssistants) start(assistantId);
        await delay(250, undefined, { signal });
      }
    } catch (error) {
      if (!signal.aborted) throw error;
    } finally {
      await Promise.all(checking.values());
    }
  }

  function forgetMissing(sessions: AgentSession[]) {
    const conversationIds = new Set<string>();
    const assistantIds = new Set<string>();
    for (const session of sessions) {
      conversationIds.add(session.conversationId);
      assistantIds.add(session.assistantId);
    }
    watchedAssistants = assistantIds;
    for (const conversationId of seen.keys()) {
      if (!conversationIds.has(conversationId)) seen.delete(conversationId);
    }
    for (const assistantId of snapshots.keys()) {
      if (!assistantIds.has(assistantId)) snapshots.delete(assistantId);
    }
  }

  return { processAssistant, pollStops, watchControls, forgetMissing };
}
