import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { tokenIssuer } from '@opencrane/auth';
import { databases, until } from '@opencrane/authz/testing';
import { event as fixtureEvent, natsFixture } from '@opencrane/event-store/testing';
import type { EventEnvelope } from '@opencrane/events';
import { HandlerRuntime } from '@opencrane/handlers';
import { inspectHostedLicences, readHostedAdmission, verifyHostedImage } from '@opencrane/models';
import { createLogger } from '@opencrane/observability';
import { connectProjectionDb } from '@opencrane/projections';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { createScannerService } from '../../../infra/clamav/service.mjs';
import { runAndWriteHostedImageCheck } from '../../../infra/clamav/image-worker.mjs';
import { sharedCertificates } from '../../../libs/event-store/test/certificates.ts';
import { hostedImageCheckHandler, recoverHostedImageChecks }
  from '../src/hosted-image-check.ts';
import { trustedHostedImageInputs } from '../src/hosted-image-inputs.ts';

const silo = 'test';
const serverId = 'local-tools-image';
const repository = 'registry.example/team/image';
const tools = { cosign: resolve('.tools/cosign'), syft: resolve('.tools/syft'),
  osiPath: resolve('.tools/osi.json'), binaryPath: resolve('.tools/grype') };
const installed = Object.values(tools).every(existsSync);

const imageFixtureSchema = z.object({ imageDigest: z.string(),
  blobs: z.record(z.string(), z.string()), review: z.record(z.string(), z.unknown()) });
const manifestSchema = z.object({ config: z.object({ digest: z.string() }),
  layers: z.array(z.object({ digest: z.string() })) });

async function localImage(directory: string, badSignature: boolean) {
  const output = execFileSync('python3',
    ['libs/models/test/support/hosted-licence-fixture.py', 'allowed'],
    { timeout: 10_000, maxBuffer: 2 * 1024 * 1024 });
  const image = imageFixtureSchema.parse(JSON.parse(output.toString()) as unknown);
  const bundleDirectory = join(directory, silo, image.imageDigest);
  const blobDirectory = join(bundleDirectory, 'blobs');
  await mkdir(blobDirectory, { recursive: true });
  for (const [name, encoded] of Object.entries(image.blobs)) {
    await writeFile(join(blobDirectory, name), Buffer.from(encoded, 'base64'));
  }
  const manifest = Buffer.from(image.blobs[image.imageDigest]!, 'base64');
  const descriptor = manifestSchema.parse(JSON.parse(manifest.toString()) as unknown);
  const config = Buffer.from(image.blobs[descriptor.config.digest.slice(7)]!, 'base64');
  await writeFile(join(bundleDirectory, 'manifest.json'), manifest);
  await writeFile(join(bundleDirectory, 'config.json'), config);
  await writeFile(join(directory, 'review.json'), JSON.stringify(image.review));

  const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const otherKeys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const payload = JSON.stringify({ critical: {
    type: 'cosign container image signature',
    identity: { 'docker-reference': repository },
    image: { 'docker-manifest-digest': `sha256:${image.imageDigest}` },
  } });
  const signingKey = badSignature ? otherKeys.privateKey : keys.privateKey;
  const signature = sign('sha256', Buffer.from(payload), signingKey).toString('base64');
  await writeFile(join(bundleDirectory, 'signature.json'), JSON.stringify({ payload, signature }));
  const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  return { image, publicKey, bundleDirectory };
}

function scanFacts(input: { sha256: string; byteCount: number }, updated: string) {
  const checkedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 10_000).toISOString();
  const database = { file: 'main.cvd', sha256: 'a'.repeat(64),
    version: 42, builtAt: updated };
  function databaseFor(file: string) {
    return { ...database, file };
  }
  const databases = ['main.cvd', 'daily.cld', 'bytecode.cvd'].map(databaseFor);
  return { ...input, verdict: 'clean', imageDigest: `sha256:${'a'.repeat(64)}`,
    manifestDigest: `sha256:${'b'.repeat(64)}`, databases,
    databaseUpdatedAt: updated, checkedAt, expiresAt };
}

