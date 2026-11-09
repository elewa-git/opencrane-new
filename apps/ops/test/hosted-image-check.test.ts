import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { event as fixtureEvent, natsFixture } from '@opencrane/event-store/testing';
import { handlerSubscriptions, hostedImageCheckedSchema, type EventEnvelope }
  from '@opencrane/events';
import { inspectHostedLicences, inspectHostedVulnerabilities, readHostedAdmission,
  verifyHostedImage } from '@opencrane/models';
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
async function mockIndependentTools(importOriginal: () => Promise<typeof import('@opencrane/models')>) {
  const original = await importOriginal();
  return { ...original, verifyHostedImage: vi.fn(), inspectHostedLicences: vi.fn(),
    inspectHostedVulnerabilities: vi.fn() };
}
vi.mock('@opencrane/models', mockIndependentTools);
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

async function custodyFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'hosted-image-inputs-'));
  const imageDirectory = join(directory, silo, digest);
  const blobsDirectory = join(imageDirectory, 'blobs');
  await mkdir(blobsDirectory, { recursive: true });
  const layerDigest = 'b'.repeat(64);
  const config = { rootfs: { diff_ids: [`sha256:${layerDigest}`] } };
  const manifest = { layers: [{ digest: `sha256:${layerDigest}`,
    mediaType: 'application/vnd.oci.image.layer.v1.tar', size: 1 }] };
  await writeFile(join(imageDirectory, 'config.json'), JSON.stringify(config));
  await writeFile(join(imageDirectory, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(join(blobsDirectory, layerDigest), 'x');
  await writeFile(join(directory, 'signature.json'), '{}');
  await writeFile(join(directory, 'ca.pem'), 'ca');
  await writeFile(join(directory, 'key.pem'), 'key');
  const settings = { silo, bundleDirectory: directory,
    trust: { version: 1, repository: 'registry.example/team/image',
      publicKey: 'fixture', revoked: false },
    scanner: { url: 'https://scanner.example/scan/image-part',
      caFile: join(directory, 'ca.pem'), privateKeyPath: join(directory, 'key.pem'),
      issuer: 'fixture', imageDigest: `sha256:${digest}`,
      manifestDigest: `sha256:${digest}` },
    tools: { cosign: 'cosign', syft: 'syft', osiPath: 'osi', reviewPath: 'review',
      binaryPath: 'grype', databasePath: 'database', databaseDigest: digest } };
  const custodyPath = join(directory, 'custody.json');
  await writeFile(custodyPath, JSON.stringify(settings));
  return { directory, custodyPath };
}

function toolOutcome(failed: boolean) {
  if (failed) return { verdict: 'fail', reasonCode: 'licence_refused' } as const;
  const evidence = { imageDigest: digest, platform: 'linux/amd64', trustVersion: 1,
    trustDigest: digest, signerDigest: digest, sbomDigest: digest, reviewDigest: digest };
  return { verdict: 'pass', evidence } as const;
}

async function failedCheckReachesQueuedWriter(failedCheck: 'signature' | 'licence' |
  'vulnerability') {
  await saveRegistration();
  const custody = await custodyFixture();
  const previous = process.env['HOSTED_IMAGE_CUSTODY_FILE'];
  process.env['HOSTED_IMAGE_CUSTODY_FILE'] = custody.custodyPath;
  const storage = await databases();
  function failed() { throw new Error('Fixture database unavailable'); }
  const db = connectProjectionDb(storage.queue.options.connectionString!, failed);
  const logger = createLogger('image-input-test', { level: 'silent' });
  const signature = vi.mocked(verifyHostedImage);
  const licence = vi.mocked(inspectHostedLicences);
  const vulnerability = vi.mocked(inspectHostedVulnerabilities);
  signature.mockResolvedValue(toolOutcome(failedCheck === 'signature'));
  licence.mockResolvedValue(toolOutcome(failedCheck === 'licence'));
  const checkedAt = new Date(Date.now() - 1_000).toISOString();
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const receipt = { verdict: 'fail' as const, checkedAt, expiresAt,
    engineVersion: '0.121.0', databaseDigest: digest, databaseUpdatedAt: checkedAt,
    reportDigest: digest, reasonCodes: ['vulnerability_refused'] };
  vulnerability.mockResolvedValue({ verdict: 'fail', reasonCode: 'vulnerability_refused',
    receipt });
  const delivered = vi.fn<(checks: unknown) => void>();
  async function scan(_store: typeof fixture.store, _silo: string, _serverId: string,
    _attemptId: number, _prepareImage: unknown, _readSettings: unknown,
    readIndependentChecks: (attempt: unknown) => Promise<unknown>) {
    const attempt = { silo, serverId, attemptId: 1, imageDigest: digest,
      platform: 'linux/amd64' };
    const checks = await readIndependentChecks(attempt);
    delivered(checks);
    return { status: 'appended' };
  }
  async function readInputs(event: EventEnvelope) {
    return trustedHostedImageInputs(fixture.store, silo, event);
  }
  const handler = hostedImageCheckHandler(fixture.store, silo, scan, readInputs);
  const runtime = new HandlerRuntime({ db: db.db, logger, silo, handlers: [handler] });
  await runtime.start();
  try {
    expect(await recoverHostedImageChecks(runtime, fixture.reader, fixture.store)).toBe(1);
    await runtime.work(1);
    function wasDelivered() { return Promise.resolve(delivered.mock.calls.length === 1); }
    await until(wasDelivered);
    const checks = hostedImageCheckedSchema.shape.checks.parse(delivered.mock.calls[0]?.[0]);
    expect(checks).toMatchObject({
      [failedCheck]: { verdict: 'fail' },
    });
    expect(checks.signature).toBeDefined();
    expect(checks.licence).toBeDefined();
    expect(checks.vulnerability).toBeDefined();
    if (failedCheck === 'signature') {
      expect(checks.licence).toEqual({ verdict: 'not_run' });
      expect(checks.vulnerability).toEqual({ verdict: 'not_run' });
    }
    if (failedCheck === 'licence') {
      expect(checks.vulnerability).toEqual({ verdict: 'not_run' });
    }
  } finally {
    await runtime.stop();
    await db.close();
    await storage.close();
    await rm(custody.directory, { recursive: true, force: true });
    if (previous) process.env['HOSTED_IMAGE_CUSTODY_FILE'] = previous;
    else delete process.env['HOSTED_IMAGE_CUSTODY_FILE'];
  }
}
it.each(['signature', 'licence', 'vulnerability'] as const)(
  'delivers a failed %s receipt from the trusted adapter through the queued job',
  failedCheckReachesQueuedWriter);
