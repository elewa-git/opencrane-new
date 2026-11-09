import { afterEach, beforeEach, expect, it } from 'vitest';
import { natsFixture } from '@opencrane/event-store/testing';
import { hostedImageCheckedSchema } from '@opencrane/events';
import { envelope } from '../src/actor.ts';
import { writeHostedAdmission } from '@opencrane/models/image-admission-writer';
import { hasAuthenticatedImageEvidence } from '../src/image-scan-evidence.ts';

let nats: Awaited<ReturnType<typeof natsFixture>>;

async function setup() {
  nats = await natsFixture();
}

async function cleanup() {
  await nats.close();
}

beforeEach(setup);
afterEach(cleanup);

async function refusesInventedEvidenceWithWriterStore() {
  const silo = 'test';
  const serverId = 'proof-test';
  const digest = 'a'.repeat(64);
  const now = new Date();
  const checkedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + 60_000).toISOString();
  const receipt = { verdict: 'pass', checkedAt, expiresAt, engineVersion: '1',
    reportDigest: digest };
  const scanReceipt = { ...receipt, databaseDigest: digest, databaseUpdatedAt: checkedAt };
  const result = hostedImageCheckedSchema.parse({ serverId, attemptId: 1,
    imageDigest: digest, platform: 'linux/amd64',
    checks: { signature: receipt, licence: receipt,
      vulnerability: scanReceipt, malware: scanReceipt } });
  const registration = { serverId, registeredBy: 'alice', kind: 'hosted',
    locator: `ghcr.io/elewa/test@sha256:${digest}`,
    installation: { attemptId: 1, platform: 'linux/amd64',
      upstream: { host: 'api.github.com', port: 443 } } };
  const event = envelope(silo, `mcp-${serverId}`, 'mcp.server_registered', registration);
  event.principal = { kind: 'human', id: 'alice' };
  expect((await nats.store.append({ event, expectedSequence: 0 })).status).toBe('appended');

  const inventedProof = { silo, serverId, attemptId: 1, imageDigest: digest,
    platform: 'linux/amd64', malware: result.checks.malware };
  function matchingEvidence() {
    return Promise.resolve({ verdict: 'clean' as const, malware: result.checks.malware });
  }
  expect(hasAuthenticatedImageEvidence(inventedProof)).toBe(false);
  const outcome = await writeHostedAdmission(nats.store, silo, result, now,
    inventedProof, matchingEvidence);
  expect(outcome.status).toBe('conflict');
  const rows = [];
  for await (const row of nats.store.readStream(`mcp-${serverId}`)) rows.push(row);
  expect(rows).toHaveLength(1);
}

it('refuses invented proof even when its caller has the writer store',
  refusesInventedEvidenceWithWriterStore);
