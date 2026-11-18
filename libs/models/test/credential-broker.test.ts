import { seedKeyAssistant } from './support/connection-release.ts';
import { confirmPreparedCredentialRelease, credentialReleaseEvidence } from '../src/credential-release.ts';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { afterAll, afterEach, beforeAll, expect, it, onTestFinished, vi } from 'vitest';
import { manualClock, natsFixture } from '@opencrane/event-store/testing';
import { databases, until } from '@opencrane/authz/testing';
import { pgDb } from '@opencrane/projections';
import { envelope, history } from '../src/actor.ts';
import { foldConnection } from '../src/bearer-connections.ts';
import { authorityFence } from '../src/authority.ts';
import { connectionCustody, type ConnectionStage } from '../src/connection-custody.ts';
import { credentialBroker } from '../src/credential-broker.ts';
import { MemberAccessRefused } from '../src/member-authority.ts';
import { oauthSelectionFixture, selectPersonalFixture } from './support/oauth-selection.ts';

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

async function fixture(settings: { serverId?: string; secrets?: Map<string, string>;
  material?: string; profileId?: string; assistantKind?: 'personal' | 'team'; consent?: 'allow' | 'deny' } = {}) {
  counter += 1;
  const userId = `person${counter}`;
  const serverId = settings.serverId ?? `server${counter}`;
  const profileId = settings.profileId ?? 'oauth';
  const directory = await mkdtemp(`${tmpdir()}/credential-broker-`);
  async function removeDirectory() {
    await rm(directory, { recursive: true, force: true });
  }
  onTestFinished(removeDirectory);
  const secrets = settings.secrets ?? new Map<string, string>();
  const keyring = { currentKeyId: 'test', keys: { test: Buffer.alloc(32, 7) } };
  const custody = connectionCustody('http://127.0.0.1:1', 'custody', keyring, directory);
  function fetchSecret(url: string | URL | Request, options?: RequestInit) {
    const path = url instanceof Request ? url.url : url.toString();
    if (options?.method === 'POST') {
      if (typeof options.body !== 'string') {
        throw new Error('Fixture body invalid');
      }
      const schema = z.looseObject({ metadata: z.looseObject({ name: z.string(),
        uid: z.string().default('uid'), resourceVersion: z.string().default('1') }) });
      const secret = schema.parse(JSON.parse(options.body));
      secrets.set(`${path}/${secret.metadata.name}`, JSON.stringify(secret));
      return Promise.resolve(new Response(JSON.stringify(secret)));
    }
    if (options?.method === 'DELETE') {
      secrets.delete(path);
      return Promise.resolve(new Response('{}'));
    }
    const response = new Response(secrets.get(path) ?? '{}',
      { status: secrets.has(path) ? 200 : 404 });
    return Promise.resolve(response);
  }
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSecret);
  const contents = JSON.stringify({ access_token: settings.material ?? 'synthetic-access',
    refresh_token: 'synthetic-refresh', id_token: 'synthetic-identity' });
  let stage: ConnectionStage;
  async function stageMaterial(input: ConnectionStage) {
    stage = input;
    return custody.stage(input, contents);
  }
  const saved = await oauthSelectionFixture(nats, userId, serverId, profileId, stageMaterial);
  const selectionSubject = `connection-selection-${userId}-${serverId}`;
  const assistantId = `${userId}-assistant`;
  let allowedAssistantIds: string[] | undefined;
  if (settings.consent === 'allow') allowedAssistantIds = [assistantId];
  if (settings.consent === 'deny') allowedAssistantIds = [];
  const selectionRevision = await selectPersonalFixture(nats, saved, allowedAssistantIds === undefined ? {} : { allowedAssistantIds });
  await seedKeyAssistant(nats, userId, assistantId, settings.assistantKind);
  const issuedAt = Date.now();
  const release = { userId, ownerId: userId, serverId, ownerKind: 'personal' as const,
    purpose: 'tool_call' as const, assistantId, computerId: 'computer',
    computerGeneration: 1, conversationId: 'conversation', turnId: 'turn', threadId: 'thread',
    toolName: 'read', generation: 1, argumentsDigest: 'a'.repeat(64),
    requestId: userId, permitId: userId, leaseId: userId, profileId,
    connectionId: 'installed', profileRevision: saved.revision,
    selectionRevision,
    policyRevision: saved.configuration.policyRevision,
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
  function broker(raw: unknown = context, callback = send,
    permission: Parameters<typeof credentialBroker>[7] = prepareAccess) {
    return credentialBroker(nats.store, db, custody, 'test', decision.id, raw,
      saved.loadConfiguration, permission, callback);
  }
  return { ...saved, userId, release, decision, context, broker, sends, custody, db,
    stage: stage!, secrets, fetch, fetchSecret, selectionSubject, prepareAccess, send };
}
async function keepsConcurrentRequestersSeparate() {
  const secrets = new Map<string, string>();
  const alice = await fixture({ serverId: 'shared', secrets, material: 'alice-access' });
  const bob = await fixture({ serverId: 'shared', secrets, material: 'bob-access',
    profileId: 'bob-oauth' });
  expect(secrets.size).toBe(2);
  const aliceIdentity = { reference: alice.saved.secretRef.slice('secret:'.length),
    uid: alice.saved.activation.uid, resourceVersion: alice.saved.activation.resourceVersion };
  expect(await alice.custody.readAccessMaterial(alice.stage, aliceIdentity)).toBe('alice-access');
  const sends = await Promise.allSettled([alice.broker().send(), bob.broker().send()]);
  expect(sends.map(result => result.status)).toEqual(['fulfilled', 'fulfilled']);
  expect(alice.sends).toEqual(['alice-access']);
  expect(bob.sends).toEqual(['bob-access']);
  expect(await nats.store.head(`credential-${alice.userId}`)).toBeGreaterThan(0);
  expect(await nats.store.head(`credential-${bob.userId}`)).toBeGreaterThan(0);
}
it('keeps two requesters on one server and their release audits separate',
  keepsConcurrentRequestersSeparate);
