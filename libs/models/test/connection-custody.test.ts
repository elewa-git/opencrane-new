import { scanConnections } from '../src/connection-scan.ts';
import { connectionRevokedDataSchema } from '@opencrane/events';
import { HandlerRuntime } from '@opencrane/handlers';
import { createLogger } from '@opencrane/observability';
import { connectionCustodyFromFile } from '../src/connection-custody-file.ts';
import { createEventStore } from '@opencrane/event-store';
import { connectionCleanupHandler } from '../src/connection-cleanup.ts';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import type { AppendCommand, StoredEvent } from '@opencrane/event-store';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { natsFixture } from '@opencrane/event-store/testing';
import { databases, until } from '@opencrane/authz/testing';
import { type Db, type Query, pgDb } from '@opencrane/projections';
import { envelope, history } from '../src/actor.ts';
import { foldConnection } from '../src/bearer-connections.ts';
import { reconcileConnectionPage, reconcileConnectionStage } from '../src/connection-reconciliation.ts';
import { withConnectionStage } from '../src/connection-stage-lock.ts';
import { z } from 'zod';
import { connectionCustody, type ConnectionStage } from '../src/connection-custody.ts';

const material = 'synthetic-custody-material';
const keyring = { currentKeyId: 'fixture', keys: { fixture: Buffer.alloc(32, 7) } };
const stage: ConnectionStage = {
  siloId: 'silo-a', userId: 'member-a', serverId: 'server-a', connectionId: 'install-a',
  profileId: 'profile-a', purpose: 'personal', generation: 1, endpointDigest: 'a'.repeat(64),
  operationId: 'operation-a', expectedSequence: 0, appendUntil: 123456789,
};
const secretSchema = z.object({
  apiVersion: z.literal('v1'), kind: z.literal('Secret'),
  immutable: z.literal(true), type: z.literal('Opaque'),
  metadata: z.object({ name: z.string(), namespace: z.string(),
    uid: z.string().default('uid-original'), resourceVersion: z.string().default('1'),
    labels: z.record(z.string(), z.string()), annotations: z.record(z.string(), z.string()),
    finalizers: z.array(z.string()).optional(), deletionTimestamp: z.string().optional() }),
  data: z.object({ token: z.string() }),
});
type Secret = z.infer<typeof secretSchema>;
const deleteSchema = z.object({ preconditions: z.unknown() });
const directories: string[] = [];
const servers: ReturnType<typeof createServer>[] = [];
async function closeServers() {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    server.close();
    await once(server, 'close');
  }
}
afterEach(closeServers);

async function fixture() {
  let secret: Secret | undefined;
  const secrets = new Map<string, Secret>();
  const pages: number[] = [];
  let creates = 0;
  let deletes = 0;
  let loseCreate = false;
  let changeOnDelete = false;
  let readsUnavailable = false;
  let finalise = false;
  let failRemovalRead = false;
  let unavailable = false;
  let preconditions: unknown;
  const listings: string[] = [];
  const removals: { name: string; preconditions: unknown }[] = [];
  let listAction: (() => Promise<void>) | undefined;
  let listFailures = 0;
  let deleteFailure = false;
  let deleteAttempts = 0;
  let activeLists = 0;
  let maximumLists = 0;
  async function handle(request: IncomingMessage, response: ServerResponse) {
    if (unavailable || (readsUnavailable && request.method === 'GET')) {
      response.writeHead(503).end(material);
      return;
    }
    const url = new URL(request.url!, 'http://localhost');
    if (request.method === 'GET' && url.pathname.endsWith('/secrets')) {
      listings.push(url.searchParams.get('continue') ?? '');
      activeLists += 1;
      maximumLists = Math.max(maximumLists, activeLists);
      await listAction?.();
      activeLists -= 1;
      if (listFailures > 0) {
        listFailures -= 1;
        response.writeHead(503).end(material);
        return;
      }
      const limit = Number(url.searchParams.get('limit'));
      expect(url.searchParams.get('labelSelector')).toBe(
        'app.kubernetes.io/managed-by=opencrane-server');
      expect(limit).toBeGreaterThan(0);
      expect(limit).toBeLessThanOrEqual(25);
      const after = url.searchParams.get('continue') ?? '';
      const items: Secret[] = [];
      const names = [...secrets.keys()];
      names.sort();
      for (const name of names) {
        if (name > after && items.length < limit) {
          items.push(secrets.get(name)!);
        }
      }
      pages.push(items.length);
      let continuation = '';
      if (items.length === limit) {
        continuation = items.at(-1)!.metadata.name;
      }
      response.end(JSON.stringify({ items, metadata: { continue: continuation } }));
      return;
    }
    if (request.method !== 'POST') {
      const segments = url.pathname.split('/');
      secret = secrets.get(segments.at(-1)!);
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      if (!Buffer.isBuffer(chunk)) throw new Error('Fixture request invalid');
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks).toString();
    if (request.method === 'POST') {
      const raw: unknown = JSON.parse(body);
      const parsed = secretSchema.parse(raw);
      if (secrets.has(parsed.metadata.name)) {
        response.writeHead(409).end(material);
        return;
      }
      parsed.metadata.uid = 'uid-original';
      parsed.metadata.resourceVersion = '1';
      if (finalise) {
        parsed.metadata.finalizers = ['fixture.test/retain'];
      }
      secret = parsed;
      secrets.set(parsed.metadata.name, parsed);
      creates += 1;
      if (loseCreate) {
        loseCreate = false;
        request.socket.destroy();
        return;
      }
    }
    if (request.method === 'DELETE') {
      const raw: unknown = JSON.parse(body);
      preconditions = deleteSchema.parse(raw).preconditions;
      deleteAttempts += 1;
      if (deleteFailure) {
        response.writeHead(503).end(material);
        return;
      }
      removals.push({ name: secret!.metadata.name, preconditions });
      if (changeOnDelete) {
        secret!.metadata.resourceVersion = '2';
        response.writeHead(409).end(material);
        return;
      }
      deletes += 1;
      if (secret?.metadata.finalizers?.length) {
        secret.metadata.deletionTimestamp = '2026-10-10T00:00:00Z';
        secret.metadata.resourceVersion = '2';
        response.end(JSON.stringify(secret));
        return;
      }
      secrets.delete(secret!.metadata.name);
      secret = undefined;
      if (failRemovalRead) {
        readsUnavailable = true;
      }
      response.end('{}');
      return;
    }
    if (!secret) {
      response.writeHead(404).end(material);
      return;
    }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(secret));
  }
  function listener(request: IncomingMessage, response: ServerResponse) {
    void handle(request, response);
  }
  const server = createServer(listener);
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture unavailable');
  const port = address.port;
  const directory = await mkdtemp(`${tmpdir()}/connection-stage-`);
  directories.push(directory);
  function restart() {
    return connectionCustody(`http://127.0.0.1:${port}`, 'custody', keyring, directory);
  }
  const custody = restart();
  return { custody, restart, directory, pages, secrets, listings, removals,
    get maximumLists() { return maximumLists; }, get deleteAttempts() { return deleteAttempts; },
    onList(action: () => Promise<void>) { listAction = action; },
    failLists(count: number) { listFailures = count; },
    failDeletes(failed: boolean) { deleteFailure = failed; }, apiUrl: `http://127.0.0.1:${port}`,
    get secret() { return secret!; }, get creates() { return creates; },
    get deletes() { return deletes; }, get preconditions() { return preconditions; },
    loseCreate() { loseCreate = true; }, changeOnDelete() { changeOnDelete = true; },
    fail() { unavailable = true; },
    failReads() { readsUnavailable = true; }, restoreReads() { readsUnavailable = false; },
    retainWithFinaliser() { finalise = true; }, failRemovalRead() { failRemovalRead = true; },
    finishDeletion() { secrets.clear(); secret = undefined; } };
}

async function recoversRecordedCreate() {
  const store = await fixture();
  const first = await store.custody.stage(stage, material);
  expect(first.status).toBe('staged');
  const expectedRecovery = { status: 'recovered', identity: first.identity };
  const recovered = await store.restart().recover(stage);
  expect(recovered).toEqual(expectedRecovery);
  const attempts = [store.custody.stage(stage, material), store.restart().stage(stage, material)];
  const repeated = await Promise.all(attempts);
  expect(repeated[0]).toEqual(expectedRecovery);
  expect(repeated[1]).toEqual(expectedRecovery);
  expect(store.creates).toBe(1);
  expect(JSON.stringify(first).includes(material)).toBe(false);
  const filenames = await readdir(store.directory);
  for (const filename of filenames) {
    const path = `${store.directory}/${filename}`;
    expect((await readFile(path, 'utf8')).includes(material)).toBe(false);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  }
  const changedGeneration = { ...stage, generation: 2 };
  expect((await store.restart().stage(changedGeneration, material)).status).toBe('conflict');
}
it('recovers one recorded private generation across restart and retries', recoversRecordedCreate);


