import { parseEventByType, providerDispatchedSchema, type EventEnvelope } from '@opencrane/events';
import type { StoredEvent } from '@opencrane/event-store';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { resolve } from 'node:path';
import { exportPKCS8, generateKeyPair } from 'jose';
import { tokenIssuer } from '@opencrane/auth';
import { BudgetActor, startDecision, startGateway } from '@opencrane/models';
import { createLogger } from '@opencrane/observability';
import { mkdtemp, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { providerSecrets, providerSecretRef, ingestUsage } from '@opencrane/models';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { encodeSession } from '@opencrane/auth';
import { createStore, memberAuthorisation, rebuildMembers } from '@opencrane/authz';
import { databases, openfga } from '@opencrane/authz/testing';
import { event, natsFixture } from '@opencrane/event-store/testing';
import { pgDb, providers, readProviders, ProjectionRunner,
  rebuildProviderProjection } from '@opencrane/projections';
import { buildServer } from '../src/server.ts';
import { testAuthConfig } from './support/test-auth-config.ts';

const config = testAuthConfig({ expectedOrgId: 'org-acme' });
let nats: Awaited<ReturnType<typeof natsFixture>>;
let fga: Awaited<ReturnType<typeof openfga>>;
let dbs: Awaited<ReturnType<typeof databases>>;
let runner: ProjectionRunner;
let app: ReturnType<typeof buildServer>;
let secretDirectory: string;
let secrets: ReturnType<typeof providerSecrets>;
let actor: BudgetActor;
let decision: Awaited<ReturnType<typeof startDecision>>;
let gateway: Awaited<ReturnType<typeof startGateway>>;
let upstream: ReturnType<typeof createServer>;
let upstreamCount = 0;
let upstreamHeaders: string[] = [];
let upstreamAuthHash = '';
let upstreamFailure = 0;
let upstreamInvalidJson = false;
let upstreamNoAnswer = false;
let auth: ReturnType<typeof memberAuthorisation>;
async function initialise() {
  nats = await natsFixture();
  fga = await openfga();
  dbs = await databases();
  runner = new ProjectionRunner(pgDb(dbs.queue), nats.reader,
    createLogger('provider-test', { level: 'silent' }));
  await runner.initialise(providers);
  const binding = await createStore(fga.apiUrl, 'acme');
  auth = memberAuthorisation(binding);
  const joined = {
    ...event('provider-owner', 'member-owner', 'member.joined'),
    silo: 'acme', correlation: {},
    principal: { kind: 'human' as const, id: 'owner' },
    data: { memberId: 'owner', email: 'owner@example.test', displayName: 'Owner',
      role: 'owner', invitationId: 'invite-owner' },
  };
  await nats.store.append({ event: joined, expectedSequence: 0 });
  await auth.handler.handle(joined, pgDb(dbs.queue));
  function memberId(_silo: string, _issuer: string, subject: string) {
    if (subject === 'idp-owner') return Promise.resolve('owner');
    return Promise.resolve('bob');
  }
  const bob = { ...event('provider-bob', 'member-bob', 'member.joined'),
    silo: 'acme', correlation: {},
    principal: { kind: 'human' as const, id: 'owner' },
    data: { memberId: 'bob', email: 'bob@example.test',
      displayName: 'Bob', role: 'member', invitationId: 'invite-bob' } };
  await nats.store.append({ event: bob, expectedSequence: 0 });
  await auth.handler.handle(bob, pgDb(dbs.queue));
  secretDirectory = await mkdtemp(`${tmpdir()}/provider-secrets-`);
  const issuer = 'https://provider-test.invalid';
  const keyPair = await generateKeyPair('ES256', { extractable: true });
  const privateKeyPath = `${secretDirectory}/issuer.pem`;
  await writeFile(privateKeyPath, await exportPKCS8(keyPair.privateKey));
  const tokens = await tokenIssuer({ privateKeyPath, issuer });
  upstream = createServer(recordUpstream);
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const upstreamAddress = upstream.address();
  if (!upstreamAddress || typeof upstreamAddress === 'string') throw new Error('Missing upstream');
  const port = await freePort();
  const readinessPort = await freePort();
  actor = new BudgetActor(nats.store, 'acme');
  await actor.start(100, 100, 'installation-default');
  secrets = providerSecrets(secretDirectory);
  const verificationOptions = { secrets,
    gatewayUrl: `http://127.0.0.1:${port}` };
  decision = await startDecision(actor, { issuer, jwks: tokens.jwks }, binding,
    0, undefined, verificationOptions);
  await writeFile(`${secretDirectory}/legacy-key`, 'fixture-only');
  const binary = resolve('spikes/s0-1c-real-model-smoke/.tools/agentgateway-linux-amd64');
  gateway = await startGateway({ binary, port, readinessPort, decisionUrl: decision.url,
    issuer, upstream: `127.0.0.1:${upstreamAddress.port}`, keyFile: `${secretDirectory}/legacy-key`,
    configFile: `${secretDirectory}/gateway.json`, usageFile: `${secretDirectory}/usage.jsonl` });
  app = buildServer(config, { providers: {
    silo: 'acme', store: nats.store, binding, db: pgDb(dbs.queue), feed: { memberId }, secrets,
    verification: { decisionUrl: decision.url, tokens },
  } });
}
beforeAll(initialise, 120_000);
async function close() {
  await app?.close();
  await gateway?.stop();
  await decision?.close();
  if (upstream) {
    upstream.closeAllConnections();
    await new Promise<void>(closeUpstream);
  }
  await dbs?.close();
  await fga?.close();
  await nats?.close();
  if (secretDirectory) await rm(secretDirectory, { recursive: true, force: true });
}
afterAll(close);
function request(method: 'GET' | 'POST', url: string, payload?: unknown,
  sub = 'idp-owner', orgId = 'org-acme', origin = 'https://app.example.test') {
  const session = { sub, orgId, roles: ['owner'],
    authTime: 1, exp: 2000000000 };
  const headers = { origin,
    'content-type': 'application/json',
    cookie: `${config.cookieName}=${encodeSession(config, session)}` };
  const options = { method, url,
    ...(payload ? { payload: JSON.stringify(payload) } : {}), headers };
  return app.inject(options);
}
async function createsConnection() {
  const input = { action: 'create', commandId: 'create-primary', providerId: 'primary',
    provider: 'openai', name: 'Primary', expectedRevision: 0 };
  const first = await request('POST', '/api/org/providers', input);
  expect(first.statusCode).toBe(200);
  for await (const row of nats.store.readStream('provider-primary')) {
    await auth.handler.handle(row.event, pgDb(dbs.queue));
  }
  expect(first.json()).toMatchObject({ status: 'appended', providerId: 'primary', revision: 1 });
  const repeat = await request('POST', '/api/org/providers', input);
  expect(repeat.json()).toEqual(first.json());
  const status = await request('GET', '/api/org/providers/primary/changes/create-primary');
  expect(status.json()).toMatchObject({ status: 'appended', revision: 1 });
}
it('an owner creates a named connection and reconciles the original command', createsConnection);
async function savesKeyOnce() {
  const key = 'fixture-provider-key-never-in-events';
  const input = { commandId: 'save-primary', expectedRevision: 1, key };
  const saved = await request('POST', '/api/org/providers/primary/key', input);
  expect(saved.statusCode).toBe(200);
  expect(saved.json()).toMatchObject({ status: 'appended', revision: 2, clearKey: true });
  const repeat = await request('POST', '/api/org/providers/primary/key', input);
  expect(repeat.json()).toEqual(saved.json());
  const status = await request('GET', '/api/org/providers/primary/changes/save-primary');
  expect(status.json()).toMatchObject({ status: 'appended', revision: 2 });
  const rows = [];
  for await (const row of nats.store.readStream('provider-primary')) rows.push(row);
  expect(JSON.stringify(rows)).not.toContain(key);
}
it('saves the key once and clears transient input on acceptance without event disclosure',
  savesKeyOnce);
async function readsAndReplaysMetadata() {
  await runner.run(providers);
  const response = await request('GET', '/api/org/providers/primary');
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ rows: [{ providerId: 'primary', revision: 2,
    saved: { revision: 2, outcome: 'recorded' }, enabledModels: [],
    status: 'saved_unverified' }] });
  await runner.run(providers);
  const before = await readProviders(pgDb(dbs.queue), 'acme', 'primary');
  await runner.rebuild(providers);
  expect(await readProviders(pgDb(dbs.queue), 'acme', 'primary')).toEqual(before);
}
it('reads separate safe facts and replays metadata without reading secrets',
  readsAndReplaysMetadata);
