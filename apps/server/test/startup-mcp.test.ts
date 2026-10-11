import { afterEach, expect, it } from 'vitest';
import Fastify from 'fastify';
import { getEventDefinition } from '@opencrane/events';
import { natsFixture } from '@opencrane/event-store/testing';
import { envelope, history, readToolPolicy } from '@opencrane/models';
import { installWorker } from '../src/integrations/install-worker.ts';
import { discoveryStatus } from '../src/integrations/registration.ts';

const imageDigest = 'a'.repeat(64);
const locator = `registry.example.test/startup@sha256:${imageDigest}`;
const contract = {
  credentialMode: 'startup_short_lived', materialKind: 'startup_capability',
  maxLifetimeSeconds: 30, delivery: 'memory_ipc', renewal: 'memory_provider',
  upstreamEnforcesExpiry: true, upstreamEnforcesBinding: true,
  imageDigest, launcherDigest: 'b'.repeat(64), dependencyDigest: 'c'.repeat(64),
  configurationDigest: 'd'.repeat(64), upstreamBindingDigest: 'e'.repeat(64),
  evidenceRef: 'evidence:synthetic-startup',
};
const cleanups: (() => Promise<unknown>)[] = [];
async function closeFixtures() {
  for (const close of cleanups.reverse()) await close();
  cleanups.length = 0;
}
afterEach(closeFixtures);

async function setup(credentialContract?: unknown) {
  const nats = await natsFixture();
  async function closeNats() {
    await nats.close();
  }
  cleanups.push(closeNats);
  const app = Fastify();
  async function closeApp() {
    await app.close();
  }
  cleanups.push(closeApp);
  let networkRequests = 0;
  async function refuseNetwork(): Promise<never> {
    await Promise.resolve();
    networkRequests += 1;
    throw new Error('Hosted review must not contact an upstream');
  }
  const worker = installWorker(app, nats.store, 'test', { resolve: refuseNetwork });
  const data = { serverId: 'startup', kind: 'hosted', locator, registeredBy: 'admin',
    ...(credentialContract === undefined ? {} : { credentialContract }) };
  const schema = getEventDefinition('mcp.server_registered')!.dataSchema;
  const registration = schema.parse(data);
  const event = envelope('test', 'mcp-startup', 'mcp.server_registered', registration, 'register');
  const registered = await nats.store.append({ event, expectedSequence: 0 });
  expect(registered.status).toBe('appended');
  function requests() {
    return networkRequests;
  }
  return { store: nats.store, worker, requests };
}

const refusedContracts = [
  { name: 'lasting', value: { credentialMode: 'startup_lasting' },
    reason: 'lasting_startup_secret_required' },
  { name: 'environment-only', value: { ...contract, delivery: 'environment' },
    reason: 'lasting_startup_secret_required' },
  { name: 'raw bearer', value: { ...contract, materialKind: 'raw_bearer' },
    reason: 'lasting_startup_secret_required' },
  { name: 'per-call lease', value: { ...contract, materialKind: 'per_call_lease' },
    reason: 'startup_contract_unverified' },
  { name: 'unknown', value: { credentialMode: 'unknown' },
    reason: 'startup_contract_unverified' },
  { name: 'missing evidence', value: { ...contract, evidenceRef: undefined },
    reason: 'startup_contract_unverified' },
  { name: 'changed image', value: { ...contract, imageDigest: 'f'.repeat(64) },
    reason: 'startup_contract_unverified' },
  { name: 'unenforced expiry', value: { ...contract, upstreamEnforcesExpiry: false },
    reason: 'startup_contract_unverified' },
  { name: 'unbound upstream', value: { ...contract, upstreamEnforcesBinding: false },
    reason: 'startup_contract_unverified' },
  { name: 'missing dependencies', value: { ...contract, dependencyDigest: undefined },
    reason: 'startup_contract_unverified' },
  { name: 'launch-only capability', value: { ...contract, renewal: 'controlled_restart' },
    reason: 'startup_contract_unverified' },
  { name: 'long OAuth access', value: { ...contract, materialKind: 'oauth_access',
    maxLifetimeSeconds: 601 }, reason: 'startup_contract_unverified' },
  { name: 'unbounded lifetime', value: { ...contract, maxLifetimeSeconds: 31 },
    reason: 'startup_contract_unverified' },
];
async function refusesContract(testCase: (typeof refusedContracts)[number]) {
  const fixture = await setup(testCase.value);
  await fixture.worker.discover('startup');
  const status = await discoveryStatus(fixture.store, 'test', 'startup');
  expect(status).toMatchObject({ state: 'failed', reason: testCase.reason });
  expect(status?.inventory).toBeUndefined();
  expect(fixture.requests()).toBe(0);
  const rows = await history(fixture.store, 'mcp-startup', 'test');
  expect(rows).toHaveLength(2);
  expect(rows[1]?.event.type).toBe('mcp.server_rejected');
  await fixture.worker.discover('startup');
  expect(await history(fixture.store, 'mcp-startup', 'test')).toHaveLength(2);
}
it.each(refusedContracts)('refuses $name before offering Connect or publication', refusesContract);

