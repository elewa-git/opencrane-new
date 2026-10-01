// The event envelope every OpenCrane event uses.
//
// This mirrors the CloudEvents fields plan.md asks for (id, type, source,
// time, subject, plus our own silo/principal/correlation fields) and wraps
// a per-event-type `data` payload. See docs/architecture/events.md: the
// event store is the only source of truth, and this is the shape every
// event takes on its way in.
import { z } from 'zod';

// The correlation ids that tie one call together across the event log:
// a conversation, a turn inside it, a gateway permit, a budget reservation
// and an approval. Every event carries whichever of these apply to it;
// none are required, because not every event has all five.
export const correlationIdsSchema = z
  .object({
    conversation: z.string().min(1).optional(),
    turn: z.string().min(1).optional(),
    permit: z.string().min(1).optional(),
    reservation: z.string().min(1).optional(),
    approval: z.string().min(1).optional(),
  })
  .strict();

export type CorrelationIds = z.infer<typeof correlationIdsSchema>;

// Who caused the event: a person, an agent acting on someone's behalf, or
// the system itself (a timer, a scheduled job). Some events genuinely have
// no principal (for example a timer firing), so this field is optional.
export const principalSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(['human', 'agent', 'system']),
  })
  .strict();

export type Principal = z.infer<typeof principalSchema>;

// Builds the envelope schema for one event type, given the zod schema for
// its `data` payload. Every event in the registry is built this way, so
// the envelope shape never drifts between event types.
export function eventEnvelopeSchema<DataSchema extends z.ZodType>(dataSchema: DataSchema) {
  return z
    .object({
      // The event's own id. NATS JetStream uses this as `Nats-Msg-Id` for
      // deduplication, so it must be stable and unique per event.
      id: z.string().min(1),
      // The event type, in past tense, e.g. "member.joined".
      type: z.string().min(1),
      // Which part of the system appended this event, e.g. "opencrane-server".
      source: z.string().min(1),
      // When the event happened, as an ISO 8601 timestamp with an offset.
      time: z.iso.datetime({ offset: true }),
      // The stream this event belongs to, e.g. "member-alice". This is the
      // CloudEvents "subject" field, and matches the catalogue's stream ids.
      subject: z.string().min(1),
      // Which customer silo this event belongs to.
      silo: z.string().min(1),
      principal: principalSchema.optional(),
      correlation: correlationIdsSchema.default({}),
      data: dataSchema,
    })
    .strict();
}

// An envelope with an untyped `data` field, only so envelope.test.ts can test
// the envelope's own shape. Every real event type has its own strict data
// schema, so this is not exported from index.ts.
export const unknownEventEnvelopeSchema = eventEnvelopeSchema(z.unknown());

export type EventEnvelope<DataSchema extends z.ZodType = z.ZodUnknown> = z.infer<
  ReturnType<typeof eventEnvelopeSchema<DataSchema>>
>;
