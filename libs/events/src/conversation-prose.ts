import { z } from 'zod';

export const conversationProseSchema = z.string().max(1_048_576);
const conversationProse = z.object({ utterance: conversationProseSchema });

export function readConversationProse(value: unknown): string {
  return conversationProse.parse(value).utterance;
}
