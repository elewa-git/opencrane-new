import { ModelRequestRefused as RequestRefused } from './state.ts';
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
  if (enabled) return managedTurnSchema.parse(raw);
  return undefined;
}

export function requireModelRoute(turnToken: z.infer<typeof legacyTurnSchema>,
  managedRoute: boolean, enabled: boolean) {
  if (managedRoute) {
    if (!enabled) {
      throw new Error('Managed calls are not enabled');
    }
  } else if (turnToken.providerId !== undefined) {
    throw new RequestRefused('Managed provider calls are not available yet');
  }
}

export function knownDecisionRoute(url: string | undefined) {
  return url === '/authorize/models/managed' || url === '/authorize' ||
    url?.startsWith('/authorize/mcp/');
}
