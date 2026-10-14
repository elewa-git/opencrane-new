import { createHash } from 'node:crypto';
import type { AppendCommand } from '@opencrane/event-store';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, readdir, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { natsFixture } from '@opencrane/event-store/testing';
import { databases } from '@opencrane/authz/testing';
import { type Db, pgDb } from '@opencrane/projections';
import { envelope, history } from '../src/actor.ts';
import { foldConnection } from '../src/bearer-connections.ts';
import { reconcileConnectionStage } from '../src/connection-reconciliation.ts';
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
  let creates = 0;
  let deletes = 0;
  let loseCreate = false;
  let changeOnDelete = false;
  let readsUnavailable = false;
  let finalise = false;
  let failRemovalRead = false;
  let unavailable = false;
  let preconditions: unknown;
  async function handle(request: IncomingMessage, response: ServerResponse) {
    if (unavailable || (readsUnavailable && request.method === 'GET')) {
      response.writeHead(503).end(material);
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      if (!Buffer.isBuffer(chunk)) throw new Error('Fixture request invalid');
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks).toString();
    if (request.method === 'POST') {
      if (secret) {
        response.writeHead(409).end(material);
        return;
      }
      const raw: unknown = JSON.parse(body);
      const parsed = secretSchema.parse(raw);
      parsed.metadata.uid = 'uid-original';
      parsed.metadata.resourceVersion = '1';
      if (finalise) {
        parsed.metadata.finalizers = ['fixture.test/retain'];
      }
      secret = parsed;
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
  return { custody, restart, directory, get secret() { return secret!; }, get creates() { return creates; },
    get deletes() { return deletes; }, get preconditions() { return preconditions; },
    loseCreate() { loseCreate = true; }, changeOnDelete() { changeOnDelete = true; },
    fail() { unavailable = true; },
    failReads() { readsUnavailable = true; }, restoreReads() { readsUnavailable = false; },
    retainWithFinaliser() { finalise = true; }, failRemovalRead() { failRemovalRead = true; },
    finishDeletion() { secret = undefined; } };
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
  const replayed = foldConnection(rows);
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