async function skipsWithoutClaimingReady() {
  const input = { commandId: 'skip-primary', expectedRevision: 2, action: 'skip' };
  const skipped = await request('POST', '/api/org/providers/primary/verify', input);
  expect(skipped.statusCode).toBe(200);
  await runner.run(providers);
  const detail = await request('GET', '/api/org/providers/primary');
  expect(detail.json()).toMatchObject({ rows: [{ status: 'saved_unverified',
    modelAnswer: { revision: 2, outcome: 'skipped' } }] });
}
it('records an explicit skipped test separately without ready or model-answer PASS',
  skipsWithoutClaimingReady);
async function checksThroughRealGateway() {
  const checked = await request('POST', '/api/org/providers/primary/verify',
    { commandId: 'reach-primary', expectedRevision: 2, action: 'reachability' });
  expect(checked.statusCode).toBe(200);
  await runner.run(providers);
  const detail = await request('GET', '/api/org/providers/primary');
  expect(upstreamAuthHash).toBe(keyHash('fixture-provider-key-never-in-events'));
  expect(detail.json()).toMatchObject({ rows: [{ status: 'connected_not_tested',
    reachable: { revision: 2, outcome: 'pass' }, modelAnswer: { outcome: 'skipped' } }] });
}
it('checks reachability through the real gateway separately from a model answer',
  checksThroughRealGateway);

function closeUpstream(resolve: () => void) {
  upstream.close(resolve);
}
async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing port');
  function closeServer(resolve: () => void) {
    server.close(resolve);
  }
  await new Promise<void>(closeServer);
  return address.port;
}
function recordUpstream(req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse) {
  upstreamCount++;
  if (upstreamInvalidJson) {
    res.end('not json');
    return;
  }
  upstreamHeaders = Object.keys(req.headers);
  const hash = createHash('sha256');
  hash.update(req.headers.authorization ?? '');
  upstreamAuthHash = hash.digest('hex');
  req.resume();
  if (upstreamFailure) {
    res.writeHead(upstreamFailure);
    res.end('{}');
    return;
  }
  res.setHeader('content-type', 'application/json');
  if (req.url === '/v1/models') {
    res.end('{"data":[{"id":"gpt-6-luna"}]}');
    return;
  }
  const response = { status: 'completed', output: [{ type: 'message',
    content: [{ type: 'output_text', text: 'OK' }] }],
    usage: { input_tokens: 10, output_tokens: 2 } };
  if (upstreamNoAnswer) {
    response.output = [];
  }
  res.end(JSON.stringify(response));
}
async function runsPricedTestOnce() {
  const quote = await request('GET', '/api/org/providers/primary/verify?model=gpt-6-luna');
  expect(quote.statusCode).toBe(200);
  expect(quote.json()).toMatchObject({ revision: 2, reservedCents: 1, consentRequired: true });
  const input = { commandId: 'test-primary', expectedRevision: 2, action: 'test',
    model: 'gpt-6-luna', priceTableId: 'openai-2026-10-02-all-eur95',
    reservedCents: 1, consent: true };
  const before = upstreamCount;
  expect((await request('POST', '/api/org/providers/primary/verify', input)).statusCode).toBe(200);
  await runner.run(providers);
  expect((await request('GET', '/api/org/providers/primary')).json()).toMatchObject({
    rows: [{ status: 'ready', modelAnswer: { revision: 2, outcome: 'pass',
      model: 'gpt-6-luna', reservedCents: 1, settledCents: 1 } }] });
  expect(actor.state.reservations).toHaveLength(1);
  expect(actor.state.reservations[0]?.settledCents).toBe(1);
  expect(actor.state.reservations[0]?.call.conversationId).toBe('provider-primary');
  await request('POST', '/api/org/providers/primary/verify', input);
  expect(upstreamCount - before).toBe(1);
  expect(upstreamHeaders).not.toContain('x-provider-token');
  expect(upstreamHeaders).not.toContain('x-provider-command');
  expect(upstreamHeaders).not.toContain('x-provider-key');
}
it('warns with an integer-cent quote, reserves and settles a real gateway test exactly once',
  runsPricedTestOnce);