async function refusesUnrecordedCreate(replace: boolean) {
  const store = await fixture();
  store.loseCreate();
  store.failReads();
  expect(await store.custody.stage(stage, material)).toEqual({ status: 'unknown' });
  const filenames = await readdir(store.directory);
  expect(filenames.length).toBeGreaterThan(0);
  for (const filename of filenames) {
    const record = await readFile(`${store.directory}/${filename}`, 'utf8');
    expect(record.includes('"uid"')).toBe(false);
    expect(record.includes(material)).toBe(false);
  }
  const original = structuredClone(store.secret);
  if (replace) {
    store.secret.metadata.uid = 'uid-replacement';
    const expectedReplacement = structuredClone(original);
    expectedReplacement.metadata.uid = 'uid-replacement';
    expect(store.secret).toEqual(expectedReplacement);
  }
  store.restoreReads();
  expect(await store.restart().recover(stage)).toEqual({ status: 'conflict' });
  expect(await store.restart().stage(stage, material)).toEqual({ status: 'conflict' });
  expect(await store.restart().remove(stage)).toEqual({ status: 'conflict' });
  expect(await readdir(store.directory)).toEqual(filenames);
  expect(store.creates).toBe(1);
  expect(store.deletes).toBe(0);
}
it.each([false, true])(
  'refuses an unrecorded create identity after a lost reply (replacement: %s)',
  refusesUnrecordedCreate,
);

async function refusesImmediateLostCreate() {
  const store = await fixture();
  store.loseCreate();
  expect(await store.custody.stage(stage, material)).toEqual({ status: 'conflict' });
  expect(await store.restart().recover(stage)).toEqual({ status: 'conflict' });
  expect(store.creates).toBe(1);
  const recoveredFiles = await readdir(store.directory);
  for (const filename of recoveredFiles) {
    const record = await readFile(`${store.directory}/${filename}`, 'utf8');
    expect(record.includes('"uid"')).toBe(false);
  }
}
it('refuses to pin the first Secret read after a lost create reply', refusesImmediateLostCreate);


async function refusesSecondCreate() {
  const store = await fixture();
  store.loseCreate();
  store.failReads();
  expect(await store.custody.stage(stage, material)).toEqual({ status: 'unknown' });
  store.finishDeletion();
  store.restoreReads();
  expect(await store.restart().stage(stage, material)).toEqual({ status: 'unknown' });
  expect(store.creates).toBe(1);
  expect(store.deletes).toBe(0);
}
it('never creates again when an unrecorded original has disappeared', refusesSecondCreate);


async function recoversIndependentIdentity() {
  const store = await fixture();
  store.loseCreate();
  store.failReads();
  expect(await store.custody.stage(stage, material)).toEqual({ status: 'unknown' });
  const identity = { reference: store.secret.metadata.name, uid: 'uid-original',
    resourceVersion: '1' };
  store.restoreReads();
  const expectedRecovery = { status: 'recovered', identity };
  expect(await store.restart().recover(stage, identity)).toEqual(expectedRecovery);
  expect(await store.restart().recover(stage)).toEqual(expectedRecovery);
  expect(store.creates).toBe(1);
}
it('recovers with an independently supplied exact identity', recoversIndependentIdentity);

const identityFields = ['reference', 'uid', 'resourceVersion'] as const;
async function refusesExpectedIdentity(field: (typeof identityFields)[number]) {
  const store = await fixture();
  const saved = await store.custody.stage(stage, material);
  if (!saved.identity) {
    throw new Error('Fixture identity missing');
  }
  const changed = { ...saved.identity, [field]: 'changed' };
  expect(await store.restart().recover(stage, changed)).toEqual({ status: 'conflict' });
  expect(await store.restart().remove(stage, changed)).toEqual({ status: 'conflict' });
  expect(store.deletes).toBe(0);
}
it.each(identityFields)('refuses a different caller-supplied %s', refusesExpectedIdentity);

const bindings = ['siloId', 'userId', 'serverId', 'connectionId', 'profileId',
  'purpose', 'endpointDigest', 'operationId', 'expectedSequence', 'appendUntil'] as const;
async function refusesBinding(field: (typeof bindings)[number]) {
  const store = await fixture();
  const saved = await store.custody.stage(stage, material);
  // Change the stored binding, including the bindings used to choose a Secret name.
  const key = `opencrane.ai/${field}`;
  if (field in stage && field !== 'endpointDigest' && field !== 'operationId'
      && field !== 'expectedSequence' && field !== 'appendUntil') {
    store.secret.metadata.labels[key] = 'wrong';
  } else {
    store.secret.metadata.annotations[key] = 'wrong';
  }
  expect((await store.custody.recover(stage, saved.identity)).status).toBe('conflict');
  expect((await store.custody.remove(stage, saved.identity)).status).toBe('conflict');
  expect(store.deletes).toBe(0);
}
it.each(bindings)('refuses a changed %s binding', refusesBinding);

async function refusesMaterial() {
  const store = await fixture();
  const saved = await store.custody.stage(stage, material);
  expect((await store.custody.stage(stage, 'synthetic-other')).status).toBe('conflict');
  store.secret.data.token = Buffer.from('synthetic-other').toString('base64');
  expect((await store.custody.recover(stage, saved.identity)).status).toBe('conflict');
  expect((await store.custody.remove(stage, saved.identity)).status).toBe('conflict');
  expect(store.deletes).toBe(0);
}
it('refuses different supplied or stored material', refusesMaterial);

async function refusesIdentity(field: 'uid' | 'resourceVersion' | 'namespace') {
  const store = await fixture();
  const saved = await store.custody.stage(stage, material);
  store.secret.metadata[field] = 'changed';
  expect((await store.restart().recover(stage)).status).toBe('conflict');
  expect((await store.custody.stage(stage, material, saved.identity)).status).toBe('conflict');
  expect((await store.custody.remove(stage, saved.identity)).status).toBe('conflict');
  expect(store.deletes).toBe(0);
}
it.each(['uid', 'resourceVersion', 'namespace'] as const)(
  'refuses a recreated or changed %s', refusesIdentity);

async function deletesExactly() {
  const store = await fixture();
  const saved = await store.custody.stage(stage, material);
  expect((await store.custody.remove(stage)).status).toBe('conflict');
  expect((await store.custody.remove(stage, saved.identity)).status).toBe('deleted');
  expect(store.preconditions).toEqual({ uid: 'uid-original', resourceVersion: '1' });
  expect(store.deletes).toBe(1);
}
it('requires an exact identity and sends both deletion preconditions', deletesExactly);


async function retainsFinalisedSecret() {
  const store = await fixture();
  store.retainWithFinaliser();
  const saved = await store.custody.stage(stage, material);
  expect(saved.status).toBe('staged');
  expect(await store.custody.remove(stage, saved.identity)).toEqual({ status: 'unknown' });
  expect(store.secret.data.token).toBe(Buffer.from(material).toString('base64'));
  expect(store.secret.metadata.deletionTimestamp).toBe('2026-10-10T00:00:00Z');
  expect(store.secret.metadata.resourceVersion).toBe('2');
  expect(store.preconditions).toEqual({ uid: 'uid-original', resourceVersion: '1' });
  expect(store.deletes).toBe(1);
  expect(await store.restart().remove(stage, saved.identity)).toEqual({ status: 'unknown' });
  expect(store.deletes).toBe(1);
  store.finishDeletion();
  expect(await store.restart().remove(stage, saved.identity)).toEqual({ status: 'deleted' });
  expect(store.deletes).toBe(1);
}
it('keeps deletion unresolved until a finalised Secret is absent', retainsFinalisedSecret);


async function requiresRemovalRead() {
  const store = await fixture();
  const saved = await store.custody.stage(stage, material);
  store.failRemovalRead();
  expect(await store.custody.remove(stage, saved.identity)).toEqual({ status: 'unknown' });
  expect(await store.restart().remove(stage, saved.identity)).toEqual({ status: 'unknown' });
  expect(store.deletes).toBe(1);
  store.restoreReads();
  expect(await store.restart().remove(stage, saved.identity)).toEqual({ status: 'deleted' });
  expect(store.deletes).toBe(1);
}
it('waits for an absence read after DELETE succeeds but the read fails', requiresRemovalRead);


async function refusesChangedDeletionIdentity(field: (typeof identityFields)[number]) {
  const store = await fixture();
  store.retainWithFinaliser();
  const saved = await store.custody.stage(stage, material);
  if (!saved.identity) {
    throw new Error('Fixture identity missing');
  }
  expect(await store.custody.remove(stage, saved.identity)).toEqual({ status: 'unknown' });
  const changed = { ...saved.identity, [field]: 'changed' };
  expect(await store.restart().remove(stage, changed)).toEqual({ status: 'conflict' });
  const changedOperation = { ...stage, operationId: 'operation-other' };
  expect(await store.restart().remove(changedOperation, saved.identity)).toEqual({
    status: 'conflict',
  });
  expect(store.deletes).toBe(1);
  expect(store.secret.data.token).toBe(Buffer.from(material).toString('base64'));
}
it.each(identityFields)(
  'refuses a different %s when checking a pending deletion', refusesChangedDeletionIdentity,
);

async function retainsDeletionRace() {
  const store = await fixture();
  const saved = await store.custody.stage(stage, material);
  store.changeOnDelete();
  expect((await store.custody.remove(stage, saved.identity)).status).toBe('conflict');
  expect(store.deletes).toBe(0);
  expect(store.secret.metadata.resourceVersion).toBe('2');
}
it('retains material when deletion races a changed version', retainsDeletionRace);

