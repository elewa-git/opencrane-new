import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { EventStore } from '@opencrane/event-store';
import type { EventEnvelope } from '@opencrane/events';
import { verifyHostedImage, inspectHostedLicences, inspectHostedVulnerabilities }
  from '@opencrane/models';
import type { Inputs } from './hosted-image-check.ts';
import { z } from 'zod';

const digest = /^[a-f0-9]{64}$/u;
const blob = /^sha256:[a-f0-9]{64}$/u;
const refusal = 'Trusted image inputs unavailable';
const digestSchema = z.string().regex(digest);
const pathSchema = z.string().min(1);
const attemptSchema = z.object({ silo: z.string(), serverId: z.string(),
  attemptId: z.number().int().positive(), imageDigest: digestSchema,
  platform: z.enum(['linux/amd64', 'linux/arm64']) });
type Attempt = z.infer<typeof attemptSchema>;
const configurationSchema = z.object({
  silo: pathSchema, bundleDirectory: pathSchema,
  trust: z.object({ version: z.number().int().positive(), repository: pathSchema,
    publicKey: pathSchema, revoked: z.literal(false) }),
  scanner: z.object({ url: pathSchema, caFile: pathSchema, privateKeyPath: pathSchema,
    issuer: pathSchema, imageDigest: z.string().regex(blob),
    manifestDigest: z.string().regex(blob) }),
  tools: z.object({ cosign: pathSchema, syft: pathSchema, osiPath: pathSchema,
    reviewPath: pathSchema, binaryPath: pathSchema, databasePath: pathSchema,
    databaseDigest: digestSchema }),
});
type Configuration = z.infer<typeof configurationSchema>;
const manifestSchema = z.object({ layers: z.array(z.object({
  digest: z.string().regex(blob), mediaType: z.string(), size: z.number().int().nonnegative(),
})).min(1).max(64) });
const imageConfigSchema = z.object({ rootfs: z.object({ diff_ids: z.array(z.string()) }) });

function requireInput(condition: unknown): asserts condition {
  if (!condition) throw new Error(refusal);
}

function hash(value: Uint8Array | string) {
  const digestValue = createHash('sha256');
  digestValue.update(value);
  return digestValue.digest('hex');
}

async function configuration(path: string, silo: string) {
  const bytes = await readFile(path);
  let parsed: Configuration;
  try {
    const raw: unknown = JSON.parse(bytes.toString());
    parsed = configurationSchema.parse(raw);
  } catch {
    throw new Error(refusal);
  }
  requireInput(parsed.silo === silo);
  return { parsed, digest: hash(bytes) };
}

async function registeredRepository(store: EventStore, silo: string, serverId: string,
  imageDigest: string) {
  const stream = `mcp-${serverId}`;
  for await (const row of store.readStream(stream, 1, performance.now() + 10_000)) {
    if (row.event.type !== 'mcp.server_registered') continue;
    const data = z.record(z.string(), z.unknown()).parse(row.event.data);
    requireInput(row.event.silo === silo && row.event.subject === stream &&
      data['kind'] === 'hosted' && typeof data['locator'] === 'string');
    const suffix = `@sha256:${imageDigest}`;
    requireInput(data['locator'].endsWith(suffix));
    return data['locator'].slice(0, -suffix.length);
  }
  throw new Error(refusal);
}

async function boundedFile(path: string, maximum: number) {
  const details = await stat(path);
  requireInput(details.isFile() && details.size <= maximum);
  return readFile(path);
}

async function scannerReady(config: Configuration) {
  const endpoint = new URL(config.scanner.url);
  requireInput(endpoint.protocol === 'https:' && !endpoint.username && !endpoint.password &&
    !endpoint.search && !endpoint.hash && endpoint.pathname === '/scan/image-part');
  const ca = await stat(config.scanner.caFile);
  const signingKey = await stat(config.scanner.privateKeyPath);
  requireInput(ca.isFile() && signingKey.isFile());
}

function bundlePath(config: Configuration, attempt: Attempt) {
  requireInput(attempt.silo === config.silo && digest.test(attempt.imageDigest) &&
    /^[\w-]{1,200}$/u.test(attempt.serverId));
  return join(config.bundleDirectory, config.silo, attempt.imageDigest);
}

async function prepareImage(config: Configuration, attempt: Attempt) {
  const directory = bundlePath(config, attempt);
  const manifest = await boundedFile(join(directory, 'manifest.json'), 1024 * 1024);
  const configBytes = await boundedFile(join(directory, 'config.json'), 1024 * 1024);
  const descriptor = manifestSchema.parse(JSON.parse(manifest.toString()) as unknown);
  const imageConfig = imageConfigSchema.parse(JSON.parse(configBytes.toString()) as unknown);
  requireInput(
    imageConfig.rootfs.diff_ids.length === descriptor.layers.length);
  let total = 0;
  const layers = [];
  for (let index = 0; index < descriptor.layers.length; index++) {
    const layer = descriptor.layers[index]!;
    requireInput(blob.test(layer.digest) && layer.size <= 32 * 1024 * 1024);
    const bytes = await boundedFile(join(directory, 'blobs', layer.digest.slice(7)),
      32 * 1024 * 1024);
    total += bytes.length;
    requireInput(total <= 128 * 1024 * 1024);
    layers.push({ bytes, digest: layer.digest, mediaType: layer.mediaType,
      diffId: imageConfig.rootfs.diff_ids[index] });
  }
  return { ...attempt, manifest, config: configBytes, layers };
}

function datedReceipt(evidence: unknown, engineVersion: string) {
  const checkedAt = new Date();
  const expiresAt = new Date(checkedAt.getTime() + 120_000);
  return { checkedAt: checkedAt.toISOString(),
    expiresAt: expiresAt.toISOString(), engineVersion,
    reportDigest: hash(JSON.stringify(evidence)) };
}

