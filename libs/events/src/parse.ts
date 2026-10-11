import { validPreferenceIdentity } from './conversation.ts';
import { memoryWrittenEventSchema } from './memory.ts';
import { checkDelegationEvent } from './delegation.ts';
// Parses a raw event by binding its `type` field to the registry, so
// `data` is checked against that type's own schema instead of the generic
// `z.unknown()` placeholder. This is what should sit in front of every
// command handler, projection and reaction: an event whose type nobody
// registered is rejected outright, and an event whose data breaks its
// type's own rules (for example a `message.posted` carrying plaintext
// `text` instead of an encrypted `ciphertext`, which events.md rule 5
// forbids) is rejected too.
import { z } from 'zod';
import { eventEnvelopeSchema, type EventEnvelope } from './envelope.ts';
import { getEventDefinition } from './registry.ts';

// A minimal check just to read `type` safely off an input we don't know
// the shape of yet. We don't know which event this is until this passes.
const typeFieldSchema = z.object({ type: z.string().min(1) });

export type ParseEventByTypeResult =
  | { readonly success: true; readonly event: EventEnvelope }
  | { readonly success: false; readonly reason: 'unknown_event_type'; readonly type: string | undefined }
  | { readonly success: false; readonly reason: 'invalid_event'; readonly error: z.ZodError };

/**
 * Validates a raw, untyped value as one specific kind of event.
 *
 * - No string `type` field at all → `unknown_event_type` (type: undefined).
 * - A `type` the registry doesn't know → `unknown_event_type` (type: the string).
 * - A `type` the registry knows, but the envelope or `data` doesn't match
 *   that type's schema → `invalid_event`, with the zod error.
 * - Otherwise → the fully validated envelope, with `data` typed and
 *   checked against its own event type's schema.
 */
export function parseEventByType(input: unknown): ParseEventByTypeResult {
  const typeField = typeFieldSchema.safeParse(input);
  if (!typeField.success) {
    return { success: false, reason: 'unknown_event_type', type: undefined };
  }

  const definition = getEventDefinition(typeField.data.type);
  if (!definition) {
    return { success: false, reason: 'unknown_event_type', type: typeField.data.type };
  }

  const envelopeSchema = eventEnvelopeSchema(definition.dataSchema).superRefine(checkDelegationEvent);
  const checkedSchema = definition.stream === 'chat-state'
    ? envelopeSchema.refine(validPreferenceIdentity)
    : envelopeSchema;
  const schema = definition.type === 'memory.written' ? memoryWrittenEventSchema : checkedSchema;
  const result = schema.safeParse(input);
  if (!result.success) {
    return { success: false, reason: 'invalid_event', error: result.error };
  }

  const event: EventEnvelope = result.data;
  if (event.type === 'provider.managed_calls_enabled') {
    const subjectSchema = z.literal(`budget-${event.silo}`);
    const subject = subjectSchema.safeParse(event.subject);
    if (!subject.success) {
      return { success: false, reason: 'invalid_event', error: subject.error };
    }
  }
  return { success: true, event };
}