async function sanitisesFailure() {
  const store = await fixture();
  await store.custody.stage(stage, material);
  store.fail();
  const result = await store.custody.recover(stage);
  expect(result).toEqual({ status: 'unknown' });
  expect(JSON.stringify(result).includes(material)).toBe(false);
  expect(store.deletes).toBe(0);
}
it('returns safe unknown status on an upstream failure and retains material', sanitisesFailure);

async function refusesMissingPreparation() {
  const store = await fixture();
  expect(await store.custody.recover(stage)).toEqual({ status: 'conflict' });
  expect(store.creates).toBe(0);
  expect(store.deletes).toBe(0);
}
it('refuses recovery without a prepared operation', refusesMissingPreparation);

let events: Awaited<ReturnType<typeof natsFixture>>;
let storage: Awaited<ReturnType<typeof databases>>;
let candidateCount = 0;
async function startReconciliation() {
  events = await natsFixture();
  storage = await databases();
}
async function stopReconciliation() {
  await storage?.close();
  await events?.close();
}
beforeAll(startReconciliation, 120_000);
afterAll(stopReconciliation);

async function candidateFixture(appendUntil = stage.appendUntil,
  expectedSequence = 0, generation = 1) {
  const store = await fixture();
  candidateCount += 1;
  const input = { ...stage, siloId: 'test', profileId: `candidate-${candidateCount}`,
    operationId: `operation-${candidateCount}`, appendUntil, expectedSequence, generation };
  const subject = `connection-${input.userId}-${input.serverId}-${input.profileId}`;
  const saved = await store.custody.stage(input, material);
  const db = pgDb(storage.queue);
  async function reconcile() {
    return reconcileConnectionStage(events.store, db, store.restart(), input);
  }
  async function invalidate() {
    const data = { userId: input.userId, serverId: input.serverId,
      profile: input.profileId, revokedBy: input.userId };
    const event = envelope('test', subject, 'connection.revoked', data);
    await events.seed([event]);
  }
  async function activate() {
    const identity = saved.identity!;
    const activation = { connectionId: input.connectionId, ownerKind: 'personal',
      purpose: 'personal', generation: 1, uid: identity.uid,
      resourceVersion: identity.resourceVersion, endpointDigest: input.endpointDigest,
      operationId: input.operationId, changedBy: input.userId, expectedSequence: 0,
      appendUntil: input.appendUntil, reason: 'bearer_create' };
    const data = { userId: input.userId, serverId: input.serverId, profile: input.profileId,
      secretRef: `secret:${identity.reference}`, activation };
    const event = envelope('test', subject, 'connection.created', data, input.operationId);
    event.principal = { kind: 'human', id: input.userId };
    await events.seed([event]);
  }
  return { store, input, subject, db, reconcile, invalidate, activate };
}
async function closesUnknownAppend() {
  const test = await candidateFixture();
  const append = vi.spyOn(events.store, 'append');
  try {
    expect(await test.reconcile()).toEqual({ status: 'deleted' });
    expect(append).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      expectedSequence: test.input.expectedSequence,
    }));
    expect(await test.reconcile()).toEqual({ status: 'retained' });
    expect(append).toHaveBeenCalledTimes(1);
  } finally {
    append.mockRestore();
  }
  const rows = await history(events.store, test.subject, 'test');
  expect(rows).toHaveLength(1);
  const hash = createHash('sha256');
  hash.update(JSON.stringify(['test', test.subject, 'connection.operation_closed',
    test.input.operationId]));
  expect(rows[0]!.event).toMatchObject({ id: hash.digest('hex'),
    type: 'connection.operation_closed', principal: { kind: 'system', id: 'models' },
    data: { userId: test.input.userId, serverId: test.input.serverId,
      profile: test.input.profileId, operationId: test.input.operationId, generation: 1,
      expectedSequence: 0, appendUntil: test.input.appendUntil, reason: 'append_deadline_passed' },
  });
  expect(test.store.preconditions).toEqual({ uid: 'uid-original', resourceVersion: '1' });
  expect(test.store.deletes).toBe(1);
  expect(JSON.stringify(rows)).not.toContain(material);
}
it('closes an expired idle stage conditionally and deletes its exact identity once',
  closesUnknownAppend);

async function closesExpiredRotationWithoutLaterEvent() {
  const test = await candidateFixture(stage.appendUntil, await events.store.head() + 1, 2);
  const previousOperationId = `previous-${test.input.operationId}`;
  const previousStore = await fixture();
  const previousStage = { ...test.input, generation: 1, expectedSequence: 0,
    operationId: previousOperationId };
  const previousSaved = await previousStore.custody.stage(previousStage, material);
  const previousReference = `secret:${previousSaved.identity!.reference}`;
  const previousActivation = {
    connectionId: test.input.connectionId, ownerKind: 'personal', purpose: 'personal',
    generation: 1, uid: previousSaved.identity!.uid,
    resourceVersion: previousSaved.identity!.resourceVersion,
    endpointDigest: test.input.endpointDigest, operationId: previousOperationId,
    changedBy: test.input.userId, expectedSequence: 0,
    appendUntil: test.input.appendUntil, reason: 'bearer_create',
  };
  const previousData = {
    userId: test.input.userId, serverId: test.input.serverId, profile: test.input.profileId,
    secretRef: previousReference, activation: previousActivation,
  };
  const previousEvent = envelope('test', test.subject, 'connection.created', previousData,
    previousOperationId);
  previousEvent.principal = { kind: 'human', id: test.input.userId };
  await events.seed([previousEvent]);

  const rows = await history(events.store, test.subject, 'test');
  const savedProfile = foldConnection(rows);
  const custody = test.store.restart();
  const removal = vi.spyOn(custody, 'remove');
  const recovered = await custody.recover(test.input);
  expect(savedProfile.status).toBe('saved_unverified');
  expect(savedProfile.sequence).toBe(test.input.expectedSequence);
  expect(savedProfile.data?.secretRef).not.toBe(`secret:${recovered.identity?.reference}`);
  expect(test.input.appendUntil).toBeLessThan(Date.now());

  const result = await reconcileConnectionStage(events.store, test.db, custody, test.input);
  expect(result).toEqual({ status: 'deleted' });
  expect(removal).toHaveBeenCalledExactlyOnceWith(test.input, recovered.identity);
  const closedRows = await history(events.store, test.subject, 'test');
  expect(closedRows).toHaveLength(2);
  expect(foldConnection(closedRows)).toMatchObject({ status: 'saved_unverified',
    data: savedProfile.data, sequence: closedRows[1]!.sequence });
  expect(test.store.deletes).toBe(1);
  expect(await reconcileConnectionStage(events.store, test.db,
    previousStore.restart(), previousStage)).toEqual({ status: 'retained' });
  expect(previousStore.deletes).toBe(0);
  expect(await previousStore.custody.recover(previousStage)).toMatchObject({ status: 'recovered' });
  const provider = vi.spyOn(globalThis, 'fetch');
  const release = vi.spyOn(events.store, 'append');
  const recovery = vi.spyOn(custody, 'recover');
  removal.mockClear();
  try {
    foldConnection(closedRows);
    expect(provider).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    expect(recovery).not.toHaveBeenCalled();
    expect(removal).not.toHaveBeenCalled();
  } finally {
    provider.mockRestore();
    release.mockRestore();
  }
}
it('closes an expired rotation and preserves the current generation and reference',
  closesExpiredRotationWithoutLaterEvent);

async function keepsCurrentAndReplay() {
  const test = await candidateFixture();
  await test.activate();
  expect(await test.reconcile()).toEqual({ status: 'retained' });
  const rows = await history(events.store, test.subject, 'test');
  const recovery = vi.spyOn(test.store.custody, 'recover');
  const removal = vi.spyOn(test.store.custody, 'remove');
  const enumeration = vi.spyOn(test.store.custody, 'candidates');
  const provider = vi.spyOn(globalThis, 'fetch');
  const append = vi.spyOn(events.store, 'append');
  const replayed = foldConnection(rows);
  expect(enumeration).not.toHaveBeenCalled();
  expect(provider).not.toHaveBeenCalled();
  expect(append).not.toHaveBeenCalled();
  provider.mockRestore();
  append.mockRestore();
  expect(replayed.status).toBe('saved_unverified');
  expect(recovery).not.toHaveBeenCalled();
  expect(removal).not.toHaveBeenCalled();
  expect(test.store.deletes).toBe(0);
  expect(JSON.stringify({ rows, replayed })).not.toContain(material);
}
it('retains the current reference and replays without custody work or release', keepsCurrentAndReplay);

async function deletesProvenOrphan() {
  const test = await candidateFixture();
  await test.invalidate();
  expect(await test.reconcile()).toEqual({ status: 'deleted' });
  expect(test.store.preconditions).toEqual({ uid: 'uid-original', resourceVersion: '1' });
  expect(test.store.deletes).toBe(1);
  expect(await test.reconcile()).toEqual({ status: 'retained' });
  expect(test.store.deletes).toBe(1);
}
it('deletes a proven orphan using its original UID and version exactly once', deletesProvenOrphan);

