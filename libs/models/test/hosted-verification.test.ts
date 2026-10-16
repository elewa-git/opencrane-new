import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, expect, it } from 'vitest';
import { z } from 'zod';
import { hostedImageCheckedSchema } from '@opencrane/events';
import { verifyHostedImage, currentHostedVerification } from '../src/hosted-verification.ts';

const repository = 'registry.example/publisher/tool';
const cosign = `${process.cwd()}/.tools/cosign`;
const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const publicKey = publicPem(keys.publicKey);
const otherKeys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });

function publicPem(key: KeyObject) {
  const exported = key.export({ type: 'spki', format: 'pem' });
  return exported.toString();
}
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
  const layer = Buffer.alloc(1024);
  const lastLayer = Buffer.alloc(2048);
  const config = bytes({ os: 'linux', architecture,
    rootfs: { type: 'layers', diff_ids: [`sha256:${hash(layer)}`, `sha256:${hash(lastLayer)}`] },
    config: { Cmd: ['/candidate-must-never-run'] } });
  const manifest = bytes({ schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.manifest.v1+json',
    config: descriptor(config, 'application/vnd.oci.image.config.v1+json'),
    layers: [descriptor(layer, 'application/vnd.oci.image.layer.v1.tar'),
      descriptor(lastLayer, 'application/vnd.oci.image.layer.v1.tar')] });
  const imageDigest = hash(manifest);
  const request = { repository, imageDigest, platform: `linux/${architecture}` };
  const trust = { version: 1, repository, publicKey, revoked: false };
  function signed(subject = imageDigest, identity = repository, signingKey = keys.privateKey) {
    const payload = JSON.stringify({ critical: {
      identity: { 'docker-reference': identity },
      image: { 'docker-manifest-digest': `sha256:${subject}` },
      type: 'cosign container image signature' } });
    const signedBytes = sign('sha256', Buffer.from(payload), signingKey);
    const signature = signedBytes.toString('base64');
    blobs.set('signature', bytes({ payload, signature }));
  }
  signed();
  blobs.set(`sha256:${imageDigest}`, manifest);
  blobs.set(`sha256:${hash(config)}`, config);
  blobs.set(`sha256:${hash(layer)}`, layer);
  blobs.set(`sha256:${hash(lastLayer)}`, lastLayer);
  function read(scope: string, resource: string) {
    expect(scope).toBe(repository);
    reads.push(resource);
    const value = blobs.get(resource);
    if (!value) {
      throw new Error('private registry credential must not escape');
    }
    return Promise.resolve(value);
  }
  function verify(binary = cosign) {
    return verifyHostedImage(request, trust, read, binary);
  }
  return { blobs, reads, request, trust, signed, verify, manifest, config, layer, lastLayer };
}

async function acceptsExactImage(architecture: string) {
  const image = fixture(architecture);
  const result = await image.verify();
  expect(result).toMatchObject({ verdict: 'pass', evidence: {
    imageDigest: image.request.imageDigest, platform: image.request.platform, trustVersion: 1,
  } });
  if (result.verdict !== 'pass') {
    throw new Error('Expected verified image');
  }
  expect(currentHostedVerification(result.evidence, image.request, image.trust)).toBe(true);
  expect(JSON.stringify(result)).not.toContain(repository);
  expect(JSON.stringify(result)).not.toContain(publicKey);
  expect(image.reads).toHaveLength(5);
  // Keep incomplete checks outside the result writer; Continue still needs all four passes.
  const dated = { verdict: 'pass', checkedAt: '2026-10-16T00:00:00Z',
    expiresAt: '2026-10-16T01:00:00Z', engineVersion: 'fixture',
    reportDigest: image.request.imageDigest };
  const incomplete = { serverId: 'fixture', attemptId: 1,
    imageDigest: image.request.imageDigest, platform: image.request.platform,
    checks: { signature: dated, licence: dated,
      vulnerability: { verdict: 'not_run' }, malware: { verdict: 'not_run' } } };
  expect(hostedImageCheckedSchema.safeParse(incomplete).success).toBe(false);
}
it.each(['amd64', 'arm64'])('verifies the signed %s subject and all stored bytes', acceptsExactImage);

