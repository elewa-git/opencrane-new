import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { memberJoinedDataSchema, siloOwnerBootstrappedDataSchema,
  assistantCreatedDataSchema, parseEventByType,
  welcomeStartedDataSchema, welcomeAnswerRecordedDataSchema,
  type EventEnvelope } from '@opencrane/events';
import type { StoredEvent } from '@opencrane/event-store';
import { currentMembership, isAuthorityChanged } from '@opencrane/models';
import { chatAccess, isChatRefused, writeChatAccess, type ChatOptions }
  from '../chat/access.ts';
import { idSchema } from '../members/guard.ts';
import { surveyHistory, savedCommand, surveyReceipt } from './history.ts';
import { SurveyConflict, SurveyUnknown } from './commands.ts';
import { welcomeScripts } from './script.ts';

const common = { commandId: idSchema, generation: z.int().positive(),
  expectedPosition: z.int().nonnegative(), scriptVersion: z.literal('welcome-v1') };
const start = z.strictObject({ ...common, operation: z.literal('start'),
  variant: z.enum(['assistant', 'no_assistant']), revision: z.int().positive().optional(),
  revisionId: idSchema.optional() });
const answer = z.strictObject({ ...common, operation: z.literal('answer'),
  welcomeId: idSchema, stepId: z.enum(['weekly_help', 'continue_to_workspace']),
  stepNumber: z.literal(1), answer: z.string().min(1) });
const inputSchema = z.discriminatedUnion('operation', [start, answer]);
type Input = z.infer<typeof inputSchema>;
type History = Awaited<ReturnType<typeof surveyHistory>>;
type Saved = NonNullable<Awaited<ReturnType<typeof savedCommand>>>;

function assignedAssistantId(silo: string, memberId: string) {
  const hash = createHash('sha256');
  const identity = [silo, memberId].join('\0');
  hash.update(identity);
  const digest = hash.digest('hex');
  return `personal-${digest.slice(0, 32)}`;
}

async function admissionChoice(options: ChatOptions, memberId: string, deadline: number) {
  const member = await currentMembership(options.store, options.silo, memberId,
    undefined, deadline);
  function isJoin(row: typeof member.facts[number]) {
    return row.event.type === 'member.joined' ||
      row.event.type === 'silo.owner_bootstrapped';
  }
  const joined = member.facts.findLast(isJoin);
  if (!joined || !member.role) throw new SurveyConflict();
  if (joined.event.type === 'silo.owner_bootstrapped') {
    siloOwnerBootstrappedDataSchema.parse(joined.event.data);
    return 'provision';
  }
  const choice = memberJoinedDataSchema.safeParse(joined.event.data);
  if (!choice.success) throw new SurveyUnknown();
  return choice.data.personalAssistant ?? 'provision';
}

async function firstAssistantEvent(options: ChatOptions, subject: string, deadline: number) {
  for await (const row of options.store.readStream(subject, 1, deadline)) return row;
  return undefined;
}

function checkedAssistant(creation: StoredEvent | undefined,
  options: ChatOptions, memberId: string, assistantId: string, position: number) {
  if (!position) return false;
  if (!creation || creation.event.type !== 'assistant.created' ||
      creation.event.silo !== options.silo ||
      creation.event.source !== 'opencrane-lifecycle' ||
      creation.event.principal?.kind !== 'system' ||
      creation.event.principal.id !== 'computer-lifecycle' ||
      !parseEventByType(creation.event).success) {
    throw new SurveyUnknown();
  }
  const assistant = assistantCreatedDataSchema.parse(creation.event.data);
  if (assistant.kind !== 'personal' || assistant.ownerId !== memberId ||
      assistant.assistantId !== assistantId) throw new SurveyUnknown();
  return true;
}