function keyHash(key: string) {
  const hash = createHash('sha256');
  hash.update(`Bearer ${key}`);
  return hash.digest('hex');
}
async function rejectsUnknownPriceAndMissingConsent() {
  const before = upstreamCount;
  const base = { commandId: 'denied-test', expectedRevision: 2, action: 'test',
    model: 'not-in-registry', priceTableId: 'openai-2026-10-02-all-eur95',
    reservedCents: 1, consent: true };
  expect((await request('POST', '/api/org/providers/primary/verify', base)).statusCode).toBe(403);
  expect((await request('POST', '/api/org/providers/primary/verify',
    { ...base, model: 'gpt-6-luna', consent: false })).statusCode).toBe(400);
  expect((await request('POST', '/api/org/providers/primary/verify',
    { ...base, model: 'gpt-6-luna', reservedCents: 2 })).statusCode).toBe(409);
  expect(upstreamCount).toBe(before);
  expect(actor.state.reservations).toHaveLength(1);
}
it('refuses unknown tariffs, missing consent and a stale quote before reservation or dispatch',
  rejectsUnknownPriceAndMissingConsent);
async function rotatesAndInvalidatesEvidence() {
  const key = 'fixture-rotated-key';
  const oldReference = providerSecretRef('acme', 'primary', 'save-primary');
  const rotated = await request('POST', '/api/org/providers/primary/key',
    { commandId: 'rotate-primary', expectedRevision: 2, key });
  expect(rotated.statusCode).toBe(200);
  await expect(secrets.read(oldReference)).rejects.toMatchObject({ code: 'ENOENT' });
  await runner.run(providers);
  expect((await request('GET', '/api/org/providers/primary')).json()).toMatchObject({
    rows: [{ revision: 3, status: 'saved_unverified', saved: { revision: 3 } }] });
  const state = await readProviders(pgDb(dbs.queue), 'acme', 'primary');
  expect(state[0]?.reachable).toBeUndefined();
  expect(state[0]?.modelAnswer).toBeUndefined();
  const before = upstreamCount;
  expect((await request('POST', '/api/org/providers/primary/verify',
    { commandId: 'stale-check', action: 'reachability', expectedRevision: 2 })).statusCode)
    .toBe(409);
  expect(upstreamCount).toBe(before);
  expect((await request('POST', '/api/org/providers/primary/verify',
    { commandId: 'fresh-rotated-check', expectedRevision: 3, action: 'reachability' })).statusCode)
    .toBe(200);
  expect(upstreamAuthHash).toBe(keyHash('fixture-rotated-key'));
}
it('rotation invalidates old check evidence and refuses stale verification',
  rotatesAndInvalidatesEvidence);
async function holdsUnknownCostWithoutRetry() {
  upstreamFailure = 504;
  const input = { commandId: 'unknown-test', expectedRevision: 3, action: 'test',
    model: 'gpt-6-luna', priceTableId: 'openai-2026-10-02-all-eur95',
    reservedCents: 1, consent: true };
  const before = upstreamCount;
  expect((await request('POST', '/api/org/providers/primary/verify', input)).statusCode).toBe(200);
  const original = await request('GET', '/api/org/providers/primary/changes/unknown-test');
  expect(original.json()).toMatchObject({ outcome: 'unknown', revision: 3 });
  await request('POST', '/api/org/providers/primary/verify', input);
  expect(upstreamCount - before).toBe(1);
  expect(actor.state.reservations[1]?.settledCents).toBeUndefined();
  upstreamFailure = 0;
}
it('holds an uncertain priced call and Check status never dispatches it again',
  holdsUnknownCostWithoutRetry);
async function refusesBudgetBeforeGateway() {
  await actor.configure({ scope: 'global', ceilingCents: 2, dailyCeilingCents: 2,
    setBy: 'owner' });
  const before = upstreamCount;
  const input = { commandId: 'budget-test', expectedRevision: 3, action: 'test',
    model: 'gpt-6-luna', priceTableId: 'openai-2026-10-02-all-eur95',
    reservedCents: 1, consent: true };
  expect((await request('POST', '/api/org/providers/primary/verify', input)).statusCode).toBe(200);
  expect((await request('GET', '/api/org/providers/primary/changes/budget-test')).json())
    .toMatchObject({ outcome: 'budget_refused' });
  expect(upstreamCount).toBe(before);
  expect(actor.state.reservations).toHaveLength(2);
  await runner.run(providers);
  const detail = await request('GET', '/api/org/providers/primary');
  expect(detail.json()).toMatchObject({ rows: [{ status: 'model_test_budget_refused' }] });
}
it('budget refusal keeps the saved key and makes no model call', refusesBudgetBeforeGateway);
async function selectsRegistryModelsWithoutGrants() {
  const body = { action: 'models', commandId: 'select-models', providerId: 'primary',
    expectedRevision: 3, models: ['gpt-6-luna', 'gpt-6.1-sol'] };
  expect((await request('POST', '/api/org/providers', body)).statusCode).toBe(200);
  expect((await auth.use('person', 'owner', 'model', 'gpt-6-luna')).allowed).toBe(false);
  await runner.run(providers);
  expect((await request('GET', '/api/org/providers/primary')).json()).toMatchObject({
    rows: [{ enabledModels: ['gpt-6-luna', 'gpt-6.1-sol'] }],
    access: { grantsAvailable: false, reason: 'p4_22_required' } });
  expect((await request('POST', '/api/org/providers', { ...body,
    commandId: 'unknown-model', expectedRevision: 4, models: ['made-up'] })).statusCode).toBe(403);
}
it('selects only registry models and never turns setup into a model grant',
  selectsRegistryModelsWithoutGrants);
