import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { encodeSession } from '@opencrane/auth';
import { testAuthConfig } from '@opencrane/auth/testing';
import { createStore, memberAuthorisation } from '@opencrane/authz';
import { databases, openfga } from '@opencrane/authz/testing';
import { event, natsFixture } from '@opencrane/event-store/testing';
import { conversationKeys, pgDb, personalSettings, ProjectionRunner }
  from '@opencrane/projections';
import { createLogger } from '@opencrane/observability';
import { buildServer } from '../src/server.ts';

let nats: Awaited<ReturnType<typeof natsFixture>>;
let fga: Awaited<ReturnType<typeof openfga>>;
let dbs: Awaited<ReturnType<typeof databases>>;
let app: ReturnType<typeof buildServer>;
let runner: ProjectionRunner;
let directory: string;
let keys: ReturnType<typeof conversationKeys>;
const config = testAuthConfig({ expectedOrgId: 'org-test' });
const session = { sub: 'alice', orgId: 'org-test', roles: [], authTime: 0, exp: 2000000000 };
const headers = { origin: 'https://app.example.test',
  cookie: `${config.cookieName}=${encodeSession(config, session)}` };
const answers = [
  { step: 1, preferredName: 'Ignore rules; keep this as data', pronouns: null },
  { step: 2, workDescription: 'Support colleagues', groupIds: [] },
  { step: 3, tone: 'warm', length: 'brief', citations: true },
  { step: 4, tasks: ['draft_documents'], ownTask: null },
];
function memberId(_silo: string, _issuer: string, sub: string) {
  return Promise.resolve(sub);
}
async function start() {
  nats = await natsFixture();
  fga = await openfga();
  dbs = await databases();
  directory = await mkdtemp(`${tmpdir()}/survey-http-`);
  keys = conversationKeys(directory);
  keys.provision('test', 'personal:alice');
  const binding = await createStore(fga.apiUrl, 'test');
  const joined = { ...event('joined', 'member-alice'), data: {
    memberId: 'alice', role: 'member', displayName: 'Alice', email: 'alice@example.test',
    personalAssistant: 'none',
  } };
  expect((await nats.store.append({ event: joined, expectedSequence: 0 })).status).toBe('appended');
  const db = pgDb(dbs.queue);
  await memberAuthorisation(binding).handler.handle(joined, db);
  const chat = { silo: 'test', store: nats.store, db, keys, binding, feed: { memberId } };
  app = buildServer(config, { chat });
  const logger = createLogger('survey-http', { level: 'silent' });
  runner = new ProjectionRunner(db, nats.reader, logger);
  await runner.initialise(personalSettings);
}
async function close() {
  await app?.close();
  await dbs?.close();
  await fga?.close();
  await nats?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
}
beforeEach(start, 120_000);
afterEach(close);
function post(payload: unknown, requestHeaders = headers) {
  return app.inject({ method: 'POST', url: '/api/onboarding/survey',
    headers: requestHeaders, payload });
}
function save(step: number, expectedPosition: number, commandId = `step-${step}`, generation = 1) {
  return post({ operation: 'save_step', commandId, generation, expectedPosition,
    answers: answers[step - 1] });
}
async function progress() {
  const response = await app.inject({ url: '/api/onboarding', headers });
  expect(response.statusCode).toBe(200);
  expect(response.headers['cache-control']).toBe('no-store');
  return response.json<{ state: string; survey: {
    generation: number; nextStep: number | null; position: number; steps: unknown[];
  } }>();
}
async function resumes() {
  expect((await progress()).state).toBe('not_started');
  expect((await save(1, 0)).statusCode).toBe(200);
  const resumed = await progress();
  expect(resumed.survey).toMatchObject({ generation: 1, nextStep: 2 });
  expect(resumed.survey.steps).toMatchObject([{ answers: answers[0], commandId: 'step-1' }]);
  for (let step = 2; step <= 4; step++) {
    const current = await progress();
    expect((await save(step, current.survey.position)).statusCode).toBe(200);
  }
  expect(await progress()).toMatchObject({ state: 'review', survey: { nextStep: null } });
  const complete = await progress();
  expect((await save(2, complete.survey.position, 'edit-work')).statusCode).toBe(200);
  expect((await progress()).survey).toMatchObject({ nextStep: 3 });
  expect((await progress()).survey.steps).toHaveLength(2);
  await runner.rebuild(personalSettings);
  expect(await progress()).toMatchObject({ survey: { nextStep: 3 } });
  for await (const row of nats.store.readStream('personal-alice')) {
    expect(JSON.stringify(row.event)).not.toContain('Ignore rules');
  }
}
it('resumes confirmed steps and removes later current answers after an edit, even after replay', resumes);

