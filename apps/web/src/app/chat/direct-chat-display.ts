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

export function formatDirectTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit', minute: '2-digit', timeZone: 'UTC',
  }).format(date);
}

export function directInitials(value: string): string {
  const words = value.trim().split(/\s+/u);
  const letters: string[] = [];
  for (const word of words.slice(0, 2)) {
    const first = word[0];
    if (first) letters.push(first.toUpperCase());
  }
  return letters.join('');
}