async function keepsDeleteConflict(field: 'uid' | 'resourceVersion' | 'during-delete') {
  const test = await candidateFixture();
  await test.invalidate();
  if (field === 'during-delete') {
    test.store.changeOnDelete();
  } else {
    test.store.secret.metadata[field] = 'changed';
  }
  expect(await test.reconcile()).toEqual({ status: 'retained' });
  expect(await test.reconcile()).toEqual({ status: 'retained' });
  expect(test.store.secret).toBeDefined();
  expect(test.store.deletes).toBe(0);
}
it.each(['uid', 'resourceVersion', 'during-delete'] as const)(
  'retains and stops after an exact deletion conflict: %s', keepsDeleteConflict);

async function keepsFailedReconciliation(failure: 'custody' | 'history' | 'lock') {
  const test = await candidateFixture();
  await test.invalidate();
  const faults = [];
  function fail(): Promise<never> {
    return Promise.reject(new Error(material));
  }
  function failHistory(): never {
    throw new Error(material);
  }
  if (failure === 'custody') {
    test.store.failReads();
  } else if (failure === 'history') {
    const fault = vi.spyOn(events.store, 'readStream');
    fault.mockImplementation(failHistory);
    faults.push(fault);
  } else {
    const fault = vi.spyOn(test.db, 'lock');
    fault.mockImplementation(fail);
    faults.push(fault);
  }
  try {
    expect(await test.reconcile()).toEqual({ status: 'retained' });
    expect(test.store.secret).toBeDefined();
    expect(test.store.deletes).toBe(0);
  } finally {
    for (const fault of faults) {
      fault.mockRestore();
    }
  }
}
it.each(['custody', 'history', 'lock'] as const)(
  'retains material and returns no dependency error when %s fails', keepsFailedReconciliation);

async function rechecksUnderCoordination() {
  const test = await candidateFixture();
  const lock = test.db.lock!.bind(test.db);
  const readStream = events.store.readStream.bind(events.store);
  let held = false;
  const reads: boolean[] = [];
  function observeRead(...parameters: Parameters<typeof readStream>) {
    reads.push(held);
    return readStream(...parameters);
  }
  async function lockAfterActivation<Result>(name: string,
    work: (db: Db) => Promise<Result>): Promise<Result> {
    await test.activate();
    async function execute(db: Db) {
      held = true;
      try {
        return await work(db);
      } finally {
        held = false;
      }
    }
    return lock(name, execute);
  }
  test.db.lock = lockAfterActivation;
  const reading = vi.spyOn(events.store, 'readStream');
  reading.mockImplementation(observeRead);
  try {
    expect(await test.reconcile()).toEqual({ status: 'retained' });
    expect(reads).toEqual([true]);
    expect(test.store.deletes).toBe(0);
  } finally {
    reading.mockRestore();
  }
}
it('reads the current reference again after acquiring cleanup coordination', rechecksUnderCoordination);

async function excludesConcurrentStage() {
  const test = await candidateFixture();
  await test.invalidate();
  async function stageInProgress() {
    expect(await test.reconcile()).toEqual({ status: 'retained' });
    expect(test.store.deletes).toBe(0);
  }
  await withConnectionStage(test.db, test.input, stageInProgress);
  expect(await test.reconcile()).toEqual({ status: 'deleted' });
}
it('keeps material while another worker holds staging coordination', excludesConcurrentStage);

async function keepsUnexpiredStage(laterEvent: boolean) {
  const test = await candidateFixture(Date.now() + 60_000);
  if (laterEvent) {
    await test.invalidate();
  }
  expect(await test.reconcile()).toEqual({ status: 'retained' });
  expect(test.store.deletes).toBe(0);
}
it.each([false, true])('keeps an unexpired stage (later event: %s)', keepsUnexpiredStage);

async function refusesUnconfirmedClosure(outcome: 'conflict' | 'unavailable' | 'throw' | 'lost' | 'unconfirmed') {
  const test = await candidateFixture();
  const append = events.store.append.bind(events.store);
  async function failClosure(command: AppendCommand) {
    if (outcome === 'throw') {
      throw new Error(material);
    }
    if (outcome === 'unconfirmed') {
      return { status: 'appended' as const, sequence: 1 };
    }
    if (outcome === 'lost') {
      await append(command);
    }
    if (outcome === 'conflict') {
      return { status: 'conflict' as const };
    }
    return { status: 'unavailable' as const, cause: new Error(material) };
  }
  const fault = vi.spyOn(events.store, 'append');
  fault.mockImplementationOnce(failClosure);
  const custody = test.store.restart();
  const remove = vi.spyOn(custody, 'remove');
  try {
    expect(await reconcileConnectionStage(events.store, test.db, custody, test.input))
      .toEqual({ status: 'retained' });
    expect(fault).toHaveBeenCalledTimes(1);
    expect(remove).not.toHaveBeenCalled();
    expect(test.store.secret).toBeDefined();
    if (outcome === 'lost') {
      expect(await test.reconcile()).toEqual({ status: 'deleted' });
      expect(fault).toHaveBeenCalledTimes(1);
      expect(await history(events.store, test.subject, 'test')).toHaveLength(1);
    }
  } finally {
    fault.mockRestore();
  }
}
it.each(['conflict', 'unavailable', 'throw', 'lost', 'unconfirmed'] as const)(
  'retains material on closure %s and recovers a lost reply without another append',
  refusesUnconfirmedClosure);

async function refusesChangedPrivateRecord(field: 'expectedSequence' | 'appendUntil') {
  const test = await candidateFixture();
  const changed = { ...test.input, [field]: test.input[field] + 1 };
  const append = vi.spyOn(events.store, 'append');
  try {
    expect(await reconcileConnectionStage(events.store, test.db, test.store.restart(), changed))
      .toEqual({ status: 'retained' });
    expect(append).not.toHaveBeenCalled();
    expect(test.store.deletes).toBe(0);
  } finally {
    append.mockRestore();
  }
}
it.each(['expectedSequence', 'appendUntil'] as const)(
  'refuses closure when %s differs from the private record', refusesChangedPrivateRecord);

async function keepsEarlierPosition() {
  const test = await candidateFixture(stage.appendUntil, await events.store.head() + 5);
  await test.activate();
  // Keep a valid saved profile with a different reference below the stage's expected position.
  const rows = await history(events.store, test.subject, 'test');
  const changed = structuredClone(rows);
  const dataSchema = z.looseObject({ secretRef: z.string() });
  const data = dataSchema.parse(changed[0]!.event.data);
  data.secretRef = 'secret:another';
  changed[0]!.event.data = data;
  async function* earlierHistory() {
    yield* await Promise.resolve(changed);
  }
  const read = vi.spyOn(events.store, 'readStream');
  read.mockImplementation(earlierHistory);
  try {
    expect(await test.reconcile()).toEqual({ status: 'retained' });
    expect(test.store.deletes).toBe(0);
  } finally {
    read.mockRestore();
  }
}
it('retains a candidate when history has not reached its expected position', keepsEarlierPosition);

async function refusesInvalidClosureCandidate() {
  const test = await candidateFixture(stage.appendUntil, 0, 2);
  const append = vi.spyOn(events.store, 'append');
  try {
    expect(await test.reconcile()).toEqual({ status: 'retained' });
    expect(append).not.toHaveBeenCalled();
    expect(test.store.deletes).toBe(0);
  } finally {
    append.mockRestore();
  }
}
it('refuses to close a generation that does not follow the saved profile',
  refusesInvalidClosureCandidate);

async function keepsInvalidClosureProof() {
  const test = await candidateFixture();
  const data = { userId: test.input.userId, serverId: test.input.serverId,
    profile: test.input.profileId, operationId: test.input.operationId, generation: 2,
    expectedSequence: 0, appendUntil: test.input.appendUntil, reason: 'append_deadline_passed' };
  const event = envelope('test', test.subject, 'connection.operation_closed', data);
  await events.seed([event]);
  expect(await test.reconcile()).toEqual({ status: 'retained' });
  expect(test.store.deletes).toBe(0);
}
it('retains material after an invalid saved closure', keepsInvalidClosureProof);


async function scan(test: Awaited<ReturnType<typeof candidateFixture>>, continuation?: string) {
  return reconcileConnectionPage(events.store, test.db, test.store.restart(), 'test', continuation);
}
async function forgetJournal(test: Awaited<ReturnType<typeof candidateFixture>>) {
  await rm(test.store.directory, { recursive: true, force: true });
}
async function scanUncertainThenLateSave() {
  const test = await candidateFixture(Date.now() + 60_000);
  expect(await scan(test)).toMatchObject({ status: 'scanned', examined: 1, deleted: 0 });
  await test.activate();
  await forgetJournal(test);
  expect(await scan(test)).toMatchObject({ examined: 1, deleted: 0 });
  expect(await test.store.restart().recover(test.input)).toMatchObject({ status: 'recovered' });
  expect(test.store.deletes).toBe(0);
}
it('enumerates an uncertain stage after restart and keeps its late saved reference',
  scanUncertainThenLateSave);

async function scanRevokedAfterJournalLoss() {
  const test = await candidateFixture();
  await test.activate();
  await test.invalidate();
  await forgetJournal(test);
  expect(await scan(test)).toMatchObject({ examined: 1, deleted: 1 });
  expect(test.store.preconditions).toEqual({ uid: 'uid-original', resourceVersion: '1' });
  expect(await scan(test)).toMatchObject({ examined: 0, deleted: 0 });
  expect(test.store.deletes).toBe(1);
}
it('rebuilds missing journal records from saved identity and deletes a revoked generation once',
  scanRevokedAfterJournalLoss);

