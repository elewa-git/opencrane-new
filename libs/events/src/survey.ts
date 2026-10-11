/// <reference lib="dom" />
import { z } from 'zod';
import { chatIdSchema } from './conversation.ts';
import { ciphertextSchema } from './data.ts';
import { event, type EventDefinition } from './definition.ts';
import { memoryTextSchema } from './memory.ts';
import type { EventEnvelope } from './envelope.ts';

const encoder = new TextEncoder();
const generation = z.int().positive();
const positiveStep = z.int().min(1);
const step = positiveStep.max(4);
const name = memoryTextSchema.max(200);
const pronouns = memoryTextSchema.max(100);
const optionalPronouns = pronouns.nullable();
const task = z.enum(['draft_documents', 'compare_supplier_proposals', 'summarise_meetings']);
function distinct(values: string[]): boolean {
  return new Set(values).size === values.length;
}
const boundedGroups = z.array(chatIdSchema).max(16);
const groupIds = boundedGroups.refine(distinct);
const boundedTasks = z.array(task).max(16);
const taskChoices = boundedTasks.refine(distinct);
const identity = { schemaVersion: z.literal(1), memberId: chatIdSchema, generation };

// Keep these wishes as data. They cannot grant access or become trusted instructions.
export const surveyAnswersSchema = z.discriminatedUnion('step', [
  z.strictObject({ step: z.literal(1), preferredName: name, pronouns: optionalPronouns }),
  z.strictObject({ step: z.literal(2), workDescription: memoryTextSchema, groupIds }),
  z.strictObject({ step: z.literal(3), tone: z.enum(['direct', 'warm', 'formal']),
    length: z.enum(['brief', 'detailed']), citations: z.boolean() }),
  z.strictObject({ step: z.literal(4), tasks: taskChoices, ownTask: memoryTextSchema.nullable() }),
]);
export const surveyStepSavedDataSchema = z.strictObject({
  ...identity, step, ciphertext: ciphertextSchema.max(16384),
  keyId: z.string().regex(/^key:[a-f0-9]{64}$/u),
});
export const surveyRestartedDataSchema = z.strictObject(identity);
const personalIdentitySchema = z.object({ memberId: chatIdSchema });
export function validSurveyEvent(record: EventEnvelope): boolean {
  if (!record.type.startsWith('onboarding.survey_')) {
    return true;
  }
  const parsed = personalIdentitySchema.safeParse(record.data);
  if (!parsed.success) {
    return false;
  }
  const fields = parsed.data;
  const bytes = encoder.encode(JSON.stringify(record));
  return record.subject === `personal-${fields.memberId}` &&
    record.source === 'opencrane-server' && record.principal?.kind === 'human' &&
    record.principal.id === fields.memberId && Boolean(record.commandId) &&
    bytes.byteLength <= 16384;
}
const exampleIdentity = { schemaVersion: 1 as const, memberId: 'alice', generation: 1 };
const savedExample = { ...exampleIdentity, step: 1,
  ciphertext: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', keyId: `key:${'a'.repeat(64)}` };
export const surveyEvents: readonly EventDefinition[] = [
  event('onboarding.survey_step_saved', 'personal',
    'A member saved one encrypted survey step.', surveyStepSavedDataSchema, savedExample),
  event('onboarding.survey_restarted', 'personal',
    'A member started a new survey generation.', surveyRestartedDataSchema, exampleIdentity),
];
