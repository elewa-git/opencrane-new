import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { beforeAll, expect, it } from 'vitest';
import { hostedImageCheckedSchema } from '@opencrane/events';
import { verifyHostedImage, currentHostedVerification } from '../src/hosted-verification.ts';

const repository = 'registry.example/publisher/tool';
const cosign = `${process.cwd()}/.tools/cosign`;
const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const otherKeys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });

function fetchCosign() {
  execFileSync('sh', ['scripts/fetch-cosign.sh'], { stdio: 'pipe', timeout: 120_000 });
}
beforeAll(fetchCosign, 120_000);
function hash(bytes: Uint8Array) {
  const digest = createHash('sha256');
  digest.update(bytes);
  return digest.digest('hex');
}
function bytes(value: unknown) {
  return Buffer.from(JSON.stringify(value));
}
function descriptor(value: Buffer, mediaType: string) {
  return { digest: `sha256:${hash(value)}`, size: value.length, mediaType };
}
function fixture(architecture = 'amd64') {
  const blobs = new Map<string, Buffer>();
  const reads: string[] = [];
  const layer = Buffer.from('candidate bytes must never execute');
  const config = bytes({ os: 'linux', architecture });
  const manifest = bytes({ schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.manifest.v1+json',
    config: descriptor(config, 'application/vnd.oci.image.config.v1+json'),
    layers: [descriptor(layer, 'application/vnd.oci.image.layer.v1.tar')] });
  const imageDigest = hash(manifest);
  const request = { repository, imageDigest, platform: `linux/${architecture}` };
  const trust = { version: 1, repository, publicKey, revoked: false };
  function signed(subject = imageDigest, identity = repository, signingKey = keys.privateKey) {
    const payload = JSON.stringify({ critical: {
      identity: { 'docker-reference': identity },
      image: { 'docker-manifest-digest': `sha256:${subject}` },
      type: 'cosign container image signature' } });
    const signature = sign('sha256', Buffer.from(payload), signingKey).toString('base64');
    blobs.set('signature', bytes({ payload, signature }));
  }
  signed();
  blobs.set(`sha256:${imageDigest}`, manifest);
  blobs.set(`sha256:${hash(config)}`, config);
  blobs.set(`sha256:${hash(layer)}`, layer);
  async function read(scope: string, resource: string) {
    expect(scope).toBe(repository);
    reads.push(resource);
    const value = blobs.get(resource);
    if (!value) throw new Error('private registry credential must not escape');
    return value;
  }
  function verify(binary = cosign) {
    return verifyHostedImage(request, trust, read, binary);
  }
  return { blobs, reads, request, trust, signed, verify, manifest, config, layer };
}

async function acceptsExactImage(architecture: string) {
  const image = fixture(architecture);
  const result = await image.verify();
  expect(result).toMatchObject({ verdict: 'pass', evidence: {
    imageDigest: image.request.imageDigest, platform: image.request.platform, trustVersion: 1,
  } });
  if (result.verdict !== 'pass') throw new Error('Expected verified image');
  expect(currentHostedVerification(result.evidence, image.request, image.trust)).toBe(true);
  expect(JSON.stringify(result)).not.toContain(repository);
  expect(JSON.stringify(result)).not.toContain(publicKey);
  expect(image.reads).toHaveLength(4);
  // Keep incomplete checks outside the result writer; Continue still needs all four passes.
  const incomplete = { serverId: 'fixture', attemptId: 1, ...image.request,
    checks: { signature: result, licence: { verdict: 'not_run' },
      vulnerability: { verdict: 'not_run' }, malware: { verdict: 'not_run' } } };
  expect(hostedImageCheckedSchema.safeParse(incomplete).success).toBe(false);
}
it.each(['amd64', 'arm64'])('verifies the signed %s subject and all stored bytes', acceptsExactImage);

const signatureFailures = ['unsigned', 'wrong_key', 'wrong_subject', 'wrong_repository',
  'revoked', 'scope', 'malformed', 'installer_key'];
