import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { afterEach, expect, it } from 'vitest';
import { connectionCustody, type ConnectionStage } from '../src/connection-custody.ts';

const material = 'synthetic-custody-material';
const keyring = { currentKeyId: 'fixture', keys: { fixture: Buffer.alloc(32, 7) } };
const stage: ConnectionStage = {
  siloId: 'silo-a', userId: 'member-a', serverId: 'server-a', connectionId: 'install-a',
  profileId: 'profile-a', purpose: 'personal', generation: 1, endpointDigest: 'a'.repeat(64),
  operationId: 'operation-a', expectedSequence: 0, appendUntil: 123456789,
};
type Secret = {
  metadata: { name: string; namespace: string; uid: string; resourceVersion: string;
    labels: Record<string, string>; annotations: Record<string, string> };
  data: { token: string };
};
const servers: ReturnType<typeof createServer>[] = [];
async function closeServers() {
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
  let unavailable = false;
  let preconditions: unknown;
  async function handle(request: IncomingMessage, response: ServerResponse) {
    if (unavailable) {
      response.writeHead(503).end(material);
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.from(chunk as Uint8Array));
    }
    const body = Buffer.concat(chunks).toString();
    if (request.method === 'POST') {
      if (secret) {
        response.writeHead(409).end(material);
        return;
      }
      const parsed = JSON.parse(body) as Secret;
      parsed.metadata.uid = 'uid-original';
      parsed.metadata.resourceVersion = '1';
      secret = parsed;
      creates += 1;
      if (loseCreate) {
        loseCreate = false;
        request.socket.destroy();
        return;
      }
    }
    if (request.method === 'DELETE') {
      preconditions = (JSON.parse(body) as { preconditions: unknown }).preconditions;
      if (changeOnDelete) {
        secret!.metadata.resourceVersion = '2';
        response.writeHead(409).end(material);
        return;
      }
      deletes += 1;
      secret = undefined;
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
  const custody = connectionCustody(`http://127.0.0.1:${address.port}`, 'custody', keyring);
  return { custody, get secret() { return secret!; }, get creates() { return creates; },
    get deletes() { return deletes; }, get preconditions() { return preconditions; },
    loseCreate() { loseCreate = true; }, changeOnDelete() { changeOnDelete = true; },
    fail() { unavailable = true; } };
}

async function recoversLostCreate() {
  const store = await fixture();
  store.loseCreate();
  const first = await store.custody.stage(stage, material);
  expect(first.status).toBe('recovered');
  const recovered = await store.custody.recover(stage, first.identity);
  expect(recovered).toEqual(first);
  const repeated = await store.custody.stage(stage, material, first.identity);
  expect(repeated).toEqual(first);
  expect(store.creates).toBe(1);
  expect(JSON.stringify(first).includes(material)).toBe(false);
  expect(store.secret.metadata.annotations['opencrane.ai/operationId']).toBe(stage.operationId);
  expect(store.secret.metadata.annotations['opencrane.ai/expectedSequence']).toBe('0');
  expect(store.secret.metadata.annotations['opencrane.ai/appendUntil']).toBe('123456789');
}
it('recovers one private generation after a lost create reply', recoversLostCreate);

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
  expect((await store.custody.recover(stage, saved.identity)).status).toBe('conflict');
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