async function scanRotationAfterJournalLoss() {
  const test = await candidateFixture();
  await test.activate();
  const rows = await history(events.store, test.subject, 'test');
  const previous = foldConnection(rows).data!;
  const replacement = { ...test.input, generation: 2, operationId: 'replacement',
    expectedSequence: rows[0]!.sequence };
  const saved = await test.store.custody.stage(replacement, material);
  const activation = { ...previous.activation, generation: 2, operationId: 'replacement',
    expectedSequence: rows[0]!.sequence, reason: 'bearer_rotation' };
  const data = { ...previous, secretRef: `secret:${saved.identity!.reference}`, activation };
  const event = envelope('test', test.subject, 'connection.refreshed', data, 'replacement');
  event.principal = { kind: 'human', id: test.input.userId };
  await events.seed([event]);
  await forgetJournal(test);
  expect(await scan(test)).toMatchObject({ examined: 2, deleted: 1 });
  expect(await test.store.restart().recover(replacement)).toMatchObject({ status: 'recovered' });
  expect(test.store.secrets.size).toBe(1);
}
it('enumerates after rotation and restart and deletes only the superseded exact generation',
  scanRotationAfterJournalLoss);

async function scanFailure(failure: string) {
  const test = await candidateFixture();
  await test.activate();
  await test.invalidate();
  const faults = [];
  function fail(): never {
    throw new Error(material);
  }
  if (failure === 'uid' || failure === 'resourceVersion') {
    await forgetJournal(test);
    test.store.secret.metadata[failure] = 'changed';
  } else if (failure === 'journal-write') {
    await forgetJournal(test);
    await writeFile(test.store.directory, material);
  } else if (failure === 'journal') {
    const files = await readdir(test.store.directory);
    for (const file of files) {
      await writeFile(`${test.store.directory}/${file}`, '{}');
    }
  } else if (failure === 'list') {
    test.store.failReads();
  } else if (failure === 'read') {
    const custody = test.store.restart();
    const candidates = custody.candidates.bind(custody);
    async function failAfterList(continuation?: string) {
      const page = await candidates(continuation);
      test.store.failReads();
      return page;
    }
    vi.spyOn(custody, 'candidates').mockImplementation(failAfterList);
    expect(await reconcileConnectionPage(events.store, test.db, custody, 'test'))
      .toMatchObject({ deleted: 0 });
    expect(test.store.deletes).toBe(0);
    return;
  } else {
    const fault = failure === 'store'
      ? vi.spyOn(events.store, 'readStream') : vi.spyOn(test.db, 'lock');
    fault.mockImplementation(fail);
    faults.push(fault);
  }
  try {
    const result = await scan(test);
    expect(JSON.stringify(result)).not.toContain(material);
    expect(test.store.deletes).toBe(0);
    expect(test.store.secrets.size).toBe(1);
  } finally {
    for (const fault of faults) {
      fault.mockRestore();
    }
  }
}
it.each(['uid', 'resourceVersion', 'journal', 'journal-write', 'list', 'read', 'store', 'lock'])(
  'retains enumerated material when %s fails', scanFailure);

async function scanPages() {
  const test = await candidateFixture();
  for (let index = 1; index < 53; index += 1) {
    const candidate = { ...test.input, profileId: `page-${index}`,
      operationId: `page-${index}` };
    await test.store.custody.stage(candidate, material);
  }
  let continuation: string | undefined;
  let examined = 0;
  let deleted = 0;
  do {
    const result = await scan(test, continuation);
    if (result.status !== 'scanned') {
      throw new Error('Fixture scan failed');
    }
    examined += result.examined;
    deleted += result.deleted;
    continuation = result.continuation;
  } while (continuation);
  expect(examined).toBe(53);
  expect(deleted).toBe(53);
  expect(test.store.pages).toEqual([25, 25, 3]);
  expect(test.store.secrets.size).toBe(0);
}
it('advances bounded pages across many candidates while deleting earlier pages', scanPages);

async function scanPastDamagedCandidate(damage: string) {
  const test = await candidateFixture();
  for (let generation = 2; generation <= 53; generation += 1) {
    const candidate = { ...test.input, generation, operationId: `generation-${generation}` };
    expect(await test.store.custody.stage(candidate, material)).toMatchObject({ status: 'staged' });
  }
  await test.invalidate();
  const names = [...test.store.secrets.keys()];
  names.sort();
  const damagedName = names[0]!;
  const damaged = test.store.secrets.get(damagedName)!;
  if (damage === 'object') {
    damaged.metadata.uid = '';
  } else {
    damaged.metadata.annotations['opencrane.ai/stage'] = '{';
  }
  const original = structuredClone(damaged);
  for (let pass = 0; pass < 2; pass += 1) {
    let continuation: string | undefined;
    let deleted = 0;
    let examined = 0;
    do {
      const result = await scan(test, continuation);
      expect(result.status).toBe('scanned');
      if (result.status !== 'scanned') {
        throw new Error('Fixture scan failed');
      }
      examined += result.examined;
      deleted += result.deleted;
      continuation = result.continuation;
    } while (continuation);
    const expectedCount = pass === 0 ? 52 : 0;
    expect(examined).toBe(expectedCount);
    expect(deleted).toBe(expectedCount);
    expect(test.store.secrets.size).toBe(1);
    expect(test.store.secrets.get(damagedName)).toEqual(original);
  }
  expect(test.store.pages).toEqual([25, 25, 3, 1]);
  expect(test.store.deletes).toBe(52);
  const rows = await history(events.store, test.subject, 'test');
  expect(foldConnection(rows).status).toBe('unavailable');
  expect(rows).toHaveLength(1);
}
it.each(['object', 'annotation'])(
  'scans past a damaged first %s and cleans healthy revoked generations', scanPastDamagedCandidate);

async function scanUnprovenIdentity() {
  const test = await candidateFixture();
  await forgetJournal(test);
  expect(await scan(test)).toMatchObject({ examined: 1, deleted: 0 });
  expect(test.store.deletes).toBe(0);
  expect((await history(events.store, test.subject, 'test')).length).toBe(0);
}
it('never adopts a listed UID without independent journal or event evidence', scanUnprovenIdentity);

async function scanNonPersonal() {
  const test = await candidateFixture();
  test.store.finishDeletion();
  const other = { ...test.input, purpose: 'company' as const, operationId: 'company',
    generation: 2 };
  await test.store.custody.stage(other, material);
  await test.invalidate();
  expect(await scan(test)).toMatchObject({ examined: 1, deleted: 0 });
  expect(test.store.deletes).toBe(0);
}
it('keeps non-personal candidates even with a later profile revocation', scanNonPersonal);


async function refusesInvalidRecovery(result: 'status' | 'identity') {
  const test = await candidateFixture();
  await test.invalidate();
  const custody = test.store.restart();
  const actual = await custody.recover(test.input);
  const recovery = vi.spyOn(custody, 'recover');
  if (result === 'status') {
    recovery.mockResolvedValue({ status: 'conflict', identity: actual.identity! });
  } else {
    recovery.mockResolvedValue({ status: 'recovered' });
  }
  const removal = vi.spyOn(custody, 'remove');
  expect(await reconcileConnectionPage(events.store, test.db, custody, 'test'))
      .toMatchObject({ deleted: 0 });
  expect(removal).not.toHaveBeenCalled();
}
it.each(['status', 'identity'] as const)(
  'keeps candidates when recovery has an invalid %s', refusesInvalidRecovery);

async function refusesMissingLockBeforeReadingProfile() {
  const profile = { ...stage };
  function unavailable(): never {
    throw new Error('Profile read before lock check');
  }
  Object.defineProperty(profile, 'siloId', { get: unavailable });
  const work = vi.fn();
  await expect(withConnectionStage({}, profile, work)).rejects.toThrow(
    'Connection coordination unavailable');
  expect(work).not.toHaveBeenCalled();
}
it('refuses missing coordination before using candidate details', refusesMissingLockBeforeReadingProfile);

async function refusesUntrustedListing(change: string) {
  const test = await candidateFixture();
  await test.activate();
  await test.invalidate();
  if (change === 'missing') {
    delete test.store.secret.metadata.annotations['opencrane.ai/stage'];
  } else if (change === 'binding') {
    const altered = { ...test.input, appendUntil: 1 };
    test.store.secret.metadata.annotations['opencrane.ai/stage'] = JSON.stringify(altered);
  } else {
    test.store.secret.metadata.annotations['opencrane.ai/stage'] = '{';
  }
  await scan(test);
  expect(test.store.deletes).toBe(0);
}
it.each(['missing', 'binding', 'malformed'])(
  'keeps material with %s private discovery metadata', refusesUntrustedListing);

