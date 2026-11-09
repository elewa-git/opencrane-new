import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { event as fixtureEvent, natsFixture } from '@opencrane/event-store/testing';
import { handlerSubscriptions, type EventEnvelope } from '@opencrane/events';
import { readHostedAdmission } from '@opencrane/models';
import { databases, until } from '@opencrane/authz/testing';
import { connectProjectionDb } from '@opencrane/projections';
import { HandlerRuntime, dispatch, provisionDispatcher } from '@opencrane/handlers';
import { createLogger } from '@opencrane/observability';
import { hostedImageCheckHandler, recoverHostedImageChecks }
  from '../src/hosted-image-check.ts';
import { trustedHostedImageInputs } from '../src/hosted-image-inputs.ts';

const digest = 'a'.repeat(64);
const serverId = 'saved-image';
const silo = 'test';
let fixture: Awaited<ReturnType<typeof natsFixture>>;
function unusedQuery() { return Promise.resolve({ rows: [] }); }
const transaction = { query: unusedQuery };
function empty() { return Promise.resolve({}); }
function inputs() {
  return Promise.resolve({ prepareImage: empty, readSettings: empty,
    readIndependentChecks: empty });
}

async function setup() {
  fixture = await natsFixture();
}

async function cleanup() {
  await fixture.close();
}

beforeEach(setup);
afterEach(cleanup);

async function saveRegistration() {
  const data = { serverId, registeredBy: 'alice', kind: 'hosted',
    locator: `registry.example/team/image@sha256:${digest}`,
    installation: { attemptId: 1, platform: 'linux/amd64',
      upstream: { host: 'api.github.com', port: 443 } } };
  const base = fixtureEvent('registration', `mcp-${serverId}`, 'mcp.server_registered');
  const event = { ...base, data, principal: { kind: 'human' as const, id: 'alice' } };
  const result = await fixture.store.append({ event, expectedSequence: 0 });
  expect(result).toMatchObject({ status: 'appended' });
  return event;
}

async function callsCheckedWriterOnlyForSavedAttempt() {
  const saved = await saveRegistration();
  const run = vi.fn().mockResolvedValue({ status: 'appended' });
  const handler = hostedImageCheckHandler(fixture.store, silo, run, inputs);
  expect(handlerSubscriptions['check-hosted-image']).toEqual([
    'mcp.server_registered', 'mcp.image_check_requested',
  ]);
  await handler.handle(saved, transaction);
  expect(run).toHaveBeenCalledOnce();
  expect(run).toHaveBeenCalledWith(fixture.store, silo, serverId, 1,
    expect.any(Function), expect.any(Function), expect.any(Function), undefined);
  expect((await readHostedAdmission(fixture.store, silo, serverId))?.status).toBe('checking');

  await handler.handle(saved, transaction);
  expect(run).toHaveBeenCalledTimes(2);
  const foreign = { ...saved, silo: 'other' };
  await handler.handle(foreign, transaction);
  expect(run).toHaveBeenCalledTimes(2);
  const changed = { ...saved, data: { locator: 'changed' } };
  await handler.handle(changed, transaction);
  expect(run).toHaveBeenCalledTimes(2);
}
it('delivers the saved attempt to the checked writer and refuses changed jobs',
  callsCheckedWriterOnlyForSavedAttempt);

async function missingTrustedCustodyNeverClaims() {
  const saved = await saveRegistration();
  const run = vi.fn().mockResolvedValue({ status: 'appended' });
  async function readInputs(event: EventEnvelope) {
    return trustedHostedImageInputs(fixture.store, silo, event);
  }
  const previous = process.env['HOSTED_IMAGE_CUSTODY_FILE'];
  delete process.env['HOSTED_IMAGE_CUSTODY_FILE'];
  try {
    const handler = hostedImageCheckHandler(fixture.store, silo, run, readInputs);
    await expect(handler.handle(saved, transaction)).rejects.toThrow(
      'Trusted image inputs unavailable');
    expect(run).not.toHaveBeenCalled();
  } finally {
    if (previous) process.env['HOSTED_IMAGE_CUSTODY_FILE'] = previous;
  }
}
it('keeps the original scan unclaimed when trusted image custody is absent',
  missingTrustedCustodyNeverClaims);

async function savedAttemptQueuesOneJob() {
  const saved = await saveRegistration();
  const storage = await databases();
  function failed() { throw new Error('Fixture database unavailable'); }
  const db = connectProjectionDb(storage.queue.options.connectionString!, failed);
  const logger = createLogger('image-dispatch-test', { level: 'silent' });
  const handler = hostedImageCheckHandler(fixture.store, silo,
    vi.fn().mockResolvedValue({ status: 'appended' }), inputs);
  const runtime = new HandlerRuntime({ db: db.db, logger, silo, handlers: [handler] });
  await provisionDispatcher(fixture.connection);
  await runtime.start();
  const stop = new AbortController();
  const running = dispatch(fixture.connection, runtime, stop.signal);
  try {
    async function queued() {
      const jobs = await storage.queue.query<{ data: unknown }>(
        "SELECT data FROM pgboss.job WHERE name='check-hosted-image'");
      return jobs.rows.length === 1;
    }
    await until(queued);
    const jobs = await storage.queue.query<{ data: unknown }>(
      "SELECT data FROM pgboss.job WHERE name='check-hosted-image'");
    expect(jobs.rows).toHaveLength(1);
    expect(jobs.rows[0]?.data).toEqual(saved);
  } finally {
    stop.abort();
    await Promise.allSettled([running]);
    await runtime.stop();
    await db.close();
    await storage.close();
  }
}
it('queues one production job when a hosted registration is saved', savedAttemptQueuesOneJob);

async function recoversQueueLossFromEvents() {
  const saved = await saveRegistration();
  const storage = await databases();
  function failed() { throw new Error('Fixture database unavailable'); }
  const db = connectProjectionDb(storage.queue.options.connectionString!, failed);
  const logger = createLogger('image-job-test', { level: 'silent' });
  const run = vi.fn().mockResolvedValue({ status: 'appended' });
  const handler = hostedImageCheckHandler(fixture.store, silo, run, inputs);
  const runtime = new HandlerRuntime({ db: db.db, logger, silo, handlers: [handler] });
  await runtime.start();
  try {
    const queue = await runtime.boss.getQueue('check-hosted-image');
    expect(queue?.expireInSeconds).toBe(1_200);
    const restored = await recoverHostedImageChecks(runtime, fixture.reader, fixture.store);
    expect(restored).toBe(1);
    expect(await recoverHostedImageChecks(runtime, fixture.reader, fixture.store)).toBe(0);
    const jobs = await storage.queue.query<{ data: unknown }>(
      "SELECT data FROM pgboss.job WHERE name='check-hosted-image'");
    expect(jobs.rows).toHaveLength(1);
    expect(jobs.rows[0]?.data).toEqual(saved);
    expect((await readHostedAdmission(fixture.store, silo, serverId))?.status).toBe('checking');
    await runtime.work(1);
    function delivered() { return Promise.resolve(run.mock.calls.length === 1); }
    await until(delivered);
    expect(run).toHaveBeenCalledOnce();
  } finally {
    await runtime.stop();
    await db.close();
    await storage.close();
  }
}
it('recovers a lost image job from saved history without creating scan evidence',
  recoversQueueLossFromEvents);