function shellQuote(value: string) {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

async function verifiesWithoutNetwork() {
  const directory = await mkdtemp(join(tmpdir(), 'hosted-offline-test-'));
  try {
    const tracePath = join(directory, 'network.trace');
    const wrapperPath = join(directory, 'cosign');
    // Block socket creation and record attempts across every Cosign thread.
    const script = '#!/bin/sh\nexec timeout 5s strace -f -e trace=network ' +
      '-e inject=socket:error=EACCES -o ' + shellQuote(tracePath) + ' ' +
      shellQuote(cosign) + ' "$@"\n';
    const executable = { mode: 0o700 };
    await writeFile(wrapperPath, script, executable);
    const image = fixture();
    const result = await image.verify(wrapperPath);
    const trace = await readFile(tracePath, 'utf8');
    expect(trace).not.toMatch(/socket\(AF_INET6?,/u);
    expect(trace).toContain('exited with 0');
    expect(result.verdict).toBe('pass');
    expect(image.reads).toHaveLength(5);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
it('verifies a valid signature with no outbound network attempts', verifiesWithoutNetwork);

const signatureFailures = ['unsigned', 'wrong_key', 'wrong_subject', 'wrong_repository',
  'revoked', 'scope', 'malformed', 'installer_key'];
async function refusesSignature(mode: string) {
  const image = fixture();
  if (mode === 'unsigned') {
    image.blobs.set('signature', bytes({}));
  }
  if (mode === 'wrong_key') {
    image.signed(undefined, undefined, otherKeys.privateKey);
  }
  if (mode === 'wrong_subject') {
    image.signed('a'.repeat(64));
  }
  if (mode === 'wrong_repository') {
    image.signed(undefined, 'registry.example/other');
  }
  if (mode === 'revoked') {
    image.trust.revoked = true;
  }
  if (mode === 'scope') {
    image.trust.repository += '-other';
  }
  if (mode === 'malformed') {
    image.blobs.set('signature', Buffer.from('private package text'));
  }
  if (mode === 'installer_key') {
    image.signed(undefined, undefined, otherKeys.privateKey);
    const installerTrust = { publicKey: publicPem(otherKeys.publicKey) };
    Object.assign(image.request, installerTrust);
  }
  expect(await image.verify()).toEqual({ verdict: 'fail', reasonCode: 'signature_refused' });
  expect(image.reads).not.toContain(`sha256:${image.request.imageDigest}`);
}
it.each(signatureFailures)('refuses %s before reading candidate bytes', refusesSignature);

async function refusesTamperedBytes(part: 'manifest' | 'config' | 'layer' | 'lastLayer') {
  const image = fixture();
  const digest = `sha256:${hash(image[part])}`;
  image.blobs.set(digest, Buffer.from('tampered private bytes'));
  expect(await image.verify()).toEqual({ verdict: 'fail', reasonCode: 'image_refused' });
}
it.each(['manifest', 'config', 'layer', 'lastLayer'] as const)('refuses tampered %s', refusesTamperedBytes);

async function refusesManifest(mode: string) {
  const image = fixture();
  const original = z.record(z.string(), z.unknown()).parse(JSON.parse(image.manifest.toString()));
  if (mode === 'index') {
    original['mediaType'] = 'application/vnd.oci.image.index.v1+json';
  }
  if (mode === 'size') original['config'] = { ...descriptor(image.config,
    'application/vnd.oci.image.config.v1+json'), size: 1 };
  if (mode === 'layer_type') {
    original['layers'] = [descriptor(image.layer, 'foreign/layer')];
  }
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
  if (result.verdict !== 'pass') {
    throw new Error('Expected verified image');
  }
  const changes = [{ version: 2 }, { revoked: true }, { repository: `${repository}-other` },
    { publicKey: publicPem(otherKeys.publicKey) }];
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

async function unavailableScratchFile(filename: string) {
  const directory = await mkdtemp(join(tmpdir(), 'hosted-file-error-test-'));
  try {
    const wrapperPath = join(directory, 'cosign');
    const statusPath = join(directory, 'exit-code');
    const errorPath = join(directory, 'stderr');
    // Replace only this invocation's scratch file before the real verifier opens it.
    const script = '#!/bin/sh\nset -eu\n' +
      'rm "$HOME/"' + shellQuote(filename) + '\n' +
      'mkdir "$HOME/"' + shellQuote(filename) + '\n' +
      'status=0\n' + shellQuote(cosign) + ' "$@" 2>' + shellQuote(errorPath) +
      ' || status=$?\ncat ' + shellQuote(errorPath) + ' >&2\n' +
      'printf "%s" "$status" >' + shellQuote(statusPath) + '\nexit "$status"\n';
    const executable = { mode: 0o700 };
    await writeFile(wrapperPath, script, executable);
    const image = fixture();
    const result = await image.verify(wrapperPath);
    expect(await readFile(statusPath, 'utf8')).toBe('1');
    expect(await readFile(errorPath, 'utf8')).toContain('is a directory');
    expect(result).toEqual({ verdict: 'unavailable', reasonCode: 'verifier_unavailable' });
    expect(image.reads).toEqual(['signature']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
it.each(['publisher.pem', 'payload', 'signature'])(
  'reports an unreadable %s as unavailable when Cosign exits 1', unavailableScratchFile);

async function refusesChangedTrustDuringRead() {
  const image = fixture();
  function read(_scope: string, resource: string) {
    if (resource === `sha256:${hash(image.layer)}`) {
      image.trust.revoked = true;
    }
    return Promise.resolve(image.blobs.get(resource)!);
  }
  expect(await verifyHostedImage(image.request, image.trust, read, cosign))
    .toEqual({ verdict: 'fail', reasonCode: 'signature_refused' });
}
it('refuses trust revoked while reading the image', refusesChangedTrustDuringRead);

async function unavailableStalledRegistry() {
  const image = fixture();
  function neverCompletes() {
    return new Promise<Uint8Array>(keepPending);
  }
  function keepPending() {
    // Model a registry that ignores cancellation.
  }
  expect(await verifyHostedImage(image.request, image.trust, neverCompletes, cosign))
    .toEqual({ verdict: 'unavailable', reasonCode: 'registry_unavailable' });
}
it('bounds a stalled registry read', unavailableStalledRegistry);

async function refusesBounds(mode: string) {
  const image = fixture();
  if (mode === 'signature') {
    image.blobs.set('signature', Buffer.alloc(65_537));
  } else {
    const original = z.record(z.string(), z.unknown()).parse(JSON.parse(image.manifest.toString()));
    if (mode === 'manifest') {
      original['annotations'] = 'x'.repeat(1024 * 1024);
    }
    if (mode === 'config') {
      const config = bytes({ architecture: 'amd64', os: 'linux', extra: 'x'.repeat(1024 * 1024) });
      original['config'] = descriptor(config, 'application/vnd.oci.image.config.v1+json');
      image.blobs.set(`sha256:${hash(config)}`, config);
    }
    const layer = descriptor(image.layer, 'application/vnd.oci.image.layer.v1.tar');
    if (mode === 'total') {
      const largeLayer = Buffer.alloc(32 * 1024 * 1024);
      const largeDescriptor = descriptor(largeLayer, 'application/vnd.oci.image.layer.v1.tar');
      image.blobs.set(largeDescriptor.digest, largeLayer);
      original['layers'] = Array(4).fill(largeDescriptor);
    }
    if (mode === 'count') {
      original['layers'] = Array(65).fill(layer);
    }
    if (mode === 'layer') {
      original['layers'] = [{ ...layer, size: 32 * 1024 * 1024 + 1 }];
    }
    const changed = bytes(original);
    image.request.imageDigest = hash(changed);
    image.blobs.set(`sha256:${hash(changed)}`, changed);
    image.signed(hash(changed));
  }
  const reasonCode = mode === 'signature' ? 'signature_refused' : 'image_refused';
  expect(await image.verify()).toEqual({ verdict: 'fail', reasonCode });
}
const excessive = ['signature', 'manifest', 'config', 'count', 'layer', 'total'];
it.each(excessive)('refuses excess %s bytes or count', refusesBounds);
