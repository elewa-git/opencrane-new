/// <reference lib="dom" />
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
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
const surveyCiphertext = ciphertextSchema.max(16384);
const ciphertextDigest = z.string().regex(/^[a-f0-9]{64}$/u);

function hasMatchingCiphertextDigest(data: { ciphertext: string; ciphertextDigest: string }) {
  if (!surveyCiphertext.safeParse(data.ciphertext).success ||
      !ciphertextDigest.safeParse(data.ciphertextDigest).success) {
    // Let the field schemas report invalid formats before comparing their values.
    return true;
  }
  // Hash the decoded encrypted bytes. Replay can check them without reading a private key.
  const decoded = atob(data.ciphertext);
  const encryptedBytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index++) {
    encryptedBytes[index] = decoded.charCodeAt(index);
  }
  const hash = sha256(encryptedBytes);
  const digest = bytesToHex(hash);
  return digest === data.ciphertextDigest;
}
export const surveyStepSavedDataSchema = z.strictObject({
  ...identity, step, ciphertext: surveyCiphertext, ciphertextDigest,
  keyId: z.string().regex(/^key:[a-f0-9]{64}$/u),
}).refine(hasMatchingCiphertextDigest, {
  path: ['ciphertextDigest'], message: 'Ciphertext digest does not match encrypted bytes',
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
  ciphertext: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  ciphertextDigest: '11e431c215c5bd334cecbd43148274edf3ffdbd6cd6479fe279577fbe5f52ce6',
  keyId: `key:${'a'.repeat(64)}` };
export const surveyEvents: readonly EventDefinition[] = [
  event('onboarding.survey_step_saved', 'personal',
    'A member saved one encrypted survey step.', surveyStepSavedDataSchema, savedExample),
  event('onboarding.survey_restarted', 'personal',
    'A member started a new survey generation.', surveyRestartedDataSchema, exampleIdentity),
];
