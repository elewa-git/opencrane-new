import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tokenIssuer } from '@opencrane/auth';
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
import { sharedCertificates } from '../../../libs/event-store/test/certificates.ts';
import { createScannerService } from '../../../infra/clamav/service.mjs';
import { runAndWriteHostedImageCheck } from '../../../infra/clamav/image-worker.mjs';

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

async function saveRegistration(imageDigest = digest) {
  const data = { serverId, registeredBy: 'alice', kind: 'hosted',
    locator: `registry.example/team/image@sha256:${imageDigest}`,
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
  'vulnerability' | 'nested-licence' | 'nested-signature') {
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
  if (failedCheck === 'nested-licence' || failedCheck === 'nested-signature') {
    const reasonCode = failedCheck === 'nested-licence'
      ? 'licence_refused' : 'signature_refused';
    vulnerability.mockResolvedValue({ verdict: 'fail', reasonCode });
  } else {
    vulnerability.mockResolvedValue({ verdict: 'fail', reasonCode: 'vulnerability_refused',
      receipt });
  }
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
    const checkSchema = hostedImageCheckedSchema.shape.checks.omit({ malware: true });
    const checks = checkSchema.parse(delivered.mock.calls[0]?.[0]);
    let refusedCheck = failedCheck;
    if (failedCheck === 'nested-licence') refusedCheck = 'licence';
    if (failedCheck === 'nested-signature') refusedCheck = 'signature';
    expect(checks).toMatchObject({ [refusedCheck]: { verdict: 'fail' } });
    expect(checks.signature).toBeDefined();
    expect(checks.licence).toBeDefined();
    expect(checks.vulnerability).toBeDefined();
    if (refusedCheck === 'signature') {
      expect(checks.licence).toEqual({ verdict: 'not_run' });
      expect(checks.vulnerability).toEqual({ verdict: 'not_run' });
    }
    if (refusedCheck === 'licence') {
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
it.each(['signature', 'licence', 'vulnerability', 'nested-licence', 'nested-signature'] as const)(
  'delivers a failed %s receipt from the trusted adapter through the queued job',
  failedCheckReachesQueuedWriter);

async function unavailableIndependentCheck(checkName: 'signature' | 'licence') {
  const registration = await saveRegistration();
  const custody = await custodyFixture();
  const previous = process.env['HOSTED_IMAGE_CUSTODY_FILE'];
  process.env['HOSTED_IMAGE_CUSTODY_FILE'] = custody.custodyPath;
  const adapter = await trustedHostedImageInputs(fixture.store, silo, registration);
  const signature = vi.mocked(verifyHostedImage);
  const licence = vi.mocked(inspectHostedLicences);
  signature.mockResolvedValue(checkName === 'signature'
    ? { verdict: 'unavailable', reasonCode: 'signature_unavailable' }
    : toolOutcome(false));
  licence.mockResolvedValue(checkName === 'licence'
    ? { verdict: 'unavailable', reasonCode: 'licence_unavailable' }
    : toolOutcome(false));
  try {
    await expect(adapter.readIndependentChecks({ silo, serverId, attemptId: 1,
      imageDigest: digest, platform: 'linux/amd64' })).resolves.toBeUndefined();
  } finally {
    await rm(custody.directory, { recursive: true, force: true });
    if (previous) process.env['HOSTED_IMAGE_CUSTODY_FILE'] = previous;
    else delete process.env['HOSTED_IMAGE_CUSTODY_FILE'];
  }
}
it.each(['signature', 'licence'] as const)(
  'does not turn an unavailable %s tool into a failed receipt', unavailableIndependentCheck);

async function grypeReceiptCannotChangeOutcome(caseName: 'unavailable' | 'missing' |
  'false-pass' | 'false-fail') {
  const registration = await saveRegistration();
  const custody = await custodyFixture();
  const previous = process.env['HOSTED_IMAGE_CUSTODY_FILE'];
  process.env['HOSTED_IMAGE_CUSTODY_FILE'] = custody.custodyPath;
  const signature = vi.mocked(verifyHostedImage);
  const licence = vi.mocked(inspectHostedLicences);
  const vulnerability = vi.mocked(inspectHostedVulnerabilities);
  signature.mockResolvedValue(toolOutcome(false));
  licence.mockResolvedValue(toolOutcome(false));
  const checkedAt = new Date(Date.now() - 1_000).toISOString();
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const receipt = { verdict: caseName === 'unavailable'
    ? 'unavailable' as const : 'fail' as const, checkedAt, expiresAt,
    engineVersion: '0.121.0', databaseDigest: digest, databaseUpdatedAt: checkedAt,
    reportDigest: digest, reasonCodes: ['vulnerability_refused'] };
  if (caseName === 'unavailable') {
    vulnerability.mockResolvedValue({ verdict: 'unavailable',
      reasonCode: 'vulnerability_unavailable', receipt });
  } else if (caseName === 'missing') {
    vulnerability.mockResolvedValue({ verdict: 'fail',
      reasonCode: 'vulnerability_refused' });
  } else if (caseName === 'false-pass') {
    vulnerability.mockResolvedValue({ verdict: 'fail',
      reasonCode: 'vulnerability_refused', receipt: { ...receipt, verdict: 'pass' } });
  } else {
    vulnerability.mockResolvedValue({ verdict: 'pass', receipt });
  }
  try {
    const adapter = await trustedHostedImageInputs(fixture.store, silo, registration);
    const attempt = { silo, serverId, attemptId: 1, imageDigest: digest,
      platform: 'linux/amd64' };
    const checks = await adapter.readIndependentChecks(attempt);
    expect(checks).toBeUndefined();
  } finally {
    await rm(custody.directory, { recursive: true, force: true });
    if (previous) process.env['HOSTED_IMAGE_CUSTODY_FILE'] = previous;
    else delete process.env['HOSTED_IMAGE_CUSTODY_FILE'];
  }
}
it.each(['unavailable', 'missing', 'false-pass', 'false-fail'] as const)(
  'refuses a Grype %s outcome without matching evidence', grypeReceiptCannotChangeOutcome);

function hash(bytes: Buffer) {
  const value = createHash('sha256');
  value.update(bytes);
  return value.digest('hex');
}

function imageLayer() {
  const part = Buffer.from('clean part');
  const header = Buffer.alloc(512);
  header.write('part-0', 0, 'utf8');
  header.write('0000644\0', 100, 'ascii');
  header.write('0000000\0', 108, 'ascii');
  header.write('0000000\0', 116, 'ascii');
  header.write(part.length.toString(8).padStart(11, '0') + '\0', 124, 'ascii');
  header.write('00000000000\0', 136, 'ascii');
  header.fill(32, 148, 156);
  header.write('0', 156, 'ascii');
  header.write('ustar\0', 257, 'ascii');
  let checksum = 0;
  for (const value of header) checksum += value;
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
  const padding = Buffer.alloc(512 - part.length);
  return Buffer.concat([header, part, padding, Buffer.alloc(1024)]);
}

function imageBundle() {
  const layer = imageLayer();
  const layerDigest = hash(layer);
  const config = Buffer.from(JSON.stringify({ os: 'linux', architecture: 'amd64',
    rootfs: { diff_ids: [`sha256:${layerDigest}`] } }));
  const mediaType = 'application/vnd.oci.image.layer.v1.tar';
  const manifest = Buffer.from(JSON.stringify({ schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.manifest.v1+json',
    config: { digest: `sha256:${hash(config)}`, size: config.length },
    layers: [{ digest: `sha256:${layerDigest}`, size: layer.length, mediaType }] }));
  return { layer, layerDigest, config, manifest, imageDigest: hash(manifest) };
}

async function realCustody(bundle: ReturnType<typeof imageBundle>) {
  const directory = await mkdtemp(join(tmpdir(), 'hosted-image-real-'));
  const imageDirectory = join(directory, silo, bundle.imageDigest);
  const blobsDirectory = join(imageDirectory, 'blobs');
  await mkdir(blobsDirectory, { recursive: true });
  await writeFile(join(imageDirectory, 'manifest.json'), bundle.manifest);
  await writeFile(join(imageDirectory, 'config.json'), bundle.config);
  await writeFile(join(blobsDirectory, bundle.layerDigest), bundle.layer);
  await writeFile(join(imageDirectory, 'signature.json'), '{}');
  await sharedCertificates(directory);
  const settings = { silo, bundleDirectory: directory,
    trust: { version: 1, repository: 'registry.example/team/image',
      publicKey: 'fixture', revoked: false },
    scanner: { url: '', caFile: join(directory, 'ca.crt'),
      privateKeyPath: join(directory, 'server.key'), issuer: 'https://issuer.invalid',
      imageDigest: `sha256:${'a'.repeat(64)}`,
      manifestDigest: `sha256:${'b'.repeat(64)}` },
    tools: { cosign: 'cosign', syft: 'syft', osiPath: 'osi', reviewPath: 'review',
      binaryPath: 'grype', databasePath: 'database', databaseDigest: digest } };
  const custodyPath = join(directory, 'custody.json');
  return { directory, custodyPath, settings };
}

function scannerFacts(input: { sha256: string; byteCount: number }, updated: string) {
  const now = Date.now();
  const checkedAt = new Date(now).toISOString();
  const expiresAt = new Date(now + 10_000).toISOString();
  function database(file: string) {
    return { file, sha256: digest, version: 42, builtAt: updated };
  }
  const databases = ['main.cvd', 'daily.cld', 'bytecode.cvd'].map(database);
  return { ...input, verdict: 'clean', imageDigest: `sha256:${'a'.repeat(64)}`,
    manifestDigest: `sha256:${'b'.repeat(64)}`, databases,
    databaseUpdatedAt: updated, checkedAt, expiresAt };
}

type QueuedOutcome = 'signature' | 'licence' | 'vulnerability' |
  'signature-outage' | 'licence-outage' | 'vulnerability-outage' |
  'missing-receipt' | 'forged-receipt' | 'malformed-result' | 'lost-reply';

async function queuedRealRefusal(refusedCheck: QueuedOutcome) {
  const canaries = ['credential-canary', 'filesystem-path-canary', 'content-canary'];
  const bundle = imageBundle();
  const registration = await saveRegistration(bundle.imageDigest);
  const custody = await realCustody(bundle);
  if (refusedCheck === 'lost-reply') {
    custody.settings.scanner.issuer += `/${canaries.join('/')}`;
  }
  const previous = process.env['HOSTED_IMAGE_CUSTODY_FILE'];
  const scannerIdentity = { service: 'image-worker' as const, silo };
  const issuer = await tokenIssuer({ ...custody.settings.scanner, scannerIdentity });
  const trust = [{ issuer: custody.settings.scanner.issuer, jwks: issuer.jwks,
    services: { 'image-worker': silo } }];
  const tls = { key: await readFile(join(custody.directory, 'server.key')),
    cert: await readFile(join(custody.directory, 'server.crt')) };
  let scanCalls = 0;
  const updated = new Date(Date.now() - 1_000).toISOString();
  function scan(input: { sha256: string; byteCount: number }) {
    scanCalls += 1;
    if (refusedCheck === 'lost-reply') {
      service.closeAllConnections();
    }
    const factsInput = { sha256: input.sha256, byteCount: input.byteCount };
    return Promise.resolve(scannerFacts(factsInput, updated));
  }
  const scanner = { scan, signal: new AbortController().signal,
    databaseUpdatedAt: updated };
  const service = createScannerService({ scanner, tls, trust });
  service.listen(0, '127.0.0.1');
  await once(service, 'listening');
  const address = service.address();
  if (!address || typeof address === 'string') throw new Error('Scanner address unavailable');
  custody.settings.scanner.url = `https://127.0.0.1:${address.port}/scan/image-part`;
  await writeFile(custody.custodyPath, JSON.stringify(custody.settings));
  process.env['HOSTED_IMAGE_CUSTODY_FILE'] = custody.custodyPath;
  const signature = vi.mocked(verifyHostedImage);
  const licence = vi.mocked(inspectHostedLicences);
  const vulnerability = vi.mocked(inspectHostedVulnerabilities);
  let signatureOutcome;
  if (refusedCheck === 'signature') {
    signatureOutcome = { verdict: 'fail' as const, reasonCode: 'signature_refused' };
  } else if (refusedCheck === 'signature-outage') {
    signatureOutcome = { verdict: 'unavailable' as const,
      reasonCode: 'signature_unavailable' };
  } else {
    signatureOutcome = toolOutcome(false);
  }
  signature.mockResolvedValue(signatureOutcome);
  if (refusedCheck === 'licence-outage') {
    licence.mockResolvedValue({ verdict: 'unavailable', reasonCode: 'licence_unavailable' });
  } else {
    licence.mockResolvedValue(toolOutcome(refusedCheck === 'licence'));
  }
  const checkedAt = new Date(Date.now() - 1_000).toISOString();
  const receipt = { verdict: 'fail' as const, checkedAt,
    expiresAt: new Date(Date.now() + 60_000).toISOString(), engineVersion: '0.121.0',
    databaseDigest: digest, databaseUpdatedAt: checkedAt, reportDigest: digest,
    reasonCodes: ['vulnerability_refused'] };
  if (refusedCheck === 'vulnerability-outage') {
    vulnerability.mockResolvedValue({ verdict: 'unavailable',
      reasonCode: 'vulnerability_unavailable',
      receipt: { ...receipt, verdict: 'unavailable' } });
  } else if (refusedCheck === 'missing-receipt') {
    vulnerability.mockResolvedValue({ verdict: 'fail',
      reasonCode: 'vulnerability_refused' });
  } else if (refusedCheck === 'forged-receipt') {
    vulnerability.mockResolvedValue({ verdict: 'fail',
      reasonCode: 'vulnerability_refused',
      receipt: { ...receipt, verdict: 'pass' } });
  } else if (refusedCheck === 'malformed-result') {
    vulnerability.mockResolvedValue({ verdict: 'pass',
      receipt: { ...receipt, verdict: 'pass', reportDigest: canaries.join('/') } });
  } else {
    vulnerability.mockResolvedValue({ verdict: 'fail',
      reasonCode: 'vulnerability_refused', receipt });
  }
  const storage = await databases();
  function failed() { throw new Error('Fixture database unavailable'); }
  const db = connectProjectionDb(storage.queue.options.connectionString!, failed);
  const logLines: string[] = [];
  const destination = { write(line: string) { logLines.push(line); } };
  const logger = createLogger('image-refusal-test', { destination });
  async function readInputs(event: EventEnvelope) {
    return trustedHostedImageInputs(fixture.store, silo, event);
  }
  const handler = hostedImageCheckHandler(fixture.store, silo,
    runAndWriteHostedImageCheck, readInputs);
  const runtime = new HandlerRuntime({ db: db.db, logger, silo, handlers: [handler] });
  await runtime.start();
  try {
    expect(await recoverHostedImageChecks(runtime, fixture.reader, fixture.store)).toBe(1);
    await runtime.work(1);
    const isFailure = refusedCheck === 'signature' || refusedCheck === 'licence' ||
      refusedCheck === 'vulnerability';
    if (isFailure) {
      async function saved() {
        const admission = await readHostedAdmission(fixture.store, silo, serverId);
        return admission?.status === 'rejected';
      }
      await until(saved);
    } else {
      async function attempted() {
        const jobs = await storage.queue.query<{ state: string }>(
          "SELECT state FROM pgboss.job WHERE name='check-hosted-image'");
        return jobs.rows.some(job => job.state === 'retry' || job.state === 'failed');
      }
      await until(attempted);
    }
    const admission = await readHostedAdmission(fixture.store, silo, serverId);
    expect(admission?.attemptId).toBe(1);
    if (isFailure) {
      expect(admission?.status).toBe('rejected');
      if (refusedCheck === 'signature' || refusedCheck === 'licence' ||
          refusedCheck === 'vulnerability') {
        expect(admission?.checks?.[refusedCheck].verdict).toBe('fail');
      }
    } else {
      expect(admission?.status).toBe('checking');
      expect(admission?.checks).toBeUndefined();
    }
    if (refusedCheck === 'signature') {
      expect(admission?.checks?.licence).toEqual({ verdict: 'not_run' });
      expect(admission?.checks?.vulnerability).toEqual({ verdict: 'not_run' });
    }
    if (refusedCheck === 'licence') {
      expect(admission?.checks?.vulnerability).toEqual({ verdict: 'not_run' });
    }
    const events = [];
    for await (const row of fixture.store.readStream(`mcp-${serverId}`, 1,
      performance.now() + 10_000)) events.push(row.event);
    const expectedEvents = ['mcp.server_registered', 'mcp.image_scan_claimed'];
    if (isFailure) expectedEvents.push('mcp.image_checked');
    expect(events.map(event => event.type)).toEqual(expectedEvents);
    if (!isFailure) {
      const jobs = await storage.queue.query<{ output: unknown }>(
        "SELECT output FROM pgboss.job WHERE name='check-hosted-image'");
      const publicOutput = JSON.stringify({ logs: logLines, savedErrors: jobs.rows[0]?.output,
        eventData: events.map(event => event.data) });
      for (const canary of canaries) expect(publicOutput).not.toContain(canary);
    }
    if (refusedCheck.endsWith('outage') || refusedCheck === 'missing-receipt' ||
        refusedCheck === 'forged-receipt') {
      // Check the adapter too: the writer can independently refuse an invalid receipt.
      const adapter = await trustedHostedImageInputs(fixture.store, silo, registration);
      const attempt = { silo, serverId, attemptId: 1,
        imageDigest: bundle.imageDigest, platform: 'linux/amd64' };
      expect(await adapter.readIndependentChecks(attempt)).toBeUndefined();
    }
    if (isFailure) await handler.handle(registration, transaction);
    expect(scanCalls).toBe(1);
    expect(await readHostedAdmission(fixture.store, silo, serverId)).toEqual(admission);
    const afterRedelivery = [];
    for await (const row of fixture.store.readStream(`mcp-${serverId}`, 1,
      performance.now() + 10_000)) afterRedelivery.push(row.event.type);
    expect(afterRedelivery).toEqual(events.map(event => event.type));
  } finally {
    await runtime.stop();
    await db.close();
    await storage.close();
    service.closeAllConnections();
    service.close();
    await once(service, 'close');
    await rm(custody.directory, { recursive: true, force: true });
    if (previous) process.env['HOSTED_IMAGE_CUSTODY_FILE'] = previous;
    else delete process.env['HOSTED_IMAGE_CUSTODY_FILE'];
  }
}
it.each(['signature', 'licence', 'vulnerability'] as const)(
  'saves one real queued %s refusal and returns it on redelivery', queuedRealRefusal);
it.each(['signature-outage', 'licence-outage', 'vulnerability-outage',
  'missing-receipt', 'forged-receipt', 'malformed-result', 'lost-reply'] as const)(
  'keeps a real queued %s without admission or a saved refusal', queuedRealRefusal);

async function privateInputErrorStaysPrivate() {
  const registration = await saveRegistration();
  const directory = await mkdtemp(join(tmpdir(), 'image-private-error-'));
  const canaries = ['credential-canary', 'filesystem-path-canary', 'content-canary'];
  const previous = process.env['HOSTED_IMAGE_CUSTODY_FILE'];
  process.env['HOSTED_IMAGE_CUSTODY_FILE'] = join(directory, ...canaries, 'missing.json');
  const logLines: string[] = [];
  const destination = { write(line: string) { logLines.push(line); } };
  const logger = createLogger('image-private-test', { destination });
  const storage = await databases();
  function failed() { throw new Error('Fixture database unavailable'); }
  const db = connectProjectionDb(storage.queue.options.connectionString!, failed);
  async function readInputs(event: EventEnvelope) {
    return trustedHostedImageInputs(fixture.store, silo, event);
  }
  const handler = hostedImageCheckHandler(fixture.store, silo,
    runAndWriteHostedImageCheck, readInputs);
  const runtime = new HandlerRuntime({ db: db.db, logger, silo, handlers: [handler],
    retryLimit: 0 });
  await runtime.start();
  try {
    expect(await recoverHostedImageChecks(runtime, fixture.reader, fixture.store)).toBe(1);
    await runtime.work(1);
    async function failedJob() {
      const jobs = await storage.queue.query<{ state: string }>(
        "SELECT state FROM pgboss.job WHERE name='check-hosted-image'");
      return jobs.rows.some(job => job.state === 'failed');
    }
    await until(failedJob);
    const jobs = await storage.queue.query<{ state: string; output: unknown }>(
      "SELECT state, output FROM pgboss.job WHERE name='check-hosted-image'");
    expect(jobs.rows).toHaveLength(1);
    expect(jobs.rows[0]?.state).toBe('failed');
    let publicError: unknown;
    try {
      await handler.handle(registration, transaction);
    } catch (error) {
      publicError = error;
    }
    expect(publicError).toEqual(new Error('Trusted image inputs unavailable'));
    const admission = await readHostedAdmission(fixture.store, silo, serverId);
    expect(admission?.status).toBe('checking');
    const events = [];
    for await (const row of fixture.store.readStream(`mcp-${serverId}`, 1,
      performance.now() + 10_000)) events.push(row.event);
    expect(events.map(event => event.type)).toEqual(['mcp.server_registered']);
    const publicOutput = JSON.stringify({ logs: logLines, savedErrors: jobs.rows[0]?.output,
      eventData: events.map(event => event.data), publicError });
    expect(publicOutput).toContain('Trusted image inputs unavailable');
    for (const canary of canaries) expect(publicOutput).not.toContain(canary);
  } finally {
    await runtime.stop();
    await db.close();
    await storage.close();
    await rm(directory, { recursive: true, force: true });
    if (previous) process.env['HOSTED_IMAGE_CUSTODY_FILE'] = previous;
    else delete process.env['HOSTED_IMAGE_CUSTODY_FILE'];
  }
}
it('keeps a private input error out of the queue and public result', privateInputErrorStaysPrivate);
