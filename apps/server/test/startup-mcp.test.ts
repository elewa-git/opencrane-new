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
  cleanups.push(nats.close);
  const app = Fastify();
  async function closeApp() {
    await app.close();
  }
  cleanups.push(closeApp);
  let networkRequests = 0;
  function refuseNetwork() {
    networkRequests += 1;
    throw new Error('Hosted review must not contact an upstream');
  }
  const worker = installWorker(app, nats.store, 'test', { resolve: refuseNetwork });
  const data = { serverId: 'startup', kind: 'hosted', locator, registeredBy: 'admin',
    ...(credentialContract === undefined ? {} : { credentialContract }) };
  const schema = getEventDefinition('mcp.server_registered')!.dataSchema;
  const registration = schema.parse(data);
  const event = envelope('test', 'mcp-startup', 'mcp.server_registered', registration, 'register');
  await nats.store.append({ event, expectedSequence: 0 });
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
  await fixture.store.append({ event: discovery, expectedSequence: 1 });
  const publication = envelope('test', 'mcp-startup', 'mcp.server_published',
    { serverId: 'startup', publishedBy: 'admin' }, 'publish');
  await fixture.store.append({ event: publication, expectedSequence: 2 });
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
