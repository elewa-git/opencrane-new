import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

export class ConversationListChanged extends Error {}
export class ConversationListIncomplete extends Error {}
export const conversationListQuery = z.strictObject({
  section: z.enum(['recent', 'archived']).default('recent'),
  q: z.string().max(100).default(''),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().max(2000).optional(),
});

function signature(secret: string, encoded: string) {
  const hmac = createHmac('sha256', secret);
  hmac.update(`conversation-list:${encoded}`);
  return hmac.digest();
}

export function conversationListCursor(secret: string, identity: unknown, cursor?: string) {
  const hash = createHash('sha256');
  hash.update(JSON.stringify(identity));
  const binding = hash.digest('hex');
  let before: [number, number] = [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER];
  if (cursor !== undefined) before = readPosition(secret, binding, cursor);

  function next(position: [number, number]) {
    const payload = JSON.stringify([binding, ...position]);
    const bytes = Buffer.from(payload);
    const encoded = bytes.toString('base64url');
    const signed = signature(secret, encoded);
    return `${encoded}.${signed.toString('base64url')}`;
  }
  return { before, next };
}

function readPosition(secret: string, binding: string, cursor: string): [number, number] {
  try {
    const [encoded, suppliedSignature, extra] = cursor.split('.');
    if (!encoded || !suppliedSignature || extra !== undefined) {
      throw new ConversationListChanged();
    }
    const expected = signature(secret, encoded);
    const supplied = Buffer.from(suppliedSignature, 'base64url');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      throw new ConversationListChanged();
    }
    const bytes = Buffer.from(encoded, 'base64url');
    const payload: unknown = JSON.parse(bytes.toString());
    const schema = z.tuple([z.literal(binding), z.int().nonnegative(), z.int().positive()]);
    const saved = schema.parse(payload);
    return [saved[1], saved[2]];
  } catch {
    throw new ConversationListChanged();
  }
}
