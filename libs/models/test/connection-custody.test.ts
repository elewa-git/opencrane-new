import { saveCompanyBearerConnection, foldCompanyConnection } from '../src/company-bearer.ts';
import { changeCompanyOptIn } from '../src/company-opt-in.ts';
import { exportSPKI, generateKeyPair, SignJWT } from 'jose';
import { OpenFgaClient } from '@openfga/sdk';
import { MemberAccessRefused } from '../src/member-authority.ts';
import { exchangePersonalOAuth } from '../src/oauth-worker.ts';
import { remoteFixture } from './support/remote-mcp.ts';
import { open } from 'node:fs/promises';
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
import { jetstreamManager } from '@nats-io/jetstream';
import { databases, openfga, until } from '@opencrane/authz/testing';
import { createStore, memberAuthorisation } from '@opencrane/authz';
import { type Db, type Query, pgDb } from '@opencrane/projections';
import { envelope, history } from '../src/actor.ts';
import { foldConnection, saveBearerConnection } from '../src/bearer-connections.ts';
import { reconcileConnectionPage, reconcileConnectionStage } from '../src/connection-reconciliation.ts';
import { withConnectionStage } from '../src/connection-stage-lock.ts';
import { z } from 'zod';
import { connectionCustody, type ConnectionStage } from '../src/connection-custody.ts';
import { catalogueDigest, toolReviewDigest } from '@opencrane/events/mcp-catalogue';
import { losslessJson } from '@opencrane/events/lossless-json';
import { prepareOAuthAttempt } from '../src/oauth-attempt.ts';
import { startPersonalOAuth } from '../src/oauth-start.ts';
import { claimPersonalOAuthCallback } from '../src/oauth-callback.ts';
import { toolPolicyFromRows } from '../src/tool-policy.ts';

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
  const listedNames: string[] = [];
  const removals: { name: string; preconditions: unknown }[] = [];
  let listAction: (() => Promise<void>) | undefined;
  let readAction: (() => void) | undefined;
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
          listedNames.push(name);
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
    if (request.method === 'GET') {
      readAction?.();
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
  return { custody, restart, directory, pages, secrets, listings, listedNames, removals,
    get maximumLists() { return maximumLists; }, get deleteAttempts() { return deleteAttempts; },
    onList(action: () => Promise<void>) { listAction = action; },
    onRead(action: () => void) { readAction = action; },
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

function oauthFixture(withTools = false, serverId = 'server-a') {
  const context = { siloId: 'silo-a', userId: 'member-a', serverId,
    connectionId: 'install-a', profileId: 'profile-a', changeRef: 'consent-a',
    sessionDigest: 'b'.repeat(64), expectedSequence: 0 };
  const locator = 'https://tools.example.test/mcp';
  const endpointHash = createHash('sha256');
  endpointHash.update(JSON.stringify(locator));
  const configuration = { serverId: context.serverId, connectionId: context.connectionId,
    endpointDigest: endpointHash.digest('hex'), policyRevision: 4,
    tokenEndpoint: 'https://mcp.example.test/token',
    revocationEndpoint: 'https://mcp.example.test/revoke',
    issuer: 'https://identity.example.test/', consentEndpoint: 'https://identity.example.test/consent',
    redirectUri: 'https://app.example.test/api/my/tools/oauth/callback', clientId: 'fixture',
    protocolScopes: ['openid'], toolScopes: { 'data.read': ['read'], 'data.write': ['write'] } };
  const tools = [];
  const choices = [];
  if (withTools) {
    for (const name of ['data.read', 'data.write']) {
      const definition = JSON.stringify({ name, inputSchema: { type: 'object' } });
      const review = { action: 'Read data', consequence: 'Returns data', targetArgument: 'id',
        fields: ['id'], stepUp: false };
      const tool = { name, revision: losslessJson(definition).digest, definition,
        reviewed: false, costCents: 0, review };
      tools.push(tool);
      const mode = name === 'data.read' ? 'ask' : 'block';
      choices.push({ name, revision: tool.revision, reviewDigest: toolReviewDigest(tool), mode });
    }
  }
  const checkedAt = Date.now();
  const catalogue = { serverId: context.serverId, connectionId: context.connectionId,
    accountMode: 'personal', tools, toolCount: tools.length, schemaDigest: catalogueDigest(tools),
    checkedAt: new Date(checkedAt).toISOString(),
    expiresAt: new Date(checkedAt + 300_000).toISOString() };
  const entries = [
    ['mcp.server_registered', { serverId: context.serverId, kind: 'remote', locator,
      registeredBy: 'admin' }],
    ['mcp.server_discovered', catalogue],
    ['mcp.server_reviewed', { serverId: context.serverId, connectionId: context.connectionId,
      accountMode: 'personal', catalogueDigest: catalogue.schemaDigest, policyRevision: 2,
      reviewedBy: 'admin', tools: choices }],
    ['mcp.server_published', { serverId: context.serverId, publishedBy: 'admin' }],
  ] as const;
  const rows: StoredEvent[] = [];
  for (const [type, data] of entries) {
    const event = envelope(context.siloId, `mcp-${context.serverId}`, type, data);
    event.principal = { kind: 'human', id: 'admin' };
    rows.push({ event, sequence: rows.length + 1 });
  }
  return { context, configuration, rows };
}

type IdentityVerification = { algorithm: 'RS256'; publicKey: string };

async function consentStartFixture(identityVerification?: IdentityVerification) {
  const store = await fixture();
  candidateCount += 1;
  const userId = `consent${candidateCount}`;
  const serverId = `consent-server-${candidateCount}`;
  // Keep each case's server history independent of earlier consent tests.
  const input = oauthFixture(true, serverId);
  const configuration: typeof input.configuration & {
    identityVerification?: IdentityVerification;
  } = { ...input.configuration };
  if (identityVerification) {
    configuration.identityVerification = identityVerification;
  }
  const context = { ...input.context, siloId: 'test', userId };
  const joined = envelope('test', `member-${userId}`, 'member.joined', {
    memberId: userId, role: 'member', email: `${userId}@example.test`, displayName: userId,
  });
  await events.seed([joined]);
  await memberAuthorisation(consentBinding).handler.handle(joined, pgDb(storage.queue));
  const memberRevision = await events.store.head(joined.subject);
  for (const row of input.rows) {
    row.event.silo = 'test';
    if (row.event.type === 'mcp.server_reviewed') {
      const data = z.record(z.string(), z.unknown()).parse(row.event.data);
      row.event.data = { ...data, policyRevision: await events.store.head(row.event.subject) };
    }
    await events.seed([row.event]);
  }
  const rows = await history(events.store, `mcp-${serverId}`, 'test');
  configuration.policyRevision = toolPolicyFromRows(rows).policyRevision;
  const session = { siloId: 'test', userId, sessionDigest: context.sessionDigest, memberRevision };
  const command = { userId, serverId: context.serverId, connectionId: context.connectionId,
    profileId: context.profileId, changeRef: context.changeRef, expectedSequence: 0 };
  function loadConfiguration() {
    return Promise.resolve(configuration);
  }
  const loader = { loadConfiguration };
  const database = pgDb(storage.queue);
  function waitForLock<Result>(name: string, work: (db: Db) => Promise<Result>) {
    return database.lock!(name, work);
  }
  const db = { ...database, lock: waitForLock };
  const custody = store.restart();
  function start(raw: unknown = command) {
    return startPersonalOAuth(events.store, consentBinding, session, custody,
      raw, loader.loadConfiguration, db);
  }
  const subject = `connection-${userId}-${serverId}-${context.profileId}`;
  return { store, configuration, session, command, start, subject, custody, loader };
}

async function callbackFixture(identityVerification?: IdentityVerification) {
  const test = await consentStartFixture(identityVerification);
  const started = await test.start();
  if (started.status !== 'started') {
    throw new Error('Fixture consent failed');
  }
  const url = new URL(started.consentUrl);
  const parameters = new URLSearchParams({ state: url.searchParams.get('state')!,
    code: 'private-callback-canary', iss: test.configuration.issuer });
  const input = { ...test.command, redirectUri: test.configuration.redirectUri, parameters };
  const config = { apiUrl: test.store.apiUrl, namespace: 'custody',
    journalDirectory: test.store.directory, currentKeyId: 'fixture',
    keys: { fixture: keyring.keys.fixture.toString('base64') } };
  const filename = `${test.store.directory}/callback-config.json`;
  await writeFile(filename, JSON.stringify(config), { mode: 0o600 });
  async function callback(raw: unknown = input, restarted = false) {
    const custody = await connectionCustodyFromFile(filename);
    if (!custody) {
      throw new Error('Fixture custody failed');
    }
    let store = events.store;
    if (restarted) {
      store = await createEventStore(events.connection);
    }
    return claimPersonalOAuthCallback(store, consentBinding, test.session,
      custody, raw, test.loader.loadConfiguration, pgDb(storage.queue));
  }
  async function claims() {
    const rows = await history(events.store, test.subject, 'test');
    function isClaim(row: StoredEvent) {
      return row.event.type === 'connection.oauth_exchange_claimed';
    }
    return rows.filter(isClaim);
  }
  return { ...test, input, callback, claims, started };
}

async function claimsCallbackOnce(failure: string) {
  const test = await callbackFixture();
  const originalMaterial = test.store.secret.data.token;
  const manager = await jetstreamManager(events.connection);
  const stream = await manager.streams.info('EVENTS');
  const append = events.store.append.bind(events.store);
  async function loseReply(command: AppendCommand) {
    await append(command);
    return { status: 'unavailable' as const, cause: new Error('private-callback-canary') };
  }
  const fault = vi.spyOn(events.store, 'append');
  if (failure === 'lost-reply') {
    fault.mockImplementationOnce(loseReply);
  }
  try {
    const results = await Promise.all([test.callback(), test.callback()]);
    function wasClaimed(result: Awaited<ReturnType<typeof test.callback>>) {
      return result.status === 'claimed';
    }
    expect(results.filter(wasClaimed)).toHaveLength(1);
    const claims = await test.claims();
    expect(claims).toHaveLength(1);
    const privateText = Buffer.from(originalMaterial, 'base64').toString();
    const privateData = z.object({ state: z.string(), verifier: z.string() })
      .parse(JSON.parse(privateText));
    const publicText = JSON.stringify({ results, claims });
    for (const value of ['private-callback-canary', privateData.state, privateData.verifier]) {
      expect(publicText).not.toContain(value);
    }
    const rows = await history(events.store, test.subject, 'test');
    const effects = vi.spyOn(globalThis, 'fetch');
    expect(foldConnection(rows).status).toBe('unavailable');
    expect(effects).not.toHaveBeenCalled();
    await manager.streams.update('EVENTS', { duplicate_window: 100_000_000 });
    const probe = envelope('test', `member-dedup-${test.session.userId}`, 'member.joined', {
      memberId: 'probe', email: 'probe@example.test', displayName: 'Probe',
      role: 'member' }, claims[0]!.event.id);
    await waitForDuplicateExpiry(probe, claims[0]!.sequence);
    fault.mockClear();
    expect(await test.callback(test.input, true)).toEqual({ status: 'unknown' });
    expect(effects).not.toHaveBeenCalled();
    expect(fault).not.toHaveBeenCalled();
    expect(await test.claims()).toEqual(claims);
    expect(test.store.creates).toBe(2);
  } finally {
    vi.restoreAllMocks();
    await manager.streams.update('EVENTS', { duplicate_window: stream.config.duplicate_window });
  }
}
it.each(['race', 'lost-reply'])(
  'claims one OAuth callback after %s and refuses restart beyond broker deduplication',
  claimsCallbackOnce);

async function refusesCallback(change: string) {
  const test = await callbackFixture();
  let input = test.input;
  const parameters = input.parameters;
  if (change === 'state') parameters.set('state', 'x'.repeat(43));
  else if (change === 'missing-code') parameters.delete('code');
  else if (change === 'empty-code') parameters.set('code', '');
  else if (change === 'malformed-code') parameters.set('code', 'bad\ncode');
  else if (change === 'long-code') parameters.set('code', 'x'.repeat(4097));
  else if (change.startsWith('duplicate-')) {
    const key = change.slice('duplicate-'.length);
    parameters.append(key, parameters.get(key) ?? 'extra');
  } else if (change === 'issuer') parameters.set('iss', 'https://foreign.example.test/');
  else if (change === 'missing-issuer') parameters.delete('iss');
  else if (change === 'redirect') input = { ...input, redirectUri: 'https://other.example.test/' };
  else if (change === 'provider') input = { ...input, serverId: 'other-server' };
  else if (change === 'profile') input = { ...input, profileId: 'other-profile' };
  else if (change === 'installation') input = { ...input, connectionId: 'other-installation' };
  else if (change === 'session') test.session.sessionDigest = 'd'.repeat(64);
  else if (change === 'member') test.session.userId = 'other-member';
  else if (change === 'revision') test.session.memberRevision += 1;
  else if (change === 'silo') test.session.siloId = 'foreign';
  else if (change === 'scopes') test.configuration.protocolScopes.push('extra');
  else if (change === 'uid') test.store.secret.metadata.uid = 'recreated';
  else if (change === 'version') test.store.secret.metadata.resourceVersion = '2';
  else if (change === 'verifier') test.store.secret.data.token = Buffer.from('{}').toString('base64');
  else if (change === 'expiry') {
    vi.spyOn(Date, 'now').mockReturnValue(test.started.appendUntil);
  } else await changeConsentAccess(test, change);
  try {
    expect(await test.callback(input)).toEqual({ status: 'unknown' });
    expect(await test.claims()).toHaveLength(0);
  } finally {
    vi.restoreAllMocks();
  }
}
it.each(['state', 'missing-code', 'empty-code', 'malformed-code', 'long-code',
  'duplicate-state', 'duplicate-code', 'duplicate-iss', 'duplicate-extra', 'issuer',
  'missing-issuer', 'redirect', 'provider', 'profile', 'installation', 'session', 'member',
  'revision', 'silo', 'scopes', 'configuration', 'uid', 'version', 'verifier', 'expiry',
  'removed', 'rejoined', 'policy', 'disabled'])(
  'refuses OAuth callback with zero claims for changed %s', refusesCallback);

async function refusesCallbackPublication(change: string) {
  const test = await callbackFixture();
  const append = events.store.append.bind(events.store);
  async function changeBeforePublication(command: AppendCommand) {
    fault.mockRestore();
    await changeConsentAccess(test, change);
    return append(command);
  }
  const fault = vi.spyOn(events.store, 'append').mockImplementationOnce(changeBeforePublication);
  try {
    expect(await test.callback()).toEqual({ status: 'unknown' });
    expect(await test.claims()).toHaveLength(0);
  } finally {
    vi.restoreAllMocks();
  }
}
it.each(['removed', 'policy', 'disabled'])(
  'refuses OAuth callback when %s changes during publication', refusesCallbackPublication);

async function expiresCallbackAfterWait(point: string) {
  const test = await callbackFixture();
  const head = events.store.head.bind(events.store);
  let appended = false;
  let configurationRead = false;
  let crossedDeadline = false;
  function loadFinalConfiguration() {
    configurationRead = appended;
    return Promise.resolve(test.configuration);
  }
  const append = events.store.append.bind(events.store);
  async function observeAppend(command: AppendCommand) {
    const result = await append(command);
    appended = true;
    return result;
  }
  async function expireAfterRead(subject?: string, deadline?: number) {
    const result = await head(subject, deadline);
    if (configurationRead && subject === undefined) {
      crossedDeadline = true;
      if (point === 'expiry') {
        vi.spyOn(Date, 'now').mockReturnValue(test.started.appendUntil);
      } else {
        vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 2001);
      }
    }
    return result;
  }
  vi.spyOn(test.loader, 'loadConfiguration').mockImplementation(loadFinalConfiguration);
  vi.spyOn(events.store, 'append').mockImplementation(observeAppend);
  vi.spyOn(events.store, 'head').mockImplementation(expireAfterRead);
  try {
    expect(await test.callback()).toEqual({ status: 'unknown' });
    expect(crossedDeadline).toBe(true);
    expect(await test.claims()).toHaveLength(1);
  } finally {
    vi.restoreAllMocks();
  }
}
it.each(['expiry', 'deadline'])(
  'refuses OAuth callback continuation when final read crosses %s', expiresCallbackAfterWait);

async function refusesCallbackCustodyWait(change: string) {
  const test = await callbackFixture();
  function expireRead() {
    if (change === 'expiry') {
      vi.spyOn(Date, 'now').mockReturnValue(test.started.appendUntil);
    } else {
      test.store.secret.metadata.uid = 'recreated-during-read';
    }
  }
  test.store.onRead(expireRead);
  try {
    expect(await test.callback()).toEqual({ status: 'unknown' });
    expect(await test.claims()).toHaveLength(0);
  } finally {
    vi.restoreAllMocks();
  }
}
it.each(['expiry', 'uid'])(
  'refuses OAuth callback when %s changes during private reads', refusesCallbackCustodyWait);

async function checksCallbackFinalConfiguration(change: string) {
  const test = await callbackFixture();
  const append = events.store.append.bind(events.store);
  let appended = false;
  async function observeAppend(command: AppendCommand) {
    const result = await append(command);
    appended = true;
    return result;
  }
  async function changeConfiguration() {
    if (appended) {
      appended = false;
      if (change === 'unrelated') {
        const unrelated = envelope('test', 'member-other', 'member.joined', {
          memberId: 'other', email: 'other@example.test', displayName: 'Other',
          role: 'member' });
        await events.seed([unrelated]);
      } else {
        await changeConsentAccess(test, change);
      }
    }
    return test.configuration;
  }
  vi.spyOn(events.store, 'append').mockImplementation(observeAppend);
  vi.spyOn(test.loader, 'loadConfiguration').mockImplementation(changeConfiguration);
  try {
    const result = await test.callback();
    if (change === 'unrelated') {
      expect(result.status).toBe('claimed');
    } else {
      expect(result).toEqual({ status: 'unknown' });
    }
    expect(await test.claims()).toHaveLength(1);
  } finally {
    vi.restoreAllMocks();
  }
}
it.each(['removed', 'policy', 'disabled', 'configuration', 'unrelated'])(
  'checks OAuth callback access after final configuration wait: %s',
  checksCallbackFinalConfiguration);

async function startsPrivateConsent() {
  const test = await consentStartFixture();
  const started = await test.start();
  expect(started.status).toBe('started');
  if (started.status !== 'started') {
    throw new Error('Fixture start failed');
  }
  const url = new URL(started.consentUrl);
  expect(url.origin + url.pathname).toBe('https://identity.example.test/consent');
  const state = url.searchParams.get('state');
  const challenge = url.searchParams.get('code_challenge');
  const nonce = url.searchParams.get('nonce');
  expect(nonce).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  expect(Object.fromEntries(url.searchParams)).toEqual({ response_type: 'code',
    client_id: 'fixture', redirect_uri: 'https://app.example.test/api/my/tools/oauth/callback',
    scope: 'openid read', state, nonce, code_challenge: challenge, code_challenge_method: 'S256' });
  expect(started.changeRef).toBe(test.command.changeRef);
  const rows = await history(events.store, test.subject, 'test');
  expect(rows).toHaveLength(1);
  expect(rows[0]!.event.type).toBe('connection.oauth_started');
  const privateData = Buffer.from(test.store.secret.data.token, 'base64').toString();
  const saved = z.object({ state: z.string(), verifier: z.string(), nonce: z.string() })
    .parse(JSON.parse(privateData));
  expect(nonce).toBe(saved.nonce);
  expect(JSON.stringify(rows)).not.toContain(saved.nonce);
  expect(url.searchParams.get('state')).toBe(saved.state);
  expect(JSON.stringify({ started, rows })).not.toContain(saved.verifier);
  expect(JSON.stringify(rows)).not.toContain(saved.state);
  expect(foldConnection(rows).status).toBe('unavailable');
  expect(await test.start()).toEqual(started);
  expect(test.store.creates).toBe(1);
}
it('records private consent before returning only its approved URL', startsPrivateConsent);

async function changeConsentAccess(test: Pick<Awaited<ReturnType<typeof consentStartFixture>>,
  'session' | 'command' | 'subject' | 'configuration'>,
  change: string) {
  const userId = test.session.userId;
  const serverId = test.command.serverId;
  if (change === 'configuration') {
    test.configuration.clientId = 'changed';
    return;
  }
  let subject = `member-${userId}`;
  let type = 'member.removed';
  let data: unknown = { memberId: userId, removedBy: 'admin' };
  if (change === 'disabled') {
    subject = `connection-control-${userId}-${serverId}`;
    type = 'connection.disabled';
    data = { userId, serverId, profile: 'old-profile', disabledBy: 'admin',
      expectedSequence: 0, reason: 'admin_disabled' };
  }
  if (change === 'policy') {
    subject = `mcp-${serverId}`;
    type = 'mcp.server_unpublished';
    data = { serverId, unpublishedBy: 'admin' };
  }
  if (change === 'profile') {
    subject = test.subject;
    type = 'connection.revoked';
    data = { userId, serverId, profile: test.command.profileId, revokedBy: userId };
  }
  await events.seed([envelope('test', subject, type, data)]);
  if (change === 'rejoined') {
    const joined = envelope('test', subject, 'member.joined', {
      memberId: userId, role: 'member', email: `${userId}@example.test`, displayName: userId,
    });
    await events.seed([joined]);
    await memberAuthorisation(consentBinding).handler.handle(joined, pgDb(storage.queue));
  }
}

async function refusesConsentInput(change: string) {
  const test = await consentStartFixture();
  let command: unknown = test.command;
  if (change === 'non-owner' || change === 'admin-as-owner') {
    if (change === 'admin-as-owner') {
      const role = envelope('test', `member-${test.session.userId}`, 'member.role_changed', {
        memberId: test.session.userId, previousRole: 'member', newRole: 'admin', changedBy: 'admin',
      });
      await events.seed([role]);
      await memberAuthorisation(consentBinding).handler.handle(role, pgDb(storage.queue));
      test.session.memberRevision = await events.store.head(role.subject);
    }
    command = { ...test.command, userId: 'someone-else' };
  } else if (change === 'silo') {
    test.session.siloId = 'foreign';
  } else if (change === 'destination') {
    command = { ...test.command, consentEndpoint: 'https://unapproved.example.test/' };
  } else if (change === 'stale-config') {
    test.configuration.policyRevision += 1;
  } else if (change === 'credentials' || change === 'redirect') {
    test.configuration.consentEndpoint = change === 'credentials'
      ? 'https://user:canary@identity.example.test/consent'
      : 'https://identity.example.test/consent?redirect_uri=https://unapproved.example.test/';
  } else {
    await changeConsentAccess(test, change);
  }
  expect(await test.start(command)).toEqual({ status: 'unknown' });
  expect(await events.store.head(test.subject)).toBe(0);
  expect(test.store.creates).toBe(0);
}
it.each(['non-owner', 'admin-as-owner', 'silo', 'removed', 'rejoined', 'disabled',
  'stale-config', 'policy', 'credentials', 'redirect', 'destination'])(
  'refuses private consent before append or URL release: %s', refusesConsentInput);

async function refusesChangedStart(change: string) {
  const test = await consentStartFixture();
  expect((await test.start()).status).toBe('started');
  const sequence = await events.store.head(test.subject);
  let command = test.command;
  if (change === 'session') {
    test.session.sessionDigest = 'd'.repeat(64);
  } else if (change === 'profile') {
    command = { ...command, profileId: 'another-profile' };
  } else {
    await changeConsentAccess(test, change);
  }
  expect(await test.start(command)).toEqual({ status: 'unknown' });
  expect(await events.store.head(test.subject)).toBe(sequence);
  const changedSubject = `connection-${test.session.userId}-${test.command.serverId}-another-profile`;
  expect(await events.store.head(changedSubject))
    .toBe(0);
  expect(test.store.creates).toBe(1);
}
it.each(['session', 'profile', 'configuration', 'removed', 'rejoined', 'disabled', 'policy'])(
  'refuses private consent recovery with changed %s', refusesChangedStart);

async function recoversConsentStart(failure: string) {
  const test = await consentStartFixture();
  const append = events.store.append.bind(events.store);
  async function loseReply(command: AppendCommand) {
    await append(command);
    return { status: 'unavailable' as const, cause: new Error(material) };
  }
  const fault = vi.spyOn(events.store, 'append');
  if (failure === 'lost-reply') {
    fault.mockImplementationOnce(loseReply);
    expect(await test.start()).toEqual({ status: 'unknown' });
  } else {
    await Promise.all([test.start(), test.start()]);
  }
  fault.mockClear();
  const original = await test.start();
  const clock = vi.spyOn(Date, 'now');
  clock.mockReturnValue(Date.now() + 121_000);
  try {
    const recovered = await test.start();
    expect(recovered.status).toBe('started');
    expect(recovered).toEqual(original);
    expect(fault).not.toHaveBeenCalled();
    expect(await history(events.store, test.subject, 'test')).toHaveLength(1);
    expect(test.store.creates).toBe(1);
  } finally {
    clock.mockRestore();
    fault.mockRestore();
  }
}
it.each(['race', 'lost-reply'])(
  'recovers one private consent after %s beyond transport deduplication', recoversConsentStart);

async function checksAfterConsentWait(point: 'prepare' | 'read' | 'append' | 'readback',
  change: string) {
  const test = await consentStartFixture();
  async function changeNow() {
    if (change === 'failure') {
      throw new Error(material);
    }
    if (change === 'expiry') {
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 600_001);
      return;
    }
    await changeConsentAccess(test, change);
  }
  if (point === 'prepare') {
    const prepare = test.custody.prepareAttempt.bind(test.custody);
    async function delayedPrepare(...args: Parameters<typeof prepare>) {
      const result = await prepare(...args);
      await changeNow();
      return result;
    }
    test.custody.prepareAttempt = delayedPrepare;
  } else if (point === 'read') {
    const read = test.custody.readAttempt.bind(test.custody);
    let reads = 0;
    async function delayedRead(...args: Parameters<typeof read>) {
      const result = await read(...args);
      reads += 1;
      if (reads === 2) {
        await changeNow();
      }
      return result;
    }
    test.custody.readAttempt = delayedRead;
  } else if (point === 'append') {
    const append = events.store.append.bind(events.store);
    async function delayedAppend(command: AppendCommand) {
      vi.restoreAllMocks();
      await changeNow();
      return append(command);
    }
    vi.spyOn(events.store, 'append').mockImplementationOnce(delayedAppend);
  } else {
    const read = events.store.readStream.bind(events.store);
    async function* failedRead(subject: string, from?: number, deadline?: number) {
      if (subject === test.subject && (from ?? 0) > 1) {
        await changeNow();
      }
      yield* read(subject, from, deadline);
    }
    vi.spyOn(events.store, 'readStream').mockImplementation(failedRead);
  }
  try {
    expect(await test.start()).toEqual({ status: 'unknown' });
  } finally {
    vi.restoreAllMocks();
  }
  const rows = await history(events.store, test.subject, 'test');
  if (point === 'prepare' || point === 'append') {
    expect(rows).toHaveLength(0);
  }
  expect(JSON.stringify(rows)).not.toContain(material);
}
const consentWaits = [
  ['prepare', 'removed'], ['prepare', 'rejoined'], ['prepare', 'disabled'],
  ['prepare', 'policy'], ['prepare', 'configuration'], ['prepare', 'expiry'],
  ['prepare', 'failure'], ['append', 'disabled'], ['append', 'failure'],
  ['append', 'removed'], ['append', 'policy'],
  ['readback', 'failure'], ['read', 'failure'], ['read', 'expiry'], ['read', 'removed'],
  ['read', 'rejoined'], ['read', 'disabled'], ['read', 'configuration'],
  ['read', 'policy'], ['read', 'profile'],
] as const;
it.each(consentWaits)('refuses private consent after %s waits across %s', checksAfterConsentWait);