async function assistantAssignment(options: ChatOptions, memberId: string) {
  const assistantId = assignedAssistantId(options.silo, memberId);
  const subject = `assistant-${assistantId}`;
  const deadline = performance.now() + 10_000;
  const choice = await admissionChoice(options, memberId, deadline);
  const position = await options.store.head(subject, deadline);
  const creation = position ? await firstAssistantEvent(options, subject, deadline) : undefined;
  const assigned = checkedAssistant(creation, options, memberId, assistantId, position);
  if (choice === 'none' && assigned) throw new SurveyConflict();
  return { assistantId, subject, position, assigned, choice };
}

function checkStart(input: z.infer<typeof start>, history: History) {
  if (history.steps.length !== 4 || history.welcome) throw new SurveyConflict();
  if (input.variant === 'assistant' &&
      (history.approval?.revision !== input.revision ||
       history.approval?.revisionId !== input.revisionId)) throw new SurveyConflict();
  if (input.variant === 'no_assistant' &&
      (input.revision !== undefined || input.revisionId !== undefined)) {
    throw new SurveyConflict();
  }
}

function checkAnswer(input: z.infer<typeof answer>, history: History) {
  const current = history.welcome;
  if (!current || current.answers.length || current.start.event.id !== input.welcomeId) {
    throw new SurveyConflict();
  }
  const frozen = welcomeStartedDataSchema.parse(current.start.event.data);
  const question = welcomeScripts[frozen.scriptVersion][frozen.variant];
  if (frozen.generation !== input.generation || question.stepId !== input.stepId) {
    throw new SurveyConflict();
  }
  if (Buffer.byteLength(input.answer, 'utf8') > 4096 ||
      (frozen.variant === 'no_assistant' && input.answer !== question.question)) {
    throw new z.ZodError([]);
  }
}

function checkInput(input: Input, history: History) {
  if (input.generation !== history.generation || input.expectedPosition !== history.position) {
    throw new SurveyConflict();
  }
  if (input.operation === 'start') checkStart(input, history);
  else checkAnswer(input, history);
}

function encryptedAnswer(options: ChatOptions, memberId: string, value: string) {
  const encrypted = options.keys.encrypt(options.silo, `personal:${memberId}`, value);
  const bytes = Buffer.from(encrypted.ciphertext, 'base64');
  const hash = createHash('sha256');
  hash.update(bytes);
  const encryptedDigest = hash.digest('hex');
  return { encrypted: encrypted.ciphertext, encryptedDigest, keyRef: encrypted.keyId };
}

function buildEvent(options: ChatOptions, memberId: string, input: Input,
  assignment: Awaited<ReturnType<typeof assistantAssignment>> | null) {
  const id = randomUUID();
  let type = 'onboarding.welcome_answer_recorded';
  let data: unknown;
  const identity = { schemaVersion: 1, memberId, generation: input.generation,
    scriptVersion: input.scriptVersion };
  if (input.operation === 'start') {
    if (!assignment) throw new SurveyUnknown();
    type = 'onboarding.welcome_started';
    let assignmentStatus: 'assigned' | 'not_requested' | 'provisioning';
    if (assignment.assigned) assignmentStatus = 'assigned';
    else if (assignment.choice === 'none') assignmentStatus = 'not_requested';
    else assignmentStatus = 'provisioning';
    data = { ...identity, welcomeId: id, variant: input.variant,
      assignmentStatus,
      revision: input.variant === 'assistant' ? input.revision : null,
      revisionId: input.variant === 'assistant' ? input.revisionId : null,
      assistantId: input.variant === 'assistant' ? assignment.assistantId : null };
  } else {
    data = { ...identity, welcomeId: input.welcomeId, stepId: input.stepId,
      stepNumber: input.stepNumber, ...encryptedAnswer(options, memberId, input.answer) };
  }
  const event: EventEnvelope = { id, commandId: input.commandId, type,
    source: 'opencrane-server', time: new Date().toISOString(), silo: options.silo,
    subject: `personal-${memberId}`, principal: { kind: 'human', id: memberId },
    correlation: {}, data };
  if (!parseEventByType(event).success) throw new z.ZodError([]);
  return event;
}

function receipt(row: NonNullable<Awaited<ReturnType<typeof savedCommand>>>['row']) {
  const base = surveyReceipt(row);
  if (row.event.type === 'onboarding.welcome_started') {
    return { ...base, welcomeId: row.event.id };
  }
  return { ...base, status: 'completion_pending' as const };
}

