import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { EventStore, StoredEvent } from '@opencrane/event-store';
import { assistantCreatedDataSchema, onboardingCompletedDataSchema,
  parseEventByType, welcomeAnswerRecordedDataSchema, welcomeStartedDataSchema,
  type EventEnvelope } from '@opencrane/events';
import { registerHandler } from '@opencrane/handlers';
import { authorityFence } from './authority.ts';
import { currentMembership } from './ownership.ts';

type Store = Pick<EventStore, 'readStream' | 'head' | 'append'>;

function completionId(silo: string, memberId: string, answerId: string): string {
  const hash = createHash('sha256');
  hash.update([silo, memberId, answerId].join('\0'));
  const digest = hash.digest('hex');
  const suffix = digest.slice(0, 32);
  return `welcome-complete-${suffix}`;
}

async function personalHistory(store: Store, subject: string): Promise<StoredEvent[]> {
  const rows: StoredEvent[] = [];
  const deadline = performance.now() + 10_000;
  for await (const row of store.readStream(subject, 1, deadline)) rows.push(row);
  return rows;
}

function currentWelcome(rows: StoredEvent[]) {
  let start: StoredEvent | undefined;
  let answer: StoredEvent | undefined;
  let completed: StoredEvent | undefined;
  for (const row of rows) {
    if (row.event.type === 'onboarding.welcome_started') {
      start = row;
      answer = undefined;
    } else if (row.event.type === 'onboarding.welcome_answer_recorded') {
      answer = row;
    } else if (row.event.type === 'onboarding.completed') {
      completed = row;
    } else if ((row.event.type === 'onboarding.survey_restarted' ||
        row.event.type === 'onboarding.survey_step_saved') && !completed) {
      start = undefined;
      answer = undefined;
    }
  }
  return { start, answer, completed };
}

async function checkAssistant(store: Store, silo: string, memberId: string,
  assistantId: string) {
  const hash = createHash('sha256');
  hash.update([silo, memberId].join('\0'));
  const digest = hash.digest('hex');
  const suffix = digest.slice(0, 32);
  const expectedId = `personal-${suffix}`;
  if (assistantId !== expectedId) throw new Error('Invalid welcome assistant');
  const subject = `assistant-${assistantId}`;
  const deadline = performance.now() + 10_000;
  const position = await store.head(subject, deadline);
  for await (const row of store.readStream(subject, 1, deadline)) {
    const event = row.event;
    if (event.type !== 'assistant.created' || event.silo !== silo ||
        event.source !== 'opencrane-lifecycle' ||
        event.principal?.kind !== 'system' ||
        event.principal.id !== 'computer-lifecycle' ||
        !parseEventByType(event).success) break;
    const data = assistantCreatedDataSchema.parse(event.data);
    if (data.kind === 'personal' && data.ownerId === memberId &&
        data.assistantId === assistantId) return { subject, position };
    break;
  }
  throw new Error('Welcome assistant unavailable');
}

function completionEvent(answer: EventEnvelope, start: EventEnvelope): EventEnvelope {
  const savedStart = welcomeStartedDataSchema.parse(start.data);
  const id = completionId(answer.silo, savedStart.memberId, answer.id);
  const event: EventEnvelope = {
    id, commandId: id, type: 'onboarding.completed', source: 'opencrane-ops',
    time: new Date().toISOString(), silo: answer.silo,
    subject: `personal-${savedStart.memberId}`,
    principal: { kind: 'system', id: 'onboarding-completion' }, correlation: {},
    data: { schemaVersion: 1, memberId: savedStart.memberId,
      generation: savedStart.generation, welcomeId: savedStart.welcomeId,
      scriptVersion: savedStart.scriptVersion, variant: savedStart.variant,
      finalAnswerId: answer.id, confirmationRef: 'welcome-v1-complete' },
  };
  if (!parseEventByType(event).success) throw new Error('Invalid welcome completion');
  return event;
}

function matchesFrozenAnswer(startRow: StoredEvent, answerRow: StoredEvent,
  trigger: EventEnvelope): boolean {
  const start = welcomeStartedDataSchema.parse(startRow.event.data);
  const answer = welcomeAnswerRecordedDataSchema.parse(trigger.data);
  const expectedStep = start.variant === 'assistant' ? 'weekly_help' : 'continue_to_workspace';
  return start.memberId === answer.memberId &&
    start.generation === answer.generation &&
    start.welcomeId === answer.welcomeId &&
    start.scriptVersion === answer.scriptVersion &&
    answer.stepId === expectedStep && answer.stepNumber === 1 &&
    answerRow.sequence > startRow.sequence;
}

