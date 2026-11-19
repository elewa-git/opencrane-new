import { z } from 'zod';

function isStorageSafeText(value: string): boolean {
  // JSONB cannot store NUL or unpaired UTF-16 surrogates. Valid pairs remain allowed.
  return !/[\u0000\ud800-\udfff]/u.test(value);
}

export const storageSafeTextSchema = z.string().refine(isStorageSafeText,
  'Text contains characters that cannot be stored');
export const conversationProseSchema = storageSafeTextSchema.max(1_048_576);
const conversationProse = z.object({ utterance: conversationProseSchema });

export function readConversationProse(value: unknown): string {
  return conversationProse.parse(value).utterance;
}