async function rejectsReferenceWithoutCustody() {
  const providerId = 'forged-reference';
  const created = { action: 'create', providerId, commandId: 'create-forged-reference',
    expectedRevision: 0, provider: 'openai', name: 'Reference guard' };
  expect((await request('POST', '/api/org/providers', created)).statusCode).toBe(200);
  for await (const row of nats.store.readStream(`provider-${providerId}`)) {
    await auth.handler.handle(row.event, pgDb(dbs.queue));
  }
  const before = await nats.store.head();
  const secretRef = providerSecretRef('acme', providerId, 'forged-key');
  const command = { action: 'key', providerId, commandId: 'forged-key',
    expectedRevision: 1, secretRef };
  expect((await request('POST', '/api/org/providers', command)).statusCode).toBe(400);
  expect(await nats.store.head()).toBe(before);
}
it('rejects a caller-supplied secret reference without claiming key custody',
  rejectsReferenceWithoutCustody);
async function deniesUntrustedRequests() {
  const before = await nats.store.head();
  const body = { action: 'create', commandId: 'denied-create', providerId: 'denied',
    expectedRevision: 0, provider: 'openai', name: 'Denied' };
  expect((await request('POST', '/api/org/providers', body, 'idp-bob')).statusCode).toBe(403);
  expect((await request('POST', '/api/org/providers', body, 'idp-owner', 'foreign')).statusCode)
    .toBe(403);
  expect((await request('POST', '/api/org/providers', body, 'idp-owner', 'org-acme',
    'https://forged.test')).statusCode).toBe(403);
  expect((await app.inject({ method: 'GET', url: '/api/org/providers' })).statusCode).toBe(401);
  expect((await request('POST', '/api/org/providers', { ...body, providerId: '*' })).statusCode)
    .toBe(400);
  expect(await nats.store.head()).toBe(before);
}
it('ignores claimed roles and refuses member, foreign silo, forged Origin and missing sessions',
  deniesUntrustedRequests);
async function deniesUnavailableAuthority() {
  const original = nats.store.readStream.bind(nats.store);
  async function* unavailable(...args: Parameters<typeof original>) {
    if (args[0] === 'member-owner') throw new Error('fixture unavailable');
    yield* original(...args);
  }
  const reader = vi.spyOn(nats.store, 'readStream').mockImplementation(unavailable);
  const before = upstreamCount;
  try {
    expect((await request('GET', '/api/org/providers')).statusCode).toBe(503);
  } finally { reader.mockRestore(); }
  expect(upstreamCount).toBe(before);
  await fga.pause();
  try {
    expect((await request('POST', '/api/org/providers/primary/key',
      { commandId: 'iam-down', expectedRevision: 4, key: 'fixture-key' })).statusCode).toBe(503);
  } finally { await fga.resume(); }
}
it('fails closed for unavailable event authority and IAM', deniesUnavailableAuthority);
async function refusesSecretFailure() {
  const before = await nats.store.head();
  const save = vi.spyOn(secrets, 'save').mockRejectedValue(new Error('fixture-secret-failure'));
  try {
    const response = await request('POST', '/api/org/providers/primary/key',
      { commandId: 'secret-down', expectedRevision: 4, key: 'fixture-rejected-key' });
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain('fixture-rejected-key');
    expect(response.body).not.toContain('fixture-secret-failure');
  } finally { save.mockRestore(); }
  expect(await nats.store.head()).toBe(before);
}
it('secret-store failure accepts no key change and discloses no key or upstream error',
  refusesSecretFailure);
async function reconcilesLostSaveReply() {
  const append = nats.store.append.bind(nats.store);
  async function loseReply(command: Parameters<typeof append>[0]) {
    const result = await append(command);
    return { status: 'unavailable' as const, cause: new Error('fixture-lost-reply'), result };
  }
  const writer = vi.spyOn(nats.store, 'append').mockImplementation(loseReply);
  const input = { commandId: 'lost-key-reply', expectedRevision: 4, key: 'fixture-lost-key' };
  try {
    expect((await request('POST', '/api/org/providers/primary/key', input)).statusCode).toBe(503);
  } finally { writer.mockRestore(); }
  const status = await request('GET', '/api/org/providers/primary/changes/lost-key-reply');
  expect(status.json()).toMatchObject({ status: 'appended', revision: 5 });
  const before = await nats.store.head();
  expect((await request('POST', '/api/org/providers/primary/key', input)).statusCode).toBe(200);
  expect(await nats.store.head()).toBe(before);
  const configuration = await readFile(`${secretDirectory}/gateway.json`, 'utf8');
  expect(configuration).not.toContain('fixture-lost-key');
}
it('lost save acknowledgement reconciles the original change without another secret or event',
  reconcilesLostSaveReply);
async function reconstructsWithoutExternalCalls() {
  await runner.run(providers);
  const before = await request('GET', '/api/org/providers');
  const count = upstreamCount;
  await rebuildProviderProjection(pgDb(dbs.queue), nats.reader,
    createLogger('provider-rebuild', { level: 'silent' }), { verify: true });
  const after = await request('GET', '/api/org/providers');
  expect(after.json<{ rows: unknown[] }>().rows).toEqual(before.json<{ rows: unknown[] }>().rows);
  const rebuilt = await rebuildMembers(fga.apiUrl, 'acme', nats.reader,
    { verifyAgainst: auth.binding });
  expect((await rebuilt.provider('owner', 'primary', 'manage')).allowed).toBe(true);
  expect((await rebuilt.provider('bob', 'primary', 'manage')).allowed).toBe(false);
  expect(upstreamCount).toBe(count);
}
it('rebuilds the same metadata and OpenFGA relations with zero verification calls',
  reconstructsWithoutExternalCalls);
