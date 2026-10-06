import { z } from 'zod';
import type { Logger } from '@opencrane/observability';
import { history } from '../../../ops/src/lifecycle.ts';
import { creationEvent } from './private-session.ts';
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
const assistantKindData = z.object({ kind: z.enum(['personal', 'team']) });

export function assistantProcessor(options: WatchOptions, tokens: Tokens, refused: Set<string>,
  connection: Parameters<typeof processConversation>[5],
  connectionId: (assistantId: string) => number | undefined, logger: Logger) {
  const seen = new Map<string, Progress>();
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

  async function snapshot(assistantId: string) {
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

  async function process(conversation: AgentSession, assistant: Snapshot,
    computerHistoryUnavailable = false) {
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
        assistant, refused, connection, computerHistoryUnavailable);
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
    function processSession(conversation: AgentSession) {
      return process(conversation, assistant, computerHistoryUnavailable);
    }
    const processing = sessions.map(processSession);
    const results = await Promise.all(processing);
    return results.includes(true);
  }

  function forgetMissing(sessions: AgentSession[]) {
    const conversationIds = new Set<string>();
    const assistantIds = new Set<string>();
    for (const session of sessions) {
      conversationIds.add(session.conversationId);
      assistantIds.add(session.assistantId);
    }
    for (const conversationId of seen.keys()) {
      if (!conversationIds.has(conversationId)) seen.delete(conversationId);
    }
    for (const assistantId of snapshots.keys()) {
      if (!assistantIds.has(assistantId)) snapshots.delete(assistantId);
    }
  }

  return { processAssistant, forgetMissing };
}
