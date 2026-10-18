import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { beforeAll, expect, it } from 'vitest';
import { z } from 'zod';
import { inspectHostedLicences } from '../src/hosted-licences.ts';

const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const encodedKey = keys.publicKey.export({ type: 'spki', format: 'pem' });
const publicKey = encodedKey.toString();
const repository = 'registry.example/private/tool';
const verificationFailures = ['revoked', 'tampered', 'config', 'layer',
  'unsigned', 'wrong-key', 'architecture'];
const fixtureSchema = z.object({ imageDigest: z.string(),
  blobs: z.record(z.string(), z.string()), review: z.record(z.string(), z.unknown()) });
function prepareTools() {
  execFileSync('sh', ['scripts/fetch-cosign.sh']);
  execFileSync('sh', ['scripts/fetch-hosted-syft.sh']);
}
beforeAll(prepareTools, 120_000);

async function inspect(mode = 'allowed', fault = '') {
  const fixtureArguments = ['libs/models/test/support/hosted-licence-fixture.py', mode];
  const output = execFileSync('python3', fixtureArguments);
  const fixture = fixtureSchema.parse(JSON.parse(output.toString()));
  const directory = await mkdtemp(join(tmpdir(), 'hosted-licence-test-'));
  const reviewPath = join(directory, 'review.json');
  if (mode !== 'no-review') {
    await writeFile(reviewPath, JSON.stringify(fixture.review));
  }
  const request = { repository, imageDigest: fixture.imageDigest, platform: 'linux/amd64' };
  if (fault === 'architecture') {
    request.platform = 'linux/arm64';
  }
  const trust = { version: 1, repository, publicKey, revoked: fault === 'revoked' };
  if (fault === 'wrong-key') {
    const otherKeys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const otherPem = otherKeys.publicKey.export({ type: 'spki', format: 'pem' });
    trust.publicKey = otherPem.toString();
  }
  const claims = { critical: { type: 'cosign container image signature',
    identity: { 'docker-reference': repository },
    image: { 'docker-manifest-digest': `sha256:${fixture.imageDigest}` } } };
  const payload = JSON.stringify(claims);
  const signatureBytes = sign('sha256', Buffer.from(payload), keys.privateKey);
  const signature = signatureBytes.toString('base64');
  const reads: string[] = [];
  function read(_repository: string, resource: string) {
    reads.push(resource);
    if (resource === 'signature') {
      const signed = fault === 'unsigned' ? {} : { payload, signature };
      return Promise.resolve(Buffer.from(JSON.stringify(signed)));
    }
    if (fault === 'registry') {
      throw new Error('private registry credential');
    }
    const encoded = fixture.blobs[resource.slice(7)]!;
    const bytes = Buffer.from(encoded, 'base64');
    const blobNames = Object.keys(fixture.blobs);
    const configurationChanged = fault === 'config' && resource.slice(7) === blobNames[1];
    const layerChanged = fault === 'layer' && resource.slice(7) === blobNames[2];
    if (fault === 'tampered' || configurationChanged || layerChanged) {
      bytes[0] = 0;
    }
    return Promise.resolve(bytes);
  }
  let syft = resolve('.tools/syft');
  if (fault === 'scanner') {
    syft = '/missing/syft';
  }
  if (verificationFailures.includes(fault)) {
    syft = join(directory, 'must-not-scan');
    await writeFile(syft, '#!/bin/sh\ntouch "$0.called"\nexit 1\n', { mode: 0o700 });
  }
  const options = { cosign: resolve('.tools/cosign'), syft,
    osiPath: resolve('.tools/osi.json'), reviewPath };
  try {
    const result = await inspectHostedLicences(request, trust, read, options);
    expect(JSON.stringify(result)).not.toMatch(/private-fixture|registry.example|MIT|BEGIN PUBLIC/u);
    // Each resource is fetched once; inspection cannot replace verified bytes from the registry.
    expect(new Set(reads).size).toBe(reads.length);
    if (verificationFailures.includes(fault)) {
      const { existsSync } = await import('node:fs');
      expect(existsSync(`${syft}.called`)).toBe(false);
    }
    return result;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
async function acceptsReviewedImage(mode: string) {
  const result = await inspect(mode);
  expect(result.verdict).toBe('pass');
  if (result.verdict !== 'pass' || !('sbomDigest' in result.evidence)) {
    throw new Error('Expected licence evidence');
  }
  expect(result.evidence.sbomDigest).toMatch(/^[a-f0-9]{64}$/u);
  expect(result.evidence.reviewDigest).toMatch(/^[a-f0-9]{64}$/u);
}
it.each(['allowed', 'debian', 'deleted'])(
  'accepts complete %s notices with real Syft', acceptsReviewedImage);
async function rejectsLicence(mode: string) {
  expect(await inspect(mode)).toEqual({ verdict: 'fail', reasonCode: 'licence_refused' });
}
it.each(['missing', 'unknown', 'changed', 'bundled', 'debian-layer', 'debian-contrib',
  'incomplete', 'unreviewed-file', 'missing-notice', 'application-cc0',
  'deleted-bundled', 'no-review'])(
  'refuses %s licence evidence', rejectsLicence);
async function rejectsBeforeScanning(fault: string) {
  const result = await inspect('allowed', fault);
  const imageFailures = ['tampered', 'config', 'layer', 'architecture'];
  const reasonCode = imageFailures.includes(fault) ? 'image_refused' : 'signature_refused';
  expect(result).toEqual({ verdict: 'fail', reasonCode });
}
it.each(verificationFailures)(
  'refuses %s before Syft', rejectsBeforeScanning);
async function unavailable(fault: string) {
  const result = await inspect('allowed', fault);
  expect(result).toEqual({ verdict: 'unavailable', reasonCode: `${fault}_unavailable` });
}
it.each(['scanner', 'registry'])('reports %s outage without private details', unavailable);
