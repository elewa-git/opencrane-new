import type { EventEnvelope } from '@opencrane/events';
import { readStreamSummary, type EventStore, type StoredEvent } from '@opencrane/event-store';
import { computerSummary, type ComputerSummary } from '@opencrane/auth';
import { closesDecisionTurn, invalidatesApproval } from './approvals.ts';
import { outputReportTypes, type decisionAuthorityFence } from './authority.ts';
import { data } from './state.ts';
import { managedProviderCallsEnabled } from './provider-turns.ts';
import { decisionChatSummary } from './decision-summary.ts';

const harmlessConversationTypes = [
  'file.uploaded', 'file.rejected', 'file.delivered', 'message.posted', 'agent.turn_started',
  ...outputReportTypes,
];

export async function confirmDecisionAccess(activity: Awaited<ReturnType<typeof decisionActivity>>,
  authority: Awaited<ReturnType<typeof decisionAuthorityFence>>, needsApproval: boolean) {
  while (true) {
    const activityChanged = await activity.confirm(authority.deadline, needsApproval);
    const authorityChanged = await authority();
    if (!activityChanged && !authorityChanged) {
      return;
    }
    // Recheck both because access or turn state can change while harmless events are read.
    // Keep the original deadline so repeated activity cannot extend the check.
  }
}

export async function decisionActivity(store: EventStore, silo: string, assistantId: string,
  conversationId: string, turnId: string, deadline: number) {
  const head = await store.head(undefined, deadline);
  const managedCallsEnabled = await managedProviderCallsEnabled(store, silo, deadline);
  const activity = await readTurnActivity(store, silo, assistantId, conversationId,
    turnId, deadline, head);
  async function confirm(deadline: number, needsApproval: boolean) {
    const enabledNow = await managedProviderCallsEnabled(store, silo, deadline);
    if (enabledNow !== managedCallsEnabled) {
      throw new Error('Provider setup changed');
    }
    return activity.confirm(deadline, needsApproval);
  }
  return { ...activity, confirm, managedCallsEnabled };
}

export async function approvalActivity(store: EventStore, silo: string, assistantId: string,
  conversationId: string, turnId: string, deadline: number) {
  const head = await store.head(undefined, deadline);
  // Check turn and control changes without tying a human decision to unrelated spending history.
  return readTurnActivity(store, silo, assistantId, conversationId, turnId, deadline, head);
}

async function readTurnActivity(store: EventStore, silo: string, assistantId: string,
  conversationId: string, turnId: string, deadline: number, head: number) {
  const conversationSubject = `conversation-${conversationId}`;
  const computerSubject = `computer-${assistantId}`;
  function capturedBeforeCheck(row: StoredEvent) {
    return row.sequence <= head;
  }
  function takeConversation(rows: StoredEvent[], sequence: number) {
    const conversation = rows.filter(capturedBeforeCheck);
    return { conversation, sequence };
  }
  function takeComputer(summary: ComputerSummary, sequence: number) {
    const turn = summary.turns.get(turnId);
    const firstClose = turn?.firstClose;
    return { sequence, control: structuredClone(summary.control), lifecycle: summary.lifecycle,
      firstStart: turn?.firstStart,
      firstClose: firstClose === undefined ? undefined : { ...firstClose } };
  }
  const conversationRead = readStreamSummary(store, silo, conversationSubject,
    decisionChatSummary, deadline, takeConversation);
  const computerRead = readStreamSummary(store, silo, computerSubject,
    computerSummary, deadline, takeComputer);
  const [chat, computer] = await Promise.all([conversationRead, computerRead]);
  const subjectHeads = [store.head(conversationSubject, deadline, true),
    store.head(computerSubject, deadline)] as const;
  const [conversationHead, computerHead] = await Promise.all(subjectHeads);
  // Refuse saved facts beyond restored history. Keep the original shared deadline.
  if (conversationHead < chat.sequence || computerHead < computer.sequence) {
    throw new Error('Authority changed');
  }
  const conversation = chat.conversation;
  const positions = new Map<string, number>();
  const subjects = [conversationSubject, computerSubject];

  async function confirm(deadline: number, needsApproval: boolean) {
    // Read only activity saved since the histories above. Never replay a long chat
    // inside the short access check. Keep these positions within this request only.
    let foundNewRows = false;
    for (const subject of subjects) {
      const from = (positions.get(subject) ?? head) + 1;
      const includeConversationCloses = subject === conversationSubject;
      const to = await store.head(subject, deadline, includeConversationCloses);
      if (to < from) continue;
      for await (const row of store.readStream(subject, from, deadline, includeConversationCloses)) {
        if (row.sequence > to) break;
        const changed = changesDecisionActivity(row.event, turnId, needsApproval);
        if (changed) throw new Error('Authority changed');
      }
      positions.set(subject, to);
      foundNewRows = true;
    }
    return foundNewRows;
  }
  return { conversation, computer, confirm };
}

function changesDecisionActivity(event: EventEnvelope, turnId: string, needsApproval: boolean) {
  if (event.subject.startsWith('computer-')) {
    const turnActivity = ['computer.turn_started', 'computer.turn_closed'].includes(event.type);
    return !turnActivity || data(event)['turnId'] === turnId;
  }
  if (event.subject.startsWith('participation-')) {
    return event.type === 'conversation.closed';
  }
  if (needsApproval && invalidatesApproval(event, turnId)) return true;
  if (closesDecisionTurn(event, turnId)) return true;
  if (harmlessConversationTypes.includes(event.type)) return false;
  const olderTurnEnded = [
    'agent.turn_completed', 'agent.turn_failed', 'agent.turn_stop_requested',
  ].includes(event.type);
  return !olderTurnEnded;
}