async function refusesSignature(mode: string) {
  const image = fixture();
  if (mode === 'unsigned') image.blobs.set('signature', bytes({}));
  if (mode === 'wrong_key') image.signed(undefined, undefined, otherKeys.privateKey);
  if (mode === 'wrong_subject') image.signed('a'.repeat(64));
  if (mode === 'wrong_repository') image.signed(undefined, 'registry.example/other');
  if (mode === 'revoked') image.trust.revoked = true;
  if (mode === 'scope') image.trust.repository += '-other';
  if (mode === 'malformed') image.blobs.set('signature', Buffer.from('private package text'));
  if (mode === 'installer_key') {
    image.signed(undefined, undefined, otherKeys.privateKey);
    Object.assign(image.request, { publicKey: otherKeys.publicKey.export({
      type: 'spki', format: 'pem' }).toString() });
  }
  expect(await image.verify()).toEqual({ verdict: 'fail', reasonCode: 'signature_refused' });
  expect(image.reads).not.toContain(`sha256:${image.request.imageDigest}`);
}
it.each(signatureFailures)('refuses %s before reading candidate bytes', refusesSignature);

async function refusesTamperedBytes(part: 'manifest' | 'config' | 'layer') {
  const image = fixture();
  const digest = `sha256:${hash(image[part])}`;
  image.blobs.set(digest, Buffer.from('tampered private bytes'));
  expect(await image.verify()).toEqual({ verdict: 'fail', reasonCode: 'image_refused' });
}
it.each(['manifest', 'config', 'layer'] as const)('refuses tampered %s', refusesTamperedBytes);

async function refusesManifest(mode: string) {
  const image = fixture();
  const original = JSON.parse(image.manifest.toString()) as Record<string, unknown>;
  if (mode === 'index') original['mediaType'] = 'application/vnd.oci.image.index.v1+json';
  if (mode === 'size') original['config'] = { ...descriptor(image.config,
    'application/vnd.oci.image.config.v1+json'), size: 1 };
  if (mode === 'layer_type') original['layers'] = [descriptor(image.layer, 'foreign/layer')];
  const changed = bytes(original);
  image.request.imageDigest = hash(changed);
  image.blobs.set(`sha256:${hash(changed)}`, changed);
  image.signed(hash(changed));
  expect(await image.verify()).toEqual({ verdict: 'fail', reasonCode: 'image_refused' });
}
it.each(['index', 'size', 'layer_type'])('refuses signed %s substitution', refusesManifest);

async function refusesArchitecture() {
  const image = fixture('arm64');
  image.request.platform = 'linux/amd64';
  expect(await image.verify()).toEqual({ verdict: 'fail', reasonCode: 'image_refused' });
  expect(image.reads).not.toContain(`sha256:${hash(image.layer)}`);
}
it('refuses the wrong architecture before reading layers', refusesArchitecture);

async function invalidatesTrust() {
  const image = fixture();
  const result = await image.verify();
  if (result.verdict !== 'pass') throw new Error('Expected verified image');
  const changes = [{ version: 2 }, { revoked: true }, { repository: `${repository}-other` },
    { publicKey: otherKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString() }];
  for (const change of changes) {
    const trust = { ...image.trust, ...change };
    expect(currentHostedVerification(result.evidence, image.request, trust)).toBe(false);
  }
  const request = { ...image.request, platform: 'linux/arm64' };
  expect(currentHostedVerification(result.evidence, request, image.trust)).toBe(false);
}
it('invalidates old evidence after rotation, revocation, scope or platform changes', invalidatesTrust);

async function unavailableRegistry() {
  const image = fixture();
  image.blobs.delete(`sha256:${hash(image.layer)}`);
  expect(await image.verify()).toEqual({ verdict: 'unavailable', reasonCode: 'registry_unavailable' });
}
it('reports a registry outage without exposing private error data', unavailableRegistry);
async function unavailableVerifier() {
  const image = fixture();
  expect(await image.verify('/missing/cosign')).toEqual({ verdict: 'unavailable',
    reasonCode: 'verifier_unavailable' });
  expect(image.reads).not.toContain(`sha256:${image.request.imageDigest}`);
}
it('reports a missing verifier before reading candidate bytes', unavailableVerifier);