function checkedIntent(trigger: EventEnvelope, rows: StoredEvent[]) {
  const welcome = currentWelcome(rows);
  if (welcome.answer?.event.id === trigger.id &&
      !isDeepStrictEqual(welcome.answer.event, trigger)) {
    throw new Error('Welcome intent differs from saved answer');
  }
  if (welcome.completed) {
    const saved = onboardingCompletedDataSchema.parse(welcome.completed.event.data);
    if (saved.finalAnswerId === trigger.id && welcome.answer &&
        isDeepStrictEqual(welcome.answer.event, trigger)) {
      return { status: 'completed' as const };
    }
    return { status: 'stale' as const };
  }
  if (!welcome.start || !welcome.answer ||
      !isDeepStrictEqual(welcome.answer.event, trigger) ||
      !parseEventByType(welcome.start.event).success ||
      !parseEventByType(welcome.answer.event).success) {
    return { status: 'stale' as const };
  }
  if (!matchesFrozenAnswer(welcome.start, welcome.answer, trigger)) {
    return { status: 'stale' as const };
  }
  return { status: 'pending' as const, start: welcome.start.event, position: rows.at(-1)!.sequence };
}

async function savedCompletion(store: Store, subject: string, answerId: string) {
  const welcome = currentWelcome(await personalHistory(store, subject));
  const completed = welcome.completed;
  if (!completed) return undefined;
  const data = onboardingCompletedDataSchema.parse(completed.event.data);
  if (data.finalAnswerId !== answerId) return undefined;
  return { status: 'completed' as const, eventId: completed.event.id,
    commandId: completed.event.commandId, time: completed.event.time,
    position: completed.sequence };
}

async function checkedAssistantSubject(store: Store, trigger: EventEnvelope,
  memberId: string, startEvent: EventEnvelope) {
  const start = welcomeStartedDataSchema.parse(startEvent.data);
  if (start.variant === 'assistant') {
    if (!start.assistantId) throw new Error('Welcome assistant unavailable');
    return checkAssistant(store, trigger.silo, memberId, start.assistantId);
  }
  if (start.assistantId || start.assignmentStatus === 'assigned') {
    throw new Error('Invalid welcome assignment');
  }
  return undefined;
}

async function appendCompletion(store: Store, trigger: EventEnvelope,
  event: EventEnvelope, position: number, deadline: number,
  checkAccess: () => Promise<void>) {
  try {
    const result = await store.append({ event, expectedSequence: position,
      deadline, historyChecked: true, checkAccess });
    if (result.status === 'appended') {
      const saved = await savedCompletion(store, event.subject, trigger.id);
      if (saved) return saved;
      throw new Error('Welcome completion result unavailable');
    }
    if (result.status !== 'conflict') throw new Error('Welcome completion unavailable');
  } catch (error) {
    const saved = await savedCompletion(store, event.subject, trigger.id);
    if (saved?.eventId === event.id) return saved;
    throw error;
  }
  const saved = await savedCompletion(store, event.subject, trigger.id);
  if (saved?.eventId === event.id) return saved;
  const latest = currentWelcome(await personalHistory(store, event.subject));
  if (!latest.start) return { status: 'stale' as const };
  throw new Error('Welcome completion conflict');
}

async function completeWelcome(store: Store, trigger: EventEnvelope) {
  if (trigger.type !== 'onboarding.welcome_answer_recorded' ||
      !parseEventByType(trigger).success) throw new Error('Invalid welcome intent');
  const answer = welcomeAnswerRecordedDataSchema.parse(trigger.data);
  const rows = await personalHistory(store, `personal-${answer.memberId}`);
  const intent = checkedIntent(trigger, rows);
  if (intent.status === 'completed') {
    return savedCompletion(store, trigger.subject, trigger.id);
  }
  if (intent.status === 'stale') return { status: 'stale' as const };
  const assistantSubject = await checkedAssistantSubject(store, trigger,
    answer.memberId, intent.start);
  const subjects = [`member-${answer.memberId}`];
  if (assistantSubject) subjects.push(assistantSubject.subject);
  const fresh = await authorityFence(store, performance.now(), subjects);
  if (assistantSubject) {
    const position = await store.head(assistantSubject.subject, fresh.deadline);
    if (position !== assistantSubject.position) throw new Error('Welcome assignment changed');
  }
  const membership = await currentMembership(store, trigger.silo, answer.memberId,
    undefined, fresh.deadline);
  if (!membership.role) return { status: 'paused' as const };
  await fresh();
  const event = completionEvent(trigger, intent.start);
  return appendCompletion(store, trigger, event, intent.position, fresh.deadline, fresh);
}

export function welcomeCompletionHandler(store: Store) {
  async function handle(event: EventEnvelope): Promise<void> {
    await completeWelcome(store, event);
  }
  return registerHandler('complete-welcome', handle);
}
