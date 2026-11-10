import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { parseEventByType, welcomeArchiveSetDataSchema, welcomeStartedDataSchema,
  type EventEnvelope } from '@opencrane/events';
import { isAuthorityChanged } from '@opencrane/models';
import { chatAccess, isChatRefused, writeChatAccess, type ChatOptions }
  from '../chat/access.ts';
import { idSchema } from '../members/guard.ts';
import { SurveyConflict, SurveyUnknown } from './commands.ts';
import { savedCommand, surveyHistory, surveyReceipt } from './history.ts';

const archiveInput = z.strictObject({
  commandId: idSchema, welcomeId: idSchema, archived: z.boolean(),
  expectedArchivePosition: z.int().nonnegative(),
});
type Input = z.infer<typeof archiveInput>;
type History = Awaited<ReturnType<typeof surveyHistory>>;
type Saved = NonNullable<Awaited<ReturnType<typeof savedCommand>>>;

export class WelcomeNotFound extends Error {}

function checkWelcome(history: History, input: Input) {
  const welcome = history.welcome;
  if (!welcome?.completion || welcome.start.event.id !== input.welcomeId) {
    throw new WelcomeNotFound();
  }
  if (input.expectedArchivePosition !== welcome.archive.position &&
      input.archived !== welcome.archive.archived) throw new SurveyConflict();
}

function archiveEvent(options: ChatOptions, memberId: string, input: Input,
  history: History): EventEnvelope {
  const started = welcomeStartedDataSchema.parse(history.welcome?.start.event.data);
  const data = { schemaVersion: 1 as const, memberId, generation: started.generation,
    welcomeId: input.welcomeId, archived: input.archived };
  const event: EventEnvelope = { id: randomUUID(), commandId: input.commandId,
    type: 'onboarding.welcome_archive_set', source: 'opencrane-server',
    time: new Date().toISOString(), silo: options.silo, subject: `personal-${memberId}`,
    principal: { kind: 'human', id: memberId }, correlation: {}, data };
  if (!parseEventByType(event).success) throw new z.ZodError([]);
  return event;
}

async function checkedReceipt(options: ChatOptions, memberId: string, input: Input,
  saved: Saved) {
  // Check membership after reading the original event, before returning its result.
  await chatAccess(options, { memberId });
  const data = welcomeArchiveSetDataSchema.safeParse(saved.row.event.data);
  if (saved.row.event.type !== 'onboarding.welcome_archive_set' || !data.success ||
      data.data.welcomeId !== input.welcomeId || data.data.archived !== input.archived ||
      saved.reference.previousArchivePosition !== input.expectedArchivePosition) {
    throw new SurveyConflict();
  }
  return surveyReceipt(saved.row);
}

export async function welcomeArchiveCommand(options: ChatOptions, memberId: string,
  body: unknown) {
  const input = archiveInput.parse(body);
  const history = await surveyHistory(options, memberId);
  const previous = await savedCommand(options, memberId, input.commandId, history);
  if (previous) return checkedReceipt(options, memberId, input, previous);
  checkWelcome(history, input);
  const event = archiveEvent(options, memberId, input, history);
  // Load personal history before the short check of access-granting streams.
  const fresh = await writeChatAccess(options, { memberId });
  await fresh();
  try {
    const result = await options.store.append({ event, expectedSequence: history.sequence,
      deadline: fresh.deadline, historyChecked: true });
    if (result.status === 'conflict' || result.status === 'rejected') {
      throw new SurveyConflict();
    }
    if (result.status !== 'appended') throw new SurveyUnknown();
    const updated = await surveyHistory(options, memberId);
    const saved = await savedCommand(options, memberId, input.commandId, updated);
    if (!saved || saved.row.sequence !== result.sequence) throw new SurveyUnknown();
    return await checkedReceipt(options, memberId, input, saved);
  } catch (error) {
    if (error instanceof SurveyConflict || isAuthorityChanged(error) ||
        isChatRefused(error)) throw error;
    throw new SurveyUnknown();
  }
}