async function accessChangesDuringConfiguration(readNumber: number, change: string) {
  const test = await consentStartFixture();
  let reads = 0;
  async function delayedConfiguration() {
    reads += 1;
    if (reads === readNumber) {
      await changeConsentAccess(test, change);
    }
    return test.configuration;
  }
  test.loader.loadConfiguration = delayedConfiguration;
  expect(await test.start()).toEqual({ status: 'unknown' });
  const rows = await history(events.store, test.subject, 'test');
  expect(rows).toHaveLength(readNumber === 2 ? 0 : 1);
}
const consentConfigurationWaits = [
  [2, 'policy'], [3, 'policy'], [2, 'removed'], [3, 'removed'],
  [2, 'disabled'], [3, 'disabled'],
] as const;
it.each(consentConfigurationWaits)(
  'rechecks private consent after configuration read %s across %s',
  accessChangesDuringConfiguration);

async function changesDuringFinalConsentMembershipRead(change: string) {
  const test = await consentStartFixture();
  const readAttempt = test.custody.readAttempt.bind(test.custody);
  let privateReads = 0;
  async function observePrivateRead(...args: Parameters<typeof readAttempt>) {
    const contents = await readAttempt(...args);
    privateReads += 1;
    return contents;
  }
  test.custody.readAttempt = observePrivateRead;
  const head = events.store.head.bind(events.store);
  let membershipReads = 0;
  let changed = false;
  async function delayedMembershipRead(subject?: string, deadline?: number) {
    const position = await head(subject, deadline);
    if (privateReads === 2 && subject === `member-${test.session.userId}`) {
      membershipReads += 1;
      // Let the last membership read return its old position after the dependency changes.
      if (membershipReads === 3) {
        await changeConsentAccess(test, change);
        changed = true;
      }
    }
    return position;
  }
  const fault = vi.spyOn(events.store, 'head').mockImplementation(delayedMembershipRead);
  try {
    const result = await test.start();
    expect(changed).toBe(true);
    expect(result).toEqual({ status: 'unknown' });
  } finally {
    fault.mockRestore();
  }
}
it.each(['policy', 'configuration', 'profile'])(
  'withholds private consent when %s changes during the final membership read',
  changesDuringFinalConsentMembershipRead);

async function unrelatedActivityDuringConsentConfiguration() {
  const test = await consentStartFixture();
  let reads = 0;
  async function delayedConfiguration() {
    reads += 1;
    if (reads === 3) {
      const memberId = 'unrelated-consent-member';
      const joined = envelope('test', `member-${memberId}`, 'member.joined', {
        memberId, role: 'member', email: `${memberId}@example.test`, displayName: memberId,
      });
      await events.seed([joined]);
    }
    return test.configuration;
  }
  test.loader.loadConfiguration = delayedConfiguration;
  expect((await test.start()).status).toBe('started');
  expect(await history(events.store, test.subject, 'test')).toHaveLength(1);
}
it('returns private consent after unrelated activity during the final configuration read',
  unrelatedActivityDuringConsentConfiguration);

async function refusesUnconfirmedConsentRecord() {
  const test = await consentStartFixture();
  const read = events.store.readStream.bind(events.store);
  async function* changedRead(subject: string, from?: number, deadline?: number) {
    for await (const row of read(subject, from, deadline)) {
      if (subject === test.subject && (from ?? 0) > 1) {
        row.event.commandId = 'different-reference';
      }
      yield row;
    }
  }
  const fault = vi.spyOn(events.store, 'readStream').mockImplementation(changedRead);
  try {
    expect(await test.start()).toEqual({ status: 'unknown' });
  } finally {
    fault.mockRestore();
  }
  const rows = await history(events.store, test.subject, 'test');
  expect(rows).toHaveLength(1);
  expect((await test.start()).status).toBe('started');
  expect(test.store.creates).toBe(1);
}
it('withholds the private consent URL when exact readback does not match',
  refusesUnconfirmedConsentRecord);