function fetchUrl(resource: Parameters<typeof fetch>[0]) {
  if (typeof resource === 'string') {
    return resource;
  }
  if (resource instanceof URL) {
    return resource.href;
  }
  return resource.url;
}
const undispatchedCases = [
  { action: 'reachability', gatewayStatus: 403 },
  { action: 'reachability', gatewayStatus: 503 },
  { action: 'test', gatewayStatus: 403 },
  { action: 'test', gatewayStatus: 503 },
] as const;
async function recordsUndispatchedCheck(
  scenario: (typeof undispatchedCases)[number],
) {
  await actor.configure({ scope: 'global', ceilingCents: 100, dailyCeilingCents: 100,
    setBy: 'owner' });
  const commandId = `undispatched-${scenario.action}-${scenario.gatewayStatus}`;
  const input = { commandId, expectedRevision: 5, action: scenario.action,
    ...(scenario.action === 'test' ? { model: 'gpt-6-luna',
      priceTableId: 'openai-2026-10-02-all-eur95', reservedCents: 1, consent: true } : {}) };
  const originalFetch = globalThis.fetch;
  async function refusedGateway(resource: Parameters<typeof fetch>[0],
    options?: Parameters<typeof fetch>[1]) {
    if (fetchUrl(resource).includes('/providers/openai/')) {
      return new Response('{}', { status: scenario.gatewayStatus });
    }
    return originalFetch(resource, options);
  }
  const gatewayRequest = vi.spyOn(globalThis, 'fetch').mockImplementation(refusedGateway);
  const before = upstreamCount;
  try {
    const response = await request('POST', '/api/org/providers/primary/verify', input);
    expect(response.statusCode).toBe(200);
    const status = await request('GET', `/api/org/providers/primary/changes/${commandId}`);
    expect(status.json()).toMatchObject({ outcome: 'unknown' });
    if (scenario.action === 'test') {
      expect(actor.state.reservations.at(-1)?.settledCents).toBe(0);
    }
    expect(upstreamCount).toBe(before);
  } finally {
    gatewayRequest.mockRestore();
  }
}
it.each(undispatchedCases)(
  'an undispatched $action check with gateway $gatewayStatus records unknown and releases money',
  recordsUndispatchedCheck,
);
async function rejectsInternalCommandLookalikes() {
  const status = await request('GET', '/api/org/providers/primary/changes/reach-primary-result');
  expect(status.statusCode).toBe(404);
}
it('a status read cannot mistake an internal result for a user command',
  rejectsInternalCommandLookalikes);
async function ignoresQueryStringsWhenRouting() {
  const input = { commandId: 'query-reachability', expectedRevision: 5, action: 'reachability' };
  const response = await request('POST', '/api/org/providers/primary/verify?x=/key', input);
  expect(response.statusCode).toBe(200);
  const status = await request('GET', '/api/org/providers/primary?x=/verify');
  expect(status.statusCode).toBe(200);
}
it('query strings cannot select a different provider handler', ignoresQueryStringsWhenRouting);
async function recordsMalformedResponse() {
  upstreamInvalidJson = true;
  const input = { commandId: 'malformed-test', expectedRevision: 5, action: 'test',
    model: 'gpt-6-luna', priceTableId: 'openai-2026-10-02-all-eur95',
    reservedCents: 1, consent: true };
  try {
    const response = await request('POST', '/api/org/providers/primary/verify', input);
    expect(response.statusCode).toBe(200);
    const status = await request('GET', '/api/org/providers/primary/changes/malformed-test');
    expect(status.json()).toMatchObject({ outcome: 'unknown' });
    expect(actor.state.reservations.at(-1)?.settledCents).toBeUndefined();
    await runner.run(providers);
    const detail = await request('GET', '/api/org/providers/primary');
    expect(detail.json()).toMatchObject({ rows: [{ status: 'model_test_unknown' }] });
  } finally {
    upstreamInvalidJson = false;
  }
}
it('a non-JSON provider reply records unknown immediately and retains uncertain spend',
  recordsMalformedResponse);
async function reportsFailedModelTest() {
  upstreamNoAnswer = true;
  const input = { commandId: 'failed-model-test', expectedRevision: 5, action: 'test',
    model: 'gpt-6-luna', priceTableId: 'openai-2026-10-02-all-eur95',
    reservedCents: 1, consent: true };
  try {
    const response = await request('POST', '/api/org/providers/primary/verify', input);
    expect(response.statusCode).toBe(200);
    await runner.run(providers);
    const detail = await request('GET', '/api/org/providers/primary');
    expect(detail.json()).toMatchObject({ rows: [{ status: 'model_test_fail',
      modelAnswer: { outcome: 'fail', settledCents: 1 } }] });
  } finally {
    upstreamNoAnswer = false;
  }
}
it('a settled test without a model answer reports failed rather than not tested',
  reportsFailedModelTest);