async function refusesUnboundedPage(kind: string) {
  const test = await candidateFixture();
  const original = structuredClone(test.store.secret);
  let body: string;
  if (kind === 'count') {
    body = JSON.stringify({ items: Array(26).fill(original), metadata: {} });
  } else if (kind === 'bytes') {
    original.metadata.annotations['fixture.test/padding'] = 'x'.repeat(1_048_576);
    body = JSON.stringify({ items: [original], metadata: {} });
  } else {
    body = JSON.stringify({ items: [original], metadata: { continue: 'x'.repeat(4097) } });
  }
  const fetch = vi.spyOn(globalThis, 'fetch');
  fetch.mockResolvedValue(new Response(body));
  try {
    expect(await scan(test)).toEqual({ status: 'unknown' });
    expect(test.store.deletes).toBe(0);
  } finally {
    fetch.mockRestore();
  }
}
it.each(['count', 'bytes', 'continuation'])(
  'refuses a custody page exceeding the %s bound', refusesUnboundedPage);


async function refusesMismatchedSavedStage() {
  const test = await candidateFixture();
  await test.activate();
  const rows = await history(events.store, test.subject, 'test');
  const saved = foldConnection(rows).data!;
  const changed = { ...saved, activation: { ...saved.activation, appendUntil: 1 } };
  const event = { ...rows[0]!.event, data: changed };
  const conflicting: StoredEvent[] = [{ ...rows[0]!, event }];
  await test.invalidate();
  const current = await history(events.store, test.subject, 'test');
  conflicting.push(current[1]!);
  await forgetJournal(test);
  async function* wrongRecord() {
    const recovered = await Promise.resolve(conflicting);
    yield* recovered;
  }
  const reading = vi.spyOn(events.store, 'readStream');
  reading.mockImplementation(wrongRecord);
  try {
    expect(await scan(test)).toMatchObject({ examined: 1, deleted: 0 });
    expect(test.store.deletes).toBe(0);
  } finally {
    reading.mockRestore();
  }
}
it('requires the saved activation to match the private stage before rebuilding records',
  refusesMismatchedSavedStage);

async function cleanupFixture() {
  const test = await candidateFixture(Date.now() + 60_000);
  await test.activate();
  const rows = await history(events.store, test.subject, 'test');
  const previous = foldConnection(rows).data!;
  async function revoke() {
    const data = { userId: test.input.userId, serverId: test.input.serverId,
      profile: test.input.profileId, revokedBy: test.input.userId,
      expectedSequence: rows[0]!.sequence, reason: 'owner_requested' };
    const event = envelope('test', test.subject, 'connection.revoked', data);
    event.principal = { kind: 'human', id: test.input.userId };
    await events.seed([event]);
    return event;
  }
  async function rotate() {
    const replacement = { ...test.input, generation: 2, operationId: 'rotation',
      expectedSequence: rows[0]!.sequence };
    const saved = await test.store.custody.stage(replacement, material);
    const activation = { ...previous.activation, generation: 2, operationId: 'rotation',
      expectedSequence: rows[0]!.sequence, reason: 'bearer_rotation' };
    const data = { ...previous, secretRef: `secret:${saved.identity!.reference}`, activation };
    const event = envelope('test', test.subject, 'connection.refreshed', data, 'rotation');
    event.principal = { kind: 'human', id: test.input.userId };
    await events.seed([event]);
    return { event, replacement };
  }
  function handler() {
    return connectionCleanupHandler(events.store, test.db, test.store.restart(), 'test');
  }
  return { ...test, revoke, rotate, handler };
}

async function reactsToRevocation() {
  const test = await cleanupFixture();
  const unrelated = { ...test.input, profileId: 'unrelated', operationId: 'unrelated' };
  await test.store.custody.stage(unrelated, material);
  const event = await test.revoke();
  expect(test.store.deletes).toBe(0);
  const connection = await events.client('command');
  const restarted = await createEventStore(connection);
  await forgetJournal(test);
  const first = connectionCleanupHandler(restarted, test.db, test.store.restart(), 'test');
  const second = test.handler();
  expect(first.eventTypes).toEqual(['connection.revoked', 'connection.refreshed']);
  const outcomes = await Promise.allSettled([first.handle(event, test.db), second.handle(event, test.db)]);
  for (const outcome of outcomes) {
    if (outcome.status === 'rejected') {
      expect(outcome.reason).toEqual(new Error('Connection cleanup unavailable'));
    }
  }
  // Retry lock contention as the queue does, using a fresh history read each time.
  await first.handle(event, test.db);
  await second.handle(event, test.db);
  expect(test.store.deletes).toBe(1);
  expect(test.store.secrets.size).toBe(1);
  expect(test.store.preconditions).toEqual({ uid: 'uid-original', resourceVersion: '1' });
}
it('cleans only saved revoked generations after restart and duplicate workers', reactsToRevocation);

async function reactsToRotation() {
  const test = await cleanupFixture();
  const rotated = await test.rotate();
  await test.handler().handle(rotated.event, test.db);
  expect(test.store.deletes).toBe(1);
  expect(await test.store.restart().recover(rotated.replacement)).toMatchObject({ status: 'recovered' });
  const rows = await history(events.store, test.subject, 'test');
  expect(foldConnection(rows).data?.activation.generation).toBe(2);
}
it('cleans the superseded generation after a saved bearer rotation', reactsToRotation);

async function retainsFailedReaction(failure: string) {
  const test = await cleanupFixture();
  const event = await test.revoke();
  const faults = [];
  function fail(): never {
    throw new Error(material);
  }
  if (failure === 'uid' || failure === 'resourceVersion') {
    test.store.secret.metadata[failure] = 'changed';
  } else if (failure === 'custody') {
    test.store.failReads();
  } else {
    const fault = failure === 'store'
      ? vi.spyOn(events.store, 'readStream') : vi.spyOn(test.db, 'lock');
    fault.mockImplementation(fail);
    faults.push(fault);
  }
  try {
    await expect(test.handler().handle(event, test.db)).rejects.toThrow(
      'Connection cleanup unavailable');
    expect(test.store.deletes).toBe(0);
    expect(test.store.secrets.size).toBe(1);
  } finally {
    for (const fault of faults) fault.mockRestore();
  }
  const rows = await history(events.store, test.subject, 'test');
  expect(foldConnection(rows).status).toBe('unavailable');
}
it.each(['uid', 'resourceVersion', 'custody', 'store', 'lock'])(
  'retains invalidated material and retries after a reaction %s failure', retainsFailedReaction);

async function ignoresUnsavedTrigger(change: string) {
  const test = await cleanupFixture();
  const event = await test.revoke();
  const altered = structuredClone(event);
  if (change === 'silo') altered.silo = 'other';
  if (change === 'subject') altered.subject = 'connection-other';
  if (change === 'id') altered.id = 'unsaved';
  if (change === 'data') {
    const data = connectionRevokedDataSchema.parse(event.data);
    altered.data = { ...data, revokedBy: 'other' };
  }
  if (change === 'id' || change === 'data') {
    await expect(test.handler().handle(altered, test.db))
      .rejects.toThrow('Connection cleanup unavailable');
  } else {
    await test.handler().handle(altered, test.db);
  }
  expect(test.store.deletes).toBe(0);
}
it.each(['silo', 'subject', 'id', 'data'])(
  'requires the exact saved trigger, including %s', ignoresUnsavedTrigger);

async function holdsLockUntilDeletionFinishes() {
  const test = await cleanupFixture();
  const event = await test.revoke();
  const custody = test.store.restart();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const remove = custody.remove.bind(custody);
  async function paused(...args: Parameters<typeof remove>) {
    entered.resolve();
    await release.promise;
    return remove(...args);
  }
  const removal = vi.spyOn(custody, 'remove');
  removal.mockImplementation(paused);
  const handler = connectionCleanupHandler(events.store, test.db, custody, 'test');
  const cleaning = handler.handle(event, test.db);
  const inject = vi.fn();
  try {
    await entered.promise;
    await expect(withConnectionStage(test.db, test.input, inject))
      .rejects.toThrow('Connection coordination unavailable');
    expect(inject).not.toHaveBeenCalled();
    expect(test.store.deletes).toBe(0);
  } finally {
    release.resolve();
    await cleaning;
  }
  expect(test.store.deletes).toBe(1);
}
it('holds the shared profile lock until the exact delete finishes', holdsLockUntilDeletionFinishes);

async function refusesDifferentSavedBinding(field: keyof ConnectionStage) {
  const test = await candidateFixture();
  await test.activate();
  await test.invalidate();
  const custody = test.store.restart();
  const recover = vi.spyOn(custody, 'recover');
  const candidate = { ...test.input };
  const value = candidate[field];
  const mismatch = { [field]: typeof value === 'number' ? value + 1 : 'different' };
  Object.assign(candidate, mismatch);
  // Return valid saved events even for the wrong requested stream to test the recovery boundary.
  const rows = await history(events.store, test.subject, 'test');
  async function* wrongStream() {
    yield* await Promise.resolve(rows);
  }
  const read = vi.spyOn(events.store, 'readStream');
  read.mockImplementation(wrongStream);
  try {
    expect(await reconcileConnectionStage(events.store, test.db, custody, candidate))
      .toEqual({ status: 'retained' });
    if (field === 'siloId') {
      expect(recover).not.toHaveBeenCalled();
    } else {
      expect(recover).toHaveBeenCalledOnce();
      expect(recover.mock.calls[0]?.[1] === undefined).toBe(true);
    }
    expect(test.store.deletes).toBe(0);
  } finally {
    read.mockRestore();
  }
}
const savedBindings: (keyof ConnectionStage)[] = ['siloId', 'userId', 'serverId', 'profileId',
  'connectionId', 'purpose', 'generation', 'endpointDigest', 'operationId',
  'expectedSequence', 'appendUntil'];
