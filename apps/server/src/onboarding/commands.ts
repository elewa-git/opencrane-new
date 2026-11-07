import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AppendCommand } from '@opencrane/event-store';
import { surveyAnswersSchema, parseEventByType, personaRevisedDataSchema,
  type EventEnvelope } from '@opencrane/events';
import { isAuthorityChanged, groupMembership } from '@opencrane/models';
import { writeChatAccess, type ChatOptions } from '../chat/access.ts';
import { idSchema } from '../members/guard.ts';
import { surveyHistory, savedCommand, decryptAnswers, decryptPersona,
  surveyReceipt, personaReceipt } from './history.ts';
import { checkedPersona, renderPersona } from './persona.ts';

const common = { commandId: idSchema, generation: z.int().positive(),
  expectedPosition: z.int().nonnegative() };
const save = z.strictObject({ ...common, operation: z.literal('save_step'),
  answers: surveyAnswersSchema });
const restart = z.strictObject({ ...common, operation: z.literal('restart') });
const revise = z.strictObject({ ...common, operation: z.literal('revise'),
  mode: z.enum(['generate', 'replace']), replacement: z.string().optional() });
const commandSchema = z.discriminatedUnion('operation', [save, restart, revise]);
export class SurveyConflict extends Error {}
export class SurveyUnknown extends Error {}

function encrypt(options: ChatOptions, memberId: string, value: string) {
  const encrypted = options.keys.encrypt(options.silo, `personal:${memberId}`, value);
  const hash = createHash('sha256');
  hash.update(Buffer.from(encrypted.ciphertext, 'base64'));
  return { ...encrypted, ciphertextDigest: hash.digest('hex') };
}
function eventData(options: ChatOptions, memberId: string, input: z.infer<typeof commandSchema>,
  history: Awaited<ReturnType<typeof surveyHistory>>) {
  const identity = { schemaVersion: 1, memberId, generation: input.generation };
  if (input.operation === 'restart') return { ...identity, generation: input.generation + 1 };
  if (input.operation === 'revise') {
    const replacement = personaValue(options, memberId, input, history);
    const encrypted = encrypt(options, memberId, replacement);
    return { ...identity, revision: history.revisions.length + 1,
      rendererVersion: 'persona-v1', mode: input.mode,
      encrypted: encrypted.ciphertext, encryptedDigest: encrypted.ciphertextDigest,
      keyRef: encrypted.keyId };
  }
  return { ...identity, step: input.answers.step,
    ...encrypt(options, memberId, JSON.stringify(input.answers)) };
}
function personaValue(options: ChatOptions, memberId: string,
  input: z.infer<typeof revise>, history: Awaited<ReturnType<typeof surveyHistory>>) {
  if (input.mode === 'generate') {
    if (input.replacement !== undefined) throw new z.ZodError([]);
    return renderPersona(options, memberId, history);
  }
  if (input.replacement === undefined) throw new z.ZodError([]);
  return checkedPersona(input.replacement);
}
function checkProgress(input: z.infer<typeof commandSchema>,
  history: Awaited<ReturnType<typeof surveyHistory>>) {
  if (input.expectedPosition !== history.position || input.generation !== history.generation) {
    throw new SurveyConflict();
  }
  if (input.operation === 'save_step' && input.answers.step > history.steps.length + 1) {
    throw new SurveyConflict();
  }
  if (input.operation === 'revise' && history.steps.length !== 4) {
    throw new SurveyConflict();
  }
}
async function selectedGroupPositions(options: ChatOptions, memberId: string,
  input: z.infer<typeof commandSchema>) {
  const groups = new Map<string, number>();
  if (input.operation !== 'save_step' || input.answers.step !== 2) return groups;
  for (const groupId of input.answers.groupIds) {
    const subject = `team-${groupId}`;
    const deadline = performance.now() + 10_000;
    const position = await options.store.head(subject, deadline);
    await groupMembership(options.store, options.silo, memberId, groupId,
      options.binding, deadline);
    groups.set(subject, position);
  }
  return groups;
}
function eventType(input: z.infer<typeof commandSchema>) {
  if (input.operation === 'save_step') return 'onboarding.survey_step_saved';
  if (input.operation === 'revise') return 'onboarding.persona_revised';
  return 'onboarding.survey_restarted';
}
export async function surveyCommand(options: ChatOptions, memberId: string, body: unknown,
  route: 'survey' | 'persona' = 'survey') {
  const input = commandSchema.parse(body);
  if ((route === 'persona') !== (input.operation === 'revise')) throw new z.ZodError([]);
  if (Buffer.byteLength(JSON.stringify(body)) > 16384) throw new z.ZodError([]);
  const history = await surveyHistory(options, memberId);
  const previous = await savedCommand(options, memberId, input.commandId, history);
  if (previous) return checkedReceipt(options, memberId, input, previous);
  checkProgress(input, history);
  const groups = await selectedGroupPositions(options, memberId, input);
  const type = eventType(input);
  const event: EventEnvelope = { id: randomUUID(), commandId: input.commandId, type,
    source: 'opencrane-server', time: new Date().toISOString(), silo: options.silo,
    subject: `personal-${memberId}`, principal: { kind: 'human', id: memberId }, correlation: {},
    data: eventData(options, memberId, input, history) };
  if (!parseEventByType(event).success) throw new z.ZodError([]);
  // Finish content and encryption before starting the short membership check.
  const accessRequest = { memberId };
  const fresh = await writeChatAccess(options, accessRequest);
  for (const [subject, position] of groups) {
    fresh.include(subject);
    if (await options.store.head(subject, fresh.deadline) !== position) {
      throw new SurveyConflict();
    }
  }
  await fresh();
  const append = { event, expectedSequence: history.sequence,
    deadline: fresh.deadline, historyChecked: true as const };
  return appendSurvey(options, memberId, input, append);
}

