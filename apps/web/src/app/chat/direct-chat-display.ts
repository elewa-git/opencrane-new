import type { ChatConversation, ChatRow } from '@opencrane/protocol';

export function directConversations(rows: ChatConversation[]): ChatConversation[] {
  const direct: ChatConversation[] = [];
  for (const row of rows) {
    if (row.mode === 'direct') direct.push(row);
  }
  return direct;
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
    if (row.mode === 'direct' && row.conversationId === conversationId) return row;
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
  if (conversation.mode !== 'direct') return '';
  const otherId = otherParticipant(conversation.participantIds, memberId);
  if (!otherId) return 'Direct conversation';
  const colleague = directColleagueById(colleagues, otherId);
  return colleague?.displayName?.trim() || otherId;
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