async function closeScannerService(service: ReturnType<typeof createScannerService>) {
  service.closeAllConnections();
  function waitForClose(resolveClose: () => void) {
    function finished() { resolveClose(); }
    service.close(finished);
  }
  await new Promise<void>(waitForClose);
}

async function exerciseLocalTools(badSignature: boolean, staleDatabase = false,
  brokenBinary = false) {
  const directory = await mkdtemp(join(tmpdir(), 'hosted-local-tools-'));
  const fixture = await natsFixture();
  const storage = await databases();
  function failed() { throw new Error('Fixture database unavailable'); }
  const db = connectProjectionDb(storage.queue.options.connectionString!, failed);
  const logger = createLogger('local-image-tools-test', { level: 'silent' });
  const previousCustody = process.env['HOSTED_IMAGE_CUSTODY_FILE'];
  let runtime: HandlerRuntime | undefined;
  let service: ReturnType<typeof createScannerService> | undefined;
  try {
    const { image, publicKey, bundleDirectory } = await localImage(directory, badSignature);
    await sharedCertificates(directory);
    const scannerSettings = { url: '', caFile: join(directory, 'ca.crt'),
      privateKeyPath: join(directory, 'server.key'), issuer: 'https://issuer.invalid',
      imageDigest: `sha256:${'a'.repeat(64)}`,
      manifestDigest: `sha256:${'b'.repeat(64)}` };
    const issuer = await tokenIssuer({ ...scannerSettings,
      scannerIdentity: { service: 'image-worker' as const, silo } });
    const trust = [{ issuer: scannerSettings.issuer, jwks: issuer.jwks,
      services: { 'image-worker': silo } }];
    const tls = { key: await readFile(join(directory, 'server.key')),
      cert: await readFile(join(directory, 'server.crt')) };
    let scanCalls = 0;
    let updatedAt = Date.now() - 1_000;
    if (staleDatabase) updatedAt -= 86_400_000;
    const updated = new Date(updatedAt).toISOString();
    function scan(input: { sha256: string; byteCount: number }) {
      scanCalls += 1;
      const factsInput = { sha256: input.sha256, byteCount: input.byteCount };
      return Promise.resolve(scanFacts(factsInput, updated));
    }
    const scanner = { scan, signal: new AbortController().signal,
      databaseUpdatedAt: updated };
    service = createScannerService({ scanner, tls, trust });
    service.listen(0, '127.0.0.1');
    await once(service, 'listening');
    const address = service.address();
    if (!address || typeof address === 'string') throw new Error('Scanner unavailable');
    scannerSettings.url = `https://127.0.0.1:${address.port}/scan/image-part`;

    let cosignPath = tools.cosign;
    if (brokenBinary) {
      cosignPath = join(directory, 'forged-cosign');
      await writeFile(cosignPath, '#!/bin/sh\nprintf "Verified OK\\n"\n', { mode: 0o700 });
    }

    const custody = { silo, bundleDirectory: directory,
      trust: { version: 1, repository, publicKey, revoked: false },
      scanner: scannerSettings,
      tools: { ...tools, cosign: cosignPath, reviewPath: join(directory, 'review.json'),
        databasePath: join(directory, 'missing-database.tar.gz'),
        databaseDigest: 'c'.repeat(64) } };
    const custodyPath = join(directory, 'custody.json');
    await writeFile(custodyPath, JSON.stringify(custody));
    process.env['HOSTED_IMAGE_CUSTODY_FILE'] = custodyPath;

    const request = { repository, imageDigest: image.imageDigest, platform: 'linux/amd64' };
    async function read(_repository: string, resource: string) {
      expect(_repository).toBe(repository);
      if (resource === 'signature') {
        return readFile(join(bundleDirectory, 'signature.json'));
      }
      if (resource === `sha256:${image.imageDigest}`) {
        return readFile(join(bundleDirectory, 'manifest.json'));
      }
      return readFile(join(bundleDirectory, 'blobs', resource.slice(7)));
    }
    const signature = await verifyHostedImage(request, custody.trust, read, cosignPath);
    if (badSignature) {
      expect(signature).toEqual({ verdict: 'fail', reasonCode: 'signature_refused' });
    } else if (brokenBinary) {
      expect(signature).toEqual({ verdict: 'unavailable', reasonCode: 'verifier_unavailable' });
    } else {
      expect(signature.verdict).toBe('pass');
      const licence = await inspectHostedLicences(request, custody.trust, read, custody.tools);
      expect(licence.verdict).toBe('pass');
    }

    const data = { serverId, registeredBy: 'alice', kind: 'hosted',
      locator: `${repository}@sha256:${image.imageDigest}`,
      installation: { attemptId: 1, platform: 'linux/amd64',
        upstream: { host: 'api.github.com', port: 443 } } };
    const base = fixtureEvent('registration', `mcp-${serverId}`, 'mcp.server_registered');
    const registration = { ...base, data,
      principal: { kind: 'human' as const, id: 'alice' } };
    const saved = await fixture.store.append({ event: registration, expectedSequence: 0 });
    expect(saved.status).toBe('appended');
    const canceled = new AbortController();
    canceled.abort();
    const canceledInputs = await trustedHostedImageInputs(fixture.store, silo, registration);
    const currentAttempt = { silo, serverId, attemptId: 1,
      imageDigest: image.imageDigest, platform: 'linux/amd64' };
    const wrongAttempts = [
      { ...currentAttempt, silo: 'other' },
      { ...currentAttempt, attemptId: 2 },
      { ...currentAttempt, imageDigest: 'd'.repeat(64) },
      { ...currentAttempt, platform: 'linux/arm64' },
    ];
    for (const wrongAttempt of wrongAttempts) {
      await expect(canceledInputs.readIndependentChecks(wrongAttempt)).rejects.toThrow(
        'Trusted image inputs unavailable');
    }
    const wrongRepository = { ...request, repository: 'registry.example/other' };
    expect(await verifyHostedImage(wrongRepository, custody.trust, read, tools.cosign))
      .toEqual({ verdict: 'fail', reasonCode: 'signature_refused' });
    const manifest = manifestSchema.parse(JSON.parse(
      (await readFile(join(bundleDirectory, 'manifest.json'))).toString()) as unknown);
    const layerPath = join(bundleDirectory, 'blobs', manifest.layers[0]!.digest.slice(7));
    const layerBytes = await readFile(layerPath);
    await rm(layerPath);
    await expect(canceledInputs.prepareImage(currentAttempt)).rejects.toThrow(
      'Trusted image inputs unavailable');
    await writeFile(layerPath, layerBytes);
    const canceledResult = await runAndWriteHostedImageCheck(fixture.store, silo, serverId, 1,
      canceledInputs.prepareImage, canceledInputs.readSettings,
      canceledInputs.readIndependentChecks, canceled.signal);
    expect(canceledResult).toEqual({ status: 'unavailable' });
    expect(scanCalls).toBe(0);
    expect((await readHostedAdmission(fixture.store, silo, serverId))?.checks).toBeUndefined();
    async function readInputs(event: EventEnvelope) {
      return trustedHostedImageInputs(fixture.store, silo, event);
    }
    const handler = hostedImageCheckHandler(fixture.store, silo,
      runAndWriteHostedImageCheck, readInputs);
    function unusedQuery() { return Promise.resolve({ rows: [] }); }
    const transaction = { query: unusedQuery };
    const wrongActor = { ...registration,
      principal: { kind: 'human' as const, id: 'another-person' } };
    const wrongSilo = { ...registration, silo: 'other' };
    await handler.handle(wrongActor, transaction);
    await handler.handle(wrongSilo, transaction);
    expect(scanCalls).toBe(0);
    expect((await readHostedAdmission(fixture.store, silo, serverId))?.checks).toBeUndefined();
    runtime = new HandlerRuntime({ db: db.db, logger, silo, handlers: [handler],
      retryLimit: 0 });
    await runtime.start();
    expect(await recoverHostedImageChecks(runtime, fixture.reader, fixture.store)).toBe(1);
    await runtime.work(1);
    async function completed() {
      const admission = await readHostedAdmission(fixture.store, silo, serverId);
      if (badSignature) return admission?.status === 'rejected';
      const jobs = await storage.queue.query<{ state: string }>(
        "SELECT state FROM pgboss.job WHERE name='check-hosted-image'");
      function failedJob(job: { state: string }) { return job.state === 'failed'; }
      return jobs.rows.some(failedJob);
    }
    await until(completed);
    const admission = await readHostedAdmission(fixture.store, silo, serverId);
    if (staleDatabase) expect(scanCalls).toBe(0);
    else expect(scanCalls).toBeGreaterThan(0);
    if (badSignature) {
      expect(admission?.status).toBe('rejected');
      expect(admission?.checks?.signature.verdict).toBe('fail');
      const checkedAt = admission?.checks?.signature;
      if (!checkedAt || !('checkedAt' in checkedAt)) {
        throw new Error('Missing dated signature refusal');
      }
      expect(Date.parse(checkedAt.checkedAt)).toBeLessThanOrEqual(Date.now());
      expect(admission?.checks?.licence).toEqual({ verdict: 'not_run' });
      expect(admission?.checks?.vulnerability).toEqual({ verdict: 'not_run' });
      const scansBeforeRestart = scanCalls;
      await runtime.stop();
      runtime = new HandlerRuntime({ db: db.db, logger, silo, handlers: [handler],
        retryLimit: 0 });
      await runtime.start();
      await recoverHostedImageChecks(runtime, fixture.reader, fixture.store);
      await runtime.work(1);
      expect(scanCalls).toBe(scansBeforeRestart);
      const eventTypes = [];
      for await (const row of fixture.store.readStream(`mcp-${serverId}`, 1,
        performance.now() + 10_000)) eventTypes.push(row.event.type);
      expect(eventTypes).toEqual(['mcp.server_registered', 'mcp.image_scan_claimed',
        'mcp.image_checked']);
    } else {
      // The missing Grype database is an outage, so clean malware cannot admit this image.
      expect(admission?.status).toBe('checking');
      expect(admission?.checks).toBeUndefined();
    }
  } finally {
    if (runtime) await runtime.stop();
    if (service) await closeScannerService(service);
    await db.close();
    await storage.close();
    await fixture.close();
    await rm(directory, { recursive: true, force: true });
    if (previousCustody) process.env['HOSTED_IMAGE_CUSTODY_FILE'] = previousCustody;
    else delete process.env['HOSTED_IMAGE_CUSTODY_FILE'];
  }
}

function cleanStillWaits() { return exerciseLocalTools(false); }
function realSignatureRefusal() { return exerciseLocalTools(true); }
function staleScannerDate() { return exerciseLocalTools(false, true); }
function brokenVerifier() { return exerciseLocalTools(false, false, true); }

it.skipIf(!installed)('keeps a clean scan waiting after real Cosign and Syft checks',
  cleanStillWaits, 120_000);
it.skipIf(!installed)('saves one real Cosign refusal and does not rescan after restart',
  realSignatureRefusal, 120_000);
it.skipIf(!installed)('leaves a clean image waiting when scanner dates are stale',
  staleScannerDate, 120_000);
it.skipIf(!installed)('does not save a failure from a forged success program',
  brokenVerifier, 120_000);
