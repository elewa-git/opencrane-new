import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { beforeAll, expect, it } from 'vitest';
import { z } from 'zod';
import { inspectHostedLicences } from '../src/hosted-licences.ts';

const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const repository = 'registry.example/private/tool';
const fixtureSchema = z.object({ imageDigest: z.string(),
  blobs: z.record(z.string(), z.string()), review: z.record(z.string(), z.unknown()) });
function prepareTools() {
  execFileSync('sh', ['scripts/fetch-cosign.sh']);
  execFileSync('sh', ['scripts/fetch-hosted-syft.sh']);
}
beforeAll(prepareTools, 120_000);

async function inspect(mode = 'allowed', fault = '') {
  const output = execFileSync('python3', ['libs/models/test/support/hosted-licence-fixture.py', mode]);
  const fixture = fixtureSchema.parse(JSON.parse(output.toString()));
  const directory = await mkdtemp(join(tmpdir(), 'hosted-licence-test-'));
  const reviewPath = join(directory, 'review.json');
  await writeFile(reviewPath, JSON.stringify(fixture.review));
  const request = { repository, imageDigest: fixture.imageDigest, platform: 'linux/amd64' };
  const trust = { version: 1, repository, publicKey, revoked: fault === 'revoked' };
  const payload = JSON.stringify({ critical: { type: 'cosign container image signature',
    identity: { 'docker-reference': repository },
    image: { 'docker-manifest-digest': `sha256:${fixture.imageDigest}` } } });
  const signatureBytes = sign('sha256', Buffer.from(payload), keys.privateKey);
  const signature = signatureBytes.toString('base64');
  const reads: string[] = [];
  function read(_repository: string, resource: string) {
    reads.push(resource);
    if (resource === 'signature') {
      return Promise.resolve(Buffer.from(JSON.stringify({ payload, signature })));
    }
    if (fault === 'registry') {
      throw new Error('private registry credential');
    }
    const encoded = fixture.blobs[resource.slice(7)]!;
    const bytes = Buffer.from(encoded, 'base64');
    if (fault === 'tampered') {
      bytes[0] = 0;
    }
    return Promise.resolve(bytes);
  }
  let syft = resolve('.tools/syft');
  if (fault === 'scanner') {
    syft = '/missing/syft';
  }
  if (fault === 'revoked' || fault === 'tampered') {
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
    if (fault === 'revoked' || fault === 'tampered') {
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
  expect(result).toMatchObject({ verdict: 'pass', evidence: {
    sbomDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
    reviewDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
  } });
}
it.each(['allowed', 'debian'])('accepts complete %s notices with real Syft', acceptsReviewedImage);
async function rejectsLicence(mode: string) {
  expect(await inspect(mode)).toEqual({ verdict: 'fail', reasonCode: 'licence_refused' });
}
it.each(['missing', 'unknown', 'changed', 'bundled', 'debian-layer', 'debian-contrib'])(
  'refuses %s licence evidence', rejectsLicence);
async function rejectsBeforeScanning(fault: string) {
  const result = await inspect('allowed', fault);
  expect(result.verdict).toBe('fail');
}
it.each(['revoked', 'tampered'])('refuses %s before Syft', rejectsBeforeScanning);
async function unavailable(fault: string) {
  const result = await inspect('allowed', fault);
  expect(result).toEqual({ verdict: 'unavailable', reasonCode: `${fault}_unavailable` });
}
it.each(['scanner', 'registry'])('reports %s outage without private details', unavailable);