export function welcomeReceipt(row: NonNullable<Awaited<ReturnType<typeof savedCommand>>>['row']) {
  return receipt(row);
}

function matchesStart(input: z.infer<typeof start>, saved: Saved) {
  const event = saved.row.event;
  const data = welcomeStartedDataSchema.safeParse(event.data);
  return event.type === 'onboarding.welcome_started' && data.success &&
    data.data.variant === input.variant && data.data.scriptVersion === input.scriptVersion &&
    data.data.revision === (input.revision ?? null) &&
    data.data.revisionId === (input.revisionId ?? null);
}

function matchesAnswer(options: ChatOptions, memberId: string,
  input: z.infer<typeof answer>, saved: Saved) {
  const event = saved.row.event;
  const data = welcomeAnswerRecordedDataSchema.safeParse(event.data);
  if (event.type !== 'onboarding.welcome_answer_recorded' || !data.success ||
      data.data.welcomeId !== input.welcomeId ||
      data.data.scriptVersion !== input.scriptVersion ||
      data.data.stepId !== input.stepId || data.data.stepNumber !== input.stepNumber) {
    return false;
  }
  const savedAnswer = options.keys.decrypt(options.silo, `personal:${memberId}`,
    { ciphertext: data.data.encrypted, keyId: data.data.keyRef });
  return savedAnswer === input.answer;
}

async function checkedReceipt(options: ChatOptions, memberId: string, input: Input,
  saved: Saved) {
  // Check membership after the point read, before opening a saved answer.
  await chatAccess(options, { memberId });
  if (saved.reference.previousPosition !== input.expectedPosition ||
      saved.reference.generation !== input.generation) throw new SurveyConflict();
  const matches = input.operation === 'start' ? matchesStart(input, saved) :
    matchesAnswer(options, memberId, input, saved);
  if (!matches) throw new SurveyConflict();
  return receipt(saved.row);
}

async function appendWelcome(options: ChatOptions, memberId: string, input: Input,
  history: History, event: EventEnvelope, deadline: number) {
  try {
    const result = await options.store.append({ event, expectedSequence: history.sequence,
      deadline, historyChecked: true });
    if (result.status === 'conflict' || result.status === 'rejected') throw new SurveyConflict();
    if (result.status !== 'appended') throw new SurveyUnknown();
    const updated = await surveyHistory(options, memberId);
    const saved = await savedCommand(options, memberId, input.commandId, updated);
    if (!saved || saved.row.sequence !== result.sequence) throw new SurveyUnknown();
    return await checkedReceipt(options, memberId, input, saved);
  } catch (error) {
    if (error instanceof SurveyConflict || isAuthorityChanged(error) || isChatRefused(error)) {
      throw error;
    }
    throw new SurveyUnknown();
  }
}

export async function welcomeCommand(options: ChatOptions, memberId: string, body: unknown) {
  const input = inputSchema.parse(body);
  if (Buffer.byteLength(JSON.stringify(body)) > 16384) throw new z.ZodError([]);
  const history = await surveyHistory(options, memberId);
  const prior = await savedCommand(options, memberId, input.commandId, history);
  if (prior) return checkedReceipt(options, memberId, input, prior);
  checkInput(input, history);
  const assignment = input.operation === 'start' ?
    await assistantAssignment(options, memberId) : null;
  if (input.operation === 'start' && assignment?.assigned !==
      (input.variant === 'assistant')) throw new SurveyConflict();
  const event = buildEvent(options, memberId, input, assignment);
  // Finish history and encryption before opening the short access check.
  const fresh = await writeChatAccess(options, { memberId });
  if (assignment) {
    fresh.include(assignment.subject);
    const position = await options.store.head(assignment.subject, fresh.deadline);
    if (position !== assignment.position) throw new SurveyConflict();
  }
  await fresh();
  return appendWelcome(options, memberId, input, history, event, fresh.deadline);
}