async function acceptsReviewOnly() {
  const fixture = await setup(contract);
  await fixture.worker.discover('startup');
  expect(await discoveryStatus(fixture.store, 'test', 'startup')).toMatchObject({
    state: 'needs_input', reason: 'pending_review',
  });
  expect(fixture.requests()).toBe(0);
  expect(await history(fixture.store, 'mcp-startup', 'test')).toHaveLength(1);
  expect(await readToolPolicy(fixture.store, 'test', 'startup')).toMatchObject({
    published: false, connectionId: null,
  });
}
it('accepts the compatible synthetic contract for review without starting a callable process',
  acceptsReviewOnly);

async function keepsHostedClosed(credentialContract?: unknown) {
  const fixture = await setup(credentialContract);
  const discovered = { serverId: 'startup', toolCount: 0, schemaDigest: imageDigest,
    connectionId: 'forged-connection', accountMode: 'none', tools: [] };
  const discovery = envelope('test', 'mcp-startup', 'mcp.server_discovered', discovered, 'discover');
  const discoveredResult = await fixture.store.append({ event: discovery, expectedSequence: 1 });
  expect(discoveredResult.status).toBe('appended');
  const publication = envelope('test', 'mcp-startup', 'mcp.server_published',
    { serverId: 'startup', publishedBy: 'admin' }, 'publish');
  const publishedResult = await fixture.store.append({ event: publication, expectedSequence: 2 });
  expect(publishedResult.status).toBe('appended');
  expect(await readToolPolicy(fixture.store, 'test', 'startup')).toMatchObject({ published: false });
}
async function keepsLegacyClosed() {
  const fixture = await setup();
  await fixture.worker.discover('startup');
  expect(await discoveryStatus(fixture.store, 'test', 'startup')).toMatchObject({
    state: 'failed', reason: 'startup_contract_unverified',
  });
  await keepsHostedClosed();
}
it('keeps legacy hosted records closed even after a credential-free publication claim',
  keepsLegacyClosed);
async function keepsCompatibleClosed() {
  await keepsHostedClosed(contract);
}
it('keeps compatible startup evidence closed even after a publication claim', keepsCompatibleClosed);

const rawFields = ['token', 'bearer', 'refreshToken', 'clientSecret'];
function rejectsMaterial(field: string) {
  const data = { serverId: 'startup', kind: 'hosted', locator, registeredBy: 'admin',
    credentialContract: { ...contract, [field]: 'synthetic-secret' } };
  expect(getEventDefinition('mcp.server_registered')!.dataSchema.safeParse(data).success).toBe(false);
}
it.each(rawFields)('refuses raw %s material in the saved contract', rejectsMaterial);

async function acceptsBoundedOAuth() {
  const oauth = { ...contract, materialKind: 'oauth_access', maxLifetimeSeconds: 600 };
  const fixture = await setup(oauth);
  await fixture.worker.discover('startup');
  expect(await discoveryStatus(fixture.store, 'test', 'startup')).toMatchObject({
    state: 'needs_input', reason: 'pending_review',
  });
  expect(fixture.requests()).toBe(0);
}
it('accepts bounded OAuth access for review without delivering material', acceptsBoundedOAuth);

async function leavesPerCallHostedReviewClosed() {
  const fixture = await setup({ credentialMode: 'per_call' });
  await fixture.worker.discover('startup');
  expect(await history(fixture.store, 'mcp-startup', 'test')).toHaveLength(1);
  expect(await readToolPolicy(fixture.store, 'test', 'startup')).toMatchObject({ published: false });
}
it('leaves hosted per-call review to the hosted installer without enabling it',
  leavesPerCallHostedReviewClosed);

async function refusesLegacyConnectionRequest() {
  const fixture = await setup();
  const rejection = envelope('test', 'mcp-startup', 'mcp.server_rejected',
    { serverId: 'startup', reason: 'connection_required' }, 'old-discovery');
  const rejected = await fixture.store.append({ event: rejection, expectedSequence: 1 });
  expect(rejected.status).toBe('appended');
  expect(await discoveryStatus(fixture.store, 'test', 'startup')).toMatchObject({
    state: 'failed', reason: 'startup_contract_unverified',
  });
}
it('refuses an older hosted request for Connect without startup evidence',
  refusesLegacyConnectionRequest);