async function releasesOnlyAccessOnce() {
  const test = await fixture();
  const permission = vi.fn(test.prepareAccess);
  async function readAfterAudit(url: string | URL | Request, options?: RequestInit) {
    expect(permission).toHaveBeenCalledTimes(1);
    const rows = await history(nats.store, `credential-${test.userId}`, 'test');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.event.id).toBe(`${test.decision.id}:release`);
    expect(rows[0]!.event.data).toEqual(test.release);
    return test.fetchSecret(url, options);
  }
  test.fetch.mockImplementationOnce(readAfterAudit);
  const broker = test.broker(test.context, test.send, permission);
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

async function refusesForeignContext(field: string) {
  const test = await fixture();
  const context = { ...test.context, [field]: 'foreign' };
  await expect(test.broker(context).send()).rejects.toThrow('Release unavailable');
  expect(test.sends).toEqual([]);
}
it.each(['userId', 'turnId', 'threadId', 'purpose', 'permitId', 'computerId',
  'conversationId', 'argumentsDigest', 'ownerId'])('refuses changed %s', refusesForeignContext);

async function refusesStoredChange(kind: string) {
  const test = await fixture();
  if (kind === 'expiry') {
    vi.spyOn(Date, 'now').mockReturnValue(test.release.expiresAt);
  } else if (kind === 'scope') {
    test.configuration.toolScopes.read.push('write');
  } else if (kind === 'custody') {
    test.fetch.mockResolvedValue(new Response('synthetic-refresh', { status: 503 }));
  } else if (kind === 'uid' || kind === 'resourceVersion') {
    for (const [key, value] of test.secrets) {
      const old = kind === 'uid' ? '"uid":"uid"' : '"resourceVersion":"1"';
      test.secrets.set(key, value.replace(old, `"${kind}":"changed"`));
    }
  } else {
    const subjects: Record<string, string> = { decision: `decision-${test.userId}`,
      selection: test.selectionSubject, generation: test.subject,
      block: `connection-control-${test.userId}-${test.release.serverId}` };
    const event = envelope('test', subjects[kind]!, 'connection.revoked', {
      userId: test.userId, serverId: test.release.serverId, profile: 'oauth',
      revokedBy: test.userId,
    });
    await nats.seed([event]);
  }
  await expect(test.broker().send()).rejects.toThrow('Release unavailable');
  expect(test.sends).toEqual([]);
  if (['custody', 'uid', 'resourceVersion'].includes(kind)) {
    const rows = await history(nats.store, `credential-${test.userId}`, 'test');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.event.data).toEqual(test.release);
    const receipt = await test.broker().recover();
    expect(receipt).toMatchObject({ status: 'confirmed', eventId: `${test.decision.id}:release` });
    test.fetch.mockClear();
    await expect(test.broker().send()).rejects.toThrow('Release unavailable');
    expect(test.fetch).not.toHaveBeenCalled();
    expect(test.sends).toEqual([]);
  } else {
    expect(await nats.store.head(`credential-${test.userId}`)).toBe(0);
  }
}
it.each(['expiry', 'scope', 'custody', 'uid', 'resourceVersion', 'decision',
  'selection', 'generation', 'block'])('refuses changed %s before release', refusesStoredChange);

