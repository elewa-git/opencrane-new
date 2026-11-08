import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { event, natsFixture } from '@opencrane/event-store/testing';
import { welcomeCompletionHandler } from '@opencrane/models';
import { HandlerRuntime } from '@opencrane/handlers';
import type { EventEnvelope } from '@opencrane/events';
import { createLogger } from '@opencrane/observability';
import { database } from '../../../libs/projections/test/database.ts';
import { until } from '../../../libs/handlers/test/helpers.ts';
import { recoverWelcomeCompletion } from '../src/welcome-recovery.ts';
import { reactionWorker } from './support/reaction-worker.ts';

let nats: Awaited<ReturnType<typeof natsFixture>>;
let storage: Awaited<ReturnType<typeof database>>;
const logger = createLogger('welcome-recovery-test', { level: 'silent' });

beforeEach(async function setup() {
  nats = await natsFixture();
  storage = await database('pg');
  const joined = event('joined');
  const started = { ...event('welcome-start', 'personal-alice', 'onboarding.welcome_started'),
    source: 'opencrane-server', principal: { kind: 'human' as const, id: 'alice' },
    data: { schemaVersion: 1, memberId: 'alice', generation: 1,
      welcomeId: 'welcome-one', scriptVersion: 'welcome-v1', variant: 'no_assistant',
      assignmentStatus: 'not_requested', revision: null, revisionId: null,
      assistantId: null } };
  const answerExample = event('welcome-answer', 'personal-alice',
    'onboarding.welcome_answer_recorded');
  const answer = { ...answerExample, source: 'opencrane-server',
    principal: { kind: 'human' as const, id: 'alice' },
    data: { ...answerExample.data, schemaVersion: 1, memberId: 'alice', generation: 1,
      welcomeId: 'welcome-one', scriptVersion: 'welcome-v1',
      stepId: 'continue_to_workspace', stepNumber: 1 } };
  expect((await nats.store.append({ event: joined, expectedSequence: 0 })).status)
    .toBe('appended');
  expect((await nats.store.append({ event: started, expectedSequence: 0 })).status)
    .toBe('appended');
  const personalPosition = await nats.store.head('personal-alice');
  expect((await nats.store.append({ event: answer,
    expectedSequence: personalPosition })).status)
    .toBe('appended');
});

afterEach(async function cleanup() {
  vi.restoreAllMocks();
  await storage?.close();
  await nats?.close();
});

function runtime(retryLimit = 2) {
  const handler = welcomeCompletionHandler(nats.store);
  return new HandlerRuntime({ db: storage.db, logger, silo: 'test',
    handlers: [handler], retryLimit, retryDelay: 1 });
}

async function completionCount() {
  let count = 0;
  for await (const row of nats.store.readStream('personal-alice')) {
    if (row.event.type === 'onboarding.completed') count++;
  }
  return count;
}

it('retries an exhausted welcome answer from events after a real runtime restart',
  async function exhaustedAnswer() {
    const first = runtime();
    await first.start();
    const rows = [];
    for await (const row of nats.store.readStream('personal-alice')) rows.push(row);
    const savedAnswer = rows.at(-1)!.event;
    const handler = first.options.handlers[0]!;
    async function enqueue(transaction: Parameters<typeof handler.handle>[1]) {
      await first.enqueue(handler, savedAnswer, transaction);
    }
    await storage.db.transaction(enqueue);
    const originalAppend = nats.store.append.bind(nats.store);
    async function unavailableAppend(command: Parameters<typeof nats.store.append>[0]) {
      const savedEvent = command.event;
      if (typeof savedEvent === 'object' && savedEvent !== null &&
          'type' in savedEvent && savedEvent.type === 'onboarding.completed') {
        throw new Error('event store unavailable');
      }
      return originalAppend(command);
    }
    const outage = vi.spyOn(nats.store, 'append').mockImplementation(unavailableAppend);
    await first.work(1);
    async function exhausted() {
      return (await first.deadLetters('complete-welcome')).length === 1;
    }
    await until(exhausted);
    const failed = (await first.deadLetters('complete-welcome'))[0]!;
    expect(outage).toHaveBeenCalledTimes(3);
    expect(await completionCount()).toBe(0);
    await first.stop();
    outage.mockRestore();

    const restarted = runtime();
    await restarted.start();
    try {
      expect(await recoverWelcomeCompletion(restarted, nats.reader)).toBe(1);
      const jobs = await storage.db.query<{ id: string; state: string }>(
        "SELECT id, state FROM pgboss.job WHERE name='complete-welcome'");
      expect(jobs.rows).toEqual([{ id: failed.id, state: 'retry' }]);
      await restarted.work(1);
      async function completed() {
        return (await completionCount()) === 1;
      }
      await until(completed);
      expect(await recoverWelcomeCompletion(restarted, nats.reader)).toBe(0);
      expect(await completionCount()).toBe(1);
    } finally {
      await restarted.stop();
    }
  }, 60_000);

it('restores a missing answer job from saved events without duplicate completion',
  async function missingJob() {
    const first = runtime();
    await first.start();
    await first.stop();
    const restarted = runtime();
    await restarted.start();
    try {
      expect(await recoverWelcomeCompletion(restarted, nats.reader)).toBe(1);
      expect(await recoverWelcomeCompletion(restarted, nats.reader)).toBe(0);
      await restarted.work(1);
      async function completed() {
        return (await completionCount()) === 1;
      }
      await until(completed);
      expect(await recoverWelcomeCompletion(restarted, nats.reader)).toBe(0);
    } finally {
      await restarted.stop();
    }
  }, 60_000);

it('retries a failed welcome job when the real dispatcher worker restarts',
  async function workerStartupRecovery() {
    const setup = await reactionWorker(true);
    const savedEvents: EventEnvelope[] = [event('joined')];
    for await (const row of nats.store.readStream('personal-alice')) {
      savedEvents.push(row.event);
    }
    await setup.nats.seed(savedEvents);
    await setup.start();
    async function queuedAnswer() {
      const jobs = await setup.storage.queue.query<{ id: string }>(
        "SELECT id FROM pgboss.job WHERE name='complete-welcome'",
      );
      return jobs.rows.length === 1;
    }
    await until(queuedAnswer);
    const queued = await setup.storage.queue.query<{ id: string }>(
      "SELECT id FROM pgboss.job WHERE name='complete-welcome'",
    );
    const jobId = queued.rows[0]!.id;
    await setup.storage.queue.query(
      "UPDATE pgboss.job SET state='failed', retry_count=5 WHERE id=$1", [jobId]);
    await setup.stop();

    await setup.start();
    const recovered = await setup.storage.queue.query<{ id: string; state: string }>(
      "SELECT id, state FROM pgboss.job WHERE name='complete-welcome'",
    );
    expect(recovered.rows).toEqual([{ id: jobId, state: 'retry' }]);
    await setup.stop();
  }, 60_000);
