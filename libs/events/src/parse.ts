import { validEgressObservation } from './egress-observation.ts';
import { childRequestedEventSchema, childStartFailedEventSchema } from './child-request.ts';
import { memoryContextRecordedEventSchema } from './memory-context.ts';
import { validSurveyEvent } from './survey.ts';
import { validEgressRuleEvent } from './egress.ts';
import { validPreferenceIdentity } from './conversation.ts';
import { memoryWrittenEventSchema, memoryForgottenEventSchema, memoryCorrectedEventSchema,
  memoryCleanupRecordedEventSchema } from './memory.ts';
import { checkDelegationEvent } from './delegation.ts';
import { checkRoutineEvent } from './routines.ts';
import { validMcpInstanceEvent } from './mcp-instance.ts';
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

  let envelopeSchema = eventEnvelopeSchema(definition.dataSchema);
  envelopeSchema = envelopeSchema.superRefine(checkDelegationEvent);
  envelopeSchema = envelopeSchema.refine(validEgressRuleEvent);
  envelopeSchema = envelopeSchema.refine(validEgressObservation);
  envelopeSchema = envelopeSchema.refine(validSurveyEvent);
  envelopeSchema = envelopeSchema.refine(validChildRequest);
  envelopeSchema = envelopeSchema.superRefine(checkRoutineEvent);
  if (definition.type === 'memory.maintenance_recorded') {
    envelopeSchema = envelopeSchema.refine(matchingMaintenanceScope);
  }
  if (definition.type === 'memory.maintenance_bound') {
    envelopeSchema = envelopeSchema.refine(validMaintenanceBinding);
  }
  if (definition.stream === 'mcp-instance') {
    envelopeSchema = envelopeSchema.refine(validMcpInstanceEvent);
  }
  const mcpSchema = definition.stream === 'mcp'
    ? envelopeSchema.refine(validMcpIdentity)
    : envelopeSchema;
  const checkedSchema = definition.stream === 'chat-state'
    ? mcpSchema.refine(validPreferenceIdentity)
    : mcpSchema;
  let schema: z.ZodType<EventEnvelope> = checkedSchema;
  if (definition.type === 'agent.memory_context_recorded') {
    schema = memoryContextRecordedEventSchema;
  }
  schema = memoryEventSchema(definition.type) ?? schema;
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

function memoryEventSchema(type: string): z.ZodType<EventEnvelope> | undefined {
  switch (type) {
    case 'memory.written':
      return memoryWrittenEventSchema;
    case 'memory.corrected':
      return memoryCorrectedEventSchema;
    case 'memory.forgotten':
      return memoryForgottenEventSchema;
    case 'memory.cleanup_recorded':
      return memoryCleanupRecordedEventSchema;
    default:
      return undefined;
  }
}

function validMcpIdentity(event: EventEnvelope): boolean {
  if (typeof event.data !== 'object' || event.data === null) {
    return false;
  }
  const serverId: unknown = Reflect.get(event.data, 'serverId');
  return typeof serverId === 'string' && event.subject === `mcp-${serverId}`;
}

function validMaintenanceBinding(event: EventEnvelope) {
  const fields = z.object({ scopeId: z.string(), scopeKind: z.string(), ownerId: z.string(),
    memberId: z.string() }).parse(event.data);
  if (fields.scopeKind === 'person' && fields.ownerId !== fields.memberId) {
    return false;
  }
  return event.subject === `scope-${fields.scopeId}` && event.source === 'opencrane-server' &&
    event.principal?.kind === 'human' && event.principal.id === fields.memberId &&
    typeof event.commandId === 'string';
}

function matchingMaintenanceScope(event: EventEnvelope) {
  const fields = z.object({ scopeId: z.string() });
  const data = fields.parse(event.data);
  return event.subject === `scope-${data.scopeId}`;
}

function validChildRequest(event: EventEnvelope) {
  if (event.type === 'conversation.child_start_failed') {
    return childStartFailedEventSchema.safeParse(event).success;
  }
  return event.type !== 'conversation.child_requested' ||
    childRequestedEventSchema.safeParse(event).success;
}