async function failedAudit(kind: string) {
  const test = await fixture();
  const append = nats.store.append.bind(nats.store);
  async function uncertain(command: Parameters<typeof append>[0]) {
    if (kind !== 'outage') {
      await append(command);
    }
    if (kind === 'duplicate') {
      const rows = await history(nats.store, `credential-${test.userId}`, 'test');
      return { status: 'appended' as const, sequence: rows[0]!.sequence,
        outcome: { kind: 'duplicate_saved' as const, saved: rows[0]! } };
    }
    return { status: 'unavailable' as const, cause: new Error('synthetic-refresh') };
  }
  const fault = vi.spyOn(nats.store, 'append').mockImplementationOnce(uncertain);
  const broker = test.broker();
  test.fetch.mockClear();
  await expect(broker.send()).rejects.toThrow('Release unavailable');
  expect(test.fetch).not.toHaveBeenCalled();
  fault.mockRestore();
  await expect(broker.send()).rejects.toThrow('Release unavailable');
  if (kind !== 'outage') {
    expect(await test.broker().recover()).toMatchObject({ status: 'confirmed' });
    await expect(test.broker().send()).rejects.toThrow('Release unavailable');
  } else {
    await expect(broker.recover()).rejects.toThrow('Release unavailable');
  }
  expect(test.sends).toEqual([]);
}
it.each(['outage', 'unknown', 'duplicate'])('never sends after an %s audit reply', failedAudit);

async function racingSend(throwing: boolean) {
  const test = await fixture();
  function send(value: string) {
    test.sends.push(value);
    if (throwing) {
      return Promise.reject(new Error('synthetic-access'));
    }
    return Promise.resolve();
  }
  const first = test.broker(test.context, send);
  const second = test.broker(test.context, send);
  const results = await Promise.allSettled([first.send(), first.send(), second.send()]);
  expect(test.sends).toEqual(['synthetic-access']);
  for (const result of results) {
    if (result.status === 'rejected') {
      expect(String(result.reason)).toBe('Error: Release unavailable');
    }
  }
  await expect(test.broker().send()).rejects.toThrow('Release unavailable');
}
it.each([false, true])('cannot send twice with racing instances and throwing=%s', racingSend);

