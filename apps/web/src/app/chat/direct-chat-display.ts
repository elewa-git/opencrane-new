import { chatMessageSchema, chatRowSchema, type ChatConversation, type ChatRow }
  from '@opencrane/protocol';
import type { Colleague, ReviewedSnapshot } from './recipient-picker';

export type DirectUpdate =
  | { kind: 'ignore' }
  | { kind: 'access_changed' }
  | { kind: 'reload' }
  | { kind: 'invalid' }
  | { kind: 'append'; row: ChatRow };

export function directSubscription(conversationId: string, position: number,
  generation: number) {
  return {
    type: 'subscribe' as const, topic: 'conversation' as const, conversationId,
    since: position, generation,
  };
}

export function readDirectUpdate(
  raw: unknown, conversationId: string, generation: number, position: number,
): DirectUpdate {
  const parsed = chatMessageSchema.safeParse(raw);
  if (!parsed.success || parsed.data.conversationId !== conversationId) {
    return { kind: 'ignore' };
  }
  if (parsed.data.type === 'refused') return { kind: 'access_changed' };
  if (parsed.data.type === 'resync' || parsed.data.generation !== generation) {
    return { kind: 'reload' };
  }
  if (parsed.data.type !== 'event' || !parsed.data.row) return { kind: 'ignore' };
  const row = chatRowSchema.safeParse(parsed.data.row);
  if (!row.success) return { kind: 'invalid' };
  if (row.data.position <= position) return { kind: 'ignore' };
  if (row.data.position !== position + 1) return { kind: 'reload' };
  return { kind: 'append', row: row.data };
}

export function directConversations(rows: ChatConversation[]): ChatConversation[] {
  const direct: ChatConversation[] = [];
  for (const row of rows) {
    if (row.mode === 'direct' || row.mode === 'group') direct.push(row);
  }
  return direct;
}

function isFocusedControl(activeElement: Element | null, control: HTMLElement): boolean {
  return control === activeElement;
}

export function trapDirectDialogFocus(
  panel: HTMLElement, event: KeyboardEvent, enabled: boolean,
): void {
  if (!enabled || event.key !== 'Tab') return;
  const controls = panel.querySelectorAll<HTMLElement>(
    'a[href], button:not([disabled]), input:not([disabled]), [tabindex="0"]',
  );
  const focusableControls = Array.from(controls);
  const first = focusableControls[0];
  const last = focusableControls.at(-1);
  if (!first || !last) {
    event.preventDefault();
    return;
  }
  const activeIndex = focusableControls.findIndex(isFocusedControl.bind(
    null, document.activeElement));
  if (event.shiftKey && activeIndex <= 0) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey
    && (activeIndex === focusableControls.length - 1 || activeIndex === -1)) {
    event.preventDefault();
    first.focus();
  }
}

function isDifferentParticipant(participantId: string, candidateId: string): boolean {
  return candidateId !== participantId;
}

export function directConversationsAfterParticipantEvent(
  rows: ChatConversation[], conversationId: string, row: ChatRow,
): ChatConversation[] {
  const participantId = row.data['participantId'];
  if (typeof participantId !== 'string') return rows;
  const participantMemberId = participantId;
  function updateConversation(conversation: ChatConversation): ChatConversation {
    if (conversation.conversationId !== conversationId
      || (conversation.mode !== 'group' && conversation.mode !== 'direct')) return conversation;
    const participantIds = conversation.participantIds.filter(isDifferentParticipant.bind(
      null, participantMemberId));
    if (row.type === 'participant.added') participantIds.push(participantMemberId);
    return { ...conversation, participantIds };
  }
  return rows.map(updateConversation);
}

export function otherParticipant(participantIds: string[], memberId: string): string | undefined {
  for (const participantId of participantIds) {
    if (participantId !== memberId) return participantId;
  }
  return undefined;
}

export function directConversationById(
  rows: ChatConversation[], conversationId: string,
): ChatConversation | undefined {
  for (const row of rows) {
    if ((row.mode === 'direct' || row.mode === 'group')
      && row.conversationId === conversationId) return row;
  }
  return undefined;
}

export function directColleagueById<T extends { memberId: string }>(
  rows: T[], memberId: string,
): T | undefined {
  for (const row of rows) {
    if (row.memberId === memberId) return row;
  }
  return undefined;
}

export function directReceivedMessageNotice(
  row: ChatRow, memberId: string, conversation: ChatConversation | undefined,
  colleague: Colleague | undefined, colleagues: Colleague[],
): string | undefined {
  if (row.type !== 'message.posted' || directIsOwnMessage(row, memberId)) return undefined;
  const authorName = conversation?.mode === 'group'
    ? groupAuthorName(row, memberId, colleagues)
    : directRecipientName(colleague);
  return `New message from ${authorName}`;
}

export function directMessageText(row: ChatRow): string {
  if (row.type !== 'message.posted') return '';
  return typeof row.data['text'] === 'string' ? row.data['text'] : '';
}

export function directIsOwnMessage(row: ChatRow, memberId: string): boolean {
  return row.type === 'message.posted' && row.data['authorId'] === memberId;
}