const gatewayStepCases = [
  { action: 'reachability', failure: 'refused' },
  { action: 'test', failure: 'refused' },
  { action: 'reachability', failure: 'unavailable' },
  { action: 'test', failure: 'unavailable' },
] as const;
async function recordsRealGatewayStepFailure(scenario: (typeof gatewayStepCases)[number]) {
  const commandId = `real-gateway-${scenario.action}-${scenario.failure}`;
  const input = { commandId, expectedRevision: 5, action: scenario.action,
    ...(scenario.action === 'test' ? { model: 'gpt-6-luna',
      priceTableId: 'openai-2026-10-02-all-eur95', reservedCents: 1, consent: true } : {}) };
  const originalFetch = globalThis.fetch;
  let gatewayStatus: number | undefined;
  async function changeGatewayCommand(resource: Parameters<typeof fetch>[0],
    options?: Parameters<typeof fetch>[1]) {
    if (scenario.failure === 'refused' && fetchUrl(resource).includes('/providers/openai/')) {
      let changedUrl = fetchUrl(resource);
      let changedOptions = options;
      if (scenario.action === 'reachability') {
        changedUrl = changedUrl.replace('/providers/openai/', '/providers/anthropic/');
      } else {
        const changedBody = { model: 'gpt-6-luna', input: 'Changed fixture prompt.' };
        changedOptions = { ...options, body: JSON.stringify(changedBody) };
      }
      const response = await originalFetch(changedUrl, changedOptions);
      gatewayStatus = response.status;
      return response;
    }
    return originalFetch(resource, options);
  }
  const gatewayRequest = vi.spyOn(globalThis, 'fetch').mockImplementation(changeGatewayCommand);
  const secretRead = vi.spyOn(secrets, 'read');
  if (scenario.failure === 'unavailable') {
    secretRead.mockRejectedValue(new Error('fixture-unreadable-secret-store'));
  }
  const before = upstreamCount;
  try {
    const response = await request('POST', '/api/org/providers/primary/verify', input);
    expect(response.statusCode).toBe(200);
    const status = await request('GET', `/api/org/providers/primary/changes/${commandId}`);
    expect(status.json()).toMatchObject({ outcome: 'unknown' });
    expect(upstreamCount).toBe(before);
    if (scenario.action === 'test') {
      expect(actor.state.reservations.at(-1)?.settledCents).toBe(0);
    }
    if (scenario.failure === 'refused') {
      expect(gatewayStatus).toBe(403);
      expect(secretRead).not.toHaveBeenCalled();
    }
  } finally {
    secretRead.mockRestore();
    gatewayRequest.mockRestore();
  }
}
it.each(gatewayStepCases)(
  'the real gateway records unknown for an undispatched $action check when $failure',
  recordsRealGatewayStepFailure,
);
async function recordsLateDispatchAcknowledgement(action: 'reachability' | 'test') {
  const commandId = `late-dispatch-ack-${action}`;
  await preparesVerificationProvider(commandId);
  const input = verificationInput(commandId, action);
  const originalAppend = nats.store.append.bind(nats.store);
  let acknowledgement: Promise<void> | undefined;
  async function delayDispatchReply(command: Parameters<typeof originalAppend>[0]) {
    const result = await originalAppend(command);
    const parsed = parseEventByType(command.event);
    if (parsed.success && parsed.event.type === 'provider.verification_dispatched') {
      acknowledgement = delay(2500);
      await acknowledgement;
    }
    return result;
  }
  const writer = vi.spyOn(nats.store, 'append').mockImplementation(delayDispatchReply);
  const originalFetch = globalThis.fetch;
  let gatewayStatus: number | undefined;
  async function observeGateway(resource: Parameters<typeof fetch>[0],
    options?: Parameters<typeof fetch>[1]) {
    const response = await originalFetch(resource, options);
    if (fetchUrl(resource).includes('/providers/openai/')) {
      gatewayStatus = response.status;
    }
    return response;
  }
  const gatewayRequest = vi.spyOn(globalThis, 'fetch').mockImplementation(observeGateway);
  const before = upstreamCount;
  try {
    const response = await request('POST', `/api/org/providers/${commandId}/verify`, input);
    expect(response.statusCode).toBe(200);
    expect(gatewayStatus).toBe(503);
    expect(upstreamCount).toBe(before);
    const rows: StoredEvent[] = [];
    for await (const row of nats.store.readStream(`provider-${commandId}`)) {
      rows.push(row);
    }
    function dispatchedAttempt(row: (typeof rows)[number]) {
      const parsed = parseEventByType(row.event);
      if (!parsed.success || parsed.event.type !== 'provider.verification_dispatched') {
        return false;
      }
      return providerDispatchedSchema.parse(parsed.event.data).attemptId === commandId;
    }
    expect(rows.some(dispatchedAttempt)).toBe(true);
    const status = await request('GET', `/api/org/providers/${commandId}/changes/${commandId}`);
    expect(status.json()).toMatchObject({ outcome: 'unknown' });
    if (action === 'test') {
      expect(actor.state.reservations.at(-1)?.settledCents).toBeUndefined();
    }
  } finally {
    await acknowledgement;
    gatewayRequest.mockRestore();
    writer.mockRestore();
  }
}
it.each(['reachability', 'test'] as const)(
  'a stored %s dispatch with a late admission reply records unknown without upstream contact',
  recordsLateDispatchAcknowledgement);
const upstreamFailureCases = [
  { action: 'reachability', status: 401, outcome: 'fail' },
  { action: 'reachability', status: 403, outcome: 'fail' },
  { action: 'reachability', status: 429, outcome: 'unknown' },
  { action: 'reachability', status: 500, outcome: 'unknown' },
  { action: 'reachability', status: 503, outcome: 'unknown' },
  { action: 'test', status: 401, outcome: 'fail', settledCents: 0 },
  { action: 'test', status: 403, outcome: 'fail', settledCents: 0 },
  { action: 'test', status: 429, outcome: 'fail', settledCents: 0 },
  { action: 'test', status: 500, outcome: 'unknown', settledCents: undefined },
  { action: 'test', status: 503, outcome: 'unknown', settledCents: undefined },
] as const;
async function recordsUpstreamFailure(scenario: (typeof upstreamFailureCases)[number]) {
  const commandId = `upstream-${scenario.action}-${scenario.status}`;
  await preparesVerificationProvider(commandId);
  const input = verificationInput(commandId, scenario.action);
  upstreamFailure = scenario.status;
  const before = upstreamCount;
  try {
    const response = await request('POST', `/api/org/providers/${commandId}/verify`, input);
    expect(response.statusCode).toBe(200);
    expect(upstreamCount - before).toBe(1);
    const status = await request('GET', `/api/org/providers/${commandId}/changes/${commandId}`);
    expect(status.json()).toMatchObject({ outcome: scenario.outcome });
    if (scenario.action === 'test') {
      const reservation = actor.state.reservations.at(-1);
      expect(reservation?.settledCents).toBe(scenario.settledCents);
    }
  } finally {
    upstreamFailure = 0;
  }
}
function verificationInput(commandId: string, action: 'reachability' | 'test') {
  const input = { commandId, expectedRevision: 2, action };
  if (action === 'test') {
    return { ...input, model: 'gpt-6-luna',
      priceTableId: 'openai-2026-10-02-all-eur95', reservedCents: 1, consent: true };
  }
  return input;
}
async function preparesVerificationProvider(providerId: string) {
  const create = { action: 'create', commandId: `create-${providerId}`, providerId,
    expectedRevision: 0, provider: 'openai', name: providerId };
  expect((await request('POST', '/api/org/providers', create)).statusCode).toBe(200);
  for await (const row of nats.store.readStream(`provider-${providerId}`)) {
    await auth.handler.handle(row.event, pgDb(dbs.queue));
  }
  const key = { commandId: `key-${providerId}`, expectedRevision: 1, key: 'fixture-only-key' };
  expect((await request('POST', `/api/org/providers/${providerId}/key`, key)).statusCode).toBe(200);
  const budget = { scope: 'global', ceilingCents: 1000, dailyCeilingCents: 1000, setBy: 'owner' };
  await actor.configure(budget);
}
it.each(upstreamFailureCases)(
  'an upstream $status during $action records $outcome with appropriate settlement',
  recordsUpstreamFailure,
);
async function releasesReservationWhenAuditFails() {
  const providerId = 'audit-failure';
  await preparesVerificationProvider(providerId);
  const input = verificationInput('audit-failure-test', 'test');
  const originalAppend = nats.store.append.bind(nats.store);
  async function unavailableAudit(command: Parameters<typeof originalAppend>[0]) {
    const parsed = parseEventByType(command.event);
    if (parsed.success && parsed.event.type === 'decision.recorded') {
      return { status: 'unavailable' as const, cause: new Error('Fixture audit outage') };
    }
    return originalAppend(command);
  }
  const writer = vi.spyOn(nats.store, 'append').mockImplementation(unavailableAudit);
  const before = upstreamCount;
  try {
    const response = await request('POST', `/api/org/providers/${providerId}/verify`, input);
    expect(response.statusCode).toBe(503);
  } finally {
    writer.mockRestore();
  }
  const reservation = actor.state.reservations.at(-1);
  expect(reservation).toBeDefined();
  expect(upstreamCount).toBe(before);
  // Expiry must not turn a known undispatched hold into an effect without an allow decision.
  const expired = new Date(Date.parse(reservation!.time) + 180_001);
  const clock = vi.spyOn(actor, 'now').mockReturnValue(expired);
  try {
    await actor.expire();
  } finally {
    clock.mockRestore();
  }
  expect(await nats.store.head(`security-${reservation!.id}`)).toBe(0);
  expect(reservation?.settledCents).toBe(0);
  const statusUrl = `/api/org/providers/${providerId}/changes/${input.commandId}`;
  expect((await request('GET', statusUrl)).json()).toMatchObject({ outcome: 'unknown' });
  expect((await request('POST', `/api/org/providers/${providerId}/verify`, input)).statusCode)
    .toBe(200);
  expect(upstreamCount).toBe(before);
}
it('an unavailable audit releases undispatched money without an expiry security alert',
  releasesReservationWhenAuditFails);
