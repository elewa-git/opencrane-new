import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, readdir, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
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
