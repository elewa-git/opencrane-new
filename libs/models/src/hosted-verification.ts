import { createHash, createPublicKey } from 'node:crypto';
import { z } from 'zod';
import { verifyPublisherSignature } from './hosted-cosign.ts';

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const requestSchema = z.strictObject({
  repository: z.string().regex(/^[a-z0-9.-]+(?::[0-9]+)?\/[a-z0-9._/-]+$/u).max(512),
  imageDigest: digest, platform: z.enum(['linux/amd64', 'linux/arm64']),
});
const trustSchema = z.strictObject({ version: z.number().int().positive(),
  repository: requestSchema.shape.repository, publicKey: z.string().max(16_384),
  revoked: z.boolean() });
const signatureSchema = z.strictObject({ payload: z.string().max(32_768),
  signature: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/u).max(16_384) });
const claimsSchema = z.object({ critical: z.strictObject({
  type: z.literal('cosign container image signature'),
  identity: z.strictObject({ 'docker-reference': z.string() }),
  image: z.strictObject({ 'docker-manifest-digest': z.string() }),
}) });
const descriptor = z.object({ digest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  size: z.number().int().nonnegative().max(32 * 1024 * 1024), mediaType: z.string() });
const manifestSchema = z.object({ schemaVersion: z.literal(2),
  mediaType: z.literal('application/vnd.oci.image.manifest.v1+json'),
  config: descriptor.extend({ mediaType: z.literal('application/vnd.oci.image.config.v1+json') }),
  layers: z.array(descriptor.extend({ mediaType: z.enum([
    'application/vnd.oci.image.layer.v1.tar', 'application/vnd.oci.image.layer.v1.tar+gzip',
    'application/vnd.oci.image.layer.v1.tar+zstd',
  ]) })).max(64),
});
const configSchema = z.object({ os: z.literal('linux'), architecture: z.enum(['amd64', 'arm64']) });
type Request = z.infer<typeof requestSchema>;
type Trust = z.infer<typeof trustSchema>;
type Evidence = { imageDigest: string; platform: string; trustVersion: number;
  trustDigest: string; signerDigest: string };
type Verification = { verdict: 'pass'; evidence: Evidence } |
  { verdict: 'fail' | 'unavailable'; reasonCode: string };
// Keep registry transport outside this private verifier. No production reader is connected yet.
type RegistryRead = (repository: string, resource: string, signal: AbortSignal) => Promise<Uint8Array>;

function hash(value: string | Uint8Array) {
  const hasher = createHash('sha256');
  hasher.update(value);
  return hasher.digest('hex');
}
function trustEvidence(trust: Trust) {
  const key = createPublicKey(trust.publicKey);
  const encoded = key.export({ type: 'spki', format: 'der' });
  const signerDigest = hash(encoded);
  const trustDigest = hash(JSON.stringify([trust.version, trust.repository, signerDigest,
    trust.revoked]));
  return { trustVersion: trust.version, signerDigest, trustDigest };
}
export function currentHostedVerification(evidence: Evidence, rawRequest: unknown,
  rawTrust: unknown): boolean {
  try {
    const request = requestSchema.parse(rawRequest);
    const trust = trustSchema.parse(rawTrust);
    const current = trustEvidence(trust);
    return !trust.revoked && trust.repository === request.repository &&
      evidence.imageDigest === request.imageDigest && evidence.platform === request.platform &&
      evidence.trustVersion === current.trustVersion && evidence.trustDigest === current.trustDigest &&
      evidence.signerDigest === current.signerDigest;
  } catch {
    return false;
  }
}

class RegistryUnavailable extends Error {}
class ImageRefused extends Error {}

async function readBytes(read: RegistryRead, request: Request, resource: string, maximum: number) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  function deadline(_resolve: (value: never) => void, reject: (error: Error) => void) {
    function expire() {
      controller.abort();
      reject(new RegistryUnavailable());
    }
    timer = setTimeout(expire, 1_000);
  }
  let value: Uint8Array;
  try {
    const timeout = new Promise<never>(deadline);
    const reading = read(request.repository, resource, controller.signal);
    value = await Promise.race([reading, timeout]);
  } catch {
    throw new RegistryUnavailable();
  } finally {
    clearTimeout(timer);
  }
  if (value.byteLength > maximum) {
    throw new ImageRefused();
  }
  return Buffer.from(value);
}
async function readHashed(read: RegistryRead, request: Request, resource: string,
  maximum: number, size?: number) {
  const value = await readBytes(read, request, resource, maximum);
  if (`sha256:${hash(value)}` !== resource || (size !== undefined && value.length !== size)) {
    throw new ImageRefused();
  }
  return value;
}
async function checkImage(read: RegistryRead, request: Request) {
  const manifestBytes = await readHashed(read, request, `sha256:${request.imageDigest}`, 1024 * 1024);
  const manifest = manifestSchema.parse(JSON.parse(manifestBytes.toString()));
  const configBytes = await readHashed(read, request, manifest.config.digest, 1024 * 1024,
    manifest.config.size);
  const config = configSchema.parse(JSON.parse(configBytes.toString()));
  if (`${config.os}/${config.architecture}` !== request.platform) {
    throw new ImageRefused();
  }
  let total = manifestBytes.length + configBytes.length;
  for (const layer of manifest.layers) {
    total += layer.size;
    if (total > 128 * 1024 * 1024) {
      throw new ImageRefused();
    }
    await readHashed(read, request, layer.digest, 32 * 1024 * 1024, layer.size);
  }
}

export async function verifyHostedImage(rawRequest: unknown, rawTrust: unknown,
  read: RegistryRead, binary: string): Promise<Verification> {
  let reasonCode = 'signature_refused';
  try {
    const request = requestSchema.parse(rawRequest);
    // Trust comes from the operator, separately from the installer's request.
    const trust = trustSchema.parse(rawTrust);
    if (trust.revoked || trust.repository !== request.repository) {
      throw new ImageRefused();
    }
    const pinned = trustEvidence(trust);
    const signatureBytes = await readBytes(read, request, 'signature', 64 * 1024);
    const signed = signatureSchema.parse(JSON.parse(signatureBytes.toString()));
    const signature = await verifyPublisherSignature(binary, trust.publicKey,
      signed.payload, signed.signature);
    if (signature === 'unavailable') {
      return { verdict: 'unavailable', reasonCode: 'verifier_unavailable' };
    }
    if (signature !== 'pass') {
      throw new ImageRefused();
    }
    const claims = claimsSchema.parse(JSON.parse(signed.payload));
    if (claims.critical.identity['docker-reference'] !== request.repository ||
        claims.critical.image['docker-manifest-digest'] !== `sha256:${request.imageDigest}`) {
      throw new ImageRefused();
    }
    reasonCode = 'image_refused';
    await checkImage(read, request);
    // Recheck operator state after slow reads so rotation during inspection cannot pass.
    const evidence = { imageDigest: request.imageDigest, platform: request.platform, ...pinned };
    if (!currentHostedVerification(evidence, request, rawTrust)) {
      return { verdict: 'fail', reasonCode: 'signature_refused' };
    }
    return { verdict: 'pass', evidence };
  } catch (error) {
    if (error instanceof RegistryUnavailable) {
      return { verdict: 'unavailable', reasonCode: 'registry_unavailable' };
    }
    return { verdict: 'fail', reasonCode };
  }
}