async function heldRead(kind: string) {
  const test = await fixture();
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  function resumeRead() {
    resume.resolve();
  }
  onTestFinished(resumeRead);
  async function read(url: string | URL | Request, options?: RequestInit) {
    entered.resolve();
    await resume.promise;
    return test.fetchSecret(url, options);
  }
  test.fetch.mockImplementationOnce(read);
  const result = test.broker().send();
  const refused = expect(result).rejects.toThrow('Release unavailable');
  await entered.promise;
  if (kind === 'lock loss') {
    await storage.queue.query(`SELECT pg_terminate_backend(pid) FROM pg_locks
      WHERE locktype = 'advisory' AND granted
      AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`);
    resume.resolve();
    await refused;
    expect(test.sends).toEqual([]);
    expect(test.secrets.size).toBe(1);
    return;
  }
  const blocked = envelope('test', `connection-control-${test.userId}-${test.release.serverId}`,
    'connection.disabled', { userId: test.userId, serverId: test.release.serverId,
      profile: 'oauth', disabledBy: 'admin', expectedSequence: 0, reason: 'admin_disabled' });
  await nats.seed([blocked]);
  const { withConnectionStage } = await import('../src/connection-stage-lock.ts');
  let retiring = false;
  async function retire() {
    retiring = true;
    const identity = { reference: test.saved.secretRef.slice('secret:'.length),
      uid: test.saved.activation.uid, resourceVersion: test.saved.activation.resourceVersion };
    return test.custody.retire(test.stage, identity);
  }
  const cleanup = withConnectionStage(test.db, test.stage, retire);
  async function waitingForRead() {
    const result = await storage.queue.query<{ waiting: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory'
       AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
       AND NOT granted) AS waiting`);
    return result.rows[0]?.waiting === true;
  }
  await until(waitingForRead);
  expect(retiring).toBe(false);
  expect(test.secrets.size).toBe(1);
  resume.resolve();
  await refused;
  expect(test.sends).toEqual([]);
  expect(await cleanup).toMatchObject({ status: 'deleted' });
  expect(test.secrets.size).toBe(0);
}
it.each(['block', 'lock loss'])('refuses %s during a read and coordinates retirement', heldRead);

async function finalInvalidation(kind: string) {
  const test = await fixture();
  const append = nats.store.append.bind(nats.store);
  async function changedAfterAudit(command: Parameters<typeof append>[0]) {
    const result = await append(command);
    if (kind === 'lease') {
      vi.spyOn(Date, 'now').mockReturnValue(test.release.expiresAt);
    } else if (kind === 'authority') {
      const now = performance.now();
      vi.spyOn(performance, 'now').mockReturnValue(now + 2001);
    } else {
      const removed = envelope('test', `member-${test.userId}`, 'member.removed',
        { memberId: test.userId, removedBy: 'admin' });
      await nats.seed([removed]);
    }
    return result;
  }
  vi.spyOn(nats.store, 'append').mockImplementationOnce(changedAfterAudit);
  await expect(test.broker().send()).rejects.toThrow('Release unavailable');
  expect(test.sends).toEqual([]);
}
it.each(['lease', 'authority', 'member'])('refuses %s changes after saving the audit',
  finalInvalidation);

async function invalidDecision(kind: string) {
  const test = await fixture();
  const read = nats.store.readStream.bind(nats.store);
  async function* changed(subject: string, from?: number, deadline?: number) {
    for await (const row of read(subject, from, deadline)) {
      const copy = structuredClone(row);
      if (kind === 'bearer' && subject === test.subject) {
        if (row.event.type !== 'connection.created') {
          continue;
        }
        const activation: Record<string, unknown> = { ...test.saved.activation,
          reason: 'bearer_create', expectedSequence: 0 };
        delete activation['account'];
        delete activation['configurationDigest'];
        copy.event.data = { ...test.saved, activation };
        expect(foldConnection([copy]).status).toBe('saved_unverified');
      }
      if (subject === `decision-${test.userId}` && kind !== 'bearer') {
        if (kind === 'missing') {
          continue;
        }
        const data = z.record(z.string(), z.unknown()).parse(copy.event.data);
        if (kind === 'deny') {
          data['outcome'] = 'deny';
        } else {
          data['release'] = { ...test.release, [kind]: changedValue(kind) };
        }
        copy.event.data = data;
      }
      yield copy;
    }
  }
  vi.spyOn(nats.store, 'readStream').mockImplementation(changed);
  test.fetch.mockClear();
  await expect(test.broker().send()).rejects.toThrow('Release unavailable');
  expect(test.fetch).not.toHaveBeenCalled();
  expect(test.sends).toEqual([]);
}
function changedValue(kind: string) {
  if (kind === 'generation') {
    return 2;
  }
  if (kind === 'ownerKind') {
    return 'company';
  }
  return 'foreign';
}
it.each(['missing', 'deny', 'generation', 'ownerId', 'ownerKind', 'purpose', 'bearer'])(
  'reads no custody for a decision with changed %s', invalidDecision);

const preparationFaults = ['none', 'validation', 'history', 'lock', 'profile', 'custody'];
function failPreparation(test: Awaited<ReturnType<typeof fixture>>, fault: string) {
  if (fault === 'history') {
    const read = nats.store.readStream.bind(nats.store);
    function failedRead(...args: Parameters<typeof read>) {
      if (args[0] === test.decision.subject) {
        throw new Error('private-history');
      }
      return read(...args);
    }
    vi.spyOn(nats.store, 'readStream').mockImplementation(failedRead);
  } else if (fault === 'lock') {
    vi.spyOn(test.db, 'lock').mockRejectedValueOnce(new Error('private-lock'));
  } else if (fault === 'profile') {
    test.configuration.toolScopes.read.push('write');
  } else if (fault === 'custody') {
    test.fetch.mockRejectedValueOnce(new Error('private-custody'));
  }
  if (fault === 'validation') {
    return { ...test.context, requestId: '' };
  }
  return test.context;
}
async function permissionBeforePreparationFailure(fault: string) {
  for (const message of ['Active silo membership required', 'Owner or Admin required']) {
    for (const action of ['send', 'recover'] as const) {
      const test = await fixture();
      const raw = failPreparation(test, fault);
      const refusal = new MemberAccessRefused(message);
      function refusePermission() {
        return Promise.reject(refusal);
      }
      const permission = vi.fn(refusePermission);
      const writes = vi.spyOn(nats.store, 'append');
      test.fetch.mockClear();
      const broker = test.broker(raw, test.send, permission);
      await expect(broker[action]()).rejects.toBe(refusal);
      expect(permission).toHaveBeenCalledTimes(1);
      expect(test.fetch).not.toHaveBeenCalled();
      expect(writes).not.toHaveBeenCalled();
      expect(test.sends).toEqual([]);
      vi.restoreAllMocks();
    }
  }
}
it.each(preparationFaults)(
  'keeps removed and demoted permission refusals ahead of %s failures',
  permissionBeforePreparationFailure);

async function allowedPreparationFailure(fault: string) {
  const test = await fixture();
  const raw = failPreparation(test, fault);
  const permission = vi.fn(test.prepareAccess);
  const broker = test.broker(raw, test.send, permission);
  await expect(broker.send()).rejects.toThrow(/^Release unavailable$/u);
  expect(permission).toHaveBeenCalledTimes(1);
  expect(test.sends).toEqual([]);
}
it.each(['validation', 'history', 'lock', 'profile', 'custody'])(
  'checks allowed permission once with a %s failure', allowedPreparationFailure);

async function refusalSurvivesLaterFailures(laterFailure: string) {
  const test = await fixture();
  const refusal = new MemberAccessRefused('Active silo membership required');
  let appending = false;
  async function prepareAccess() {
    const access = await test.prepareAccess();
    async function checkAccess() {
      if (appending) {
        throw refusal;
      }
      await access.checkAccess();
    }
    return { deadline: access.deadline, checkAccess };
  }
  const permission = vi.fn(prepareAccess);
  const append = nats.store.append.bind(nats.store);
  async function failedAppend(command: Parameters<typeof append>[0]) {
    appending = true;
    const result = await append(command);
    expect(result.status).toBe('unavailable');
    if (laterFailure === 'audit') {
      throw new Error('private-audit');
    }
    if (laterFailure === 'expiry') {
      vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 30_001);
    }
    return result;
  }
  vi.spyOn(nats.store, 'append').mockImplementationOnce(failedAppend);
  if (laterFailure === 'unlock') {
    const lock = test.db.lock!.bind(test.db);
    const failedUnlock: typeof lock = async function failedUnlock(name, work, options) {
      await lock(name, work, options);
      throw new Error('private-unlock');
    };
    vi.spyOn(test.db, 'lock').mockImplementationOnce(failedUnlock);
  }
  test.fetch.mockClear();
  await expect(test.broker(test.context, test.send, permission).send()).rejects.toBe(refusal);
  expect(permission).toHaveBeenCalledTimes(1);
  expect(test.fetch).not.toHaveBeenCalled();
  expect(test.sends).toEqual([]);
  expect(await nats.store.head(`credential-${test.userId}`)).toBe(0);
}
it.each(['audit', 'expiry', 'unlock'])(
  'preserves a permission refusal through a later %s failure', refusalSurvivesLaterFailures);

async function keepsPreparedRequestsBoundToTheirOwners() {
  const secrets = new Map<string, string>();
  const alice = await fixture({ serverId: 'shared', secrets, material: 'alice-access' });
  const bob = await fixture({ serverId: 'shared', secrets, material: 'bob-access',
    profileId: 'bob-oauth' });
  const bobBroker = bob.broker();
  await bobBroker.prepare();
  const evidence = await credentialReleaseEvidence(nats.store, 'test', bob.decision.id,
    bob.release, bob.loadConfiguration);
  const replacement = { release: bob.release, evidence };
  const context = { ...alice.context };
  const aliceBroker = alice.broker(context);
  const reached = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const read = nats.store.readStream.bind(nats.store);
  async function* heldDecision(subject: string, from?: number, deadline?: number) {
    if (subject === `decision-${alice.userId}`) {
      reached.resolve();
      await resume.promise;
    }
    yield* read(subject, from, deadline);
  }
  const streamReader = vi.spyOn(nats.store, 'readStream');
  streamReader.mockImplementation(heldDecision);
  // Supply another owner's prepared data through JavaScript's extra arguments too.
  const prepareAlice: (...extra: unknown[]) => Promise<void> = aliceBroker.prepare;
  const preparing = prepareAlice(replacement);
  try {
    await reached.promise;
    Object.assign(context, bob.context);
  } finally {
    resume.resolve();
  }
  await preparing;
  expect(alice.sends).toEqual([]);
  expect(bob.sends).toEqual([]);
  const sendAlice: (...extra: unknown[]) => Promise<void> = aliceBroker.send;
  await sendAlice(replacement);
  await bobBroker.send();
  const aliceRows = await history(nats.store, `credential-${alice.userId}`, 'test');
  const bobRows = await history(nats.store, `credential-${bob.userId}`, 'test');
  expect(aliceRows).toHaveLength(1);
  expect(bobRows).toHaveLength(1);
  expect(aliceRows[0]!.event.data).toEqual(alice.release);
  expect(bobRows[0]!.event.data).toEqual(bob.release);
  expect(alice.sends).toEqual(['alice-access']);
  expect(bob.sends).toEqual(['bob-access']);
}
it('prepares two owners’ requests without accepting caller mutation or foreign prepared data',
  keepsPreparedRequestsBoundToTheirOwners);

async function refusesForeignPreparedContext(field: 'userId' | 'turnId') {
  const test = await fixture();
  const context = { ...test.context, [field]: 'foreign' };
  const broker = test.broker(context);
  await expect(broker.prepare()).rejects.toThrow('Release unavailable');
  expect(test.sends).toEqual([]);
  expect(await nats.store.head(`credential-${test.userId}`)).toBe(0);
}
it.each(['userId', 'turnId'] as const)(
  'refuses preparation when %s differs from the saved request', refusesForeignPreparedContext);

async function refusesPreparationAfterSending() {
  const test = await fixture();
  const broker = test.broker();
  await broker.prepare();
  await broker.send();
  await expect(broker.prepare()).rejects.toThrow('Release unavailable');
  await expect(broker.send()).rejects.toThrow('Release unavailable');
  const rows = await history(nats.store, `credential-${test.userId}`, 'test');
  expect(rows).toHaveLength(1);
  expect(rows[0]!.event.data).toEqual(test.release);
  expect(test.sends).toEqual(['synthetic-access']);
}
it('refuses preparation after sending and never sends the saved request again',
  refusesPreparationAfterSending);

async function refusesAssistantWithoutConsent() {
  const test = await fixture({ assistantKind: 'team' });
  await expect(test.broker().send()).rejects.toThrow('Release unavailable');
  expect(test.sends).toEqual([]);
  expect(await nats.store.head(`credential-${test.userId}`)).toBe(0);
}
it('refuses release to another assistant when an old choice has no assistant list',
  refusesAssistantWithoutConsent);

async function explicitlyAllowedSharedAssistant() {
  const test = await fixture({ assistantKind: 'team', consent: 'allow' });
  await test.broker().send();
  expect(test.sends).toEqual(['synthetic-access']);
}
it('releases a key to a shared assistant only after its owner explicitly allows it',
  explicitlyAllowedSharedAssistant);

async function ownerCanDisableOwnAssistant() {
  const test = await fixture({ consent: 'deny' });
  await expect(test.broker().send()).rejects.toThrow('Release unavailable');
  expect(test.sends).toEqual([]);
}
it('an empty assistant list refuses even the owner’s own personal assistant',
  ownerCanDisableOwnAssistant);

async function changedConsentInvalidatesPass() {
  const test = await fixture();
  await selectPersonalFixture(nats, test, {
    allowedAssistantIds: [test.release.assistantId],
    expectedSequence: test.release.selectionRevision,
  });
  await expect(test.broker().send()).rejects.toThrow('Release unavailable');
  expect(test.sends).toEqual([]);
}
it('refuses an old revision pass after the list changes even if the assistant stays allowed',
  changedConsentInvalidatesPass);

async function timedFixture() {
  const clock = manualClock(performance.now() + 5000);
  const previous = nats;
  nats = await natsFixture({ clock });
  async function restoreFixture() {
    await nats.close();
    nats = previous;
  }
  onTestFinished(restoreFixture);
  const test = await fixture();
  return { clock, test };
}

async function releaseDeadline(expired: boolean) {
  const { clock, test } = await timedFixture();
  const evidence = await credentialReleaseEvidence(nats.store, 'test', test.decision.id,
    test.release, test.loadConfiguration);
  const prepared = { release: test.release, evidence };
  const head = nats.store.head.bind(nats.store);
  async function savedHead(subject?: string) {
    return head(subject);
  }
  // Let the credential check itself refuse elapsed access, rather than a storage read.
  vi.spyOn(nats.store, 'head').mockImplementation(savedHead);
  const started = clock.now();
  function checkAccess() {
    if (expired) clock.advance(2001);
    return Promise.resolve();
  }
  const access = { deadline: Infinity, checkAccess };
  const append = vi.spyOn(nats.store, 'append');
  const result = confirmPreparedCredentialRelease(nats.store, 'test', prepared, access, 'claim');
  if (expired) {
    await expect(result).rejects.toThrow('Release unavailable');
    expect(append).not.toHaveBeenCalled();
  } else {
    await result;
    expect(append.mock.calls[0]?.[0].deadline).toBe(started + 2000);
  }
}
it.each([false, true])('uses manual time for release confirmation (expired: %s)', releaseDeadline);

async function brokerDeadline(expired: boolean) {
  const { clock, test } = await timedFixture();
  const started = clock.now();
  async function checkAccess() {}
  function prepareAccess() {
    return Promise.resolve({ deadline: Infinity, checkAccess });
  }
  const read = test.custody.readAccessMaterial.bind(test.custody);
  async function readMaterial(...args: Parameters<typeof read>) {
    const material = await read(...args);
    if (expired) clock.advance(2001);
    return material;
  }
  vi.spyOn(test.custody, 'readAccessMaterial').mockImplementation(readMaterial);
  const append = vi.spyOn(nats.store, 'append');
  const result = test.broker(test.context, test.send, prepareAccess).send();
  if (expired) {
    await expect(result).rejects.toThrow('Release unavailable');
    expect(test.sends).toEqual([]);
  } else {
    await result;
    expect(test.sends).toEqual(['synthetic-access']);
  }
  expect(append.mock.calls[0]?.[0].deadline).toBe(started + 2000);
}
it.each([false, true])('uses manual time before sending credentials (expired: %s)', brokerDeadline);
