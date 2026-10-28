import { z } from 'zod';
import type { EventEnvelope } from './envelope.ts';
import { ciphertextSchema, keyIdSchema } from './data.ts';

const id = z.string().min(1).max(300);
const revision = z.int().positive();
const instant = z.iso.datetime({ offset: true });
const localTime = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u);
const zone = z.string().min(1).max(100);
const reason = z.string().regex(/^[a-z][a-z0-9_]{1,63}$/u);
const daily = z.object({ frequency: z.literal('daily'), localTime, zone }).strict();
const weekly = daily.extend({ frequency: z.literal('weekly'), weekday: z.int().min(1).max(7) });
export const routineScheduleSchema = z.discriminatedUnion('frequency', [daily, weekly]);
const slot = z.object({ localDate: z.iso.date(), localTime, zone, at: instant,
  offsetMinutes: z.int().min(-840).max(840) }).strict();
const reference = z.object({ eventId: id, position: revision }).strict();

export const routineRecordIdentitySchema = z.object({ routineId: z.string().min(1),
  version: z.literal(1).optional() });

export const routineDefinitionSchema = z.object({
  name: z.string().min(1).max(200), ownerId: id, ownerAdmissionId: id,
  assistantId: id, assistantKind: z.literal('team'), payingGroupId: id,
  assistantPayingGroupId: id, connectionId: id, connectionKind: z.literal('company'),
  profileId: id, profileRevision: revision, connectionRevision: revision,
  companyAccountId: id, scopes: z.array(id).max(32),
  instructions: z.object({ ciphertext: ciphertextSchema, keyId: keyIdSchema }).strict(),
  schedule: routineScheduleSchema,
}).strict().refine(hasAssistantPayer, 'The payer must equal the assistant payer');
function hasAssistantPayer(data: { payingGroupId: string; assistantPayingGroupId: string }) {
  return data.payingGroupId === data.assistantPayingGroupId;
}
const identity = z.object({ version: z.literal(1), routineId: id,
  definitionRevision: revision, scheduleRevision: revision, controlRevision: revision }).strict();
export const routineDefinitionEventSchema = identity.extend({ definition: routineDefinitionSchema,
  status: z.enum(['active', 'paused']), actorId: id, effectiveAt: instant,
  next: slot.nullable(), cursor: slot.nullable() });
export const routineControlSchema = identity.extend({ actorId: id,
  reason,
  source: z.enum(['owner', 'admin', 'access']), affectedRun: id.nullable(), next: slot.nullable(),
  cause: reference.optional() });
const run = { occurrenceId: id, rootId: id, conversationId: id, messageId: id, turnId: id };
export const routineDueSchema = identity.extend({ ...run,
  source: z.enum(['scheduled', 'manual']), definition: routineDefinitionSchema,
  slot, firedAt: instant, startBy: instant });
export const routineReassignedSchema = routineControlSchema.extend({ source: z.literal('admin'),
  definition: routineDefinitionSchema });
export const routineSkippedSchema = identity.extend({ occurrenceId: id,
  localDate: z.iso.date(), localTime, zone,
  reason: z.enum(['dst', 'overlap']), cursor: slot.nullable(), next: slot.nullable() });
export const routineMissedSchema = identity.extend({ firstLocalDate: z.iso.date(),
  lastLocalDate: z.iso.date(), count: revision, reason: z.literal('downtime'),
  cursor: slot.nullable(), next: slot.nullable() });
export const routineActivationSchema = identity.extend({ ...run, senderAttemptId: id,
  admission: reference });
export const routineStopSchema = routineControlSchema.extend({ ...run,
  source: z.enum(['owner', 'admin']) });
export const routineFinishedSchema = identity.extend({ ...run,
  outcome: z.enum(['succeeded', 'failed', 'cancelled', 'interrupted']),
  reason, terminalEvidence: reference, resultReference: reference.optional() });

// Keep the old records exact so replay cannot guess a governed definition from cron text.
const legacyCreated = z.object({ routineId: z.string().min(1), assistantId: z.string().min(1),
  schedule: z.string().min(1), createdBy: z.string().min(1) }).strict();
const legacyUpdated = z.object({ routineId: z.string().min(1), schedule: z.string().min(1),
  updatedBy: z.string().min(1) }).strict();
const legacyPaused = z.object({ routineId: z.string().min(1), pausedBy: z.string().min(1) }).strict();
const legacyResumed = z.object({ routineId: z.string().min(1), resumedBy: z.string().min(1) }).strict();
const legacyRetired = z.object({ routineId: z.string().min(1), retiredBy: z.string().min(1) }).strict();
const legacyDue = z.object({ routineId: z.string().min(1), firedAt: instant }).strict();
export const routineCreatedSchema = z.union([routineDefinitionEventSchema, legacyCreated]);
export const routineUpdatedSchema = z.union([routineDefinitionEventSchema, legacyUpdated]);
export const routinePausedSchema = z.union([routineControlSchema, legacyPaused]);
const resumedControl = routineControlSchema.extend({ source: z.literal('owner') });
export const routineResumedSchema = z.union([resumedControl, legacyResumed]);
export const routineRetiredSchema = z.union([routineControlSchema, legacyRetired]);
export const routineDueDataSchema = z.union([routineDueSchema, legacyDue]);

const modernIdentity = z.object({ version: z.literal(1), routineId: id,
  actorId: id.optional(), definition: routineDefinitionSchema.optional(),
  source: z.string().optional(), cause: reference.optional() });
export function checkRoutineEvent(event: EventEnvelope, context: z.RefinementCtx): void {
  if (!event.type.startsWith('routine.')) {
    return;
  }
  const parsed = modernIdentity.safeParse(event.data);
  if (!parsed.success) {
    return;
  }
  const data = parsed.data;
  const actorId = data.actorId ?? 'opencrane-server';
  const kind = actorId === 'opencrane-server' ? 'system' : 'human';
  let valid = event.subject === `routine-${data.routineId}` &&
    event.source === 'opencrane-server' && event.principal?.kind === kind &&
    event.principal.id === actorId && typeof event.commandId === 'string';
  valid = valid && validDefinitionOwner(event.type, data, actorId);
  valid = valid && validAccessCause(event.type, data);
  if (!valid) {
    context.addIssue({ code: 'custom', message: 'Routine record requires its bound server stream' });
  }
}

function validDefinitionOwner(type: string, data: z.infer<typeof modernIdentity>, actorId: string) {
  if (type === 'routine.created' || type === 'routine.updated') {
    return data.definition?.ownerId === actorId;
  }
  return true;
}

function validAccessCause(type: string, data: z.infer<typeof modernIdentity>) {
  if (data.source === 'access') {
    return type === 'routine.paused' && data.actorId === 'opencrane-server' &&
      data.cause !== undefined;
  }
  return data.cause === undefined;
}