export function directAuthorName(row: ChatRow, memberId: string, recipientName: string): string {
  if (directIsOwnMessage(row, memberId)) return 'You';
  return recipientName;
}

export function directRecipientName(
  colleague: { memberId: string; displayName: string | null } | undefined,
): string {
  if (!colleague) return '';
  return colleague.displayName?.trim() || colleague.memberId;
}

export function directConversationHeaderTitle(
  conversation: ChatConversation | undefined, memberId: string,
  colleagues: { memberId: string; displayName: string | null }[],
  recipient: { memberId: string; displayName: string | null } | undefined,
): string {
  if (!conversation) return directRecipientName(recipient);
  if (conversation.mode === 'group' && conversation.title?.trim()) {
    return conversation.title.trim();
  }
  return directConversationTitle(conversation, memberId, colleagues);
}

export function directPendingNavigationTitle(
  archiveCommandId: string, participantChangeUnsettled: boolean, composerBusy: boolean,
): string | null {
  if (archiveCommandId) return 'Check the archive change before leaving this chat.';
  if (participantChangeUnsettled) {
    return 'Check the participant change before leaving this chat.';
  }
  if (composerBusy) return 'Wait until this message is confirmed.';
  return null;
}

export function directConversationMode(conversation: ChatConversation | undefined)
  : 'direct' | 'group' | undefined {
  if (!conversation || conversation.mode === 'agent_session') return undefined;
  return conversation.mode;
}

export function mergeDirectColleagues(
  known: { memberId: string; displayName: string | null }[],
  latest: { memberId: string; displayName: string | null }[],
): { memberId: string; displayName: string | null }[] {
  const merged = new Map<string, { memberId: string; displayName: string | null }>();
  for (const colleague of known) merged.set(colleague.memberId, colleague);
  for (const colleague of latest) merged.set(colleague.memberId, colleague);
  return Array.from(merged.values());
}

export function isDirectTranscriptNearNewest(transcript: HTMLElement): boolean {
  const remaining = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight;
  return remaining < 80;
}

export function focusDirectComposer(host: HTMLElement | undefined): void {
  if (!host) return;
  const field = host.querySelector('textarea');
  if (field instanceof HTMLTextAreaElement) field.focus();
}

export function hasDirectMessage(rows: ChatRow[], messageId: string): boolean {
  if (!messageId) return false;
  for (const row of rows) {
    if (row.id === messageId) return true;
  }
  return false;
}

export function exceedsDirectRecipientLimit(
  people: Colleague[], snapshot: ReviewedSnapshot | undefined,
): boolean {
  const maximum = snapshot ? 97 : 96;
  return people.length > maximum;
}

export function directDraftKey(conversationId: string, colleagueId: string | undefined): string {
  if (conversationId) return `conversation:${conversationId}`;
  return `recipient:${colleagueId ?? ''}`;
}

export function groupAuthorName(
  row: ChatRow, memberId: string,
  colleagues: { memberId: string; displayName: string | null }[],
): string {
  if (row.type !== 'message.posted') return '';
  if (row.data['authorId'] === memberId) return 'You';
  const authorId = row.data['authorId'];
  if (typeof authorId !== 'string') return 'Unknown person';
  const author = directColleagueById(colleagues, authorId);
  return author?.displayName?.trim() || authorId;
}

export function formatDirectTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit', minute: '2-digit', timeZone: 'UTC',
  }).format(date);
}

export function directInitials(value: string): string {
  const trimmed = value.trim();
  const words = trimmed.split(/\s+/u);
  const letters: string[] = [];
  const firstWords = words.slice(0, 2);
  for (const word of firstWords) {
    const first = word[0];
    if (first) letters.push(first.toUpperCase());
  }
  return letters.join('');
}

export function directConversationTitle(
  conversation: ChatConversation, memberId: string,
  colleagues: { memberId: string; displayName: string | null }[],
): string {
  if (conversation.mode === 'group') {
    const names: string[] = [];
    for (const participantId of conversation.participantIds) {
      if (participantId === memberId) continue;
      const colleague = directColleagueById(colleagues, participantId);
      names.push(colleague?.displayName?.trim() || 'Group member');
    }
    return names.join(', ') || 'Group conversation';
  }
  if (conversation.mode !== 'direct') return '';
  const otherId = otherParticipant(conversation.participantIds, memberId);
  if (!otherId) return 'Direct conversation';
  const colleague = directColleagueById(colleagues, otherId);
  return colleague?.displayName?.trim() || conversation.title || 'Direct conversation';
}

export async function scrollDirectTranscript(
  transcript: HTMLElement, shouldScroll: () => boolean,
): Promise<void> {
  try {
    // Wait for the fonts and the next frame, because they can change message heights.
    await document.fonts?.ready;
    await nextFrame();
    if (shouldScroll()) transcript.scrollTop = transcript.scrollHeight;
  } catch (error) {
    console.warn('The latest message could not be brought into view.', error);
  }
}

function nextFrame(): Promise<void> {
  function requestFrame(resolve: () => void): void {
    requestAnimationFrame(resolve);
  }
  return new Promise<void>(requestFrame);
}

export function appendDirectMessage(rows: ChatRow[], newRow: ChatRow): ChatRow[] {
  return [...rows, newRow];
}
