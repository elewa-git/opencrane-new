import type { ToolActivityRecord, Turn } from './chat-state';

export function activityExpanded(openId: string, conversationId: string, activityId: string) {
  return openId === `${conversationId}:${activityId}`;
}

export function nextExpandedActivity(openId: string, conversationId: string,
  activityId: string): string {
  const selectedId = `${conversationId}:${activityId}`;
  if (openId === selectedId) return '';
  return selectedId;
}

export function turnTools(turn: Turn): ToolActivityRecord[] {
  return turn.tools;
}