it.each(savedBindings)('refuses recovery evidence with a different %s', refusesDifferentSavedBinding);

async function refusesUnlistedPage(throws: boolean) {
  const test = await candidateFixture();
  await test.invalidate();
  const custody = test.store.restart();
  function unavailable() {
    if (throws) throw new Error(material);
    const result = { status: 'unknown' as const };
    const unexpected = { stages: [test.input], continuation: 'private' };
    Object.assign(result, unexpected);
    return Promise.resolve(result);
  }
  const listing = vi.spyOn(custody, 'candidates');
  listing.mockImplementation(unavailable);
  expect(await reconcileConnectionPage(events.store, test.db, custody, 'test'))
    .toEqual({ status: 'unknown' });
  expect(test.store.deletes).toBe(0);
}
it.each([false, true])('retains a failed candidate page (throws: %s)', refusesUnlistedPage);

async function retriesWithTheHandlerRuntime() {
  const test = await cleanupFixture();
  const event = await test.revoke();
  const custody = test.store.restart();
  const recovery = vi.spyOn(custody, 'recover');
  const unknown = { status: 'unknown' as const };
  recovery.mockResolvedValueOnce(unknown);
  const handler = connectionCleanupHandler(events.store, test.db, custody, 'test');
  const completed = Promise.withResolvers<void>();
  const transaction = test.db.transaction.bind(test.db);
  let failures = 0;
  async function observe<Result>(work: (tx: Query) => Promise<Result>): Promise<Result> {
    try {
      const result = await transaction(work);
      const receipts = await test.db.query(
        "SELECT 1 FROM handler_receipts WHERE handler='cleanup-connection' AND event_id=$1",
        [event.id]);
      if (receipts.rows.length) completed.resolve();
      return result;
    } catch (error) {
      failures += 1;
      throw error;
    }
  }
  test.db.transaction = observe;
  const logger = createLogger('connection-cleanup-test');
  const logged = vi.spyOn(logger, 'info');
  const options = { db: test.db, logger, silo: 'test',
    handlers: [handler], retryLimit: 1, retryDelay: 0 };
  const runtime = new HandlerRuntime(options);
  async function enqueue(tx: Parameters<typeof handler.handle>[1]) {
    await runtime.enqueue(handler, event, tx);
  }
  try {
    await runtime.start();
    await test.db.transaction(enqueue);
    await runtime.work(2);
    await completed.promise;
    expect(failures).toBe(1);
    expect(test.store.deletes).toBe(1);
    expect(await runtime.deadLetters('cleanup-connection')).toEqual([]);
    expect(logged).not.toHaveBeenCalled();
  } finally {
    await runtime.stop();
  }
}
it('retries retained cleanup through the real queue without logging event identities',
  retriesWithTheHandlerRuntime);

async function rejectsRecoveryWithoutSavedActivation(closed: boolean) {
  const test = await candidateFixture();
  if (closed) await test.activate();
  const rows = await history(events.store, test.subject, 'test');
  const data = { userId: test.input.userId, serverId: test.input.serverId,
    profile: test.input.profileId, operationId: 'closed-operation',
    generation: closed ? 2 : 1, expectedSequence: rows.at(-1)?.sequence ?? 0,
    appendUntil: test.input.appendUntil, reason: 'append_deadline_passed' };
  const event = envelope('test', test.subject, 'connection.operation_closed', data);
  await events.seed([event]);
  const candidate = { ...test.input, operationId: event.id };
  const custody = test.store.restart();
  const recover = vi.spyOn(custody, 'recover');
  expect(await reconcileConnectionStage(events.store, test.db, custody, candidate))
    .toEqual({ status: 'retained' });
  expect(recover).toHaveBeenCalledOnce();
  expect(recover.mock.calls[0]?.[1] === undefined).toBe(true);
  expect(test.store.deletes).toBe(0);
}
it.each([false, true])('requires a matching saved activation (previous activation: %s)',
  rejectsRecoveryWithoutSavedActivation);

async function loadsPrivateCustodyConfiguration() {
  const test = await candidateFixture();
  const config = { apiUrl: test.store.apiUrl, namespace: 'custody',
    journalDirectory: test.store.directory, currentKeyId: keyring.currentKeyId,
    keys: { fixture: keyring.keys.fixture.toString('base64') } };
  const filename = `${test.store.directory}/configuration.json`;
  await writeFile(filename, JSON.stringify(config));
  const loaded = await connectionCustodyFromFile(filename);
  if (!loaded) {
    throw new Error('Connection custody configuration did not load');
  }
  expect(await loaded.recover(test.input)).toMatchObject({ status: 'recovered' });
  await writeFile(filename, material);
  await expect(connectionCustodyFromFile(filename)).rejects.toThrow(
    'Connection custody configuration unavailable');
}
it('loads mounted private custody settings and hides malformed file contents',
  loadsPrivateCustodyConfiguration);

async function refusesIneffectiveSavedRevocation() {
  const test = await cleanupFixture();
  const data = { userId: test.input.userId, serverId: test.input.serverId,
    profile: test.input.profileId, revokedBy: test.input.userId,
    expectedSequence: 0, reason: 'owner_requested' };
  const event = envelope('test', test.subject, 'connection.revoked', data);
  event.principal = { kind: 'human', id: test.input.userId };
  await events.seed([event]);
  await expect(test.handler().handle(event, test.db))
    .rejects.toThrow('Connection cleanup unavailable');
  expect(test.store.deletes).toBe(0);
  expect(await test.store.restart().recover(test.input)).toMatchObject({ status: 'recovered' });
}
it('retains material when a saved revoke did not target the current revision',
  refusesIneffectiveSavedRevocation);

function runningScan(test: Awaited<ReturnType<typeof candidateFixture>>, intervalMs?: number) {
  const stop = new AbortController();
  const records: { counts: unknown; message: unknown }[] = [];
  function info(counts: unknown, message?: unknown) {
    records.push({ counts, message });
  }
  const logger = { info };
  const done = scanConnections(events.store, test.db, test.store.restart(), logger,
    'test', stop.signal, intervalMs);
  async function close() {
    stop.abort();
    expect(await done).toBeUndefined();
  }
  async function pages(count = 1) {
    function ready() {
      return records.length >= count;
    }
    await until(ready);
  }
  return { stop, done, records, close, pages };
}

async function startupRemovesAbandonedRotation() {
  const test = await cleanupFixture();
  const rows = await history(events.store, test.subject, 'test');
  const rotation = { ...test.input, generation: 2, operationId: 'abandoned-rotation',
    expectedSequence: rows[0]!.sequence };
  const saved = await test.store.custody.stage(rotation, material);
  const first = runningScan(test);
  try {
    await first.pages();
    expect(test.store.deletes).toBe(0);
  } finally {
    await first.close();
  }
  await test.revoke();
  const now = vi.spyOn(Date, 'now');
  now.mockReturnValue(rotation.appendUntil + 1);
  const restarted = runningScan(test);
  try {
    await restarted.pages();
    expect(test.store.secrets.has(saved.identity!.reference)).toBe(false);
    expect(test.store.deletes).toBe(2);
    expect(test.store.preconditions).toEqual({ uid: 'uid-original', resourceVersion: '1' });
    expect(restarted.records).toEqual([
      { counts: { examined: 2, deleted: 2 }, message: 'Connection custody page scanned' },
    ]);
  } finally {
    await restarted.close();
    now.mockRestore();
  }
}
it('startup scan removes an unsaved rotation after revoke and restart',
  startupRemovesAbandonedRotation);

async function intervalCleansExhaustedReaction() {
  const test = await cleanupFixture();
  const isolated = await databases();
  test.db = pgDb(isolated.queue);
  const event = await test.revoke();
  test.store.failDeletes(true);
  const handler = test.handler();
  const logger = createLogger('scan-exhaustion-test');
  const runtime = new HandlerRuntime({ db: test.db, logger, silo: 'test',
    handlers: [handler], retryDelay: 0 });
  async function enqueue(tx: Query) {
    await runtime.enqueue(handler, event, tx);
  }
  async function exhausted() {
    return (await runtime.deadLetters(handler.name)).length === 1;
  }
  let scan: ReturnType<typeof runningScan> | undefined;
  try {
    await runtime.start();
    await test.db.transaction(enqueue);
    await runtime.work(2);
    await until(exhausted, 80_000);
    expect(test.store.deleteAttempts).toBe(6);
    const failed = await runtime.deadLetters(handler.name);
    expect(JSON.stringify(failed)).not.toContain(material);
    scan = runningScan(test, 100);
    await scan.pages();
    expect(test.store.deletes).toBe(0);
    test.store.failDeletes(false);
    function deleted() {
      return test.store.deletes === 1;
    }
    await until(deleted);
    await scan.close();
    expect(scan.records.length).toBeGreaterThan(1);
    expect(test.store.deletes).toBe(1);
    expect(await runtime.deadLetters(handler.name)).toEqual(failed);
  } finally {
    await scan?.close();
    await runtime.stop();
    await isolated.close();
  }
}
it('interval scan removes copies after every reaction retry fails and keeps the failed job',
  intervalCleansExhaustedReaction, 90_000);