async function preparesPrivateConsent() {
  const store = await fixture();
  const input = oauthFixture();
  const before = Date.now();
  const first = await prepareOAuthAttempt(store.custody, input.context,
    input.configuration, input.rows);
  expect(first.status).toBe('prepared');
  if (first.status !== 'prepared') {
    throw new Error('Fixture preparation failed');
  }
  expect(first.stage.appendUntil).toBeGreaterThanOrEqual(before + 600_000);
  expect(first.stage.appendUntil).toBeLessThanOrEqual(Date.now() + 600_000);
  const privateData = JSON.parse(Buffer.from(store.secret.data.token, 'base64').toString()) as unknown;
  const material = z.strictObject({ state: z.string(), verifier: z.string(), nonce: z.string() })
    .parse(privateData);
  expect(material.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  expect(material.nonce).not.toBe(material.state);
  expect(material.nonce).not.toBe(material.verifier);
  expect(JSON.stringify(first)).not.toContain(material.nonce);
  expect(material.state).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  expect(material.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  expect(material.state).not.toBe(material.verifier);
  const hash = createHash('sha256');
  hash.update(material.verifier);
  expect(first.challenge).toBe(hash.digest('base64url'));
  expect(JSON.stringify(first)).not.toContain(material.state);
  expect(JSON.stringify(first)).not.toContain(material.verifier);
  expect(await prepareOAuthAttempt(store.restart(), input.context,
    input.configuration, input.rows)).toEqual(first);
  expect(store.creates).toBe(1);
}
it('prepares one private PKCE attempt and keeps its original expiry on retry', preparesPrivateConsent);

async function requestsReviewedScopes() {
  const store = await fixture();
  const input = oauthFixture(true);
  const prepared = await prepareOAuthAttempt(store.custody, input.context,
    input.configuration, input.rows);
  expect(prepared).toMatchObject({ status: 'prepared', requestedScopes: ['openid', 'read'] });
}
it('prepares OAuth scopes for enabled reviewed tools only', requestsReviewedScopes);

async function refusesChangedConsent(field: string) {
  const store = await fixture();
  const input = oauthFixture();
  const original = await prepareOAuthAttempt(store.custody, input.context,
    input.configuration, input.rows);
  expect(original.status).toBe('prepared');
  const changed: Record<string, unknown> = { ...input.configuration };
  changed[field] = 'https://changed.example.test/';
  if (field === 'protocolScopes') {
    changed[field] = ['offline_access'];
  }
  if (field === 'policyRevision') {
    changed[field] = 5;
  }
  if (field === 'endpointDigest') {
    changed[field] = 'c'.repeat(64);
  }
  expect(await prepareOAuthAttempt(store.restart(), input.context, changed, input.rows))
    .toEqual({ status: 'unknown' });
  expect(store.creates).toBe(1);
}
it.each(['issuer', 'redirectUri', 'consentEndpoint', 'clientId', 'protocolScopes',
  'policyRevision', 'endpointDigest', 'serverId', 'connectionId'])(
  'refuses changed OAuth configuration %s for the same operation', refusesChangedConsent);

async function refusesChangedSession() {
  const store = await fixture();
  const input = oauthFixture();
  await prepareOAuthAttempt(store.custody, input.context, input.configuration, input.rows);
  const changed = { ...input.context, sessionDigest: 'c'.repeat(64) };
  expect(await prepareOAuthAttempt(store.restart(), changed, input.configuration, input.rows))
    .toEqual({ status: 'unknown' });
  expect(store.creates).toBe(1);
}
it('refuses a changed OAuth session binding without replacing its private material',
  refusesChangedSession);

async function refusesUnsafeConsent(value: string) {
  for (const field of ['issuer', 'consentEndpoint', 'redirectUri']) {
    const store = await fixture();
    const input = oauthFixture();
    const configuration = { ...input.configuration, [field]: value };
    expect(await prepareOAuthAttempt(store.custody, input.context, configuration, input.rows))
      .toEqual({ status: 'unknown' });
    expect(store.creates).toBe(0);
  }
}
it.each(['http://example.test/', 'https://user:synthetic-canary@example.test/',
  'https://127.0.0.1/', 'https://example.test/#fragment', 'https://example.test/?state=canary',
  'https://example.test/../callback', 'https://example.test/\\callback'])(
  'refuses an unsafe OAuth destination %s before staging', refusesUnsafeConsent);

async function losesConsentReply(ambiguous: boolean) {
  const store = await fixture();
  const input = oauthFixture();
  if (ambiguous) {
    store.loseCreate();
  }
  store.failReads();
  expect(await prepareOAuthAttempt(store.custody, input.context, input.configuration, input.rows))
    .toEqual({ status: 'unknown' });
  const original = structuredClone(store.secret);
  store.restoreReads();
  const retry = await prepareOAuthAttempt(store.restart(), input.context,
    input.configuration, input.rows);
  expect(retry.status).toBe(ambiguous ? 'unknown' : 'prepared');
  expect(store.secret).toEqual(original);
  expect(store.creates).toBe(1);
}
it.each([false, true])('recovers OAuth replies only with a pinned identity (ambiguous: %s)',
  losesConsentReply);

async function refusesDamagedConsent(change: string) {
  const store = await fixture();
  const input = oauthFixture();
  const prepared = await prepareOAuthAttempt(store.custody, input.context,
    input.configuration, input.rows);
  if (prepared.status !== 'prepared') {
    throw new Error('Fixture preparation failed');
  }
  if (change === 'uid') {
    store.secret.metadata.uid = 'replacement';
  }
  if (change === 'version') {
    store.secret.metadata.resourceVersion = '2';
  }
  if (change === 'missing') {
    store.finishDeletion();
  }
  if (change === 'outage') {
    store.failReads();
  }
  if (change === 'material') {
    store.secret.data.token = Buffer.from(material).toString('base64');
  }
  expect(await store.restart().readAttempt(prepared.stage, prepared.identity)).toBeUndefined();
  expect(await prepareOAuthAttempt(store.restart(), input.context, input.configuration, input.rows))
    .toEqual({ status: 'unknown' });
  expect(store.creates).toBe(1);
  expect(store.deletes).toBe(0);
}
it.each(['uid', 'version', 'missing', 'outage', 'material'])(
  'keeps damaged OAuth custody unknown: %s', refusesDamagedConsent);

async function concurrentConsent() {
  const store = await fixture();
  const input = oauthFixture();
  const pending = [prepareOAuthAttempt(store.custody, input.context, input.configuration, input.rows),
    prepareOAuthAttempt(store.restart(), input.context, input.configuration, input.rows)];
  await Promise.all(pending);
  const first = await prepareOAuthAttempt(store.restart(), input.context,
    input.configuration, input.rows);
  expect(first.status).toBe('prepared');
  expect(await prepareOAuthAttempt(store.restart(), input.context, input.configuration, input.rows))
    .toEqual(first);
  expect(store.creates).toBe(1);
}
it('recovers concurrent OAuth preparation as one immutable attempt', concurrentConsent);

async function retainsConsentAlongsideBearer() {
  const test = await candidateFixture();
  await test.activate();
  const input = oauthFixture();
  input.context.siloId = test.input.siloId;
  input.context.profileId = test.input.profileId;
  for (const row of input.rows) {
    row.event.silo = test.input.siloId;
  }
  const prepared = await prepareOAuthAttempt(test.store.custody, input.context,
    input.configuration, input.rows);
  if (prepared.status !== 'prepared') {
    throw new Error('Fixture preparation failed');
  }
  expect(test.store.secrets.size).toBe(2);
  expect(await test.reconcile()).toEqual({ status: 'retained' });
  const result = await reconcileConnectionStage(events.store, test.db,
    test.store.restart(), prepared.stage);
  expect(result).toEqual({ status: 'retained' });
  const rows = await history(events.store, test.subject, 'test');
  expect(rows).toHaveLength(1);
  expect(foldConnection(rows).status).toBe('saved_unverified');
  const changed = { ...prepared.stage, operationId: 'different-operation' };
  expect(await test.store.restart().readAttempt(changed, prepared.identity)).toBeUndefined();
  expect(await test.store.restart().readAttempt(test.input, prepared.identity)).toBeUndefined();
  expect(test.store.deletes).toBe(0);
}
it('retains pending OAuth custody beside the current bearer without changing its fold',
  retainsConsentAlongsideBearer);

async function loadsPrivateAttemptAfterRestart() {
  const store = await fixture();
  const input = oauthFixture();
  const config = { apiUrl: store.apiUrl, namespace: 'custody', journalDirectory: store.directory,
    currentKeyId: 'fixture', keys: { fixture: keyring.keys.fixture.toString('base64') } };
  const filename = `${store.directory}/configuration.json`;
  await writeFile(filename, JSON.stringify(config), { mode: 0o600 });
  const loaded = await connectionCustodyFromFile(filename);
  if (!loaded) {
    throw new Error('Fixture configuration failed');
  }
  const prepared = await prepareOAuthAttempt(loaded, input.context, input.configuration, input.rows);
  if (prepared.status !== 'prepared') {
    throw new Error('Fixture preparation failed');
  }
  const contents = await loaded.readAttempt(prepared.stage, prepared.identity);
  expect(contents).toBeDefined();
  const later = prepared.stage.appendUntil - 1;
  const clock = vi.spyOn(Date, 'now').mockReturnValue(later);
  try {
    expect(await store.restart().readAttempt(prepared.stage, prepared.identity)).toBe(contents);
    clock.mockReturnValue(prepared.stage.appendUntil);
    expect(await store.restart().readAttempt(prepared.stage, prepared.identity)).toBeUndefined();
    const pending = await reconcileConnectionStage(events.store, pgDb(storage.queue), loaded,
      prepared.stage);
    expect(pending).toEqual({ status: 'retained' });
    expect(store.secrets.size).toBe(1);
  } finally {
    clock.mockRestore();
  }
  const filenames = await readdir(store.directory);
  for (const name of filenames) {
    expect(await readFile(`${store.directory}/${name}`, 'utf8')).not.toContain(contents!);
  }
}
it('loads OAuth custody from its private path and retains expired attempts without releasing them',
  loadsPrivateAttemptAfterRestart);

async function refusesAttemptExpiringDuringRecovery(operation: 'readAttempt' | 'prepareAttempt',
  expireOnRead: number) {
  const store = await fixture();
  const input = oauthFixture();
  const prepared = await prepareOAuthAttempt(store.custody, input.context,
    input.configuration, input.rows);
  if (prepared.status !== 'prepared') {
    throw new Error('Fixture preparation failed');
  }
  const original = structuredClone(store.secret);
  const appendUntil = prepared.stage.appendUntil;
  const clock = vi.spyOn(Date, 'now').mockReturnValue(appendUntil - 1);
  let reads = 0;
  function expireDuringRead() {
    reads += 1;
    if (reads === expireOnRead) {
      clock.mockReturnValue(appendUntil + 1);
    }
  }
  function refuseNewMaterial(): string {
    throw new Error('Retry must retain the original material');
  }
  store.onRead(expireDuringRead);
  try {
    const restarted = store.restart();
    if (operation === 'readAttempt') {
      const contents = await restarted.readAttempt(prepared.stage, prepared.identity);
      expect(contents).toBeUndefined();
    } else {
      const result = await restarted.prepareAttempt(prepared.stage, refuseNewMaterial);
      expect(result).toEqual({ status: 'unknown' });
    }
    expect(Date.now()).toBe(appendUntil + 1);
    expect(store.secret).toEqual(original);
    expect(store.creates).toBe(1);
  } finally {
    clock.mockRestore();
  }
}
it.each([
  ['readAttempt', 1], ['readAttempt', 2],
  ['prepareAttempt', 2], ['prepareAttempt', 3],
] as const)('refuses OAuth %s when custody read %s crosses expiry',
  refusesAttemptExpiringDuringRecovery);

async function refusesAttemptExpiringAfterRead() {
  const store = await fixture();
  const input = oauthFixture();
  const prepared = await prepareOAuthAttempt(store.custody, input.context,
    input.configuration, input.rows);
  if (prepared.status !== 'prepared') {
    throw new Error('Fixture preparation failed');
  }
  const original = structuredClone(store.secret);
  const expectedContents = Buffer.from(original.data.token, 'base64').toString('utf8');
  const appendUntil = prepared.stage.appendUntil;
  const clock = vi.spyOn(Date, 'now').mockReturnValue(appendUntil - 1);
  const restarted = store.restart();
  const readAttempt = restarted.readAttempt.bind(restarted);
  let returnedContents: string | undefined;
  async function expireAfterRead(...args: Parameters<typeof readAttempt>) {
    returnedContents = await readAttempt(...args);
    // Cross expiry only after the real reader has returned valid private material.
    clock.mockReturnValue(appendUntil + 1);
    return returnedContents;
  }
  function refuseNewMaterial(): string {
    throw new Error('Retry must retain the original material');
  }
  const reader = vi.spyOn(restarted, 'readAttempt').mockImplementation(expireAfterRead);
  try {
    const result = await restarted.prepareAttempt(prepared.stage, refuseNewMaterial);
    expect(returnedContents).toBe(expectedContents);
    expect(Date.now()).toBe(appendUntil + 1);
    expect(result).toEqual({ status: 'unknown' });
    expect(store.secret).toEqual(original);
    expect(store.creates).toBe(1);
    expect(store.deletes).toBe(0);
  } finally {
    reader.mockRestore();
    clock.mockRestore();
  }
}
it('refuses OAuth preparation when expiry passes after readAttempt returns valid contents',
  refusesAttemptExpiringAfterRead);


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
let consentFga: Awaited<ReturnType<typeof openfga>>;
let consentBinding: Awaited<ReturnType<typeof createStore>>;
async function startReconciliation() {
  events = await natsFixture();
  storage = await databases();
  consentFga = await openfga();
  consentBinding = await createStore(consentFga.apiUrl, 'test');
}
async function stopReconciliation() {
  await consentFga?.close();
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
  const db = waitingCleanupDatabase(pgDb(storage.queue));
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
  const database = pgDb(storage.queue);
  const test = await candidateFixture();
  await test.invalidate();
  async function stageInProgress() {
    const result = await reconcileConnectionStage(events.store, database,
      test.store.restart(), test.input);
    expect(result).toEqual({ status: 'retained' });
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
  const other = { ...test.input, purpose: 'validation' as const, operationId: 'validation',
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
  const database = pgDb(storage.queue);
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
    await expect(withConnectionStage(database, test.input, inject))
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
  let pageCompleted = Promise.withResolvers<void>();
  function info(counts: unknown, message?: unknown) {
    records.push({ counts, message });
    pageCompleted.resolve();
    pageCompleted = Promise.withResolvers<void>();
  }
  const logger = { info };
  const done = scanConnections(events.store, test.db, test.store.restart(), logger,
    'test', stop.signal, intervalMs);
  async function close() {
    stop.abort();
    expect(await done).toBeUndefined();
  }
  async function pages(count = 1) {
    // Wait for completed pages rather than a separate polling deadline under load.
    while (records.length < count) {
      await pageCompleted.promise;
    }
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
  const database = pgDb(isolated.queue);
  test.db = waitingCleanupDatabase(database);
  const event = await test.revoke();
  test.store.failDeletes(true);
  const cleanup = connectionCleanupHandler(events.store, test.db, test.store.restart(), 'test');
  const attemptDeletes: number[] = [];
  async function handle(...parameters: Parameters<typeof cleanup.handle>) {
    const before = test.store.deleteAttempts;
    try {
      await cleanup.handle(...parameters);
    } finally {
      attemptDeletes.push(test.store.deleteAttempts - before);
    }
  }
  const handler = { ...cleanup, handle };
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
    expect(attemptDeletes).toEqual([1, 1, 1, 1, 1, 1]);
    expect(test.store.deleteAttempts).toBe(6);
    const failed = await runtime.deadLetters(handler.name);
    const expectedFailedJobs = [{ state: 'failed', retryCount: 5 }];
    expect(failed).toMatchObject(expectedFailedJobs);
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

function waitingCleanupDatabase(database: Db): Db {
  function waitForCleanupLock<Result>(name: string, work: (db: Db) => Promise<Result>) {
    // Wait for the real lock so acquisition delays cannot skip the cleanup being checked.
    // Keep the production deadline covered by the separate lock contention tests.
    return database.lock!(name, work);
  }
  return { ...database, lock: waitForCleanupLock };
}

async function pagedScan(restart: boolean) {
  const test = await candidateFixture();
  for (let index = 1; index < 53; index += 1) {
    const candidate = { ...test.input, generation: index + 1, operationId: `scan-${index}` };
    const saved = await test.store.custody.stage(candidate, material);
    expect(saved.status).toBe('staged');
  }
  await test.invalidate();
  const savedRows = await history(events.store, test.subject, 'test');
  expect(savedRows).toHaveLength(1);
  expect(savedRows[0]!.event.type).toBe('connection.revoked');
  async function* savedHistory(subject: string, fromSequence = 1) {
    expect(subject).toBe(test.subject);
    const rows = await Promise.resolve(savedRows);
    for (const row of rows) {
      if (row.sequence >= fromSequence) {
        yield structuredClone(row);
      }
    }
  }
  const names = [...test.store.secrets.keys()];
  expect(names).toHaveLength(53);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  async function pauseSecondPage() {
    if (test.store.listings.length === 2 && restart) {
      entered.resolve();
      await release.promise;
    }
  }
  test.store.onList(pauseSecondPage);
  // Keep history fixed so this test checks paging rather than live read deadlines.
  const reading = vi.spyOn(events.store, 'readStream');
  reading.mockImplementation(savedHistory);
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
        await resumed.pages();
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
    try {
      await scan.close();
    } finally {
      reading.mockRestore();
    }
  }
  const listedNames = [...test.store.listedNames];
  listedNames.sort();
  names.sort();
  expect(listedNames).toEqual(names);
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

async function withSlowConnections(work: () => Promise<void>, count = 2) {
  const realNow = performance.now.bind(performance);
  let elapsed = 0;
  let slowConnections = 0;
  function now() {
    return realNow() + elapsed;
  }
  function acquired() {
    if (slowConnections < count) {
      // Model connections arriving after the production acquisition deadline.
      // Advance the clock instead of sleeping or depending on machine load.
      elapsed += 101;
      slowConnections += 1;
    }
  }
  const clock = vi.spyOn(performance, 'now');
  clock.mockImplementation(now);
  storage.queue.on('acquire', acquired);
  try {
    await work();
    expect(slowConnections).toBe(count);
  } finally {
    storage.queue.off('acquire', acquired);
    clock.mockRestore();
  }
}
async function pagedScanWithSlowConnections() {
  async function scan() {
    await pagedScan(false);
  }
  await withSlowConnections(scan);
}
it('scan examines all 53 candidates once after two slow database connections',
  pagedScanWithSlowConnections);

async function closesWithSlowConnection() {
  await withSlowConnections(closesUnknownAppend, 1);
}
it('closes an expired idle stage after a slow database connection', closesWithSlowConnection);

async function pagedScanWithUnavailableReads() {
  const readStream = events.store.readStream.bind(events.store);
  let reads = 0;
  async function* interrupted(...parameters: Parameters<typeof readStream>) {
    reads += 1;
    if (reads === 2 || reads === 3) {
      throw new Error('Synthetic event history unavailable');
    }
    yield* readStream(...parameters);
  }
  const reading = vi.spyOn(events.store, 'readStream');
  reading.mockImplementation(interrupted);
  try {
    await pagedScan(false);
    expect(reads).toBe(1);
  } finally {
    reading.mockRestore();
  }
}
it('loads saved history before checking paging through every candidate',
  pagedScanWithUnavailableReads);

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


function refreshLifetime(mode: string) {
  if (mode === 'renewable') {
    return 120;
  }
  if (mode === 'short') {
    return 1;
  }
  if (mode === 'lifetime') {
    return 86_401;
  }
  return 300;
}

async function exchangeFixture(mode = 'valid', signed = false, lifetime = 3600) {
  let identityVerification: IdentityVerification | undefined;
  const keys = await generateKeyPair('RS256');
  if (signed) {
    identityVerification = { algorithm: 'RS256', publicKey: await exportSPKI(keys.publicKey) };
  }
  const test = await callbackFixture(identityVerification);
  const claim = await test.callback();
  const custody = test.store.restart();
  let sends = 0;
  let refreshSends = 0;
  const revocations: URLSearchParams[] = [];
  const liveTokens = new Set(['result-canary', 'refresh-canary']);
  function tokenIsValid(token: string) {
    return liveTokens.has(token);
  }
  let loseRevocation = false;
  function loseRevokeReply() {
    loseRevocation = true;
  }
  let refreshMode = 'valid';
  function setRefreshMode(value: string) {
    refreshMode = value;
  }
  async function refreshResponse(parameters: URLSearchParams, response: ServerResponse) {
    refreshSends++;
    response.setHeader('content-type', 'application/json');
    expect(Object.fromEntries(parameters)).toEqual({ grant_type: 'refresh_token',
      client_id: test.configuration.clientId,
      refresh_token: refreshMode === 'next' ? 'next-refresh-canary' : 'refresh-canary' });
    await beforeReply?.();
    if (refreshMode === 'lost') {
      response.destroy();
      return;
    }
    if (refreshMode === 'revoked' || !tokenIsValid(parameters.get('refresh_token')!)) {
      response.end(JSON.stringify({ error: 'invalid_grant' }));
      return;
    }
    const now = Math.floor(Date.now() / 1000);
    const audience = refreshMode === 'audience' ? 'another-client' : test.configuration.clientId;
    const subject = refreshMode === 'account' ? 'another-account' : 'account-123';
    const claims = { iss: test.configuration.issuer, aud: audience, sub: subject, iat: now,
      exp: refreshMode === 'expired' ? now - 1 : now + 300 };
    const signedClaims = new SignJWT(claims);
    signedClaims.setProtectedHeader({ alg: 'RS256' });
    const idToken = await signedClaims.sign(keys.privateKey);
    let refreshToken = 'next-refresh-canary';
    if (refreshMode === 'unrotated') {
      refreshToken = 'refresh-canary';
    } else if (refreshMode === 'next') {
      refreshToken = 'third-refresh-canary';
    }
    const reply = { access_token: 'next-access-canary', token_type: 'Bearer',
      refresh_token: refreshToken,
      id_token: idToken, scope: refreshMode === 'scopes' ? 'write' : 'read',
      expires_in: refreshLifetime(refreshMode) };
    liveTokens.delete(parameters.get('refresh_token')!);
    liveTokens.add(refreshToken);
    liveTokens.add(reply.access_token);
    response.end(JSON.stringify(reply));
  }
  let beforeReply: (() => Promise<void>) | undefined;
  let responseText = ' {"access_token":"result-canary","token_type":"Bearer"}\n';
  if (signed && mode !== 'missing') {
    const consentUrl = new URL(test.started.consentUrl);
    const nonce = consentUrl.searchParams.get('nonce');
    const claims = { iss: test.configuration.issuer, aud: test.configuration.clientId,
      sub: 'account-123', nonce, name: 'provider-name-canary' };
    const signedClaims = new SignJWT(claims);
    signedClaims.setProtectedHeader({ alg: 'RS256' });
    signedClaims.setIssuedAt();
    signedClaims.setExpirationTime('1m');
    const token = await signedClaims.sign(keys.privateKey);
    responseText = JSON.stringify({ access_token: 'result-canary', token_type: 'Bearer',
      id_token: token, refresh_token: mode === 'no-refresh' ? undefined : 'refresh-canary',
      name: 'provider-name-canary',
      scope: 'read', expires_in: lifetime });
  }
  async function respond(request: IncomingMessage, response: ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      if (!Buffer.isBuffer(chunk)) {
        throw new Error('Fixture request invalid');
      }
      chunks.push(chunk);
    }
    const parameters = new URLSearchParams(Buffer.concat(chunks).toString());
    if (request.url === '/revoke') {
      revocations.push(parameters);
      // Invalidate only the submitted token. Obsolete tokens are a successful no-op.
      liveTokens.delete(parameters.get('token')!);
      if (loseRevocation) {
        response.destroy();
      } else {
        response.writeHead(200).end();
      }
      return;
    }
    if (parameters.get('grant_type') === 'refresh_token') {
      await refreshResponse(parameters, response);
      return;
    }
    const hash = createHash('sha256');
    hash.update(parameters.get('code_verifier') ?? '');
    expect(hash.digest('base64url')).toBe(
      new URL(test.started.consentUrl).searchParams.get('code_challenge'));
    expect(parameters.get('code')).toBe('private-callback-canary');
    expect(request.url).toBe('/token');
    sends++;
    response.setHeader('content-type', 'application/json');
    await beforeReply?.();
    if (mode === 'crash') {
      response.destroy();
    } else if (mode === 'timeout') {
      response.writeHead(200);
      response.write('{');
    } else {
      response.end(responseText);
    }
  }
  function provider(request: IncomingMessage, response: ServerResponse) {
    void respond(request, response);
  }
  const providerFixture = await remoteFixture(false, provider);
  async function run(restarted = false, supplied = claim) {
    const live = restarted ? undefined : supplied;
    const currentCustody = restarted ? test.store.restart() : custody;
    return exchangePersonalOAuth(events.store, consentBinding, test.session, currentCustody,
      test.command, test.loader.loadConfiguration, pgDb(storage.queue), live,
      providerFixture.network);
  }
  function before(action: () => Promise<void>) {
    beforeReply = action;
  }
  return { ...test, claim, custody, run, before, responseText, providerFixture, setRefreshMode,
    revocations, loseRevokeReply, tokenIsValid,
    get refreshSends() { return refreshSends; },
    get sends() { return sends; } };
}

async function exchangesOnce() {
  const test = await exchangeFixture();
  try {
    const results = await Promise.all([test.run(), test.run()]);
    expect(results).toContainEqual(expect.objectContaining({ status: 'unconfirmed' }));
    expect(test.sends).toBe(1);
    const recovered = await test.run(true);
    expect(recovered.status).toBe('unconfirmed');
    expect(test.sends).toBe(1);
    expect(test.store.creates).toBe(3);
    expect(Buffer.from(test.store.secret.data.token, 'base64').toString()).toBe(test.responseText);
    const rows = await history(events.store, test.subject, 'test');
    expect(rows).toHaveLength(2);
    expect(foldConnection(rows).status).toBe('unavailable');
    expect(test.sends).toBe(1);
    const publicData = JSON.stringify({ results, recovered, rows });
    const canaries = ['result-canary', 'private-callback-canary'];
    for (const secret of test.store.secrets.values()) {
      const contents = Buffer.from(secret.data.token, 'base64').toString();
      const parsed = z.object({ state: z.string(), verifier: z.string() }).safeParse(JSON.parse(contents));
      if (parsed.success) {
        canaries.push(parsed.data.state, parsed.data.verifier);
      }
    }
    for (const canary of canaries) {
      expect(publicData).not.toContain(canary);
    }
  } finally {
    await test.providerFixture.close();
  }
}
it('sends one OAuth exchange concurrently and recovers its exact unconfirmed reply', exchangesOnce);

async function keepsUnknownExchange(mode: string) {
  const test = await exchangeFixture(mode);
  const claimSend = test.custody.claimSend.bind(test.custody);
  async function existingMarker(...args: Parameters<typeof claimSend>) {
    expect(await claimSend(...args)).toBe(true);
    if (mode === 'marker') {
      throw new Error('result-canary');
    }
    return claimSend(...args);
  }
  const hasMarker = mode === 'marker' || mode === 'existing';
  if (hasMarker) {
    vi.spyOn(test.custody, 'claimSend').mockImplementationOnce(existingMarker);
  }
  try {
    expect(await test.run()).toEqual({ status: 'unknown' });
    expect(await test.run(true)).toEqual({ status: 'unknown' });
    expect(test.sends).toBe(hasMarker ? 0 : 1);
    expect(test.store.creates).toBe(2);
  } finally {
    vi.restoreAllMocks();
    await test.providerFixture.close();
  }
}
it.each(['crash', 'timeout', 'marker', 'existing'])('never resends OAuth after a possible send: %s', keepsUnknownExchange);

async function refusesExchangeChange(point: string, change: string) {
  const test = await exchangeFixture();
  async function changeNow() {
    if (change === 'expiry') {
      vi.spyOn(Date, 'now').mockReturnValue(test.started.appendUntil);
    } else {
      await changeConsentAccess(test, change);
    }
  }
  if (point === 'read') {
    const read = test.custody.readAttempt.bind(test.custody);
    async function changedRead(...args: Parameters<typeof read>) {
      const result = await read(...args);
      await changeNow();
      return result;
    }
    vi.spyOn(test.custody, 'readAttempt').mockImplementationOnce(changedRead);
  } else {
    test.before(changeNow);
  }
  try {
    expect(await test.run()).toEqual({ status: 'unknown' });
    expect(test.sends).toBe(point === 'read' ? 0 : 1);
    expect(test.store.creates).toBe(2);
  } finally {
    vi.restoreAllMocks();
    await test.providerFixture.close();
  }
}
it.each([
  ['read', 'removed'], ['read', 'disabled'], ['read', 'configuration'], ['read', 'expiry'],
  ['provider', 'removed'], ['provider', 'disabled'], ['provider', 'configuration'],
  ['provider', 'expiry'],
])('refuses OAuth after %s wait changes access: %s', refusesExchangeChange);

async function damagedExchangeResult(change: string) {
  const test = await exchangeFixture();
  try {
    expect((await test.run()).status).toBe('unconfirmed');
    if (change === 'uid') {
      test.store.secret.metadata.uid = 'recreated';
    } else if (change === 'version') {
      test.store.secret.metadata.resourceVersion = '2';
    } else if (change === 'material') {
      test.store.secret.data.token = Buffer.from('{}').toString('base64');
    } else {
      test.store.secrets.delete(test.store.secret.metadata.name);
    }
    expect(await test.run(true)).toEqual({ status: 'unknown' });
    expect(test.sends).toBe(1);
  } finally {
    await test.providerFixture.close();
  }
}
it.each(['uid', 'version', 'material', 'missing'])(
  'refuses changed saved OAuth result: %s', damagedExchangeResult);

async function lostExchangeReply() {
  const test = await exchangeFixture();
  const stageResult = test.custody.stage.bind(test.custody);
  async function loseReply(...args: Parameters<typeof stageResult>): Promise<never> {
    await stageResult(...args);
    throw new Error('result-canary', { cause: new Error('private-callback-canary') });
  }
  vi.spyOn(test.custody, 'stage').mockImplementationOnce(loseReply);
  try {
    expect(await test.run()).toEqual({ status: 'unknown' });
    expect((await test.run(true)).status).toBe('unconfirmed');
    expect(test.sends).toBe(1);
  } finally {
    vi.restoreAllMocks();
    await test.providerFixture.close();
  }
}
it('recovers an exact saved OAuth response after its staging reply is lost', lostExchangeReply);

async function refusesJournalFlush(point: string) {
  const test = await exchangeFixture();
  const descriptor = await open(test.store.directory, 'r');
  function failSync() {
    return Promise.reject(new Error('result-canary'));
  }
  function hasSync(value: object | null): value is Pick<typeof descriptor, 'sync'> {
    return value !== null && 'sync' in value && typeof value.sync === 'function';
  }
  function failFlush() {
    const prototype = Reflect.getPrototypeOf(descriptor);
    if (!hasSync(prototype)) {
      throw new Error('Fixture file handle unavailable');
    }
    vi.spyOn(prototype, 'sync').mockImplementation(failSync);
    return Promise.resolve();
  }
  const claimSend = test.custody.claimSend.bind(test.custody);
  async function failSendFlush(...args: Parameters<typeof claimSend>) {
    await failFlush();
    return claimSend(...args);
  }
  if (point === 'send') {
    vi.spyOn(test.custody, 'claimSend').mockImplementationOnce(failSendFlush);
  } else {
    test.before(failFlush);
  }
  try {
    expect(await test.run()).toEqual({ status: 'unknown' });
    expect(await test.run(true)).toEqual({ status: 'unknown' });
    expect(test.sends).toBe(point === 'send' ? 0 : 1);
  } finally {
    vi.restoreAllMocks();
    await descriptor.close();
    await test.providerFixture.close();
  }
}
it.each(['send', 'result'])('refuses OAuth %s when the journal cannot flush', refusesJournalFlush);

async function refusesForeignClaimReadback() {
  const test = await callbackFixture();
  const read = events.store.readStream.bind(events.store);
  async function* foreignClaim(subject: string, from?: number, deadline?: number) {
    for await (const row of read(subject, from, deadline)) {
      if (subject === test.subject && row.event.type === 'connection.oauth_exchange_claimed') {
        const data = z.record(z.string(), z.unknown()).parse(row.event.data);
        const event = { ...row.event, data: { ...data, workerId: 'different-worker' } };
        yield { ...row, event };
      } else {
        yield row;
      }
    }
  }
  vi.spyOn(events.store, 'readStream').mockImplementation(foreignClaim);
  try {
    expect(await test.callback()).toEqual({ status: 'unknown' });
  } finally {
    vi.restoreAllMocks();
  }
}
it('refuses another OAuth worker claim during callback readback', refusesForeignClaimReadback);

async function refusesChangedExchangeMaterial(kind: string, change: string) {
  const test = await exchangeFixture();
  try {
    for (const secret of test.store.secrets.values()) {
      const contents = Buffer.from(secret.data.token, 'base64').toString();
      if (!contents.includes(`"${kind}"`)) {
        continue;
      }
      if (change === 'uid') {
        secret.metadata.uid = 'recreated';
      } else if (change === 'version') {
        secret.metadata.resourceVersion = '2';
      } else {
        secret.data.token = Buffer.from('{}').toString('base64');
      }
    }
    expect(await test.run()).toEqual({ status: 'unknown' });
    expect(test.sends).toBe(0);
  } finally {
    await test.providerFixture.close();
  }
}
it.each([
  ['code', 'uid'], ['code', 'version'], ['code', 'material'],
  ['verifier', 'uid'], ['verifier', 'version'], ['verifier', 'material'],
])('refuses changed OAuth %s custody: %s', refusesChangedExchangeMaterial);

async function refusesCopiedClaim() {
  const test = await exchangeFixture();
  try {
    const copied = structuredClone(test.claim);
    expect(await test.run(false, copied)).toEqual({ status: 'unknown' });
    expect(test.sends).toBe(0);
    expect((await test.run()).status).toBe('unconfirmed');
    expect(test.sends).toBe(1);
  } finally {
    await test.providerFixture.close();
  }
}
it('cannot turn an OAuth claim readback into live send permission', refusesCopiedClaim);


async function refusesAfterProviderLookup() {
  const test = await exchangeFixture();
  const resolve = test.providerFixture.network.resolve!;
  async function changedLookup(...args: Parameters<typeof resolve>) {
    const addresses = await resolve(...args);
    await changeConsentAccess(test, 'disabled');
    return addresses;
  }
  test.providerFixture.network.resolve = changedLookup;
  try {
    expect(await test.run()).toEqual({ status: 'unknown' });
    expect(test.sends).toBe(0);
  } finally {
    await test.providerFixture.close();
  }
}
it('rechecks OAuth permission after provider address lookup and before sending',
  refusesAfterProviderLookup);


async function verifiesSavedIdentity() {
  const test = await exchangeFixture('valid', true);
  try {
    const consentUrl = new URL(test.started.consentUrl);
    const nonce = consentUrl.searchParams.get('nonce');
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    const result = await test.run();
    expect(result).toMatchObject({ status: 'unconfirmed',
      verifiedIdentity: { issuer: test.configuration.issuer, subject: 'account-123' } });
    const stored = test.store.secret;
    const rawReply = Buffer.from(stored.data.token, 'base64');
    expect(rawReply.toString()).toBe(test.responseText);
    expect(await test.run(true)).toEqual(result);
    expect(test.sends).toBe(1);
    const rows = await history(events.store, test.subject, 'test');
    expect(rows).toHaveLength(2);
    expect(foldConnection(rows).status).toBe('unavailable');
    const exposed = JSON.stringify({ result, rows });
    for (const canary of ['result-canary', 'provider-name-canary', nonce!, test.responseText]) {
      expect(exposed).not.toContain(canary);
    }
  } finally {
    await test.providerFixture.close();
  }
}
it('verifies the exact saved OAuth reply on reload without another send or activation',
  verifiesSavedIdentity);

async function refusesMissingSavedIdentity() {
  const test = await exchangeFixture('missing', true);
  try {
    expect(await test.run()).toEqual({ status: 'unknown' });
    expect(await test.run(true)).toEqual({ status: 'unknown' });
    expect(test.sends).toBe(1);
    const rawReply = Buffer.from(test.store.secret.data.token, 'base64');
    expect(rawReply.toString()).toBe(test.responseText);
  } finally {
    await test.providerFixture.close();
  }
}
it('keeps a saved OAuth reply with missing identity private and never resends',
  refusesMissingSavedIdentity);

async function refusesFinalIdentityChange(change: string) {
  const test = await exchangeFixture('valid', true);
  const read = test.custody.readAttempt.bind(test.custody);
  let changed = false;
  async function changedRead(...args: Parameters<typeof read>) {
    if (test.store.creates !== 3 || args[0].expectedSequence === 0 || changed) {
      return read(...args);
    }
    changed = true;
    const saved = test.store.secrets.get(args[1].reference)!;
    if (change === 'uid') {
      saved.metadata.uid = 'replacement';
    } else if (change === 'version') {
      saved.metadata.resourceVersion = '2';
    } else if (change === 'dependency') {
      throw new Error('dependency-private-canary', { cause: new Error('result-canary') });
    }
    const result = await read(...args);
    if (change === 'expiry') {
      vi.spyOn(Date, 'now').mockReturnValue(test.started.appendUntil);
    } else if (change === 'key') {
      test.configuration.identityVerification!.publicKey += 'changed';
    } else if (!['uid', 'version', 'identity-expiry'].includes(change)) {
      await changeConsentAccess(test, change);
    }
    return result;
  }
  vi.spyOn(test.custody, 'readAttempt').mockImplementation(changedRead);
  const load = test.loader.loadConfiguration;
  const identityExpiredAt = Date.now() + 90_000;
  async function expireDuringAccessCheck() {
    if (changed && change === 'identity-expiry') {
      vi.spyOn(Date, 'now').mockReturnValue(identityExpiredAt);
    }
    return load();
  }
  vi.spyOn(test.loader, 'loadConfiguration').mockImplementation(expireDuringAccessCheck);
  try {
    expect(await test.run()).toEqual({ status: 'unknown' });
    expect(changed).toBe(true);
    expect(test.sends).toBe(1);
  } finally {
    vi.restoreAllMocks();
    await test.providerFixture.close();
  }
}
it.each(['removed', 'rejoined', 'disabled', 'configuration', 'key', 'expiry', 'uid',
  'version', 'dependency', 'identity-expiry'])(
  'refuses OAuth identity when final recovery changes %s', refusesFinalIdentityChange);

async function refusesChangedIdentitySession() {
  const test = await exchangeFixture('valid', true);
  try {
    const result = await test.run();
    expect(result.status).toBe('unconfirmed');
    test.session.sessionDigest = 'c'.repeat(64);
    expect(await test.run(true)).toEqual({ status: 'unknown' });
    expect(test.sends).toBe(1);
  } finally {
    await test.providerFixture.close();
  }
}
it('refuses saved OAuth identity from a changed session', refusesChangedIdentitySession);

async function confirmAccount(test: Awaited<ReturnType<typeof exchangeFixture>>,
  evidence: unknown, confirmed = true) {
  const { confirmPersonalOAuth } = await import('../src/oauth-confirmation.ts');
  return confirmPersonalOAuth(events.store, consentBinding, test.session, test.custody,
    test.command, evidence, confirmed, pgDb(storage.queue));
}

async function confirmsOneGeneration() {
  const test = await exchangeFixture('valid', true);
  try {
    const evidence = await test.run();
    expect(await confirmAccount(test, evidence, false)).toEqual({ status: 'unknown' });
    expect(await confirmAccount(test, structuredClone(evidence))).toEqual({ status: 'unknown' });
    expect(test.store.creates).toBe(3);
    const results = await Promise.all([
      confirmAccount(test, evidence), confirmAccount(test, evidence),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(results[0]).toMatchObject({ status: 'saved', generation: 1, callsAvailable: false });
    const rows = await history(events.store, test.subject, 'test');
    expect(rows).toHaveLength(3);
    const folded = foldConnection(rows);
    expect(folded.status).toBe('unavailable');
    expect(folded.data?.activation).toMatchObject({ reason: 'oauth_confirmed', generation: 1,
      account: { issuer: test.configuration.issuer, subject: 'account-123',
        scopes: ['read'], expiresAt: Date.parse(rows[1]!.event.time) + 3600_000 } });
    expect(folded.data?.secretRef).toBe(`secret:${test.store.secret.metadata.name}`);
    expect(folded.data?.activation.uid).toBe(test.store.secret.metadata.uid);
    expect(folded.data?.activation.resourceVersion).toBe(test.store.secret.metadata.resourceVersion);
    expect(Buffer.from(test.store.secret.data.token, 'base64').toString()).toBe(test.responseText);
    const stage = vi.spyOn(test.custody, 'stage');
    const reads = vi.spyOn(test.custody, 'readAttempt');
    vi.spyOn(Date, 'now').mockReturnValue(test.started.appendUntil + 1);
    expect(await confirmAccount(test, undefined)).toEqual(results[0]);
    expect(foldConnection(rows)).toEqual(folded);
    expect(stage).not.toHaveBeenCalled();
    expect(reads).not.toHaveBeenCalled();
    expect(test.sends).toBe(1);
    expect(test.store.creates).toBe(4);
    const exposed = JSON.stringify({ results, rows });
    const privateReply = z.object({ id_token: z.string() }).parse(JSON.parse(test.responseText));
    const canaries = ['result-canary', 'refresh-canary', 'provider-name-canary',
      privateReply.id_token, test.responseText];
    for (const canary of canaries) {
      const hash = createHash('sha256');
      hash.update(canary);
      const digest = hash.digest('hex');
      expect(exposed).not.toContain(canary);
      expect(exposed).not.toContain(digest);
    }
    const malformed = structuredClone(rows);
    malformed[1]!.event.type = 'connection.revoked';
    expect(foldConnection(malformed).data).toBeUndefined();
    expect(foldConnection(rows.slice(2)).data).toBeUndefined();
  } finally {
    vi.restoreAllMocks();
    await test.providerFixture.close();
  }
}
it('confirms one exact OAuth generation and recovers its receipt after consent expiry',
  confirmsOneGeneration);

async function refusesConfirmation(change: string) {
  const test = await exchangeFixture('valid', true);
  try {
    const original = await test.run();
    let evidence: unknown = original;
    if (change === 'account') {
      evidence = { ...original,
        verifiedIdentity: { issuer: test.configuration.issuer, subject: 'other-account' } };
    } else if (change === 'profile') {
      test.command.profileId = 'another-profile';
    } else if (change === 'uid') {
      test.store.secret.metadata.uid = 'replaced';
    } else if (change === 'version') {
      test.store.secret.metadata.resourceVersion = '2';
    } else if (change === 'expiry') {
      vi.spyOn(Date, 'now').mockReturnValue(test.started.appendUntil);
    } else if (change === 'key') {
      // Keep the key valid, so only the original configuration binding can refuse restart.
      test.configuration.identityVerification!.publicKey += '\n';
      expect(await test.run(true)).toEqual({ status: 'unknown' });
    } else if (change === 'stage') {
      vi.spyOn(test.custody, 'stage').mockRejectedValue(new Error('result-canary'));
    } else {
      await changeConsentAccess(test, change);
    }
    expect(await confirmAccount(test, evidence)).toEqual({ status: 'unknown' });
    const rows = await history(events.store, test.subject, 'test');
    expect(rows).toHaveLength(2);
    expect(foldConnection(rows).data).toBeUndefined();
    expect(test.sends).toBe(1);
  } finally {
    vi.restoreAllMocks();
    await test.providerFixture.close();
  }
}
it.each(['account', 'profile', 'uid', 'version', 'expiry', 'key', 'stage', 'removed',
  'rejoined', 'configuration', 'disabled'])(
  'refuses OAuth confirmation with changed %s', refusesConfirmation);

async function refusesConfirmationPublication(change: string) {
  const test = await exchangeFixture('valid', true);
  try {
    const evidence = await test.run();
    const append = events.store.append.bind(events.store);
    async function changed(command: AppendCommand) {
      fault.mockRestore();
      await changeConsentAccess(test, change);
      return append(command);
    }
    const fault = vi.spyOn(events.store, 'append').mockImplementationOnce(changed);
    expect(await confirmAccount(test, evidence)).toEqual({ status: 'unknown' });
    const rows = await history(events.store, test.subject, 'test');
    expect(rows).toHaveLength(2);
    expect(foldConnection(rows).data).toBeUndefined();
  } finally {
    vi.restoreAllMocks();
    await test.providerFixture.close();
  }
}
it.each(['removed', 'rejoined', 'configuration', 'policy', 'disabled'])(
  'refuses OAuth confirmation when %s changes at publication', refusesConfirmationPublication);

async function recoversConfirmationReply() {
  const test = await exchangeFixture('valid', true);
  try {
    const evidence = await test.run();
    const append = events.store.append.bind(events.store);
    async function loseReply(command: AppendCommand): Promise<never> {
      await append(command);
      throw new Error('result-canary');
    }
    vi.spyOn(events.store, 'append').mockImplementationOnce(loseReply);
    expect(await confirmAccount(test, evidence)).toEqual({ status: 'unknown' });
    expect(await confirmAccount(test, undefined)).toMatchObject({
      status: 'saved', generation: 1, callsAvailable: false,
    });
    expect(test.store.creates).toBe(4);
    expect(test.sends).toBe(1);
    expect(await history(events.store, test.subject, 'test')).toHaveLength(3);
  } finally {
    vi.restoreAllMocks();
    await test.providerFixture.close();
  }
}
it('recovers a lost OAuth activation reply without staging or exchanging again',
  recoversConfirmationReply);

async function refusesUnsignedAndForeignEvidence() {
  const unsigned = await exchangeFixture();
  const verified = await exchangeFixture('valid', true);
  try {
    const unsignedEvidence = await unsigned.run();
    const foreignEvidence = await verified.run();
    expect(await confirmAccount(unsigned, unsignedEvidence)).toEqual({ status: 'unknown' });
    expect(await confirmAccount(unsigned, foreignEvidence)).toEqual({ status: 'unknown' });
    expect(await history(events.store, unsigned.subject, 'test')).toHaveLength(2);
    expect(unsigned.store.creates).toBe(3);
  } finally {
    await unsigned.providerFixture.close();
    await verified.providerFixture.close();
  }
}
it('refuses unsigned and another original attempt as OAuth confirmation evidence',
  refusesUnsignedAndForeignEvidence);

async function refreshFixture(mode = 'valid') {
  const test = await exchangeFixture(mode, true, 120);
  const evidence = await test.run();
  expect((await confirmAccount(test, evidence)).status).toBe('saved');
  const rows = await history(events.store, test.subject, 'test');
  const generation = foldConnection(rows).data!;
  if (generation.activation.reason !== 'oauth_confirmed') {
    throw new Error('Fixture confirmation missing');
  }
  const input = { ...test.command, changeRef: 'refresh-first',
    expectedSequence: rows[2]!.sequence, expectedGeneration: 1 };
  const dueAt = generation.activation.account.expiresAt - 30_000;
  vi.spyOn(Date, 'now').mockReturnValue(dueAt);
  async function start(raw: unknown = input, session: unknown = test.session, restart = false) {
    const { startPersonalOAuthRefresh } = await import('../src/oauth-refresh.ts');
    const custody = restart ? test.store.restart() : test.custody;
    return startPersonalOAuthRefresh(events.store, consentBinding, session, custody,
      raw, test.loader.loadConfiguration, pgDb(storage.queue));
  }
  async function close() {
    vi.restoreAllMocks();
    await test.providerFixture.close();
  }
  return { ...test, input, start, close, generation, dueAt,
    get refreshSends() { return test.refreshSends; },
    get sends() { return test.sends; } };
}

async function refreshRaceAndRecovery(mode: string) {
  const test = await refreshFixture();
  const manager = await jetstreamManager(events.connection);
  const stream = await manager.streams.info('EVENTS');
  try {
    const append = events.store.append.bind(events.store);
    async function loseReply(command: AppendCommand): Promise<never> {
      await append(command);
      throw new Error('refresh-canary');
    }
    if (mode === 'lost-reply') {
      vi.spyOn(events.store, 'append').mockImplementationOnce(loseReply);
      expect(await test.start()).toEqual({ status: 'unknown' });
    }
    const competing = { ...test.input, changeRef: 'refresh-second' };
    const results = await Promise.all([test.start(), test.start(competing)]);
    expect(results[0]).toEqual(results[1]);
    expect(results[0]).toMatchObject({ status: 'saved', generation: 1, callsAvailable: false });
    const rows = await history(events.store, test.subject, 'test');
    expect(rows).toHaveLength(4);
    expect(rows[3]!.event.type).toBe('connection.refresh_started');
    await manager.streams.update('EVENTS', { duplicate_window: 100_000_000 });
    const probe = envelope('test', `member-probe-${test.session.userId}`, 'member.joined', {
      memberId: 'probe', email: 'probe@example.test', displayName: 'Probe', role: 'member',
    }, rows[3]!.event.id);
    await waitForDuplicateExpiry(probe, rows[3]!.sequence);
    const effects = vi.spyOn(globalThis, 'fetch');
    const rebuilt = foldConnection(structuredClone(rows));
    expect(rebuilt.data).toEqual(test.generation);
    expect(rebuilt.lastGeneration).toBe(1);
    expect(rebuilt.status).toBe('unavailable');
    expect(rebuilt.refreshAttempt?.sequence).toBe(rows[3]!.sequence);
    expect(effects).not.toHaveBeenCalled();
    const writes = vi.spyOn(events.store, 'append');
    writes.mockClear();
    expect(await test.start(test.input, test.session, true)).toEqual(results[0]);
    expect(await test.start(competing, test.session, true)).toEqual(results[0]);
    expect(writes).not.toHaveBeenCalled();
    expect(await history(events.store, test.subject, 'test')).toEqual(rows);
    expect(test.sends).toBe(1);
    expect(test.store.creates).toBe(4);
    expect(JSON.stringify({ rows, results })).not.toMatch(/result-canary|refresh-canary/);
  } finally {
    await manager.streams.update('EVENTS', { duplicate_window: stream.config.duplicate_window });
    await test.close();
  }
}
it.each(['race', 'lost-reply'])(
  'starts one OAuth refresh after %s and recovers both references beyond deduplication',
  refreshRaceAndRecovery);

async function refusesRefresh(change: string) {
  const mode = change === 'missing-material' ? 'no-refresh' : 'valid';
  const test = await refreshFixture(mode);
  try {
    const input = { ...test.input };
    const session = { ...test.session };
    if (change === 'not-due') {
      vi.spyOn(Date, 'now').mockReturnValue(test.dueAt - 60_000);
    } else if (change === 'generation') {
      input.expectedGeneration = 2;
    } else if (change === 'sequence') {
      input.expectedSequence++;
    } else if (change === 'foreign-member') {
      session.userId = 'another-member';
    } else if (change === 'foreign-silo') {
      session.siloId = 'another-silo';
    } else if (change === 'foreign-profile') {
      input.profileId = 'another-profile';
    } else if (change === 'installation') {
      input.connectionId = 'another-installation';
    } else if (change === 'uid') {
      test.store.secret.metadata.uid = 'replaced';
    } else if (change === 'version') {
      test.store.secret.metadata.resourceVersion = '2';
    } else if (change === 'verifier') {
      test.configuration.identityVerification!.publicKey += '\n';
    } else {
      await changeConsentAccess(test, change);
    }
    const result = await test.start(input, session);
    const status = change === 'not-due' ? 'not_due' : 'unknown';
    expect(result).toEqual({ status });
    expect(await history(events.store, test.subject, 'test')).toHaveLength(3);
    expect(test.sends).toBe(1);
  } finally {
    await test.close();
  }
}
it.each(['not-due', 'missing-material', 'generation', 'sequence', 'foreign-member',
  'foreign-silo', 'foreign-profile', 'installation', 'uid', 'version', 'configuration',
  'policy', 'disabled', 'removed', 'verifier'])(
  'refuses OAuth refresh with %s', refusesRefresh);

async function refusesRefreshDuringWait(point: string, change: string) {
  const test = await refreshFixture();
  try {
    async function changeAccess() {
      if (change === 'unrelated') {
        const event = envelope('test', 'member-unrelated-refresh', 'member.joined', {
          memberId: 'unrelated', email: 'other@example.test', displayName: 'Other', role: 'member',
        });
        await events.seed([event]);
      } else if (change === 'deadline') {
        vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 2001);
      } else {
        await changeConsentAccess(test, change);
      }
    }
    if (point === 'publication') {
      const append = events.store.append.bind(events.store);
      async function beforeAppend(command: AppendCommand) {
        fault.mockRestore();
        await changeAccess();
        return append(command);
      }
      const fault = vi.spyOn(events.store, 'append').mockImplementationOnce(beforeAppend);
    } else {
      const check = test.custody.hasRefreshMaterial.bind(test.custody);
      async function afterPreparation(...args: Parameters<typeof check>) {
        const result = await check(...args);
        await changeAccess();
        return result;
      }
      vi.spyOn(test.custody, 'hasRefreshMaterial').mockImplementationOnce(afterPreparation);
    }
    const result = await test.start();
    const succeeds = change === 'unrelated';
    expect(result.status).toBe(succeeds ? 'saved' : 'unknown');
    const rows = await history(events.store, test.subject, 'test');
    function isAttempt(row: StoredEvent) {
      return row.event.type === 'connection.refresh_started';
    }
    expect(rows.filter(isAttempt)).toHaveLength(succeeds ? 1 : 0);
    expect(test.sends).toBe(1);
  } finally {
    await test.close();
  }
}
const refreshWaitCases: [string, string][] = [];
for (const point of ['preparation', 'publication']) {
  for (const change of ['removed', 'policy', 'profile', 'configuration', 'disabled', 'unrelated']) {
    refreshWaitCases.push([point, change]);
  }
}
refreshWaitCases.push(['publication', 'deadline']);
it.each(refreshWaitCases)(
  'checks OAuth refresh after %s changes %s', refusesRefreshDuringWait);

async function checksRefreshReceiptBindings() {
  const test = await refreshFixture();
  try {
    const receipt = await test.start();
    expect(receipt.status).toBe('saved');
    for (const patch of [{ expectedGeneration: 2 }, { expectedSequence: 1 },
      { connectionId: 'other' }, { profileId: 'other' }, { serverId: 'other' }]) {
      expect(await test.start({ ...test.input, ...patch })).toEqual({ status: 'unknown' });
    }
    test.configuration.clientId = 'changed';
    expect(await test.start()).toEqual({ status: 'unknown' });
    expect(await history(events.store, test.subject, 'test')).toHaveLength(4);
  } finally {
    await test.close();
  }
}
it('refuses changed bindings under a saved OAuth refresh reference', checksRefreshReceiptBindings);

async function checksRefreshHistory(mode: string) {
  const test = await refreshFixture();
  try {
    const read = events.store.readStream.bind(events.store);
    let delayed = false;
    async function* changedHistory(...args: Parameters<typeof read>) {
      for await (const row of read(...args)) {
        expect(args[0]).not.toMatch(/^conversation-/u);
        if (mode === 'bearer' && args[0] === test.subject &&
            row.event.type !== 'connection.created') {
          continue;
        }
        if (args[0] === test.subject && row.event.type === 'connection.created') {
          if (mode === 'slow') {
            expect(args[2]! - performance.now()).toBeGreaterThan(2000);
            await delay(2100);
            delayed = true;
          } else {
            const altered = structuredClone(row);
            const schema = z.object({ activation: z.record(z.string(), z.unknown()) });
            const payload = schema.parse(altered.event.data);
            delete payload.activation['configurationDigest'];
            if (mode === 'bearer') {
              payload.activation['reason'] = 'bearer_create';
              payload.activation['expectedSequence'] = 0;
              delete payload.activation['account'];
            }
            altered.event.data = { ...test.generation, activation: payload.activation };
            if (mode === 'bearer') {
              expect(foldConnection([altered]).status).toBe('saved_unverified');
            }
            if (mode === 'legacy') {
              const legacy = { userId: test.generation.userId, serverId: test.generation.serverId,
                profile: test.generation.profile, secretRef: test.generation.secretRef };
              altered.event.data = legacy;
            }
            yield altered;
            continue;
          }
        }
        yield row;
      }
    }
    vi.spyOn(events.store, 'readStream').mockImplementation(changedHistory);
    const result = await test.start();
    expect(result.status).toBe(mode === 'slow' ? 'saved' : 'unknown');
    expect(delayed).toBe(mode === 'slow');
    expect(test.sends).toBe(1);
  } finally {
    await test.close();
  }
}
it.each(['slow', 'legacy', 'bearer', 'old-oauth'])(
  'checks OAuth refresh with %s profile history before its short access check', checksRefreshHistory);

async function claimRefresh(test: Awaited<ReturnType<typeof refreshFixture>>,
  input: unknown = test.input, session: unknown = test.session, restart = false,
  db: Pick<Db, 'lock'> = pgDb(storage.queue)) {
  const { claimPersonalOAuthRefresh } = await import('../src/oauth-refresh.ts');
  const custody = restart ? test.store.restart() : test.custody;
  return claimPersonalOAuthRefresh(events.store, consentBinding, session, custody,
    input, test.loader.loadConfiguration, db);
}

async function claimsRefreshOnce(mode: string) {
  const test = await refreshFixture();
  const manager = await jetstreamManager(events.connection);
  const stream = await manager.streams.info('EVENTS');
  try {
    const start = await test.start();
    const { takePersonalOAuthRefreshClaim } = await import('../src/oauth-refresh.ts');
    expect(takePersonalOAuthRefreshClaim(start)).toBeUndefined();
    const append = events.store.append.bind(events.store);
    async function loseReply(command: AppendCommand) {
      await append(command);
      if (mode === 'throw') {
        throw new Error('refresh-canary', { cause: new Error(test.responseText) });
      }
      return { status: 'unavailable' as const, cause: new Error(test.responseText) };
    }
    if (mode !== 'race') {
      vi.spyOn(events.store, 'append').mockImplementationOnce(loseReply);
    }
    const competing = { ...test.input, changeRef: 'another-refresh' };
    const results = await Promise.all([claimRefresh(test), claimRefresh(test, competing)]);
    const rows = await history(events.store, test.subject, 'test');
    expect(rows).toHaveLength(5);
    const claimed = rows[4]!;
    expect(claimed.event.type).toBe('connection.oauth_exchange_claimed');
    expect(claimed.event.data).toMatchObject({ purpose: 'refresh',
      secretRef: test.generation.secretRef, uid: test.generation.activation.uid,
      resourceVersion: test.generation.activation.resourceVersion,
      expectedSequence: rows[3]!.sequence });
    function wasClaimed(result: (typeof results)[number]) {
      return result.status === 'claimed';
    }
    const live = results.find(wasClaimed);
    expect(Boolean(live)).toBe(mode !== 'throw');
    expect(takePersonalOAuthRefreshClaim({ ...live })).toBeUndefined();
    if (live) {
      expect(await test.run(false, live)).toEqual({ status: 'unknown' });
      expect(Object.isFrozen(live)).toBe(true);
      expect(takePersonalOAuthRefreshClaim(live)).toEqual(live);
      expect(takePersonalOAuthRefreshClaim(live)).toBeUndefined();
    }
    const effects = vi.spyOn(globalThis, 'fetch');
    const rebuilt = foldConnection(structuredClone(rows));
    expect(rebuilt.data).toEqual(test.generation);
    expect(rebuilt.refreshAttempt).toEqual(rows[3]);
    expect(rebuilt.refreshClaim).toEqual(claimed);
    expect(rebuilt.status).toBe('unavailable');
    expect(effects).not.toHaveBeenCalled();
    await manager.streams.update('EVENTS', { duplicate_window: 100_000_000 });
    const probe = envelope('test', `member-claim-probe-${test.session.userId}`, 'member.joined', {
      memberId: 'probe', email: 'probe@example.test', displayName: 'Probe', role: 'member',
    }, claimed.event.id);
    await waitForDuplicateExpiry(probe, claimed.sequence);
    const writes = vi.spyOn(events.store, 'append');
    writes.mockClear();
    expect(await claimRefresh(test, test.input, test.session, true)).toEqual({ status: 'unknown' });
    expect(await test.start()).toEqual(start);
    expect(writes).not.toHaveBeenCalled();
    expect(await history(events.store, test.subject, 'test')).toEqual(rows);
    expect(test.store.creates).toBe(4);
    expect(test.sends).toBe(1);
    const publicValues = JSON.stringify({ results, rows });
    for (const canary of ['result-canary', 'refresh-canary', test.responseText]) {
      const digest = createHash('sha256');
      digest.update(canary);
      expect(publicValues).not.toContain(canary);
      expect(publicValues).not.toContain(digest.digest('hex'));
    }
  } finally {
    await manager.streams.update('EVENTS', { duplicate_window: stream.config.duplicate_window });
    await test.close();
  }
}
it.each(['race', 'lost-reply', 'throw'])(
  'claims one refresh after %s without giving restart or copies permission', claimsRefreshOnce);

async function refusesRefreshClaim(change: string) {
  const test = await refreshFixture();
  try {
    if (change !== 'no-start') {
      expect((await test.start()).status).toBe('saved');
    }
    const input = { ...test.input };
    const session = { ...test.session };
    if (change === 'generation') {
      input.expectedGeneration++;
    } else if (change === 'sequence') {
      input.expectedSequence++;
    } else if (change === 'owner') {
      session.userId = 'other';
    } else if (change === 'silo') {
      session.siloId = 'other';
    } else if (change === 'profile') {
      input.profileId = 'other';
    } else if (change === 'uid') {
      test.store.secret.metadata.uid = 'replaced';
    } else if (change === 'version') {
      test.store.secret.metadata.resourceVersion = '2';
    } else if (change !== 'no-start') {
      await changeConsentAccess(test, change);
    }
    const writes = vi.spyOn(events.store, 'append');
    expect(await claimRefresh(test, input, session)).toEqual({ status: 'unknown' });
    expect(writes).not.toHaveBeenCalled();
    expect(test.sends).toBe(1);
  } finally {
    await test.close();
  }
}
it.each(['no-start', 'generation', 'sequence', 'owner', 'silo', 'profile', 'uid', 'version',
  'configuration', 'policy', 'disabled', 'removed'])(
  'refuses refresh claim with %s', refusesRefreshClaim);

async function checksRefreshClaimWait(point: string, change: string) {
  const test = await refreshFixture();
  try {
    expect((await test.start()).status).toBe('saved');
    async function changeAccess() {
      if (change === 'expiry') {
        vi.spyOn(Date, 'now').mockReturnValue(test.dueAt + 60_001);
      } else if (change === 'unrelated') {
        const event = envelope('test', 'member-unrelated-claim', 'member.joined', {
          memberId: 'other', email: 'other@example.test', displayName: 'Other', role: 'member',
        });
        await events.seed([event]);
      } else {
        await changeConsentAccess(test, change);
      }
    }
    if (point === 'private-read' || point === 'final-read') {
      const read = test.custody.hasRefreshMaterial.bind(test.custody);
      let reads = 0;
      async function afterRead(...args: Parameters<typeof read>) {
        const result = await read(...args);
        reads++;
        if (point === 'private-read' || reads === 2) {
          await changeAccess();
        }
        return result;
      }
      vi.spyOn(test.custody, 'hasRefreshMaterial').mockImplementation(afterRead);
    } else {
      const append = events.store.append.bind(events.store);
      async function beforeAppend(command: AppendCommand) {
        fault.mockRestore();
        await changeAccess();
        return append(command);
      }
      const fault = vi.spyOn(events.store, 'append').mockImplementationOnce(beforeAppend);
    }
    const result = await claimRefresh(test);
    expect(result.status).toBe(change === 'unrelated' ? 'claimed' : 'unknown');
    const rows = await history(events.store, test.subject, 'test');
    function isRefreshClaim(row: StoredEvent) {
      return row.event.type === 'connection.oauth_exchange_claimed' &&
        z.object({ purpose: z.string() }).parse(row.event.data).purpose === 'refresh';
    }
    const saved = point === 'final-read' || change === 'unrelated';
    expect(rows.filter(isRefreshClaim)).toHaveLength(saved ? 1 : 0);
    expect(test.sends).toBe(1);
  } finally {
    await test.close();
  }
}
const refreshClaimWaitCases: [string, string][] = [];
for (const point of ['private-read', 'publication', 'final-read']) {
  for (const change of ['removed', 'policy', 'disabled', 'configuration', 'unrelated']) {
    refreshClaimWaitCases.push([point, change]);
  }
}
refreshClaimWaitCases.push(['publication', 'expiry'], ['final-read', 'expiry']);
it.each(refreshClaimWaitCases)(
  'checks refresh claim at %s after %s', checksRefreshClaimWait);

async function refusesBlockedRefreshJoin() {
  const test = await refreshFixture();
  try {
    expect((await test.start()).status).toBe('saved');
    await changeConsentAccess(test, 'disabled');
    const writes = vi.spyOn(events.store, 'append');
    expect(await test.start()).toEqual({ status: 'unknown' });
    expect(writes).not.toHaveBeenCalled();
  } finally {
    await test.close();
  }
}
it('refuses an admin block when joining a saved refresh attempt', refusesBlockedRefreshJoin);

async function checksRefreshClaimReplay() {
  const test = await refreshFixture();
  try {
    const consentRead = vi.spyOn(test.custody, 'readAttempt');
    consentRead.mockRejectedValue(new Error('expired-private-consent-canary'));
    expect((await test.start()).status).toBe('saved');
    expect((await claimRefresh(test)).status).toBe('claimed');
    expect(consentRead).not.toHaveBeenCalled();
    const rows = await history(events.store, test.subject, 'test');
    const patches = [
      { purpose: 'consent' }, { attemptId: 'f'.repeat(64) }, { userId: 'other' },
      { serverId: 'other' }, { connectionId: 'other' }, { profile: 'other' },
      { secretRef: 'secret:other' }, { uid: 'other' }, { resourceVersion: 'other' },
      { expectedSequence: rows[2]!.sequence }, { appendUntil: test.dueAt + 120_000 },
    ];
    for (const patch of patches) {
      const altered = structuredClone(rows);
      const claim = altered[4]!;
      const data = z.record(z.string(), z.unknown()).parse(claim.event.data);
      claim.event.data = { ...data, ...patch };
      expect(foldConnection(altered).data).toBeUndefined();
    }
    const envelopes = [
      { silo: 'other' }, { subject: 'connection-other' }, { id: 'other' },
      { commandId: 'other' }, { source: 'other' },
      { principal: { kind: 'human' as const, id: 'other' } },
    ];
    for (const patch of envelopes) {
      const altered = structuredClone(rows);
      altered[4]!.event = { ...altered[4]!.event, ...patch };
      expect(foldConnection(altered).data).toBeUndefined();
    }
    const repeated = [...rows, { ...rows[4]!, sequence: rows[4]!.sequence + 1 }];
    expect(foldConnection(repeated).data).toBeUndefined();
    const wrongConsent = structuredClone(rows.slice(0, 3));
    const data = z.record(z.string(), z.unknown()).parse(wrongConsent[1]!.event.data);
    wrongConsent[1]!.event.data = { ...data, purpose: 'refresh' };
    expect(foldConnection(wrongConsent).data).toBeUndefined();
    expect(test.sends).toBe(1);
  } finally {
    await test.close();
  }
}
it('retains refresh claims without rereading consent and refuses altered replay bindings',
  checksRefreshClaimReplay);

async function sendRefresh(test: Awaited<ReturnType<typeof refreshFixture>>,
  live?: unknown, restart = false, network = test.providerFixture.network) {
  const { exchangePersonalOAuthRefresh } = await import('../src/oauth-refresh-worker.ts');
  const custody = restart ? test.store.restart() : test.custody;
  return exchangePersonalOAuthRefresh(events.store, consentBinding, test.session, custody,
    test.input, test.loader.loadConfiguration, pgDb(storage.queue), live, network);
}

async function sendsClaimedRefreshOnce() {
  const test = await refreshFixture();
  try {
    await test.start();
    const claim = await claimRefresh(test);
    expect(await sendRefresh(test, { ...claim })).toEqual({ status: 'unknown' });
    expect(test.refreshSends).toBe(0);
    const results = await Promise.all([sendRefresh(test, claim), sendRefresh(test, claim)]);
    expect(results[0]).toMatchObject({ status: 'verified', callsAvailable: false });
    // Allow a recovery caller to reach the lock before the live sender has saved its reply.
    const safeResults = [results[0], { status: 'unknown' }];
    expect(safeResults).toContainEqual(results[1]);
    expect(await sendRefresh(test, undefined, true)).toEqual(results[0]);
    expect(test.refreshSends).toBe(1);
    expect(test.sends).toBe(1);
    const rows = await history(events.store, test.subject, 'test');
    expect(rows).toHaveLength(5);
    expect(foldConnection(rows).lastGeneration).toBe(1);
    const publicValues = JSON.stringify({ rows, results });
    for (const canary of ['next-access-canary', 'next-refresh-canary', 'refresh-canary']) {
      const hash = createHash('sha256');
      hash.update(canary);
      expect(publicValues).not.toContain(canary);
      expect(publicValues).not.toContain(hash.digest('hex'));
    }
  } finally {
    await test.close();
  }
}
it('sends a claimed refresh once under racing callers and recovers after restart',
  sendsClaimedRefreshOnce);

async function refusesRefreshReply(mode: string) {
  const test = await refreshFixture();
  try {
    await test.start();
    const claim = await claimRefresh(test);
    test.setRefreshMode(mode);
    expect(await sendRefresh(test, claim)).toEqual({ status: 'unknown' });
    expect(await sendRefresh(test, undefined, true)).toEqual({ status: 'unknown' });
    expect(test.refreshSends).toBe(1);
    const rows = await history(events.store, test.subject, 'test');
    expect(rows).toHaveLength(5);
    expect(foldConnection(rows).data).toEqual(test.generation);
  } finally {
    await test.close();
  }
}
it.each(['expired', 'revoked', 'audience', 'account', 'unrotated', 'scopes', 'lifetime', 'lost'])(
  'refuses a claimed refresh reply with %s without resending or replacing the account',
  refusesRefreshReply);

async function recoversLostRefreshResult() {
  const test = await refreshFixture();
  try {
    await test.start();
    const claim = await claimRefresh(test);
    const stage = test.custody.stage.bind(test.custody);
    async function loseReply(...args: Parameters<typeof stage>): Promise<never> {
      await stage(...args);
      throw new Error('next-access-canary', { cause: new Error('next-refresh-canary') });
    }
    vi.spyOn(test.custody, 'stage').mockImplementationOnce(loseReply);
    expect(await sendRefresh(test, claim)).toEqual({ status: 'unknown' });
    expect(await sendRefresh(test, undefined, true)).toMatchObject({ status: 'verified' });
    expect(test.refreshSends).toBe(1);
    expect(test.store.creates).toBe(5);
    expect(await history(events.store, test.subject, 'test')).toHaveLength(5);
  } finally {
    await test.close();
  }
}
it('recovers a claimed refresh result after losing its private save reply',
  recoversLostRefreshResult);

async function checksRefreshSendAccess(point: string, change: string) {
  const test = await refreshFixture();
  try {
    await test.start();
    const claim = await claimRefresh(test);
    const network = { ...test.providerFixture.network };
    async function changeAccess() {
      await changeConsentAccess(test, change);
    }
    if (point === 'dns') {
      const resolve = network.resolve!;
      async function changedDns(host: string) {
        const addresses = await resolve(host);
        await changeAccess();
        return addresses;
      }
      network.resolve = changedDns;
    } else if (point === 'reply') {
      test.before(changeAccess);
    } else if (point === 'result-read') {
      const read = test.custody.readAttempt.bind(test.custody);
      async function changedResult(...args: Parameters<typeof read>) {
        const result = await read(...args);
        await changeAccess();
        return result;
      }
      vi.spyOn(test.custody, 'readAttempt').mockImplementationOnce(changedResult);
    } else if (point === 'marker') {
      const claimSend = test.custody.claimSend.bind(test.custody);
      async function changedMarker(...args: Parameters<typeof claimSend>) {
        const result = await claimSend(...args);
        await changeAccess();
        return result;
      }
      vi.spyOn(test.custody, 'claimSend').mockImplementationOnce(changedMarker);
    } else {
      const read = test.custody.readRefreshMaterial.bind(test.custody);
      async function changedRead(...args: Parameters<typeof read>) {
        const result = await read(...args);
        await changeAccess();
        return result;
      }
      vi.spyOn(test.custody, 'readRefreshMaterial').mockImplementationOnce(changedRead);
    }
    expect(await sendRefresh(test, claim, false, network)).toEqual({ status: 'unknown' });
    expect(await sendRefresh(test, undefined, true)).toEqual({ status: 'unknown' });
    const sent = point === 'reply' || point === 'result-read';
    expect(test.refreshSends).toBe(sent ? 1 : 0);
    expect(await history(events.store, test.subject, 'test')).toHaveLength(5);
  } finally {
    await test.close();
  }
}
const refreshSendAccessCases: [string, string][] = [];
for (const point of ['private-read', 'marker', 'dns', 'reply', 'result-read']) {
  for (const change of ['removed', 'policy', 'disabled', 'configuration']) {
    refreshSendAccessCases.push([point, change]);
  }
}
it.each(refreshSendAccessCases)(
  'refuses a claimed refresh when %s waits for %s', checksRefreshSendAccess);

async function refusesChangedRefreshCustody(change: string) {
  const test = await refreshFixture();
  try {
    await test.start();
    const claim = await claimRefresh(test);
    const recovered = change.startsWith('result-');
    if (recovered) {
      expect((await sendRefresh(test, claim)).status).toBe('verified');
    }
    if (change.endsWith('uid')) {
      test.store.secret.metadata.uid = 'replaced';
    } else if (change.endsWith('version')) {
      test.store.secret.metadata.resourceVersion = '2';
    } else {
      vi.spyOn(Date, 'now').mockReturnValue(test.dueAt + 60_001);
    }
    expect(await sendRefresh(test, claim)).toEqual({ status: 'unknown' });
    expect(await sendRefresh(test, undefined, true)).toEqual({ status: 'unknown' });
    expect(test.refreshSends).toBe(recovered ? 1 : 0);
  } finally {
    await test.close();
  }
}
it.each(['generation-uid', 'generation-version', 'result-uid', 'result-version',
  'claim-expired', 'result-expired'])(
  'refuses a claimed refresh with changed %s', refusesChangedRefreshCustody);

async function saveRefresh(test: Awaited<ReturnType<typeof refreshFixture>>, live?: unknown,
  restart = false) {
  const { savePersonalOAuthRefresh } = await import('../src/oauth-refresh-save.ts');
  const custody = restart ? test.store.restart() : test.custody;
  return savePersonalOAuthRefresh(events.store, consentBinding, test.session, custody,
    test.input, test.loader.loadConfiguration, pgDb(storage.queue), live,
    test.providerFixture.network);
}

async function savesRefreshOnce(fault: string) {
  const test = await refreshFixture();
  try {
    await test.start();
    const claim = await claimRefresh(test);
    const append = events.store.append.bind(events.store);
    async function lostReply(command: AppendCommand): Promise<never> {
      await append(command);
      throw new Error('next-refresh-canary');
    }
    if (fault === 'append') {
      vi.spyOn(events.store, 'append').mockImplementationOnce(lostReply);
    } else if (fault === 'delete') {
      test.store.failDeletes(true);
    } else if (fault === 'stage') {
      const stage = test.custody.stage.bind(test.custody);
      async function lostStage(...args: Parameters<typeof stage>) {
        const result = await stage(...args);
        if (args[0].generation === 2) {
          throw new Error('next-refresh-canary');
        }
        return result;
      }
      vi.spyOn(test.custody, 'stage').mockImplementation(lostStage);
    }
    const results = await Promise.all([saveRefresh(test, claim), saveRefresh(test, claim)]);
    test.store.failDeletes(false);
    const saved = await saveRefresh(test, undefined, true);
    expect(saved).toMatchObject({ status: 'saved', generation: 2, callsAvailable: false });
    vi.spyOn(Date, 'now').mockReturnValue(test.dueAt + 600_000);
    expect(await saveRefresh(test, undefined, true)).toEqual(saved);
    const rows = await history(events.store, test.subject, 'test');
    expect(rows).toHaveLength(6);
    expect(rows[5]!.event.type).toBe('connection.refreshed');
    const rebuilt = foldConnection(structuredClone(rows));
    expect(rebuilt.lastGeneration).toBe(2);
    expect(rebuilt.status).toBe('unavailable');
    expect(rebuilt.data?.activation).toMatchObject({ reason: 'oauth_confirmed', generation: 2,
      account: { subject: 'account-123', scopes: ['read'] } });
    const alterations = { generation: 4, expectedSequence: 0, operationId: 'another-save',
      configurationDigest: 'f'.repeat(64), appendUntil: 1 };
    for (const [field, value] of Object.entries(alterations)) {
      const altered = structuredClone(rows);
      const data = rebuilt.data!;
      altered[5]!.event.data = { ...data, activation: { ...data.activation, [field]: value } };
      expect(foldConnection(altered).data).toBeUndefined();
    }
    expect(test.refreshSends).toBe(1);
    expect(test.store.creates).toBe(7);
    expect(test.store.secrets.has(test.generation.secretRef.slice(7))).toBe(false);
    for (const secret of test.store.secrets.values()) {
      const contents = Buffer.from(secret.data.token, 'base64').toString();
      expect(contents).not.toContain('"refresh_token":"refresh-canary"');
    }
    expect(await sendRefresh(test, claim)).toEqual({ status: 'unknown' });
    const publicValues = JSON.stringify({ rows, results, saved });
    expect(publicValues).not.toMatch(/next-access-canary|next-refresh-canary|refresh-canary/);
  } finally {
    await test.close();
  }
}
it.each(['none', 'append', 'delete', 'stage'])(
  'saves the next OAuth generation once and retires old copies after %s failure', savesRefreshOnce);

async function retiresRefreshAfterMemberRemoval() {
  const test = await refreshFixture();
  try {
    const oldCopies: string[] = [];
    for (const secret of test.store.secrets.values()) {
      const contents = Buffer.from(secret.data.token, 'base64').toString();
      if (contents.includes('"refresh_token":"refresh-canary"')) {
        oldCopies.push(secret.metadata.name);
      }
    }
    expect(oldCopies).toHaveLength(2);
    await test.start();
    const claim = await claimRefresh(test);
    const append = events.store.append.bind(events.store);
    async function lostReply(command: AppendCommand): Promise<never> {
      const result = await append(command);
      expect(result.status).toBe('appended');
      throw new Error('Fixture lost refresh save reply');
    }
    vi.spyOn(events.store, 'append').mockImplementationOnce(lostReply);
    expect(await saveRefresh(test, claim)).toEqual({ status: 'unknown' });
    const savedRows = await history(events.store, test.subject, 'test');
    expect(savedRows).toHaveLength(6);
    expect(savedRows[5]!.event.type).toBe('connection.refreshed');
    expect(foldConnection(savedRows).lastGeneration).toBe(2);
    for (const name of oldCopies) {
      expect(test.store.secrets.has(name)).toBe(true);
    }
    await changeConsentAccess(test, 'removed');
    expect(await saveRefresh(test, undefined, true)).toEqual({ status: 'unknown' });
    for (const name of oldCopies) {
      expect(test.store.secrets.has(name)).toBe(false);
    }
    expect(test.store.deletes).toBe(2);
    expect(await saveRefresh(test, undefined, true)).toEqual({ status: 'unknown' });
    expect(test.store.deletes).toBe(2);
    expect(await history(events.store, test.subject, 'test')).toEqual(savedRows);
    expect(test.store.creates).toBe(7);
    expect(test.refreshSends).toBe(1);
  } finally {
    await test.close();
  }
}
it('retires both old OAuth copies after a lost save reply and member removal',
  retiresRefreshAfterMemberRemoval);

async function refusesNewRefreshAfterMemberRemoval() {
  const test = await refreshFixture();
  try {
    await test.start();
    const claim = await claimRefresh(test);
    expect((await sendRefresh(test, claim)).status).toBe('verified');
    const originalRows = await history(events.store, test.subject, 'test');
    expect(originalRows).toHaveLength(5);
    await changeConsentAccess(test, 'removed');
    const anotherAttempt = { ...test.input, changeRef: 'removed-member-refresh' };
    expect(await test.start(anotherAttempt)).toEqual({ status: 'unknown' });
    expect(await saveRefresh(test, claim)).toEqual({ status: 'unknown' });
    expect(await saveRefresh(test, undefined, true)).toEqual({ status: 'unknown' });
    expect(await history(events.store, test.subject, 'test')).toEqual(originalRows);
    expect(test.store.creates).toBe(5);
    expect(test.store.deletes).toBe(0);
    expect(test.refreshSends).toBe(1);
  } finally {
    await test.close();
  }
}
it('refuses a new OAuth refresh start or save after member removal',
  refusesNewRefreshAfterMemberRemoval);

async function refusesRefreshSave(mode: string) {
  const test = await refreshFixture();
  try {
    await test.start();
    const claim = await claimRefresh(test);
    test.setRefreshMode(mode);
    expect(await saveRefresh(test, claim)).toEqual({ status: 'unknown' });
    expect(await saveRefresh(test, undefined, true)).toEqual({ status: 'unknown' });
    expect(await history(events.store, test.subject, 'test')).toHaveLength(5);
    expect(test.refreshSends).toBe(1);
    expect(test.store.deletes).toBe(0);
  } finally {
    await test.close();
  }
}
it.each(['expired', 'revoked', 'audience'])(
  'refuses to save an OAuth refresh reply with %s', refusesRefreshSave);

async function refusesRefreshSaveAtPublication(change: string) {
  const test = await refreshFixture();
  try {
    await test.start();
    const claim = await claimRefresh(test);
    const append = events.store.append.bind(events.store);
    async function changedAccess(command: AppendCommand) {
      fault.mockRestore();
      if (change === 'expiry') {
        vi.spyOn(Date, 'now').mockReturnValue(test.dueAt + 2000);
      } else {
        await changeConsentAccess(test, change);
      }
      return append(command);
    }
    if (change === 'expiry') {
      test.setRefreshMode('short');
    }
    const fault = vi.spyOn(events.store, 'append').mockImplementationOnce(changedAccess);
    expect(await saveRefresh(test, claim)).toEqual({ status: 'unknown' });
    expect(await history(events.store, test.subject, 'test')).toHaveLength(5);
    expect(test.store.deletes).toBe(0);
    expect(test.refreshSends).toBe(1);
  } finally {
    await test.close();
  }
}
it.each(['removed', 'policy', 'disabled', 'configuration', 'expiry'])(
  'refuses saving the OAuth refresh after %s at publication', refusesRefreshSaveAtPublication);

async function refreshesTheNextGeneration() {
  const test = await refreshFixture();
  try {
    test.setRefreshMode('renewable');
    await test.start();
    expect((await saveRefresh(test, await claimRefresh(test))).status).toBe('saved');
    const rows = await history(events.store, test.subject, 'test');
    const second = foldConnection(rows).data!;
    if (second.activation.reason !== 'oauth_confirmed') {
      throw new Error('Fixture account missing');
    }
    test.input.expectedGeneration = 2;
    test.input.expectedSequence = rows[5]!.sequence;
    test.input.changeRef = 'refresh-next';
    test.setRefreshMode('next');
    vi.spyOn(Date, 'now').mockReturnValue(second.activation.account.expiresAt - 30_000);
    expect((await test.start()).status).toBe('saved');
    const saved = await saveRefresh(test, await claimRefresh(test));
    expect(saved).toMatchObject({ status: 'saved', generation: 3 });
    expect(await saveRefresh(test, undefined, true)).toEqual(saved);
    expect(test.refreshSends).toBe(2);
    expect(test.store.secrets.has(second.secretRef.slice(7))).toBe(false);
    const final = await history(events.store, test.subject, 'test');
    expect(final).toHaveLength(9);
    expect(foldConnection(final).lastGeneration).toBe(3);
  } finally {
    await test.close();
  }
}
it('refreshes the next saved OAuth generation and retires its earlier reply',
  refreshesTheNextGeneration);

async function refusesExpiryDuringFinalRefreshCheck() {
  const test = await refreshFixture();
  try {
    await test.start();
    const claim = await claimRefresh(test);
    test.setRefreshMode('short');
    const read = test.custody.readAttempt.bind(test.custody);
    let resultRead = false;
    async function observedRead(...args: Parameters<typeof read>) {
      const result = await read(...args);
      resultRead = true;
      return result;
    }
    vi.spyOn(test.custody, 'readAttempt').mockImplementationOnce(observedRead);
    const load = test.loader.loadConfiguration.bind(test.loader);
    function delayedCheck() {
      if (resultRead) {
        vi.spyOn(Date, 'now').mockReturnValue(test.dueAt + 2000);
      }
      return load();
    }
    vi.spyOn(test.loader, 'loadConfiguration').mockImplementation(delayedCheck);
    expect(await sendRefresh(test, claim)).toEqual({ status: 'unknown' });
    expect(await sendRefresh(test, undefined, true)).toEqual({ status: 'unknown' });
    expect(test.refreshSends).toBe(1);
    expect(await history(events.store, test.subject, 'test')).toHaveLength(5);
  } finally {
    await test.close();
  }
}
it('refuses reply expiry during final access checks while the refresh claim is still valid',
  refusesExpiryDuringFinalRefreshCheck);

async function blocksRetiredPrivateReads(attempt: boolean) {
  const test = await fixture();
  const input: ConnectionStage = { ...stage, appendUntil: Date.now() + 60_000 };
  if (attempt) {
    input.attemptId = input.operationId;
    input.attemptDigest = 'a'.repeat(64);
  }
  const material = '{"refresh_token":"retired-refresh-canary"}';
  const saved = await test.custody.stage(input, material);
  expect(saved.status).toBe('staged');
  test.failDeletes(true);
  expect(await test.custody.retire(input, saved.identity!)).toEqual({ status: 'unknown' });
  const restarted = test.restart();
  expect(await restarted.readAttempt(input, saved.identity!)).toBeUndefined();
  expect(await restarted.readRefreshMaterial(input, saved.identity!)).toBeUndefined();
  expect(test.secrets.size).toBe(1);
  test.failDeletes(false);
  expect(await restarted.retire(input, saved.identity!)).toEqual({ status: 'deleted' });
  expect(test.secrets.size).toBe(0);
}
it.each([false, true])('refuses retired private reads while deletion waits, attempt=%s',
  blocksRetiredPrivateReads);

async function waitForDuplicateExpiry(probe: ReturnType<typeof envelope>, sequence: number) {
  // Wait for the broker's duplicate record to expire, not just its configured window.
  async function expired() {
    await events.seed([probe]);
    return await events.store.head(probe.subject) > sequence;
  }
  await until(expired);
}

async function revokeOAuth(test: Awaited<ReturnType<typeof refreshFixture>>,
  input: unknown = { ...test.input, changeRef: 'revoke-first' },
  actorId = test.session.userId, db = pgDb(storage.queue)) {
  const { revokePersonalOAuth } = await import('../src/oauth-revoke.ts');
  return revokePersonalOAuth(events.store, consentBinding, actorId, input, db);
}

async function revokesOAuthOnce(failure: string) {
  const test = await refreshFixture();
  try {
    const append = events.store.append.bind(events.store);
    async function loseReply(command: AppendCommand): Promise<never> {
      await append(command);
      throw new Error('refresh-canary');
    }
    if (failure === 'lost append reply') {
      vi.spyOn(events.store, 'append').mockImplementationOnce(loseReply);
      await expect(revokeOAuth(test)).rejects.toThrow(/^OAuth revoke unavailable$/u);
    }
    const competing = { ...test.input, changeRef: 'another-revoke' };
    const results = await Promise.all([revokeOAuth(test), revokeOAuth(test, competing)]);
    expect(results[0]).toEqual(results[1]);
    expect(results[0]).toMatchObject({ status: 'revoked', generation: 1, callsAvailable: false });
    vi.spyOn(Date, 'now').mockReturnValue(test.dueAt + 600_000);
    expect(await revokeOAuth(test)).toEqual(results[0]);
    const rows = await history(events.store, test.subject, 'test');
    expect(rows).toHaveLength(4);
    expect(rows[3]!.event.type).toBe('connection.revoked');
    expect(foldConnection(structuredClone(rows)).data).toBeUndefined();
    expect(await test.start()).toEqual({ status: 'unknown' });
    expect(test.refreshSends).toBe(0);
    expect(test.store.creates).toBe(4);
    expect(test.store.deletes).toBe(0);
    expect(JSON.stringify({ rows, results })).not.toMatch(/result-canary|refresh-canary/);
  } finally {
    await test.close();
  }
}
it.each(['none', 'lost append reply'])(
  'revokes one OAuth generation under competing callers after %s', revokesOAuthOnce);

async function cancelsClaimedOAuthRefresh() {
  const test = await refreshFixture();
  try {
    await test.start();
    const claim = await claimRefresh(test);
    expect(claim.status).toBe('claimed');
    const append = events.store.append.bind(events.store);
    let pending: ReturnType<typeof sendRefresh> | undefined;
    async function race(command: AppendCommand) {
      const event = z.object({ type: z.string() }).parse(command.event);
      if (event.type === 'connection.revoked') {
        pending = sendRefresh(test, claim);
      }
      return append(command);
    }
    vi.spyOn(events.store, 'append').mockImplementation(race);
    expect(await revokeOAuth(test)).toMatchObject({ status: 'revoked' });
    const { finishPersonalOAuthRevoke } = await import('../src/oauth-revoke-worker.ts');
    const input = { ...test.input, changeRef: 'revoke-first' };
    expect(await finishPersonalOAuthRevoke(events.store, 'test', test.store.restart(), input,
      test.loader.loadConfiguration, pgDb(storage.queue), test.providerFixture.network))
      .toEqual({ status: 'completed' });
    expect(test.revocations).toHaveLength(2);
    expect(test.store.secrets.size).toBe(0);
    expect(pending).toBeDefined();
    expect(await pending).toEqual({ status: 'unknown' });
    expect(await sendRefresh(test, claim)).toEqual({ status: 'unknown' });
    expect(await saveRefresh(test, claim)).toEqual({ status: 'unknown' });
    expect(test.refreshSends).toBe(0);
    const rows = await history(events.store, test.subject, 'test');
    expect(rows).toHaveLength(6);
    expect(rows[5]!.event.type).toBe('connection.revoked');
    expect(foldConnection(rows).refreshClaim).toBeUndefined();
  } finally {
    await test.close();
  }
}
it('cancels a claimed OAuth refresh waiting behind the revoke without sending',
  cancelsClaimedOAuthRefresh);

async function checksOAuthRevokeAccessOnce(outcome: string) {
  const test = await refreshFixture();
  try {
    const read = events.store.readStream.bind(events.store);
    const client = new OpenFgaClient(consentBinding);
    const check = client.check.bind(client);
    let prepared = false;
    let checks = 0;
    let denied = false;
    async function* prepare(subject: string, from?: number, deadline?: number) {
      if (subject === test.subject) {
        prepared = true;
        if (outcome === 'failed history') {
          throw new Error('refresh-canary');
        }
        if (outcome === 'missing history') {
          return;
        }
      }
      yield* read(subject, from, deadline);
    }
    async function permission(...args: Parameters<typeof check>) {
      if (args[0].relation === 'member') {
        checks += 1;
        expect(prepared).toBe(true);
        if (denied) {
          throw new Error('refresh-canary');
        }
      }
      const result = await check(...args);
      if (args[0].relation === 'member' && outcome === 'denied permission') {
        denied = true;
        return { ...result, allowed: false };
      }
      return result;
    }
    vi.spyOn(events.store, 'readStream').mockImplementation(prepare);
    vi.spyOn(OpenFgaClient.prototype, 'check').mockImplementation(permission);
    const writes = vi.spyOn(events.store, 'append');
    const input = { ...test.input };
    if (outcome === 'stale revision') {
      input.expectedSequence++;
    }
    if (outcome === 'success') {
      expect(await revokeOAuth(test, input)).toMatchObject({ status: 'revoked' });
      expect(writes).toHaveBeenCalledTimes(1);
    } else {
      const pending = revokeOAuth(test, input);
      if (outcome === 'denied permission') {
        await expect(pending).rejects.toBeInstanceOf(MemberAccessRefused);
      } else {
        await expect(pending).rejects.toThrow(/^OAuth revoke unavailable$/u);
      }
      expect(writes).not.toHaveBeenCalled();
    }
    expect(checks).toBe(1);
  } finally {
    await test.close();
  }
}
it.each(['success', 'failed history', 'missing history', 'stale revision', 'denied permission'])(
  'checks OAuth revoke access once after %s', checksOAuthRevokeAccessOnce);

async function refusesOAuthRevoke(change: string) {
  const test = await refreshFixture();
  try {
    const input = { ...test.input };
    let actorId = test.session.userId;
    let db = pgDb(storage.queue);
    if (change === 'removed' || change === 'removed with failed history') {
      await changeConsentAccess(test, 'removed');
    } else if (change === 'another member' || change === 'admin') {
      actorId = `other-${actorId}`;
      const role = change === 'admin' ? 'admin' : 'member';
      const joined = envelope('test', `member-${actorId}`, 'member.joined', {
        memberId: actorId, role, email: 'other@example.test', displayName: 'Other',
      });
      await events.seed([joined]);
      await memberAuthorisation(consentBinding).handler.handle(joined, pgDb(storage.queue));
    } else if (change === 'generation') {
      input.expectedGeneration++;
    } else if (change === 'installation') {
      input.connectionId = 'another-installation';
    } else if (change === 'reused reference') {
      input.changeRef = test.command.changeRef;
    }
    if (change === 'removed with failed history') {
      const read = events.store.readStream.bind(events.store);
      async function* unavailable(subject: string, from?: number, deadline?: number) {
        if (subject === test.subject) {
          throw new Error('refresh-canary');
        }
        yield* read(subject, from, deadline);
      }
      vi.spyOn(events.store, 'readStream').mockImplementation(unavailable);
      async function failedRelease<Result>(_name: string,
        work: (db: Db) => Promise<Result>): Promise<never> {
        await work(db);
        throw new Error('refresh-canary');
      }
      db = { ...db, lock: failedRelease };
    }
    const writes = vi.spyOn(events.store, 'append');
    const pending = revokeOAuth(test, input, actorId, db);
    const refusal = ['removed', 'removed with failed history', 'another member', 'admin'];
    if (refusal.includes(change)) {
      await expect(pending).rejects.toBeInstanceOf(MemberAccessRefused);
    } else {
      await expect(pending).rejects.toThrow(/^OAuth revoke unavailable$/u);
    }
    expect(writes).not.toHaveBeenCalled();
    expect(test.refreshSends).toBe(0);
  } finally {
    await test.close();
  }
}
it.each(['removed', 'removed with failed history', 'another member', 'admin',
  'generation', 'installation', 'reused reference'])(
  'refuses OAuth revoke for %s without exposing the account', refusesOAuthRevoke);

async function retainsOAuthForRevokeWorker() {
  const test = await refreshFixture();
  try {
    await revokeOAuth(test);
    const rows = await history(events.store, test.subject, 'test');
    const db = pgDb(storage.queue);
    const custody = test.store.restart();
    const cleanup = connectionCleanupHandler(events.store, db, custody, 'test');
    await expect(cleanup.handle(rows[3]!.event, db)).resolves.toBeUndefined();
    const scanned = await reconcileConnectionPage(events.store, db, custody, 'test');
    expect(scanned).toMatchObject({ status: 'scanned', deleted: 0 });
    expect(test.store.deletes).toBe(0);
    expect(test.store.secrets.size).toBe(4);
    await changeConsentAccess(test, 'removed');
    await expect(revokeOAuth(test)).rejects.toBeInstanceOf(MemberAccessRefused);
    expect(await history(events.store, test.subject, 'test')).toEqual(rows);
  } finally {
    await test.close();
  }
}
it('retains private OAuth copies for the separate provider revoke worker',
  retainsOAuthForRevokeWorker);

async function checksRevokePublication(change: string) {
  const test = await refreshFixture();
  try {
    const append = events.store.append.bind(events.store);
    async function beforeAppend(command: AppendCommand) {
      if (change === 'membership') {
        const removed = envelope('test', `member-${test.session.userId}`, 'member.removed', {
          memberId: test.session.userId, removedBy: 'admin',
        });
        await append({ event: removed,
          expectedSequence: await events.store.head(removed.subject) });
      } else if (change === 'deadline') {
        vi.spyOn(performance, 'now').mockReturnValue(command.deadline! + 1);
      } else {
        const activity = envelope('test', 'conversation-unrelated', 'conversation.created', {
          conversationId: 'unrelated', assistantId: 'assistant', createdBy: test.session.userId,
        });
        await append({ event: activity, expectedSequence: 0 });
      }
      return append(command);
    }
    vi.spyOn(events.store, 'append').mockImplementationOnce(beforeAppend);
    if (change === 'unrelated activity') {
      expect(await revokeOAuth(test)).toMatchObject({ status: 'revoked' });
    } else {
      await expect(revokeOAuth(test)).rejects.toThrow(/^OAuth revoke unavailable$/u);
      expect(await history(events.store, test.subject, 'test')).toHaveLength(3);
    }
  } finally {
    await test.close();
  }
}
it.each(['membership', 'deadline', 'unrelated activity'])(
  'checks OAuth revoke publication after %s', checksRevokePublication);

async function refusesChangedRevokeReadback(field: string) {
  const test = await refreshFixture();
  try {
    await revokeOAuth(test);
    const read = events.store.readStream.bind(events.store);
    async function* altered(subject: string, from?: number, deadline?: number) {
      for await (const row of read(subject, from, deadline)) {
        if (subject !== test.subject || row.event.type !== 'connection.revoked') {
          yield row;
          continue;
        }
        const changed = structuredClone(row);
        if (field === 'principal') {
          changed.event.principal = { kind: 'human', id: 'another-member' };
        } else if (field === 'payload') {
          changed.event.data = { ...connectionRevokedDataSchema.parse(row.event.data),
            expectedSequence: 0 };
        } else {
          changed.event.id = 'another-operation';
        }
        yield changed;
      }
    }
    vi.spyOn(events.store, 'readStream').mockImplementation(altered);
    const writes = vi.spyOn(events.store, 'append');
    await expect(revokeOAuth(test)).rejects.toThrow(/^OAuth revoke unavailable$/u);
    expect(writes).not.toHaveBeenCalled();
  } finally {
    await test.close();
  }
}
it.each(['principal', 'payload', 'id'])(
  'refuses OAuth revoke recovery with a changed %s', refusesChangedRevokeReadback);

async function revokesAfterOAuthRefresh(progress: string) {
  const test = await refreshFixture();
  try {
    await test.start();
    const claim = await claimRefresh(test);
    if (progress === 'saved') {
      expect(await saveRefresh(test, claim)).toMatchObject({ status: 'saved', generation: 2 });
    } else {
      expect(await sendRefresh(test, claim)).toMatchObject({ status: 'verified' });
    }
    const before = await history(events.store, test.subject, 'test');
    const input = { ...test.input, changeRef: 'revoke-after-refresh' };
    if (progress === 'saved') {
      input.expectedSequence = before.at(-1)!.sequence;
      input.expectedGeneration = 2;
      await expect(revokeOAuth(test)).rejects.toThrow(/^OAuth revoke unavailable$/u);
    }
    const result = await revokeOAuth(test, input);
    expect(result).toMatchObject({ status: 'revoked', generation: input.expectedGeneration });
    expect(await revokeOAuth(test, input)).toEqual(result);
    await saveRefresh(test, claim);
    expect(await test.start(input)).toEqual({ status: 'unknown' });
    const after = await history(events.store, test.subject, 'test');
    expect(after).toHaveLength(before.length + 1);
    expect(after.at(-1)!.event.type).toBe('connection.revoked');
    expect(test.refreshSends).toBe(1);
  } finally {
    await test.close();
  }
}
it.each(['saved', 'verified'])(
  'revokes the current OAuth generation after a refresh reply is %s', revokesAfterOAuthRefresh);


async function finishesProviderRevoke(removed: boolean) {
  const { finishPersonalOAuthRevoke } = await import('../src/oauth-revoke-worker.ts');
  const test = await refreshFixture();
  try {
    await revokeOAuth(test);
    if (removed) {
      await changeConsentAccess(test, 'removed');
      await expect(revokeOAuth(test)).rejects.toThrow(/^OAuth revoke refused$/u);
    }
    async function finish() {
      return finishPersonalOAuthRevoke(events.store, 'test', test.store.restart(), test.input,
        test.loader.loadConfiguration, pgDb(storage.queue), test.providerFixture.network);
    }
    const results = await Promise.all([finish(), finish()]);
    // Allow a busy caller to retry after the bounded profile lock wait.
    expect(results).toContainEqual({ status: 'completed' });
    expect(await finish()).toEqual({ status: 'completed' });
    expect(test.revocations).toHaveLength(2);
    expect(Object.fromEntries(test.revocations[0]!)).toEqual({ client_id: 'fixture',
      token: 'refresh-canary', token_type_hint: 'refresh_token' });
    expect(Object.fromEntries(test.revocations[1]!)).toEqual({ client_id: 'fixture',
      token: 'result-canary', token_type_hint: 'access_token' });
    expect(test.tokenIsValid('refresh-canary')).toBe(false);
    expect(test.tokenIsValid('result-canary')).toBe(false);
    expect(test.store.secrets.size).toBe(0);
    expect(await test.start()).toEqual({ status: 'unknown' });
    const rows = await history(events.store, test.subject, 'test');
    expect(rows).toHaveLength(4);
    expect(JSON.stringify({ results, rows })).not.toMatch(/canary/);
  } finally {
    await test.close();
  }
}
it.each([false, true])(
  'finishes one provider revoke under racing workers and retires every copy, removed=%s',
  finishesProviderRevoke);

async function revokesAccessOnlyAccount() {
  const test = await refreshFixture('no-refresh');
  try {
    await revokeOAuth(test);
    const { finishPersonalOAuthRevoke } = await import('../src/oauth-revoke-worker.ts');
    expect(await finishPersonalOAuthRevoke(events.store, 'test', test.custody, test.input,
      test.loader.loadConfiguration, pgDb(storage.queue), test.providerFixture.network))
      .toEqual({ status: 'completed' });
    expect(test.revocations).toHaveLength(1);
    expect(Object.fromEntries(test.revocations[0]!)).toEqual({ client_id: 'fixture',
      token: 'result-canary', token_type_hint: 'access_token' });
    expect(test.store.secrets.size).toBe(0);
  } finally {
    await test.close();
  }
}
it('revokes an access-only OAuth account at the provider and retires its copies',
  revokesAccessOnlyAccount);

async function recoversProviderRevoke(failure: string) {
  const test = await refreshFixture();
  try {
    const { finishPersonalOAuthRevoke } = await import('../src/oauth-revoke-worker.ts');
    await revokeOAuth(test);
    const lostProviderReply = failure.startsWith('provider reply');
    if (lostProviderReply) {
      test.loseRevokeReply();
      test.store.failDeletes(failure === 'provider reply and delete');
    } else if (failure === 'delete') {
      test.store.failDeletes(true);
    } else {
      const revoke = test.custody.revokeOnce.bind(test.custody);
      async function loseReply(...args: Parameters<typeof revoke>): Promise<never> {
        await revoke(...args);
        throw new Error('refresh-canary', { cause: new Error('result-canary') });
      }
      vi.spyOn(test.custody, 'revokeOnce').mockImplementationOnce(loseReply);
    }
    async function finish(custody = test.custody) {
      return finishPersonalOAuthRevoke(events.store, 'test', custody, test.input,
        test.loader.loadConfiguration, pgDb(storage.queue), test.providerFixture.network);
    }
    expect(await finish()).toEqual({ status: 'unknown' });
    await changeConsentAccess(test, 'removed');
    await expect(revokeOAuth(test)).rejects.toThrow(/^OAuth revoke refused$/u);
    const restarted = test.store.restart();
    const page = await restarted.candidates();
    expect(page.status).toBe('listed');
    for (const stage of page.stages ?? []) {
      const copy = await restarted.recover(stage);
      expect(await restarted.readAttempt(stage, copy.identity!)).toBeUndefined();
      expect(await restarted.readRefreshMaterial(stage, copy.identity!)).toBeUndefined();
    }
    test.store.failDeletes(false);
    const expected = { status: lostProviderReply ? 'unknown' : 'completed' };
    expect(await finish(restarted)).toEqual(expected);
    expect(await finish(test.store.restart())).toEqual(expected);
    expect(test.revocations).toHaveLength(lostProviderReply ? 1 : 2);
    expect(test.store.secrets.size).toBe(0);
    const rows = await history(events.store, test.subject, 'test');
    expect(rows).toHaveLength(4);
    const journal: string[] = [];
    for (const name of await readdir(test.store.directory)) {
      journal.push(await readFile(`${test.store.directory}/${name}`, 'utf8'));
    }
    expect(JSON.stringify({ rows, expected, journal })).not.toMatch(/canary/);
  } finally {
    await test.close();
  }
}
it.each(['provider reply', 'provider reply and delete', 'saved reply', 'delete'])(
  'recovers OAuth revoke after lost %s and member removal without another provider call',
  recoversProviderRevoke);

async function retiresAllOAuthGenerations(progress: string) {
  const test = await refreshFixture();
  try {
    await test.start();
    const claim = await claimRefresh(test);
    if (progress === 'saved') {
      expect(await saveRefresh(test, claim)).toMatchObject({ status: 'saved', generation: 2 });
      const rows = await history(events.store, test.subject, 'test');
      test.input.expectedSequence = rows.at(-1)!.sequence;
      test.input.expectedGeneration = 2;
    } else {
      expect(await sendRefresh(test, claim)).toMatchObject({ status: 'verified' });
    }
    const privateCopies = test.store.secrets.size;
    expect(test.tokenIsValid('refresh-canary')).toBe(false);
    expect(test.tokenIsValid('result-canary')).toBe(true);
    test.input.changeRef = 'revoke-after-refresh';
    await revokeOAuth(test, test.input);
    const { finishPersonalOAuthRevoke } = await import('../src/oauth-revoke-worker.ts');
    expect(await finishPersonalOAuthRevoke(events.store, 'test', test.store.restart(), test.input,
      test.loader.loadConfiguration, pgDb(storage.queue), test.providerFixture.network))
      .toEqual({ status: 'completed' });
    expect(test.store.secrets.size).toBe(0);
    expect(test.tokenIsValid('next-refresh-canary')).toBe(false);
    expect(test.tokenIsValid('next-access-canary')).toBe(false);
    expect(test.tokenIsValid('result-canary')).toBe(false);
    expect(privateCopies).toBe(5);
    expect(test.revocations).toHaveLength(3);
    expect(test.revocations[0]!.get('token')).toBe('next-refresh-canary');
    expect(test.revocations[1]!.get('token')).toBe('next-access-canary');
    expect(test.revocations[2]!.get('token')).toBe('result-canary');
    expect(await sendRefresh(test, claim)).toEqual({ status: 'unknown' });
    expect(test.refreshSends).toBe(1);
  } finally {
    await test.close();
  }
}
it.each(['saved', 'verified'])(
  'retires all OAuth generations and the %s refresh reply after provider revoke',
  retiresAllOAuthGenerations);

async function requiresSavedRevoke(change: string) {
  const test = await refreshFixture();
  try {
    const { finishPersonalOAuthRevoke } = await import('../src/oauth-revoke-worker.ts');
    if (change !== 'missing revoke') {
      await revokeOAuth(test);
    }
    const input = { ...test.input };
    if (change === 'wrong generation') {
      input.expectedGeneration++;
    } else if (change === 'wrong member') {
      input.userId = 'another-member';
    } else if (change === 'configuration') {
      test.configuration.revocationEndpoint = 'https://other.example.test/revoke';
    }
    expect(await finishPersonalOAuthRevoke(events.store, 'test', test.custody, input,
      test.loader.loadConfiguration, pgDb(storage.queue), test.providerFixture.network))
      .toEqual({ status: 'unknown' });
    expect(test.revocations).toHaveLength(0);
    expect(test.store.secrets.size).toBe(change === 'configuration' ? 0 : 4);
  } finally {
    await test.close();
  }
}
it.each(['missing revoke', 'wrong generation', 'wrong member', 'configuration'])(
  'refuses provider revocation for %s without disclosing private data', requiresSavedRevoke);

async function scopesRevokeRetirement(damaged: boolean) {
  const test = await refreshFixture();
  try {
    const { finishPersonalOAuthRevoke } = await import('../src/oauth-revoke-worker.ts');
    const copy = { ...stage, siloId: 'test', userId: test.session.userId,
      serverId: test.input.serverId, profileId: test.input.profileId };
    for (let index = 0; index < 26; index++) {
      const abandoned = { ...copy, operationId: `abandoned-${index}`, generation: index + 2 };
      await test.custody.stage(abandoned,
        '{"access_token":"abandoned-canary","refresh_token":"abandoned-refresh-canary"}');
    }
    if (damaged) {
      test.store.secret.data.token = Buffer.from('corrupt-canary').toString('base64');
    }
    const revoked = await revokeOAuth(test);
    const later = { ...copy, operationId: 'later-profile', generation: 28,
      expectedSequence: revoked.sequence };
    const laterCopy = await test.custody.stage(later, material);
    const foreign = await test.custody.stage(stage, material);
    expect(laterCopy.status).toBe('staged');
    expect(foreign.status).toBe('staged');
    expect(await finishPersonalOAuthRevoke(events.store, 'test', test.store.restart(), test.input,
      test.loader.loadConfiguration, pgDb(storage.queue), test.providerFixture.network))
      .toEqual({ status: damaged ? 'unknown' : 'completed' });
    expect(test.store.secrets.size).toBe(damaged ? 3 : 2);
    expect(test.store.secrets.has(laterCopy.identity!.reference)).toBe(true);
    expect(test.store.secrets.has(foreign.identity!.reference)).toBe(true);
    expect(test.revocations).toHaveLength(2);
  } finally {
    await test.close();
  }
}
it.each([false, true])(
  'retires every page without touching later or foreign copies, damaged=%s', scopesRevokeRetirement);

async function refusesUnresolvedRefreshRevoke() {
  const test = await refreshFixture();
  try {
    await test.start();
    const claim = await claimRefresh(test);
    test.setRefreshMode('lost');
    expect(await sendRefresh(test, claim)).toEqual({ status: 'unknown' });
    test.input.changeRef = 'revoke-after-lost-refresh';
    await revokeOAuth(test, test.input);
    const { finishPersonalOAuthRevoke } = await import('../src/oauth-revoke-worker.ts');
    async function finish() {
      return finishPersonalOAuthRevoke(events.store, 'test', test.store.restart(), test.input,
        test.loader.loadConfiguration, pgDb(storage.queue), test.providerFixture.network);
    }
    expect(await finish()).toEqual({ status: 'unknown' });
    expect(await finish()).toEqual({ status: 'unknown' });
    expect(test.revocations).toHaveLength(0);
    expect(test.store.secrets.size).toBe(0);
  } finally {
    await test.close();
  }
}
it('keeps provider revoke unknown when a refresh reply cannot be recovered',
  refusesUnresolvedRefreshRevoke);

async function refusesMissingUnexpiredAccess() {
  const test = await refreshFixture();
  try {
    await test.start();
    expect(await saveRefresh(test, await claimRefresh(test)))
      .toMatchObject({ status: 'saved', generation: 2 });
    for (const [name, secret] of test.store.secrets) {
      const contents = Buffer.from(secret.data.token, 'base64').toString();
      if (contents === '{"access_token":"result-canary"}') {
        test.store.secrets.delete(name);
      }
    }
    const rows = await history(events.store, test.subject, 'test');
    test.input.expectedSequence = rows.at(-1)!.sequence;
    test.input.expectedGeneration = 2;
    test.input.changeRef = 'revoke-missing-old-access';
    await revokeOAuth(test);
    const { finishPersonalOAuthRevoke } = await import('../src/oauth-revoke-worker.ts');
    expect(await finishPersonalOAuthRevoke(events.store, 'test', test.store.restart(), test.input,
      test.loader.loadConfiguration, pgDb(storage.queue), test.providerFixture.network))
      .toEqual({ status: 'unknown' });
    expect(test.revocations).toHaveLength(0);
    expect(test.tokenIsValid('result-canary')).toBe(true);
    expect(test.store.secrets.size).toBe(0);
    expect(await finishPersonalOAuthRevoke(events.store, 'test', test.store.restart(), test.input,
      test.loader.loadConfiguration, pgDb(storage.queue), test.providerFixture.network))
      .toEqual({ status: 'unknown' });
    expect(test.revocations).toHaveLength(0);
  } finally {
    await test.close();
  }
}
it('refuses revoke completion when an unexpired older access token is missing',
  refusesMissingUnexpiredAccess);

async function expiresRetainedAccess(removed: boolean) {
  const test = await refreshFixture();
  try {
    await test.start();
    expect(await saveRefresh(test, await claimRefresh(test)))
      .toMatchObject({ status: 'saved', generation: 2 });
    const rows = await history(events.store, test.subject, 'test');
    test.input.expectedSequence = rows.at(-1)!.sequence;
    test.input.expectedGeneration = 2;
    test.input.changeRef = 'revoke-after-access-expiry';
    await revokeOAuth(test);
    if (removed) {
      await changeConsentAccess(test, 'removed');
    }
    const custody = test.store.restart();
    const db = pgDb(storage.queue);
    const savedRows = await history(events.store, test.subject, 'test');
    vi.spyOn(Date, 'now').mockReturnValue(test.dueAt + 29_999);
    expect(await reconcileConnectionPage(events.store, db, custody, 'test'))
      .toMatchObject({ status: 'scanned', deleted: 0 });
    expect(test.store.secrets.size).toBe(5);
    vi.spyOn(Date, 'now').mockReturnValue(test.dueAt + 30_000);
    test.store.failDeletes(true);
    expect(await reconcileConnectionPage(events.store, db, custody, 'test'))
      .toMatchObject({ status: 'scanned', deleted: 0 });
    expect(test.store.secrets.size).toBe(5);
    test.store.failDeletes(false);
    expect(await reconcileConnectionPage(events.store, db, test.store.restart(), 'test'))
      .toMatchObject({ status: 'scanned', deleted: 1 });
    expect(test.store.secrets.size).toBe(4);
    expect(await reconcileConnectionPage(events.store, db, test.store.restart(), 'test'))
      .toMatchObject({ status: 'scanned', deleted: 0 });
    expect(test.revocations).toHaveLength(0);
    expect(await history(events.store, test.subject, 'test')).toEqual(savedRows);
    const { finishPersonalOAuthRevoke } = await import('../src/oauth-revoke-worker.ts');
    expect(await finishPersonalOAuthRevoke(events.store, 'test', test.store.restart(), test.input,
      test.loader.loadConfiguration, db, test.providerFixture.network))
      .toEqual({ status: 'completed' });
    expect(test.revocations).toHaveLength(2);
    expect(test.revocations[0]!.get('token')).toBe('next-refresh-canary');
    expect(test.revocations[1]!.get('token')).toBe('next-access-canary');
    expect(test.store.secrets.size).toBe(0);
  } finally {
    await test.close();
  }
}
it.each([false, true])(
  'automatically retires retained access at its exact expiry after restart, removed=%s',
  expiresRetainedAccess);

async function companyFixture(enable = true, accountMode = 'company') {
  const store = await fixture();
  candidateCount += 1;
  const userId = `custodian${candidateCount}`;
  const serverId = `company${candidateCount}`;
  const joined = envelope('test', `member-${userId}`, 'member.joined', {
    memberId: userId, role: 'admin', email: `${userId}@example.test`, displayName: userId,
  });
  await events.seed([joined]);
  await memberAuthorisation(consentBinding).handler.handle(joined, pgDb(storage.queue));
  const setup = oauthFixture(false, serverId);
  let registrationRevision = 0;
  for (const row of setup.rows) {
    row.event.silo = 'test';
    const data = z.record(z.string(), z.unknown()).parse(row.event.data);
    if (row.event.type === 'mcp.server_discovered' || row.event.type === 'mcp.server_reviewed') {
      row.event.data = { ...data, accountMode };
    }
    if (row.event.type === 'mcp.server_reviewed') {
      row.event.data = { ...data, accountMode,
        policyRevision: await events.store.head(row.event.subject) };
    }
    await events.seed([row.event]);
    if (row.event.type === 'mcp.server_registered') {
      registrationRevision = await events.store.head(row.event.subject);
    }
  }
  const optIn = { serverId, connectionId: 'install-a', registrationRevision,
    enabled: true, expectedSequence: 0, changeRef: 'enable' };
  let choice = { sequence: 1 };
  if (enable) {
    choice = await changeCompanyOptIn(events.store, consentBinding, userId, optIn);
  }
  const input = { serverId, connectionId: 'install-a', profileId: 'company-profile',
    registrationRevision, optInRevision: choice.sequence, changeRef: 'create',
    expectedSequence: 0, appendUntil: Date.now() + 60_000 };
  const subject = `connection-company:${serverId}:${input.profileId}`;
  const database = pgDb(storage.queue);
  function waitForLock<Result>(name: string, work: (db: Db) => Promise<Result>) {
    return database.lock!(name, work);
  }
  const db = { ...database, lock: waitForLock };
  async function save(raw: unknown = input, supplied = material, binding = consentBinding) {
    return saveCompanyBearerConnection(events.store, binding, userId,
      store.custody, raw, supplied, db);
  }
  async function rows() {
    return history(events.store, subject, 'test');
  }
  async function disable() {
    return changeCompanyOptIn(events.store, consentBinding, userId,
      { ...optIn, enabled: false, expectedSequence: choice.sequence, changeRef: 'disable' });
  }
  async function removeAdmin() {
    const removed = envelope('test', `member-${userId}`, 'member.removed', {
      memberId: userId, removedBy: 'owner',
    });
    await events.seed([removed]);
  }
  return { store, userId, input, subject, save, rows, disable, removeAdmin, db };
}
async function savesCompany() {
  const test = await companyFixture();
  const before = await events.store.head();
  const attempts = [test.save(), test.save()];
  const saved = await Promise.all(attempts);
  expect(saved[0]).toEqual(saved[1]);
  expect(saved[0]).toMatchObject({ status: 'saved_unverified', generation: 1 });
  expect(test.store.creates).toBe(1);
  expect(await events.store.head()).toBe(before + 1);
  const rows = await test.rows();
  const rebuilt = foldCompanyConnection(rows);
  expect(rebuilt).toMatchObject({ status: 'saved_unverified', data: {
    siloId: 'test', custodianId: test.userId,
    activation: { ownerKind: 'company', purpose: 'company', generation: 1 },
  } });
  expect(foldConnection(rows).status).toBe('unavailable');
  const personal = { action: 'rotate', serverId: test.input.serverId,
    connectionId: test.input.connectionId, profileId: test.input.profileId,
    changeRef: 'adopt', expectedSequence: rows[0]!.sequence, expectedGeneration: 1,
    appendUntil: test.input.appendUntil };
  await expect(saveBearerConnection(events.store, consentBinding, test.userId,
    test.store.custody, personal, material, test.db)).rejects.toThrow();
  const page = await test.store.custody.candidates();
  const candidate = page.stages![0]!;
  const stored = await test.store.custody.recover(candidate);
  expect(await test.store.custody.readRefreshMaterial(candidate, stored.identity!)).toBeUndefined();
  expect(await test.store.custody.readRevocationMaterial(candidate, stored.identity!)).toBeUndefined();
  expect(await reconcileConnectionStage(events.store, test.db, test.store.custody, candidate))
    .toEqual({ status: 'retained' });
  expect(JSON.stringify([rows, saved]).includes(material)).toBe(false);
  test.store.fail();
  expect(foldCompanyConnection(rows)).toEqual(rebuilt);
}
it('saves one silo-owned company generation without granting or selecting it', savesCompany);

async function refusesCompanyBeforeStage(kind: string) {
  const mode = kind === 'mode' ? 'personal' : 'company';
  const test = await companyFixture(kind !== 'absent', mode);
  let input: unknown = test.input;
  let binding = consentBinding;
  if (kind === 'disabled') {
    await test.disable();
  } else if (kind === 'removed') {
    await test.removeAdmin();
  } else if (kind === 'non-admin') {
    const demoted = envelope('test', `member-${test.userId}`, 'member.role_changed', {
      memberId: test.userId, previousRole: 'admin', newRole: 'member', changedBy: 'owner',
    });
    await events.seed([demoted]);
  } else if (kind === 'silo') {
    binding = { ...binding, silo: 'foreign' };
  } else if (kind !== 'absent') {
    const patches: Record<string, object> = {
      owner: { siloId: 'forged', custodianId: 'forged' }, purpose: { purpose: 'personal' },
      installation: { connectionId: 'wrong' }, server: { serverId: 'wrong' },
      registration: { registrationRevision: 1 }, stale: { optInRevision: 1 },
    };
    input = { ...test.input, ...patches[kind] };
  }
  await expect(test.save(input, material, binding)).rejects.toThrow('Company connection unavailable');
  expect(test.store.creates).toBe(0);
  expect(await test.rows()).toHaveLength(0);
}
it.each(['mode', 'absent', 'disabled', 'stale', 'non-admin', 'removed', 'silo', 'server',
  'installation', 'registration', 'purpose', 'owner'])(
  'refuses company %s before staging', refusesCompanyBeforeStage);

async function companyStageRace(kind: 'admin' | 'opt-in') {
  const test = await companyFixture();
  const stage = test.store.custody.stage.bind(test.store.custody);
  async function changeDuringStage(...args: Parameters<typeof stage>) {
    const result = await stage(...args);
    if (kind === 'admin') {
      await test.removeAdmin();
    } else {
      await test.disable();
    }
    return result;
  }
  const fault = vi.spyOn(test.store.custody, 'stage');
  fault.mockImplementationOnce(changeDuringStage);
  await expect(test.save()).rejects.toThrow('Company connection unavailable');
  expect(await test.rows()).toHaveLength(0);
  expect(test.store.creates).toBe(1);
  expect(test.store.deletes).toBe(0);
}
it.each(['admin', 'opt-in'] as const)('refuses company %s loss while staging', companyStageRace);

async function companyRecovery(kind: string) {
  const test = await companyFixture();
  const append = events.store.append.bind(events.store);
  async function loseReply(command: AppendCommand) {
    if (kind !== 'unknown') {
      await append(command);
    }
    return { status: 'unavailable' as const, cause: new Error(material) };
  }
  const fault = vi.spyOn(events.store, 'append');
  fault.mockImplementationOnce(loseReply);
  await expect(test.save()).rejects.toThrow('Company connection unavailable');
  fault.mockRestore();
  expect(test.store.creates).toBe(1);
  expect(test.store.deletes).toBe(0);
  if (kind === 'unknown') {
    expect(foldCompanyConnection(await test.rows()).status).toBe('unavailable');
    return;
  }
  if (kind === 'reply') {
    const clock = vi.spyOn(Date, 'now');
    clock.mockReturnValue(test.input.appendUntil + 1);
    try {
      const receipt = await test.save();
      expect(await test.save()).toEqual(receipt);
    } finally {
      clock.mockRestore();
    }
  } else {
    let input = test.input;
    let supplied = material;
    if (kind === 'reference') {
      input = { ...input, changeRef: 'changed' };
    }
    if (kind === 'material') {
      supplied = 'changed-material';
    }
    if (kind === 'uid') {
      test.store.secret.metadata.uid = 'replacement';
    }
    if (kind === 'version') {
      test.store.secret.metadata.resourceVersion = '2';
    }
    await expect(test.save(input, supplied)).rejects.toThrow('Company connection unavailable');
  }
  expect(await test.rows()).toHaveLength(1);
  expect(test.store.creates).toBe(1);
}
it.each(['reply', 'unknown', 'reference', 'material', 'uid', 'version'])(
  'recovers or refuses the exact company generation after %s', companyRecovery);

async function companyCommitRace() {
  const test = await companyFixture();
  const append = events.store.append.bind(events.store);
  async function changeAfterCheck(command: AppendCommand) {
    async function checkAccess() {
      await command.checkAccess!();
      await test.removeAdmin();
    }
    return append({ ...command, checkAccess });
  }
  const fault = vi.spyOn(events.store, 'append');
  fault.mockImplementationOnce(changeAfterCheck);
  try {
    await expect(test.save()).rejects.toThrow('Company connection unavailable');
  } finally {
    fault.mockRestore();
  }
  expect(await test.rows()).toHaveLength(0);
}
it('refuses company authority loss between the final check and publication', companyCommitRace);

async function companyReplayTampering(field: string) {
  const test = await companyFixture();
  await test.save();
  const rows = await test.rows();
  const row = rows[0]!;
  const data = z.record(z.string(), z.unknown()).parse(row.event.data);
  if (field === 'subject' || field === 'silo' || field === 'source') {
    row.event[field] = 'forged';
  } else {
    row.event.data = { ...data, [field]: 'forged' };
  }
  expect(foldCompanyConnection(rows).status).toBe('unavailable');
  expect(foldConnection(rows).status).toBe('unavailable');
}
it.each(['siloId', 'custodianId', 'subject', 'silo', 'source', 'userId'])(
  'refuses company replay with forged %s', companyReplayTampering);

async function companyHistoryDeadline() {
  const test = await companyFixture();
  const read = events.store.readStream.bind(events.store);
  async function* slowHistory(subject: string, from?: number, deadline?: number) {
    if (subject === test.subject) {
      expect(deadline! - performance.now()).toBeGreaterThan(8000);
      await delay(2100);
    }
    yield* read(subject, from, deadline);
  }
  const fault = vi.spyOn(events.store, 'readStream');
  fault.mockImplementation(slowHistory);
  try {
    expect(await test.save()).toMatchObject({ status: 'saved_unverified' });
  } finally {
    fault.mockRestore();
  }
}
it('loads company history before the short authority check', companyHistoryDeadline);

async function companyApprovalReuse() {
  const test = await companyFixture();
  const append = vi.spyOn(events.store, 'append');
  append.mockResolvedValueOnce({ status: 'unavailable', cause: new Error(material) });
  await expect(test.save()).rejects.toThrow('Company connection unavailable');
  append.mockRestore();
  const disabled = await test.disable();
  const choice = { serverId: test.input.serverId, connectionId: test.input.connectionId,
    registrationRevision: test.input.registrationRevision, enabled: true,
    expectedSequence: disabled.sequence, changeRef: 'enable-again' };
  const enabled = await changeCompanyOptIn(events.store, consentBinding, test.userId, choice);
  const changed = { ...test.input, optInRevision: enabled.sequence };
  await expect(test.save(changed)).rejects.toThrow('Company connection unavailable');
  expect(test.store.creates).toBe(1);
  expect(await test.rows()).toHaveLength(0);
}
it('refuses reusing a pending company operation with changed approval', companyApprovalReuse);
