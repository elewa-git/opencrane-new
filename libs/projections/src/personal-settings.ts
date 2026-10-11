import { parseEventByType, surveyStepSavedDataSchema, surveyRestartedDataSchema,
  type EventEnvelope } from '@opencrane/events';
import type { Query } from './db.ts';
import type { Projection } from './runner.ts';

type SavedStep = { step: number; ciphertext: string; ciphertextDigest: string; keyId: string;
  eventId: string; commandId: string; time: string; position: number };
type Survey = { generation: number; steps: SavedStep[]; nextStep: number | null;
  position: number };

async function create(db: Query): Promise<void> {
  await db.query(`CREATE TABLE IF NOT EXISTS personal_settings (
    silo TEXT NOT NULL, member_id TEXT NOT NULL, survey JSONB NOT NULL,
    PRIMARY KEY (silo, member_id))`);
}
async function drop(db: Query): Promise<void> {
  await db.query('DROP TABLE IF EXISTS personal_settings');
}
export async function readSurvey(db: Query, silo: string, memberId: string): Promise<Survey | null> {
  const result = await db.query<{ survey: Survey }>(
    'SELECT survey FROM personal_settings WHERE silo = $1 AND member_id = $2', [silo, memberId]);
  return result.rows[0]?.survey ?? null;
}
async function apply(db: Query, event: EventEnvelope, position: number): Promise<void> {
  if (event.type !== 'onboarding.survey_step_saved' &&
      event.type !== 'onboarding.survey_restarted') {
    return;
  }
  if (!parseEventByType(event).success || !event.commandId) {
    throw new Error('Invalid survey event');
  }
  const dataSchema = surveyStepSavedDataSchema.or(surveyRestartedDataSchema);
  const data = dataSchema.parse(event.data);
  const current = await readSurvey(db, event.silo, data.memberId);
  const survey: Survey = current ?? { generation: 1, steps: [], nextStep: 1, position: 0 };
  if (event.type === 'onboarding.survey_restarted') {
    if (data.generation !== survey.generation + 1) {
      throw new Error('Invalid survey generation');
    }
    survey.generation = data.generation;
    survey.steps = [];
    survey.nextStep = 1;
  } else {
    if (!('step' in data) || data.generation !== survey.generation ||
        data.step > survey.steps.length + 1) {
      throw new Error('Invalid survey progress');
    }
    // Keep later answers in event history. Editing a step removes them from current progress.
    survey.steps = survey.steps.slice(0, data.step - 1);
    const saved: SavedStep = { step: data.step, ciphertext: data.ciphertext,
      ciphertextDigest: data.ciphertextDigest, keyId: data.keyId,
      eventId: event.id, commandId: event.commandId, time: event.time, position };
    survey.steps.push(saved);
    survey.nextStep = data.step === 4 ? null : data.step + 1;
  }
  survey.position = position;
  await db.query(`INSERT INTO personal_settings VALUES ($1,$2,$3)
    ON CONFLICT (silo, member_id) DO UPDATE SET survey = $3`,
  [event.silo, data.memberId, JSON.stringify(survey)]);
}
export const personalSettings: Projection = { name: 'personal-settings', create, drop, apply };