async function appendSurvey(options: ChatOptions, memberId: string,
  input: z.infer<typeof commandSchema>, command: AppendCommand) {
  try {
    const result = await options.store.append(command);
    if (result.status === 'conflict' || result.status === 'rejected') throw new SurveyConflict();
    if (result.status !== 'appended') throw new SurveyUnknown();
    // Read the saved event because another device may have used this command id first.
    const updated = await surveyHistory(options, memberId);
    const saved = await savedCommand(options, memberId, input.commandId, updated);
    if (!saved || saved.row.sequence !== result.sequence) throw new SurveyUnknown();
    return checkedReceipt(options, memberId, input, saved);
  } catch (error) {
    if (error instanceof SurveyConflict || isAuthorityChanged(error)) throw error;
    throw new SurveyUnknown();
  }
}

function checkedReceipt(options: ChatOptions, memberId: string,
  input: z.infer<typeof commandSchema>,
  previous: NonNullable<Awaited<ReturnType<typeof savedCommand>>>) {
  const { row, reference } = previous;
  let matches = row.event.type === 'onboarding.survey_restarted';
  if (input.operation === 'save_step') {
    matches = row.event.type === 'onboarding.survey_step_saved' &&
      JSON.stringify(decryptAnswers(options, memberId, row.event)) ===
      JSON.stringify(input.answers);
  }
  if (input.operation === 'revise') {
    const data = personaRevisedDataSchema.safeParse(row.event.data);
    matches = row.event.type === 'onboarding.persona_revised' && data.success &&
      data.data.mode === input.mode;
    if (matches && input.mode === 'replace') {
      matches = decryptPersona(options, memberId, row.event) === input.replacement;
    }
    if (matches && input.mode === 'generate') matches = input.replacement === undefined;
  }
  if (!matches || reference.previousPosition !== input.expectedPosition ||
    reference.generation !== input.generation) throw new SurveyConflict();
  if (row.event.type === 'onboarding.persona_revised') return personaReceipt(row);
  return surveyReceipt(row);
}
