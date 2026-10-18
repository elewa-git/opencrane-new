import type { EventEnvelope } from '@opencrane/events';
import { readStreamSummary, type EventStore, type StoredEvent } from '@opencrane/event-store';
import { computerSummary, type ComputerSummary } from '@opencrane/auth';
import { closesDecisionTurn, invalidatesApproval } from './approvals.ts';
import { outputReportTypes, type decisionAuthorityFence } from './authority.ts';
import { data } from './state.ts';
import { managedProviderCallsEnabled } from './provider-turns.ts';
import { decisionProvider } from './decision-provider.ts';
import { decisionChatSummary } from './decision-summary.ts';

const harmlessConversationTypes = [
  'file.uploaded', 'file.rejected', 'file.delivered', 'message.posted', 'agent.turn_started',
  ...outputReportTypes,
];

export async function confirmDecisionAccess(
  activity: Pick<Awaited<ReturnType<typeof decisionActivity>>, 'confirm'>,
  authority: Awaited<ReturnType<typeof decisionAuthorityFence>>, needsApproval: boolean,
  refuseMemoryLoads = false) {
  while (true) {
    const activityChanged = await activity.confirm(authority.deadline, needsApproval, refuseMemoryLoads);
    const authorityChanged = await authority();
    if (!activityChanged && !authorityChanged) {
      return;
    }
    // Recheck both because access or turn state can change while harmless events are read.
    // Keep the original deadline so repeated activity cannot extend the check.
  }
}

export async function decisionActivity(store: EventStore, silo: string, assistantId: string,
  conversationId: string, turnId: string, deadline: number,
  choice?: { providerId: string; model: string }) {
  const head = await store.head(undefined, deadline);
  const managedCallsEnabled = await managedProviderCallsEnabled(store, silo, deadline);
  const activity = await readTurnActivity(store, silo, assistantId, conversationId,
    turnId, deadline, head);
  const provider = choice === undefined ? undefined
    : await decisionProvider(store, silo, choice, deadline, head);
  async function confirm(deadline: number, needsApproval: boolean, refuseMemoryLoads = false) {
    const enabledNow = await managedProviderCallsEnabled(store, silo, deadline);
    if (enabledNow !== managedCallsEnabled) {
      throw new Error('Provider setup changed');
    }
    const providerChanged = await provider?.confirm(deadline);
    const activityChanged = await activity.confirm(deadline, needsApproval, refuseMemoryLoads);
    return activityChanged || providerChanged === true;
  }
  const providerFacts = provider === undefined ? {} : { provider };
  return { ...activity, confirm, managedCallsEnabled, ...providerFacts };
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

  async function confirm(deadline: number, needsApproval: boolean, refuseMemoryLoads = false) {
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
        const changed = changesDecisionActivity(row.event, turnId, needsApproval, refuseMemoryLoads);
        if (changed) throw new Error('Authority changed');
      }
      positions.set(subject, to);
      foundNewRows = true;
    }
    return foundNewRows;
  }
  return { conversation, computer, confirm };
}

function changesDecisionActivity(event: EventEnvelope, turnId: string, needsApproval: boolean,
  refuseMemoryLoads = false) {
  if (event.subject.startsWith('computer-')) {
    const turnActivity = ['computer.turn_started', 'computer.turn_closed'].includes(event.type);
    return !turnActivity || data(event)['turnId'] === turnId;
  }
  if (event.subject.startsWith('participation-')) {
    return event.type === 'conversation.closed';
  }
  if (needsApproval && invalidatesApproval(event, turnId)) return true;
  if (closesDecisionTurn(event, turnId)) return true;
  if (event.type === 'agent.memory_context_recorded') {
    const fields = data(event);
    // Refuse old passes when a recall adds references after their history was read.
    const terminal = fields['action'] === 'invalidated' || fields['action'] === 'ended';
    return (terminal || refuseMemoryLoads) && fields['turnId'] === turnId;
  }
  if (harmlessConversationTypes.includes(event.type)) return false;
  const olderTurnEnded = [
    'agent.turn_completed', 'agent.turn_failed', 'agent.turn_stop_requested',
  ].includes(event.type);
  return !olderTurnEnded;
}

export function decisionHistoryDeadline(managedRoute: boolean, decisionDeadline: number) {
  if (managedRoute) {
    return performance.now() + 10_000;
  }
  return decisionDeadline;
}

export function decisionAccessStarted(managedRoute: boolean, loadedMemory: boolean, started: number) {
  if (managedRoute || loadedMemory) {
    return performance.now();
  }
  return started;
}

export function requireActiveConversationTurn(conversation: StoredEvent[], turnId: string) {
  function closesCurrentTurn(row: StoredEvent) {
    return closesDecisionTurn(row.event, turnId);
  }
  if (conversation.some(closesCurrentTurn)) throw new Error('Turn is not active');
}
