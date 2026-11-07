import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { natsFixture } from '@opencrane/event-store/testing';
import { databases, openfga } from '@opencrane/authz/testing';
import { pgDb } from '@opencrane/projections';
import { decisionRecordedDataSchema } from '@opencrane/events';
import { toolCredentialReleaseExample } from '../../events/src/credential-release.ts';
import { credentialBroker } from '../src/credential-broker.ts';
import { envelope } from '../src/actor.ts';

let nats: Awaited<ReturnType<typeof natsFixture>>;
let storage: Awaited<ReturnType<typeof databases>>;
let fga: Awaited<ReturnType<typeof openfga>>;
let serial = 0;
beforeAll(async function start() {
  nats = await natsFixture();
  storage = await databases();
  fga = await openfga();
}, 120_000);
afterAll(async function stop() {
  await fga?.close();
  await storage?.close();
  await nats?.close();
});

async function fixture() {
  serial += 1;
  const suffix = String(serial);
  const userId = `owner${suffix}`;
  const serverId = `server${suffix}`;
  const profileId = `profile${suffix}`;
  const requestId = `request${suffix}`;
  const decisionId = `decision${suffix}`;
  const issuedAt = Date.now();
  const release = {
    requestId, permitId: requestId, leaseId: requestId, purpose: 'tool_call' as const,
    userId, ownerId: userId, ownerKind: 'company' as const,
    assistantId: 'assistant', computerId: 'computer', computerGeneration: 1,
    conversationId: 'conversation', turnId: 'turn', threadId: 'thread',
    serverId, toolName: 'read', argumentsDigest: 'a'.repeat(64),
    connectionId: 'installed', profileId, generation: 1,
    profileRevision: 1, selectionRevision: 1, policyRevision: 1,
    accountDigest: 'b'.repeat(64), scopeDigest: 'c'.repeat(64),
    routineId: `routine${suffix}`, occurrenceId: `occurrence${suffix}`,
    companyAccountId: 'company-bot', schemaDigest: 'd'.repeat(64),
    payingGroupId: 'payer', issuedAt, expiresAt: issuedAt + 30_000,
  };
  const decision = envelope('test', `decision-${requestId}`, 'decision.recorded', {
    requestId, requesterId: userId, assistantId: 'assistant', conversationId: 'conversation',
    turnId: 'turn', permitId: requestId, serverId, toolName: 'read', route: 'mcp',
    outcome: 'allow', reason: 'policy_allow', contextDigest: 'e'.repeat(64), release,
  }, decisionId);
  await nats.seed([decision]);
  const context = { requestId, permitId: requestId, userId, assistantId: 'assistant',
    computerId: 'computer', computerGeneration: 1, conversationId: 'conversation',
    turnId: 'turn', threadId: 'thread', serverId, toolName: 'read',
    argumentsDigest: release.argumentsDigest, purpose: 'tool_call' };
  const sends: string[] = [];
  const custody = { async readAccessMaterial() { return 'synthetic-company-token'; } };
  const loadConfiguration = async () => ({});
  const readProfile = () => ({ status: 'verified', accountId: 'company-bot' });
  const checkAccess = vi.fn(async () => undefined);
  async function prepareAccess() {
    return { deadline: performance.now() + 2000, checkAccess };
  }
  async function send(material: string) {
    sends.push(material);
  }
  const db = pgDb(storage.queue);
  function broker(raw: unknown = context) {
    return credentialBroker(nats.store, db, custody, 'test', decisionId, raw,
      loadConfiguration, prepareAccess, send, readProfile);
  }
  return { release, context, broker, sends, checkAccess, readProfile, userId, serverId,
    profileId, requestId, decisionId };
}

it('accepts a strict company release record with its frozen routine binding', function contract() {
  const release = { ...toolCredentialReleaseExample, ownerKind: 'company',
    routineId: 'routine', occurrenceId: 'occurrence',
    companyAccountId: 'account', schemaDigest: 'd'.repeat(64), payingGroupId: 'payer' };
  const personal = decisionRecordedDataSchema.shape.release;
  expect(personal?.safeParse(release).success).toBe(true);
});

it('refuses a company release without an explicit verified profile', async function missingProfile() {
  const test = await fixture();
  await expect(test.broker().send()).rejects.toThrow('Release unavailable');
  expect(test.sends).toEqual([]);
});

it('does not accept a forged profile in the authenticated context', async function forgedProfile() {
  const test = await fixture();
  const forged = { ...test.context, profileId: 'personal-profile' };
  await expect(test.broker(forged).send()).rejects.toThrow('Release unavailable');
  expect(test.sends).toEqual([]);
});
