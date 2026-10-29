import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { afterAll, afterEach, beforeAll, expect, it, onTestFinished, vi } from 'vitest';
import { natsFixture } from '@opencrane/event-store/testing';
import { databases } from '@opencrane/authz/testing';
import { pgDb } from '@opencrane/projections';
import { envelope, history } from '../src/actor.ts';
import { authorityFence } from '../src/authority.ts';
import { connectionCustody, type ConnectionStage } from '../src/connection-custody.ts';
import { credentialBroker } from '../src/credential-broker.ts';
import { oauthSelectionFixture } from './support/oauth-selection.ts';

let nats: Awaited<ReturnType<typeof natsFixture>>;
let storage: Awaited<ReturnType<typeof databases>>;
let counter = 0;
async function initialise() {
  nats = await natsFixture();
  storage = await databases();
}
async function close() {
  await storage?.close();
  await nats?.close();
}
beforeAll(initialise, 120_000);
afterAll(close);
afterEach(vi.restoreAllMocks);
function digest(value: unknown) {
  const hash = createHash('sha256');
  hash.update(JSON.stringify(value));
  return hash.digest('hex');
}

async function fixture() {
  counter += 1;
  const userId = `person${counter}`;
  const serverId = `server${counter}`;
  const directory = await mkdtemp(`${tmpdir()}/credential-broker-`);
  async function removeDirectory() {
    await rm(directory, { recursive: true, force: true });
  }
  onTestFinished(removeDirectory);
  const secrets = new Map<string, string>();
  const keyring = { currentKeyId: 'test', keys: { test: Buffer.alloc(32, 7) } };
  const custody = connectionCustody('http://127.0.0.1:1', 'custody', keyring, directory);
  async function fetchSecret(url: string | URL | Request, options?: RequestInit) {
    const path = String(url);
    if (options?.method === 'POST') {
      const body: unknown = JSON.parse(String(options.body));
      const secret = body as { metadata: { name: string; uid: string; resourceVersion: string } };
      secret.metadata.uid = 'uid';
      secret.metadata.resourceVersion = '1';
      secrets.set(`${path}/${secret.metadata.name}`, JSON.stringify(secret));
      return new Response(JSON.stringify(secret));
    }
    if (options?.method === 'DELETE') {
      secrets.delete(path);
      return new Response('{}');
    }
    return new Response(secrets.get(path) ?? '{}', { status: secrets.has(path) ? 200 : 404 });
  }
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSecret);
  const contents = JSON.stringify({ access_token: 'synthetic-access',
    refresh_token: 'synthetic-refresh', id_token: 'synthetic-identity' });
  let stage: ConnectionStage;
  async function stageMaterial(input: ConnectionStage) {
    stage = input;
    return custody.stage(input, contents);
  }
  const saved = await oauthSelectionFixture(nats, userId, serverId, 'oauth', stageMaterial);
  const selected = { action: 'select', userId, serverId, connectionId: 'installed',
    profileId: 'oauth', profileRevision: saved.revision, expectedSequence: 0 };
  const selectionSubject = `connection-selection-${userId}-${serverId}`;
  const selection = envelope('test', selectionSubject, 'connection.selected', selected,
    digest(['test', selectionSubject, 'choice']));
  selection.source = 'opencrane-server';
  selection.principal = { kind: 'human', id: userId };
  selection.commandId = 'choice';
  await nats.seed([selection]);
  const issuedAt = Date.now();
  const release = { userId, ownerId: userId, serverId, ownerKind: 'personal' as const,
    purpose: 'tool_call' as const, assistantId: 'assistant', computerId: 'computer',
    computerGeneration: 1, conversationId: 'conversation', turnId: 'turn', threadId: 'thread',
    toolName: 'read', generation: 1, argumentsDigest: 'a'.repeat(64),
    requestId: userId, permitId: userId, leaseId: userId, profileId: 'oauth',
    connectionId: 'installed', profileRevision: saved.revision,
    selectionRevision: await nats.store.head(selectionSubject),
    policyRevision: await nats.store.head(`mcp-${serverId}`),
    accountDigest: digest(saved.saved.activation.account),
    scopeDigest: digest(saved.saved.activation.account.scopes), issuedAt, expiresAt: issuedAt + 30_000 };
  const decision = envelope('test', `decision-${release.requestId}`, 'decision.recorded', {
    requestId: release.requestId, requesterId: userId, assistantId: release.assistantId,
    conversationId: release.conversationId, turnId: release.turnId, permitId: release.permitId,
    serverId, toolName: release.toolName, route: 'mcp', outcome: 'allow',
    reason: 'policy_allow', contextDigest: 'd'.repeat(64), release,
  });
  await nats.seed([decision]);
  const context = { requestId: release.requestId, permitId: release.permitId, userId,
    assistantId: release.assistantId, computerId: release.computerId,
    computerGeneration: release.computerGeneration, conversationId: release.conversationId,
    turnId: release.turnId, threadId: release.threadId, serverId, toolName: release.toolName,
    argumentsDigest: release.argumentsDigest, purpose: release.purpose };
  async function prepareAccess() {
    const fresh = await authorityFence(nats.store, performance.now(), [`member-${userId}`]);
    return { deadline: fresh.deadline, checkAccess: fresh };
  }
  const sends: string[] = [];
  async function send(value: string) {
    const receipts = await history(nats.store, `credential-${userId}`, 'test');
    expect(receipts).toHaveLength(1);
    sends.push(value);
  }
  const db = pgDb(storage.queue);
  function broker(raw: unknown = context, callback = send) {
    return credentialBroker(nats.store, db, custody, 'test', decision.id, raw,
      saved.loadConfiguration, prepareAccess, callback);
  }
  return { ...saved, userId, release, decision, context, broker, sends, custody, db,
    stage: stage!, secrets, fetch, fetchSecret, selectionSubject };
}
async function releasesOnlyAccessOnce() {
  const test = await fixture();
  const broker = test.broker();
  expect(await broker.send()).toBeUndefined();
  await expect(broker.send()).rejects.toThrow('Release unavailable');
  await expect(test.broker().send()).rejects.toThrow('Release unavailable');
  expect(test.sends).toEqual(['synthetic-access']);
  const receipt = await test.broker().recover();
  expect(receipt).toMatchObject({ status: 'confirmed', eventId: `${test.decision.id}:release` });
  const rows = await history(nats.store, `credential-${test.userId}`, 'test');
  const output = JSON.stringify({ rows, receipt });
  expect(output).not.toContain('synthetic-');
}
it('releases only current access material once after its saved audit, including after restart',
  releasesOnlyAccessOnce);
