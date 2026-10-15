import { providerTurnBindingSchema } from '@opencrane/events';
import { z } from 'zod';

const id = z.string().regex(/^[\w-]+$/u).max(200);
const common = { silo: id, assistant: id, exp: z.int(), iat: z.int() };

export const legacyTurnSchema = z.object({
  ...common, typ: z.literal('turn'), conversation: id, turn: id, requester: id, thread: id,
  task: z.string().min(1), model: z.string().min(1), delegation: z.array(id).min(1).max(3),
  sharingClass: z.literal('shared_only').optional(),
  providerId: id.optional(), bindingSequence: z.int().positive().optional(),
});

const managedTurnSchema = legacyTurnSchema.extend(providerTurnBindingSchema.shape);

export function parseTurnToken(raw: unknown) {
  const token = legacyTurnSchema.parse(raw);
  if (token.providerId !== undefined || token.bindingSequence !== undefined) {
    return managedTurnSchema.parse(raw);
  }
  return token;
}

export function requireManagedTurnClaims(raw: unknown, enabled: boolean) {
  if (enabled) managedTurnSchema.parse(raw);
}
