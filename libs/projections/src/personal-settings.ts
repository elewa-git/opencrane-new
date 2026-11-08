import { parseEventByType, surveyStepSavedDataSchema, surveyRestartedDataSchema,
  personaRevisedDataSchema, personaApprovedDataSchema,
  welcomeStartedDataSchema, welcomeAnswerRecordedDataSchema, onboardingCompletedDataSchema,
  type EventEnvelope } from '@opencrane/events';
import type { Query } from './db.ts';
import type { Projection } from './runner.ts';

type SavedStep = { step: number; ciphertext: string; ciphertextDigest: string; keyId: string;
  eventId: string; commandId: string; time: string; position: number };
type Survey = { generation: number; steps: SavedStep[]; nextStep: number | null;
  position: number; currentRevision?: number; currentRevisionId?: string;
  revisionCount?: number; approvedRevision?: number; approvedRevisionId?: string;
  approvedTime?: string;
  welcome?: { welcomeId: string; scriptVersion: 'welcome-v1'; variant: 'assistant' | 'no_assistant';
    assignmentStatus: 'assigned' | 'not_requested' | 'provisioning';
    generation: number; revision: number | null; revisionId: string | null;
    assistantId: string | null; startedAt: string; answered: number;
    status: 'welcome_active' | 'completion_pending' | 'completed';
    completedAt?: string; finalAnswerId?: string;
    answers: { eventId: string; commandId: string; position: number;
      encrypted: string; encryptedDigest: string; keyRef: string }[] } };