async function pagedScan(restart: boolean) {
  const test = await candidateFixture();
  for (let index = 1; index < 53; index += 1) {
    const candidate = { ...test.input, generation: index + 1, operationId: `scan-${index}` };
    await test.store.custody.stage(candidate, material);
  }
  await test.invalidate();
  const names = [...test.store.secrets.keys()];
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  async function pauseSecondPage() {
    if (test.store.listings.length === 2 && restart) {
      entered.resolve();
      await release.promise;
    }
  }
  test.store.onList(pauseSecondPage);
  const scan = runningScan(test);
  try {
    if (restart) {
      await entered.promise;
      scan.stop.abort();
      release.resolve();
      await scan.close();
      expect(test.store.listings).toHaveLength(2);
      const resumed = runningScan(test);
      try {
        function deleted() {
          return test.store.deletes === 53;
        }
        await until(deleted);
      } finally {
        await resumed.close();
      }
    } else {
      await scan.pages(3);
      expect(scan.records).toEqual([
        { counts: { examined: 25, deleted: 25 }, message: 'Connection custody page scanned' },
        { counts: { examined: 25, deleted: 25 }, message: 'Connection custody page scanned' },
        { counts: { examined: 3, deleted: 3 }, message: 'Connection custody page scanned' },
      ]);
      expect(test.store.pages).toEqual([25, 25, 3]);
    }
  } finally {
    release.resolve();
    await scan.close();
  }
  expect(test.store.removals).toHaveLength(53);
  for (const name of names) {
    function matches(removal: { name: string }) {
      return removal.name === name;
    }
    const matching = test.store.removals.filter(matches);
    expect(matching).toEqual([{ name, preconditions: { uid: 'uid-original', resourceVersion: '1' } }]);
  }
  const rows = await history(events.store, test.subject, 'test');
  expect(rows).toHaveLength(1);
  expect(rows[0]!.event.type).toBe('connection.revoked');
}
it.each([false, true])('scan examines all 53 candidates, with mid-page restart: %s', pagedScan);

async function slowAndUnknownPages() {
  const test = await candidateFixture();
  for (let index = 1; index < 26; index += 1) {
    const candidate = { ...test.input, generation: index + 1, operationId: `retry-${index}` };
    await test.store.custody.stage(candidate, material);
  }
  await test.invalidate();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  async function controlPages() {
    const count = test.store.listings.length;
    if (count === 1) {
      entered.resolve();
      await release.promise;
    }
    if (count === 2) {
      test.store.failLists(2);
    }
  }
  test.store.onList(controlPages);
  const scan = runningScan(test, 50);
  try {
    await entered.promise;
    await delay(160);
    expect(test.store.listings).toEqual(['']);
    expect(test.store.maximumLists).toBe(1);
    release.resolve();
    function deleted() {
      return test.store.deletes === 26;
    }
    await until(deleted);
    await scan.close();
    const requests = test.store.listings;
    expect(requests[1]).toBeTruthy();
    expect(requests.slice(0, 4)).toEqual(['', requests[1], requests[1], '']);
    const stoppedCount = requests.length;
    await delay(160);
    expect(requests).toHaveLength(stoppedCount);
    const rows = await history(events.store, test.subject, 'test');
    expect(rows).toHaveLength(1);
    const output = JSON.stringify({ records: scan.records, events: rows });
    expect(output).not.toContain(requests[1]);
    expect(output).not.toContain(material);
    expect(output).not.toContain('secret:');
    expect(output).not.toContain('credential.released');
  } finally {
    release.resolve();
    await scan.close();
  }
}
it('scan serialises slow pages, retries unknown pages unchanged and resets expired continuations',
  slowAndUnknownPages);

async function scanRetainsCurrentUnknownAndLate() {
  const test = await candidateFixture(Date.now() + 60_000);
  const uncertain = { ...test.input, profileId: 'uncertain', operationId: 'uncertain' };
  const unknown = await test.store.custody.stage(uncertain, material);
  await test.activate();
  const rows = await history(events.store, test.subject, 'test');
  const data = foldConnection(rows).data!;
  const revoked = envelope('test', 'connection-member-a-server-a-uncertain', 'connection.revoked',
    { userId: uncertain.userId, serverId: uncertain.serverId, profile: uncertain.profileId,
      revokedBy: uncertain.userId });
  await events.seed([revoked]);
  const late = { ...test.input, profileId: 'late', operationId: 'late' };
  const staged = await test.store.custody.stage(late, material);
  async function saveDuringList() {
    const event = { ...rows[0]!.event, id: late.operationId,
      subject: 'connection-member-a-server-a-late', data: { ...data, profile: 'late',
        secretRef: `secret:${staged.identity!.reference}`,
        activation: { ...data.activation, operationId: late.operationId } } };
    await events.seed([event]);
  }
  test.store.onList(saveDuringList);
  const scan = runningScan(test);
  try {
    await scan.pages();
    expect(scan.records[0]?.counts).toEqual({ examined: 3, deleted: 0 });
    expect(test.store.deletes).toBe(0);
    for (const identity of [unknown.identity!, staged.identity!]) {
      expect(test.store.secrets.has(identity.reference)).toBe(true);
    }
  } finally {
    await scan.close();
  }
}
it('scan keeps current and uncertain generations and an activation saved during its pass',
  scanRetainsCurrentUnknownAndLate);

async function keepsForeignCurrentCopy() {
  const test = await candidateFixture();
  await test.invalidate();
  const foreign = await natsFixture();
  const input = { ...test.input, siloId: 'foreign', profileId: 'foreign-profile',
    operationId: 'foreign-operation', appendUntil: Date.now() - 60_000 };
  const staged = await test.store.custody.stage(input, material);
  const subject = `connection-${input.userId}-${input.serverId}-${input.profileId}`;
  const activation = { connectionId: input.connectionId, ownerKind: 'personal',
    purpose: 'personal', generation: 1, uid: staged.identity!.uid,
    resourceVersion: staged.identity!.resourceVersion, endpointDigest: input.endpointDigest,
    operationId: input.operationId, changedBy: input.userId, expectedSequence: 0,
    appendUntil: input.appendUntil, reason: 'bearer_create' };
  const data = { userId: input.userId, serverId: input.serverId, profile: input.profileId,
    secretRef: `secret:${staged.identity!.reference}`, activation };
  const event = envelope('foreign', subject, 'connection.created', data, input.operationId);
  event.principal = { kind: 'human', id: input.userId };
  event.time = new Date(input.appendUntil - 1000).toISOString();
  await foreign.seed([event]);
  const localPosition = await events.store.head();
  const lock = vi.spyOn(test.db, 'lock');
  const scan = runningScan(test);
  try {
    await scan.pages();
    const current = foldConnection(await history(foreign.store, subject, 'foreign'));
    expect(current.status).toBe('saved_unverified');
    expect(current.data?.secretRef === `secret:${staged.identity!.reference}`).toBe(true);
    const localRows = await history(events.store, subject, 'foreign');
    expect(test.store.secrets.has(staged.identity!.reference)).toBe(true);
    expect(localRows).toEqual([]);
    expect(await events.store.head()).toBe(localPosition);
    expect(scan.records).toEqual([
      { counts: { examined: 2, deleted: 1 }, message: 'Connection custody page scanned' },
    ]);
    expect(test.store.deletes).toBe(1);
    expect(lock).toHaveBeenCalledTimes(1);
  } finally {
    await scan.close();
    lock.mockRestore();
    await foreign.close();
  }
}
it('scan keeps and counts a foreign current copy on a mixed custody page', keepsForeignCurrentCopy);

async function scansEveryFifteenMinutesByDefault() {
  const test = await candidateFixture();
  await test.invalidate();
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const scan = runningScan(test);
  try {
    await scan.pages();
    expect(test.store.listings).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(899_999);
    await delay(50);
    expect(test.store.listings).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await scan.pages(2);
    expect(test.store.listings).toHaveLength(2);
  } finally {
    await scan.close();
    vi.useRealTimers();
  }
}
it('scan defaults to exactly fifteen minutes between passes', scansEveryFifteenMinutesByDefault);

async function clearsUnknownAfterSuccess() {
  const test = await candidateFixture();
  for (let index = 1; index < 26; index += 1) {
    const candidate = { ...test.input, generation: index + 1, operationId: `reset-${index}` };
    await test.store.custody.stage(candidate, material);
  }
  await test.invalidate();
  function failSeparatePages() {
    const count = test.store.listings.length;
    if (count === 1 || count === 3) {
      test.store.failLists(1);
    }
    return Promise.resolve();
  }
  test.store.onList(failSeparatePages);
  const scan = runningScan(test, 50);
  try {
    function deleted() {
      return test.store.deletes === 26;
    }
    await until(deleted);
    await scan.close();
    const requests = test.store.listings;
    expect(requests[2]).toBeTruthy();
    expect(requests.slice(0, 4)).toEqual(['', '', requests[2], requests[2]]);
    expect(test.store.maximumLists).toBe(1);
  } finally {
    await scan.close();
  }
}
it('scan clears consecutive unknown state after a successful page', clearsUnknownAfterSuccess);