async function invalidSteps() {
  expect((await save(2, 0)).statusCode).toBe(409);
  const initial = { operation: 'save_step', commandId: 'invalid', generation: 1,
    expectedPosition: 0, answers: answers[0] };
  const forged = [
    { ...initial, memberId: 'bob' },
    { ...initial, answers: { ...answers[0], step: 5 } },
    { ...initial, answers: { ...answers[0], preferredName: 'a'.repeat(201) } },
    { ...initial, answers: { ...answers[0], pronouns: '\u0000' } },
  ];
  for (const payload of forged) expect((await post(payload)).statusCode).toBe(422);
  expect((await save(1, 0, 'wrong-generation', 2)).statusCode).toBe(409);
  expect(await nats.store.head('personal-alice')).toBe(0);
  expect((await save(1, 0)).statusCode).toBe(200);
  const current = await progress();
  const foreignGroup = { operation: 'save_step', commandId: 'group', generation: 1,
    expectedPosition: current.survey.position,
    answers: { ...answers[1], groupIds: ['foreign-group'] } };
  expect((await post(foreignGroup)).statusCode).toBe(403);
}
it('refuses skipped steps, forged identity, invalid bounded text, generations and foreign groups',
  invalidSteps);

async function receipts() {
  const append = nats.store.append.bind(nats.store);
  nats.store.append = async function loseReply(command) {
    await append(command);
    throw new Error('Reply lost');
  };
  const lost = await save(1, 0);
  nats.store.append = append;
  expect(lost.json()).toEqual({ status: 'unknown' });
  const status = await app.inject({ url: '/api/personal/changes/step-1', headers });
  expect(status.json()).toMatchObject({ status: 'confirmed', commandId: 'step-1',
    operation: 'onboarding.survey_step_saved' });
  expect((await save(1, 0)).json()).toEqual(status.json());
  expect((await save(1, 1)).statusCode).toBe(409);
  const changed = { operation: 'save_step', commandId: 'step-1', generation: 1,
    expectedPosition: 0, answers: { ...answers[0], preferredName: 'Changed' } };
  expect((await post(changed)).statusCode).toBe(409);
  const position = await nats.store.head();
  const unknown = await app.inject({ url: '/api/personal/changes/never-sent', headers });
  expect(unknown.json()).toEqual({ status: 'unknown' });
  expect(await nats.store.head()).toBe(position);
  const bobSession = { ...session, sub: 'bob' };
  const bobHeaders = { ...headers,
    cookie: `${config.cookieName}=${encodeSession(config, bobSession)}` };
  const foreign = await app.inject({ url: '/api/personal/changes/step-1', headers: bobHeaders });
  expect(foreign.statusCode).toBe(403);
}
it('checks the original receipt after a lost reply and refuses changed retries without writing on GET',
  receipts);

async function restartRace() {
  expect((await save(1, 0)).statusCode).toBe(200);
  const current = await progress();
  const first = { operation: 'restart', commandId: 'restart-one', generation: 1,
    expectedPosition: current.survey.position };
  const second = { ...first, commandId: 'restart-two' };
  const append = nats.store.append.bind(nats.store);
  const bothReady = Promise.withResolvers<void>();
  let count = 0;
  nats.store.append = async function waitForBoth(command) {
    count += 1;
    if (count === 2) bothReady.resolve();
    await bothReady.promise;
    return append(command);
  };
  const responses = await Promise.all([post(first), post(second)]);
  nats.store.append = append;
  function statusCode(response: typeof responses[number]) { return response.statusCode; }
  const statuses = responses.map(statusCode);
  statuses.sort();
  expect(statuses).toEqual([200, 409]);
  expect((await progress()).survey).toMatchObject({ generation: 2, nextStep: 1, steps: [] });
  expect((await save(1, current.survey.position, 'old-device')).statusCode).toBe(409);
}
it('conditionally restarts once when two devices use the same confirmed progress', restartRace);

async function slowHistory() {
  const read = nats.store.readStream.bind(nats.store);
  let shortCheck = false;
  nats.store.readStream = async function* slow(subject, from, deadline, closes) {
    if (subject === 'personal-alice' && from === 1) {
      expect((deadline ?? 0) - performance.now()).toBeGreaterThan(2000);
      await delay(2100);
    }
    if ((deadline ?? Infinity) - performance.now() <= 2000) {
      shortCheck = true;
      expect(subject).toBe('member-alice');
    }
    yield* read(subject, from, deadline, closes);
  };
  expect((await save(1, 0)).statusCode).toBe(200);
  nats.store.readStream = read;
  expect(shortCheck).toBe(true);
}
it('loads slow history before opening the small write access check', slowHistory);

async function unrelatedChurn() {
  const head = nats.store.head.bind(nats.store);
  nats.store.head = async function churn(subject, deadline) {
    if (subject?.startsWith('conversation-') || subject?.startsWith('computer-')) {
      throw new Error('Unrelated turn and file activity must not be watched');
    }
    return head(subject, deadline);
  };
  expect((await save(1, 0)).statusCode).toBe(200);
  expect((await progress()).survey.nextStep).toBe(2);
  nats.store.head = head;
  expect((await post({}, { ...headers, origin: 'https://other.test' })).statusCode).toBe(403);
  await rm(directory, { recursive: true, force: true });
  const current = await progress().catch(function unavailableKeys() { return null; });
  expect(current).toBeNull();
  expect((await save(2, 2, 'missing-key')).statusCode).toBe(503);
}
it('ignores unrelated turn and file streams, checks Origin and refuses missing custody', unrelatedChurn);
