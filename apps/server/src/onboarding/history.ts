import { parseEventByType, surveyRestartedDataSchema, surveyStepSavedDataSchema,
  type EventEnvelope } from '@opencrane/events';
import { readStreamSummary, readEventAt, type StoredEvent, type SummaryKind }
  from '@opencrane/event-store';
import type { ChatOptions } from '../chat/access.ts';

type Reference = ReturnType<typeof surveyReceipt> & {
  sequence: number; previousPosition: number; generation: number;
};
type Survey = { generation: number; position: number; steps: StoredEvent[];
  commands: Map<string, Reference> };
function empty(): Survey {
  return { generation: 1, position: 0, steps: [], commands: new Map() };
}
function add(survey: Survey, row: StoredEvent) {
  const event = row.event;
  if (event.type !== 'onboarding.survey_step_saved' &&
      event.type !== 'onboarding.survey_restarted') return;
  if (!parseEventByType(event).success || !event.commandId) {
    throw new Error('Invalid survey event');
  }
  const reference = { ...surveyReceipt(row), sequence: row.sequence, previousPosition: survey.position,
    generation: survey.generation };
  if (event.type === 'onboarding.survey_restarted') {
    const data = surveyRestartedDataSchema.parse(event.data);
    if (data.generation !== survey.generation + 1) throw new Error('Invalid generation');
    survey.generation = data.generation;
    survey.steps = [];
  } else {
    const data = surveyStepSavedDataSchema.parse(event.data);
    if (data.generation !== survey.generation || data.step > survey.steps.length + 1) {
      throw new Error('Invalid progress');
    }
    survey.steps = survey.steps.slice(0, data.step - 1);
    survey.steps.push(row);
  }
  survey.commands.set(event.commandId, reference);
  survey.position = row.sequence;
}
function size(survey: Survey) {
  return Buffer.byteLength(JSON.stringify(survey.steps)) + survey.commands.size * 512;
}
const kind: SummaryKind<Survey> = { name: 'http-survey', keep: 32, empty, add,
  budget: { limit: 16 * 1024 * 1024, size } };
export function surveyHistory(options: ChatOptions, memberId: string) {
  function take(survey: Survey, sequence: number) {
    return { ...survey, steps: [...survey.steps], commands: new Map(survey.commands), sequence };
  }
  return readStreamSummary(options.store, options.silo, `personal-${memberId}`,
    kind, performance.now() + 10_000, take);
}
export function surveyReceipt(row: StoredEvent) {
  const event = row.event;
  return { status: 'confirmed' as const, commandId: event.commandId, eventId: event.id,
    operation: event.type, time: event.time, position: row.sequence };
}
export async function savedCommand(options: ChatOptions, memberId: string, commandId: string,
  history: Awaited<ReturnType<typeof surveyHistory>>) {
  const reference = history.commands.get(commandId);
  if (!reference) return undefined;
  const row = await readEventAt(options.store, `personal-${memberId}`,
    reference.sequence, performance.now() + 10_000);
  const event = row?.event;
  if (!event || event.commandId !== commandId || event.principal?.id !== memberId ||
      event.principal.kind !== 'human' || !parseEventByType(event).success) {
    throw new Error('Saved command unavailable');
  }
  return { row, reference };
}
export function decryptAnswers(options: ChatOptions, memberId: string, event: EventEnvelope) {
  const data = surveyStepSavedDataSchema.parse(event.data);
  const text = options.keys.decrypt(options.silo, `personal:${memberId}`, data);
  const answers: unknown = JSON.parse(text);
  return answers;
}
