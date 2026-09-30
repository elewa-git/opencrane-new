// Parses a raw event by binding its `type` field to the registry, so
// `data` is checked against that type's own schema instead of the generic
// `z.unknown()` placeholder, and its `subject` is checked against that
// type's own stream. This is what should sit in front of every command
// handler, projection and reaction: an event whose type nobody registered
// is rejected outright, an event whose data breaks its type's own rules
// (for example a `message.posted` carrying plaintext `text` instead of an
// encrypted `ciphertext`, which events.md rule 5 forbids) is rejected
// too, and so is an event on the wrong stream (for example a
// `member.joined` whose `subject` doesn't match `member-<memberId>`).
import { z } from 'zod';
import { eventEnvelopeSchema, type EventEnvelope } from './envelope.ts';
import { getEventDefinition } from './registry.ts';
import { expectedSubject } from './subject.ts';

// A minimal check just to read `type` safely off an input we don't know
// the shape of yet. We don't know which event this is until this passes.
const typeFieldSchema = z.object({ type: z.string().min(1) });

export type ParseEventByTypeResult =
  | { readonly success: true; readonly event: EventEnvelope }
  | { readonly success: false; readonly reason: 'unknown_event_type'; readonly type: string | undefined }
  | { readonly success: false; readonly reason: 'invalid_event'; readonly error: z.ZodError }
  | {
      readonly success: false;
      readonly reason: 'subject_mismatch';
      readonly expected: string;
      readonly actual: string;
    };

/**
 * Validates a raw, untyped value as one specific kind of event.
 *
 * - No string `type` field at all → `unknown_event_type` (type: undefined).
 * - A `type` the registry doesn't know → `unknown_event_type` (type: the string).
 * - A `type` the registry knows, but the envelope or `data` doesn't match
 *   that type's schema → `invalid_event`, with the zod error.
 * - The envelope and data are otherwise valid, but `subject` doesn't
 *   match this type's stream (see subject.ts) → `subject_mismatch`, with
 *   the subject it should have carried and the one it actually carried.
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

  const result = eventEnvelopeSchema(definition.dataSchema).safeParse(input);
  if (!result.success) {
    return { success: false, reason: 'invalid_event', error: result.error };
  }

  const event: EventEnvelope = result.data;
  const expected = expectedSubject(definition, event.data, event.silo);
  if (event.subject !== expected) {
    return { success: false, reason: 'subject_mismatch', expected, actual: event.subject };
  }

  return { success: true, event };
}