async function create(db: Query): Promise<void> {
  await db.query(`CREATE TABLE IF NOT EXISTS personal_settings (
    silo TEXT NOT NULL, member_id TEXT NOT NULL, survey JSONB NOT NULL,
    PRIMARY KEY (silo, member_id))`);
  await db.query(`CREATE TABLE IF NOT EXISTS persona_revisions (
    silo TEXT NOT NULL, member_id TEXT NOT NULL, revision INTEGER NOT NULL,
    record JSONB NOT NULL, PRIMARY KEY (silo, member_id, revision))`);
}
async function drop(db: Query): Promise<void> {
  await db.query('DROP TABLE IF EXISTS persona_revisions');
  await db.query('DROP TABLE IF EXISTS personal_settings');
}
export async function readSurvey(db: Query, silo: string, memberId: string): Promise<Survey | null> {
  const result = await db.query<{ survey: Survey }>(
    'SELECT survey FROM personal_settings WHERE silo = $1 AND member_id = $2', [silo, memberId]);
  return result.rows[0]?.survey ?? null;
}
function restartSurvey(survey: Survey, event: EventEnvelope) {
  const data = surveyRestartedDataSchema.parse(event.data);
  if (data.generation !== survey.generation + 1) {
    throw new Error('Invalid survey generation');
  }
  survey.generation = data.generation;
  survey.steps = [];
  survey.nextStep = 1;
  if (survey.welcome?.status !== 'completed') delete survey.welcome;
  delete survey.currentRevision;
  delete survey.currentRevisionId;
}
async function revisePersona(db: Query, survey: Survey, event: EventEnvelope, position: number) {
  const revised = personaRevisedDataSchema.parse(event.data);
  if (survey.steps.length !== 4 || revised.generation !== survey.generation ||
      revised.revision !== (survey.revisionCount ?? 0) + 1) {
    throw new Error('Invalid persona revision');
  }
  const record = { ...revised, eventId: event.id, commandId: event.commandId,
    time: event.time, position };
  await db.query('INSERT INTO persona_revisions VALUES ($1,$2,$3,$4)',
    [event.silo, revised.memberId, revised.revision, JSON.stringify(record)]);
  survey.currentRevision = revised.revision;
  survey.currentRevisionId = event.id;
  survey.revisionCount = revised.revision;
}
function approvePersona(survey: Survey, event: EventEnvelope) {
  const approved = personaApprovedDataSchema.parse(event.data);
  if (approved.generation !== survey.generation ||
      approved.revision !== survey.currentRevision ||
      approved.revisionId !== survey.currentRevisionId) {
    throw new Error('Invalid persona approval');
  }
  survey.approvedRevision = approved.revision;
  survey.approvedRevisionId = approved.revisionId;
  survey.approvedTime = event.time;
}
function startWelcome(survey: Survey, event: EventEnvelope) {
  const data = welcomeStartedDataSchema.parse(event.data);
  if (survey.welcome || data.welcomeId !== event.id ||
      data.generation !== survey.generation || survey.steps.length !== 4) {
    throw new Error('Invalid welcome start');
  }
  if (data.variant === 'assistant' &&
      (survey.approvedRevision !== data.revision ||
       survey.approvedRevisionId !== data.revisionId || !data.assistantId ||
       data.assignmentStatus !== 'assigned')) {
    throw new Error('Invalid welcome revision');
  }
  if (data.variant === 'no_assistant' &&
      (data.revision !== null || data.revisionId !== null || data.assistantId !== null ||
       data.assignmentStatus === 'assigned')) {
    throw new Error('Invalid welcome variant');
  }
  survey.welcome = { welcomeId: data.welcomeId, scriptVersion: data.scriptVersion,
    variant: data.variant, assignmentStatus: data.assignmentStatus,
    generation: data.generation, revision: data.revision,
    revisionId: data.revisionId, assistantId: data.assistantId, startedAt: event.time,
    answered: 0, status: 'welcome_active', answers: [] };
}
function recordWelcomeAnswer(survey: Survey, event: EventEnvelope, position: number) {
  const data = welcomeAnswerRecordedDataSchema.parse(event.data);
  const welcome = survey.welcome;
  const expectedStep = welcome?.variant === 'assistant' ?
    'weekly_help' : 'continue_to_workspace';
  if (!welcome || welcome.answered || data.welcomeId !== welcome.welcomeId ||
      data.generation !== welcome.generation || data.scriptVersion !== welcome.scriptVersion ||
      data.stepId !== expectedStep) throw new Error('Invalid welcome answer');
  welcome.answers.push({ eventId: event.id, commandId: event.commandId!, position,
    encrypted: data.encrypted, encryptedDigest: data.encryptedDigest,
    keyRef: data.keyRef });
  welcome.answered = 1;
  welcome.status = 'completion_pending';
}
function completeWelcome(survey: Survey, event: EventEnvelope) {
  const data = onboardingCompletedDataSchema.parse(event.data);
  const welcome = survey.welcome;
  if (!welcome || welcome.status !== 'completion_pending' ||
      welcome.answers[0]?.eventId !== data.finalAnswerId ||
      welcome.welcomeId !== data.welcomeId || welcome.generation !== data.generation ||
      welcome.scriptVersion !== data.scriptVersion || welcome.variant !== data.variant) {
    throw new Error('Invalid welcome completion');
  }
  welcome.status = 'completed';
  welcome.completedAt = event.time;
  welcome.finalAnswerId = data.finalAnswerId;
}
function saveStep(survey: Survey, event: EventEnvelope, position: number, commandId: string) {
  const data = surveyStepSavedDataSchema.parse(event.data);
  if (data.generation !== survey.generation || data.step > survey.steps.length + 1) {
    throw new Error('Invalid survey progress');
  }
  // Keep later answers in event history. Editing a step removes them from current progress.
  survey.steps = survey.steps.slice(0, data.step - 1);
  const saved: SavedStep = { step: data.step, ciphertext: data.ciphertext,
    ciphertextDigest: data.ciphertextDigest, keyId: data.keyId,
    eventId: event.id, commandId, time: event.time, position };
  survey.steps.push(saved);
  survey.nextStep = data.step === 4 ? null : data.step + 1;
  delete survey.currentRevision;
  delete survey.currentRevisionId;
  if (survey.welcome?.status !== 'completed') delete survey.welcome;
}
const personalTypes = new Set([
  'onboarding.survey_step_saved', 'onboarding.survey_restarted',
  'onboarding.persona_revised', 'onboarding.persona_approved',
  'onboarding.welcome_started', 'onboarding.welcome_answer_recorded',
  'onboarding.completed',
]);
async function apply(db: Query, event: EventEnvelope, position: number): Promise<void> {
  if (!personalTypes.has(event.type)) {
    return;
  }
  if (!parseEventByType(event).success || !event.commandId) {
    throw new Error('Invalid survey event');
  }
  const dataSchema = surveyStepSavedDataSchema.or(surveyRestartedDataSchema)
    .or(personaRevisedDataSchema).or(personaApprovedDataSchema)
    .or(welcomeStartedDataSchema).or(welcomeAnswerRecordedDataSchema)
    .or(onboardingCompletedDataSchema);
  const data = dataSchema.parse(event.data);
  const current = await readSurvey(db, event.silo, data.memberId);
  const survey: Survey = current ?? { generation: 1, steps: [], nextStep: 1, position: 0 };
  if (event.type === 'onboarding.survey_restarted') {
    restartSurvey(survey, event);
  } else if (event.type === 'onboarding.persona_revised') {
    await revisePersona(db, survey, event, position);
  } else if (event.type === 'onboarding.persona_approved') {
    approvePersona(survey, event);
  } else if (event.type === 'onboarding.welcome_started') {
    startWelcome(survey, event);
  } else if (event.type === 'onboarding.welcome_answer_recorded') {
    recordWelcomeAnswer(survey, event, position);
  } else if (event.type === 'onboarding.completed') {
    completeWelcome(survey, event);
  } else {
    saveStep(survey, event, position, event.commandId);
  }
  survey.position = position;
  await db.query(`INSERT INTO personal_settings VALUES ($1,$2,$3)
    ON CONFLICT (silo, member_id) DO UPDATE SET survey = $3`,
  [event.silo, data.memberId, JSON.stringify(survey)]);
}
export const personalSettings: Projection = { name: 'personal-settings', create, drop, apply };