const preReservationRefusals = [
  { change: 'config', status: 409 },
  { change: 'role', status: 403 },
  { change: 'iam', status: 503 },
] as const;
async function finishesPreReservationRefusal(scenario: (typeof preReservationRefusals)[number]) {
  const providerId = `before-reservation-${scenario.change}`;
  await preparesVerificationProvider(providerId);
  const input = verificationInput(providerId, 'test');
  const originalAppend = nats.store.append.bind(nats.store);
  let roleChange: EventEnvelope | undefined;
  async function changeAfterRequest(command: Parameters<typeof originalAppend>[0]) {
    const result = await originalAppend(command);
    const parsed = parseEventByType(command.event);
    if (!parsed.success || parsed.event.type !== 'provider.verification_requested') {
      return result;
    }
    if (scenario.change === 'config') {
      const selection = { action: 'models', commandId: `${providerId}-models`, providerId,
        expectedRevision: 2, models: ['gpt-6-luna'] };
      expect((await request('POST', '/api/org/providers', selection)).statusCode).toBe(200);
    } else {
      const newRole = scenario.change === 'role' ? 'member' : 'admin';
      roleChange = { ...event(`${providerId}-role`, 'member-owner', 'member.role_changed'),
        silo: 'acme', correlation: {}, principal: { kind: 'human', id: 'owner' },
        data: { memberId: 'owner', previousRole: 'owner', newRole, changedBy: 'owner' } };
      const roleCommand = { event: roleChange,
        expectedSequence: await nats.store.head('member-owner') };
      await originalAppend(roleCommand);
    }
    return result;
  }
  const writer = vi.spyOn(nats.store, 'append').mockImplementation(changeAfterRequest);
  const before = upstreamCount;
  const reservationCount = actor.state.reservations.length;
  try {
    const response = await request('POST', `/api/org/providers/${providerId}/verify`, input);
    expect(response.statusCode).toBe(scenario.status);
  } finally {
    writer.mockRestore();
    if (roleChange) {
      await auth.handler.handle(roleChange, pgDb(dbs.queue));
      const restored = { ...event(`${providerId}-restore`, 'member-owner', 'member.role_changed'),
        silo: 'acme', correlation: {}, principal: { kind: 'human' as const, id: 'owner' },
        data: { memberId: 'owner', previousRole: scenario.change === 'role' ? 'member' : 'admin',
          newRole: 'owner', changedBy: 'owner' } };
      const restoreCommand = { event: restored,
        expectedSequence: await nats.store.head('member-owner') };
      await nats.store.append(restoreCommand);
      await auth.handler.handle(restored, pgDb(dbs.queue));
    }
  }
  const statusUrl = `/api/org/providers/${providerId}/changes/${input.commandId}`;
  expect((await request('GET', statusUrl)).json()).toMatchObject({ outcome: 'unknown' });
  expect(actor.state.reservations).toHaveLength(reservationCount);
  expect(upstreamCount).toBe(before);
}
it.each(preReservationRefusals)(
  'a refusal at $change before reservation finishes the attempt as unknown',
  finishesPreReservationRefusal,
);
async function recordsResultAfterRevisionChanges() {
  const providerId = 'changing';
  const create = { action: 'create', providerId, commandId: 'create-changing',
    expectedRevision: 0, provider: 'openai', name: 'Changing' };
  expect((await request('POST', '/api/org/providers', create)).statusCode).toBe(200);
  for await (const row of nats.store.readStream('provider-changing')) {
    await auth.handler.handle(row.event, pgDb(dbs.queue));
  }
  const key = { commandId: 'key-changing', expectedRevision: 1, key: 'fixture-changing' };
  expect((await request('POST', '/api/org/providers/changing/key', key)).statusCode).toBe(200);
  const originalFetch = globalThis.fetch;
  async function changeWhileCalling(resource: Parameters<typeof fetch>[0],
    options?: Parameters<typeof fetch>[1]) {
    const response = await originalFetch(resource, options);
    if (fetchUrl(resource).endsWith('/providers/openai/test')) {
      const selection = { action: 'models', commandId: 'models-changing', providerId,
        expectedRevision: 2, models: ['gpt-6-luna'] };
      expect((await request('POST', '/api/org/providers', selection)).statusCode).toBe(200);
    }
    return response;
  }
  const gatewayRequest = vi.spyOn(globalThis, 'fetch').mockImplementation(changeWhileCalling);
  try {
    const input = { commandId: 'test-changing', expectedRevision: 2, action: 'test',
      model: 'gpt-6-luna', priceTableId: 'openai-2026-10-02-all-eur95',
      reservedCents: 1, consent: true };
    const response = await request('POST', '/api/org/providers/changing/verify', input);
    expect(response.statusCode).toBe(200);
    const status = await request('GET', '/api/org/providers/changing/changes/test-changing');
    expect(status.json()).toMatchObject({ outcome: 'pass', revision: 2, currentRevision: 3 });
    expect(actor.state.reservations.at(-1)?.settledCents).toBe(1);
    await runner.rebuild(providers);
    const detail = await request('GET', '/api/org/providers/changing');
    expect(detail.json()).toMatchObject({ rows: [{ revision: 3, status: 'saved_unverified' }] });
  } finally {
    gatewayRequest.mockRestore();
  }
}
it('a revision change during a model call cannot prevent recording its settled result',
  recordsResultAfterRevisionChanges);