function passedReceipt(evidence: unknown, engineVersion: string) {
  const dated = datedReceipt(evidence, engineVersion);
  return { ...dated, verdict: 'pass' as const };
}

function failedReceipt(outcome: { reasonCode: string }, engineVersion: string) {
  const dated = datedReceipt(outcome, engineVersion);
  return { ...dated, verdict: 'fail' as const, reasonCodes: [outcome.reasonCode] };
}

const notRun = { verdict: 'not_run' as const };

async function independentChecks(config: Configuration, attempt: Attempt, repository: string) {
  const directory = bundlePath(config, attempt);
  async function read(_repository: string, resource: string, _signal: AbortSignal) {
    requireInput(_repository === repository);
    if (resource === 'signature') {
      return boundedFile(join(directory, 'signature.json'), 64 * 1024);
    }
    requireInput(blob.test(resource));
    if (resource === `sha256:${attempt.imageDigest}`) {
      return boundedFile(join(directory, 'manifest.json'), 1024 * 1024);
    }
    return boundedFile(join(directory, 'blobs', resource.slice(7)), 32 * 1024 * 1024);
  }
  const request = { repository, imageDigest: attempt.imageDigest, platform: attempt.platform };
  const signature = await verifyHostedImage(request, config.trust, read, config.tools.cosign);
  if (signature.verdict !== 'pass') {
    if (signature.verdict !== 'fail') return;
    return { signature: failedReceipt(signature, 'cosign-2.6.1'),
      licence: notRun, vulnerability: notRun };
  }
  const licence = await inspectHostedLicences(request, config.trust, read, config.tools);
  if (licence.verdict !== 'pass') {
    if (licence.verdict !== 'fail') return;
    return { signature: passedReceipt(signature.evidence, 'cosign-2.6.1'),
      licence: failedReceipt(licence, 'syft-1.54.0'), vulnerability: notRun };
  }
  const vulnerability = await inspectHostedVulnerabilities(request, config.trust, read,
    config.tools);
  if (vulnerability.verdict === 'fail' && !('receipt' in vulnerability)) {
    // Keep failures from checks repeated before Grype with the check that refused them.
    if (vulnerability.reasonCode === 'signature_refused') {
      const failure = { ...vulnerability, reasonCode: 'signature_refused' };
      return { signature: failedReceipt(failure, 'cosign-2.6.1'),
        licence: notRun, vulnerability: notRun };
    }
    if (vulnerability.reasonCode === 'licence_refused') {
      const failure = { ...vulnerability, reasonCode: 'licence_refused' };
      return { signature: passedReceipt(signature.evidence, 'cosign-2.6.1'),
        licence: failedReceipt(failure, 'syft-1.54.0'), vulnerability: notRun };
    }
  }
  if (vulnerability.verdict !== 'pass' && vulnerability.verdict !== 'fail') return;
  if (!('receipt' in vulnerability) || !vulnerability.receipt) return;
  if (vulnerability.receipt['verdict'] !== vulnerability.verdict) return;
  return { signature: passedReceipt(signature.evidence, 'cosign-2.6.1'),
    licence: passedReceipt(licence.evidence, 'syft-1.54.0'),
    vulnerability: vulnerability.receipt };
}

/** Read only operator-owned files. The saved event selects the exact digest and repository. */
async function readHostedImageInputs(store: EventStore, silo: string,
  trigger: EventEnvelope): Promise<Inputs> {
  const path = process.env['HOSTED_IMAGE_CUSTODY_FILE'];
  requireInput(path);
  const custodyPath = path;
  const initial = await configuration(custodyPath, silo);
  await scannerReady(initial.parsed);
  const serverId = trigger.subject.slice(4);
  const data = z.record(z.string(), z.unknown()).parse(trigger.data);
  let imageDigest: string | undefined;
  if (trigger.type === 'mcp.image_check_requested') {
    imageDigest = z.string().parse(data['imageDigest']);
  } else {
    const locator = z.string().parse(data['locator']);
    imageDigest = locator.split('@sha256:')[1];
  }
  requireInput(imageDigest && digest.test(imageDigest));
  const repository = await registeredRepository(store, silo, serverId, imageDigest);
  requireInput(repository === initial.parsed.trust.repository);
  async function unchanged() {
    const current = await configuration(custodyPath, silo);
    requireInput(current.digest === initial.digest);
    return current.parsed;
  }
  async function image(raw: unknown) {
    try {
      const attempt = attemptSchema.parse(raw);
      requireInput(attempt.imageDigest === imageDigest && attempt.serverId === serverId &&
        attempt.silo === silo);
      return await prepareImage(initial.parsed, attempt);
    } catch {
      throw new Error(refusal);
    }
  }
  async function settings() {
    const current = await unchanged();
    return { silo, ...current.scanner };
  }
  async function checks(raw: unknown) {
    try {
      const attempt = attemptSchema.parse(raw);
      requireInput(attempt.imageDigest === imageDigest && attempt.serverId === serverId &&
        attempt.silo === silo);
      await unchanged();
      return await independentChecks(initial.parsed, attempt, repository);
    } catch {
      throw new Error(refusal);
    }
  }
  return { prepareImage: image, readSettings: settings, readIndependentChecks: checks };
}

export async function trustedHostedImageInputs(store: EventStore, silo: string,
  trigger: EventEnvelope): Promise<Inputs> {
  try {
    return await readHostedImageInputs(store, silo, trigger);
  } catch {
    // Hide private file names and configuration values from queue errors and logs.
    throw new Error(refusal);
  }
}