async function cleansRejectedSecret() {
  const originalAppend = nats.store.append.bind(nats.store);
  async function refuseKeyAppend(command: Parameters<typeof originalAppend>[0]) {
    const parsed = parseEventByType(command.event);
    if (!parsed.success) {
      throw new Error('Invalid fixture event');
    }
    if (parsed.event.commandId === 'orphan-key') {
      const selection = { action: 'models', commandId: 'orphan-key-config',
        providerId: 'primary', expectedRevision: 5, models: ['gpt-6-luna'] };
      expect((await request('POST', '/api/org/providers', selection)).statusCode).toBe(200);
    }
    return originalAppend(command);
  }
  const writer = vi.spyOn(nats.store, 'append').mockImplementation(refuseKeyAppend);
  try {
    const input = { commandId: 'orphan-key', expectedRevision: 5, key: 'fixture-orphan' };
    expect((await request('POST', '/api/org/providers/primary/key', input)).statusCode).toBe(409);
    const reference = providerSecretRef('acme', 'primary', 'orphan-key');
    await expect(secrets.read(reference)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    writer.mockRestore();
  }
}
it('a rejected key append deletes its orphan secret without deleting an accepted key',
  cleansRejectedSecret);
async function retainsSecretForInflightRetry() {
  const input = { commandId: 'concurrent-key-cleanup', expectedRevision: 6,
    key: 'fixture-concurrent-key' };
  const originalAppend = nats.store.append.bind(nats.store);
  const firstStarted = Promise.withResolvers<void>();
  const secondStarted = Promise.withResolvers<void>();
  const finishFirst = Promise.withResolvers<void>();
  const finishSecond = Promise.withResolvers<void>();
  let appendCount = 0;
  async function pauseKeyAppend(command: Parameters<typeof originalAppend>[0]) {
    const parsed = parseEventByType(command.event);
    if (!parsed.success) {
      throw new Error('Invalid fixture event');
    }
    if (parsed.event.commandId === input.commandId) {
      appendCount += 1;
      if (appendCount === 1) {
        firstStarted.resolve();
        await finishFirst.promise;
      } else if (appendCount === 2) {
        secondStarted.resolve();
        await finishSecond.promise;
      }
    }
    return originalAppend(command);
  }
  const writer = vi.spyOn(nats.store, 'append').mockImplementation(pauseKeyAppend);
  const first = request('POST', '/api/org/providers/primary/key', input);
  let second: ReturnType<typeof request> | undefined;
  try {
    await firstStarted.promise;
    const skip = { commandId: 'concurrent-key-skip', expectedRevision: 6, action: 'skip' };
    expect((await request('POST', '/api/org/providers/primary/verify', skip)).statusCode).toBe(200);
    second = request('POST', '/api/org/providers/primary/key', input);
    await secondStarted.promise;
    finishFirst.resolve();
    expect((await first).statusCode).toBe(409);
    finishSecond.resolve();
    expect((await second).statusCode).toBe(200);
    const reference = providerSecretRef('acme', 'primary', input.commandId);
    await expect(secrets.read(reference)).resolves.toBe(input.key);
  } finally {
    finishFirst.resolve();
    finishSecond.resolve();
    await first;
    if (second) {
      await second;
    }
    writer.mockRestore();
  }
}
it('a refused save cannot delete the secret of an in-flight retry', retainsSecretForInflightRetry);
async function recordsNoFakeGatewayObservations() {
  let usage = '';
  try {
    usage = await readFile(`${secretDirectory}/usage.jsonl`, 'utf8');
  } catch (error) {
    expect(error).toMatchObject({ code: 'ENOENT' });
  }
  const lines = usage.trim().split('\n');
  expect(lines).toHaveLength(2);
  for (const line of lines) {
    expect(JSON.parse(line)).toMatchObject({ outcome: 'error', reason: 'jwt_failed' });
  }
  await ingestUsage(actor, `${secretDirectory}/usage.jsonl`);
  const files = await readdir(secretDirectory);
  expect(files).not.toContain(providerSecretRef('acme', 'primary', 'save-primary').slice(16));
}
it('provider checks retain only 401 gateway audit rows',
  recordsNoFakeGatewayObservations);
async function deniesRevokedRoleBeforeIamCatchesUp() {
  const row = { ...event('provider-revoked-owner', 'member-owner', 'member.role_changed'),
    silo: 'acme', correlation: {},
    principal: { kind: 'human' as const, id: 'owner' },
    data: { memberId: 'owner', previousRole: 'owner',
      newRole: 'member', changedBy: 'owner' } };
  await nats.store.append({ event: row, expectedSequence: await nats.store.head('member-owner') });
  const before = upstreamCount;
  expect((await request('POST', '/api/org/providers/primary/key',
    { commandId: 'revoked-key', expectedRevision: 4, key: 'fixture-key' })).statusCode).toBe(403);
  expect((await request('GET', '/api/org/providers')).statusCode).toBe(403);
  expect(upstreamCount).toBe(before);
}
it('revoked role denies reads and key rotation before the IAM projection catches up',
  deniesRevokedRoleBeforeIamCatchesUp);
