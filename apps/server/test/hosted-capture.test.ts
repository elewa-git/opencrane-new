import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { natsFixture } from '@opencrane/event-store/testing';
import { envelope, history, toolPolicyFromRows } from '@opencrane/models';
import { applyToolPolicy, emptyToolPolicy, isToolPolicyAvailable } from '@opencrane/projections';
import { toolReviewDigest } from '@opencrane/events/mcp-catalogue';
import { discoverInventory } from '../src/integrations/inventory.ts';
import { captureHostedStart, type HostedCaptureTransport }
  from '../src/integrations/hosted-capture.ts';

const serverId = 'hosted-fixture';
const imageDigest = 'a'.repeat(64);
const locator = `ghcr.io/example/fixture@sha256:${imageDigest}`;
const run = { imageDigest, platform: 'linux/amd64' as const, podUid: 'pod-one',
  workloadSpecDigest: 'b'.repeat(64), runGeneration: 1 };
const discovery = { resultType: 'complete', ttlMs: 60_000, cacheScope: 'private',
  supportedVersions: ['2026-07-28'], capabilities: { tools: {} },
  _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'Fixture', version: '1' } } };
const tool = { name: 'echo', description: 'Echo text', inputSchema: { type: 'object' },
  outputSchema: { type: 'object' },
  _meta: { 'io.opencrane/costCents': 0,
    'io.opencrane/review': { action: 'Echo', consequence: 'Return the input.',
      targetArgument: 'value', fields: ['value'], stepUp: false } } };
let fixture: Awaited<ReturnType<typeof natsFixture>>;

function transport(currentRun: Awaited<ReturnType<HostedCaptureTransport['observe']>> = run,
  definition: unknown = tool) {
  const observe = vi.fn().mockResolvedValue(currentRun);
  const request = vi.fn().mockImplementation((method: string) => {
    const result = method === 'server/discover' ? discovery :
      { resultType: 'complete', ttlMs: 60_000, cacheScope: 'private', tools: [definition] };
    return Promise.resolve(JSON.stringify(result));
  });
  return { observe, request };
}

async function save(type: string, data: unknown, sequence: number) {
  const event = envelope('test', `mcp-${serverId}`, type, data);
  if (type === 'mcp.server_registered') event.principal = { kind: 'human', id: 'admin' };
  if (type === 'mcp.image_checked') {
    event.source = 'models';
    event.principal = { kind: 'system', id: 'models' };
  }
  const result = await fixture.store.append({ event, expectedSequence: sequence });
  expect(result.status).toBe('appended');
}

async function admitted(expiryOffsetMs = 60_000, extra: Record<string, unknown> = {}) {
  const registration = { serverId, kind: 'hosted', locator, registeredBy: 'admin',
    installation: { attemptId: 1, platform: 'linux/amd64',
      upstream: { host: 'api.example.com', port: 443 } }, ...extra };
  await save('mcp.server_registered', registration, 0);
  const checkedAt = new Date(Date.now() - 1000).toISOString();
  const expiresAt = new Date(Date.now() + expiryOffsetMs).toISOString();
  const receipt = { verdict: 'pass', checkedAt, expiresAt, engineVersion: 'fixture',
    reportDigest: 'c'.repeat(64) };
  const database = { ...receipt, databaseDigest: 'd'.repeat(64), databaseUpdatedAt: checkedAt };
  const checked = { serverId, attemptId: 1, imageDigest, platform: 'linux/amd64',
    checks: { signature: receipt, licence: receipt, vulnerability: database, malware: database } };
  await save('mcp.image_checked', checked, 1);
}

async function policy() {
  const rows = await history(fixture.store, `mcp-${serverId}`, 'test');
  return toolPolicyFromRows(rows);
}

beforeEach(async () => { fixture = await natsFixture(); });
afterEach(async () => { await fixture.close(); });

it('keeps a clean signed image closed until this run has captured its definitions', async () => {
  await admitted();
  expect((await policy()).catalogue).toBeNull();
  const checked = transport();
  const result = await captureHostedStart(fixture.store, 'test', serverId, run, checked);
  const saved = await policy();
  expect(result.schemaDigest).toBe(saved.catalogue?.schemaDigest);
  expect(saved.catalogue?.tools?.[0]?.definition).toContain('Echo text');
  expect(saved.tools[0]?.mode).toBe('block');
  expect(saved.published).toBe(false);
  expect(checked.request).toHaveBeenCalledTimes(2);
  const admittedForUse = { ...saved, published: true, driftHeld: false };
  expect(isToolPolicyAvailable(admittedForUse,
    Date.parse(saved.admissionExpiresAt!))).toBe(false);
});

it('uses stable field ordering and changes the digest for edited declarations', async () => {
  const base = transport();
  const reordered = transport(run, { inputSchema: { type: 'object' },
    _meta: tool._meta, outputSchema: { type: 'object' }, description: 'Echo text', name: 'echo' });
  const changedDescription = transport(run, { ...tool, description: 'Changed' });
  const changedInput = transport(run, { ...tool, inputSchema: { type: 'object', properties: {} } });
  const changedOutput = transport(run, { ...tool, outputSchema: { type: 'object', properties: {} } });
  async function digest(source: ReturnType<typeof transport>) {
    const inventory = await discoverInventory(source.request);
    return inventory.schemaDigest;
  }
  expect(await digest(reordered)).toBe(await digest(base));
  expect(await digest(changedDescription)).not.toBe(await digest(base));
  expect(await digest(changedInput)).not.toBe(await digest(base));
  expect(await digest(changedOutput)).not.toBe(await digest(base));
});

it('refuses a foreign image or Pod before asking the fixture for tools', async () => {
  await admitted();
  const wrongImage = transport({ ...run, imageDigest: 'e'.repeat(64) });
  await expect(captureHostedStart(fixture.store, 'test', serverId, run, wrongImage))
    .rejects.toThrow();
  expect(wrongImage.request).not.toHaveBeenCalled();
  const wrongPlatform = transport({ ...run, platform: 'linux/arm64' });
  await expect(captureHostedStart(fixture.store, 'test', serverId,
    { ...run, platform: 'linux/arm64' }, wrongPlatform)).rejects.toThrow();
  expect(wrongPlatform.request).not.toHaveBeenCalled();
  const wrongPod = transport({ ...run, podUid: 'replacement' });
  await expect(captureHostedStart(fixture.store, 'test', serverId, run, wrongPod))
    .rejects.toThrow();
  expect(wrongPod.request).not.toHaveBeenCalled();
  expect((await policy()).catalogue).toBeNull();
});

it('refuses expired evidence and a foreign silo', async () => {
  await admitted(-100);
  const checked = transport();
  await expect(captureHostedStart(fixture.store, 'test', serverId, run, checked))
    .rejects.toThrow();
  await expect(captureHostedStart(fixture.store, 'foreign', serverId, run, checked))
    .rejects.toThrow();
  expect(checked.request).not.toHaveBeenCalled();
});

it('refuses a hosted registration requiring startup credentials', async () => {
  const registration = { serverId, kind: 'hosted', locator, registeredBy: 'admin',
    credentialContract: { credentialMode: 'startup_lasting', materialKind: 'raw_bearer',
      delivery: 'environment' } };
  await save('mcp.server_registered', registration, 0);
  const checked = transport();
  await expect(captureHostedStart(fixture.store, 'test', serverId, run, checked))
    .rejects.toThrow();
  expect(checked.request).not.toHaveBeenCalled();
});

it('requires a new capture after a changed generation and holds the old review', async () => {
  await admitted();
  await captureHostedStart(fixture.store, 'test', serverId, run, transport());
  const first = await policy();
  const declaration = first.catalogue!.tools![0]!;
  const review = { serverId, catalogueDigest: first.catalogue!.schemaDigest,
    connectionId: first.connectionId!, accountMode: 'none', policyRevision: first.policyRevision,
    reviewedBy: 'admin', tools: [{ name: declaration.name, revision: declaration.revision,
      reviewDigest: toolReviewDigest(declaration), mode: 'block' }] };
  const reviewed = envelope('test', `mcp-${serverId}`, 'mcp.server_reviewed', review);
  reviewed.principal = { kind: 'human', id: 'admin' };
  expect((await fixture.store.append({ event: reviewed, expectedSequence: first.sequence })).status)
    .toBe('appended');
  expect((await policy()).reviewRevision).toBeDefined();
  const next = { ...run, podUid: 'pod-two', runGeneration: 2 };
  const changed = transport(next, { ...tool, description: 'New meaning' });
  await captureHostedStart(fixture.store, 'test', serverId, next, changed);
  const current = await policy();
  expect(current.previousCatalogue?.schemaDigest).toBe(first.catalogue?.schemaDigest);
  expect(current.catalogue?.schemaDigest).not.toBe(first.catalogue?.schemaDigest);
  expect(current.reviewRevision).toBeUndefined();
  expect(current.tools[0]?.mode).toBe('block');
  expect(current.published).toBe(false);
  const old = transport();
  await expect(captureHostedStart(fixture.store, 'test', serverId, run, old)).rejects.toThrow();
  expect(old.request).not.toHaveBeenCalled();
});

it('recovers a lost start reply and a worker restart without reusing another run', async () => {
  await admitted();
  const append = fixture.store.append.bind(fixture.store);
  const lost = vi.spyOn(fixture.store, 'append');
  lost.mockImplementationOnce(async command => {
    await append(command);
    throw new Error('reply lost');
  });
  const first = transport();
  await captureHostedStart(fixture.store, 'test', serverId, run, first);
  lost.mockRestore();
  const restarted = transport();
  await captureHostedStart(fixture.store, 'test', serverId, run, restarted);
  expect(restarted.request).not.toHaveBeenCalled();
  expect((await policy()).hostedRun).toEqual(run);
});

it('recovers a lost catalogue reply by reading the original saved snapshot', async () => {
  await admitted();
  const append = fixture.store.append.bind(fixture.store);
  const lost = vi.spyOn(fixture.store, 'append');
  lost.mockImplementation(async command => {
    const result = await append(command);
    const attempted = command.event;
    if (attempted && typeof attempted === 'object' && 'type' in attempted &&
        attempted.type === 'mcp.server_discovered') {
      throw new Error('reply lost');
    }
    return result;
  });
  const checked = transport();
  const result = await captureHostedStart(fixture.store, 'test', serverId, run, checked);
  lost.mockRestore();
  expect(result.schemaDigest).toBe((await policy()).catalogue?.schemaDigest);
  const restarted = transport();
  await captureHostedStart(fixture.store, 'test', serverId, run, restarted);
  expect(restarted.request).not.toHaveBeenCalled();
});

it('ends the review after a new Pod even when its definitions are unchanged', async () => {
  await admitted();
  await captureHostedStart(fixture.store, 'test', serverId, run, transport());
  const first = await policy();
  const next = { ...run, podUid: 'pod-two', runGeneration: 2 };
  await captureHostedStart(fixture.store, 'test', serverId, next, transport(next));
  const current = await policy();
  expect(current.catalogue?.schemaDigest).toBe(first.catalogue?.schemaDigest);
  expect(current.policyRevision).toBeGreaterThan(first.policyRevision);
  expect(current.reviewRevision).toBeUndefined();
  expect(current.published).toBe(false);
});

it('closes a captured run when a new image check is requested', async () => {
  await admitted();
  await captureHostedStart(fixture.store, 'test', serverId, run, transport());
  const current = await policy();
  const request = { serverId, attemptId: 2, imageDigest, platform: run.platform,
    registrationRevision: 1, expectedSequence: current.sequence };
  const event = envelope('test', `mcp-${serverId}`, 'mcp.image_check_requested', request);
  const closed = applyToolPolicy(current, event, current.sequence + 1);
  expect(closed.admissionExpiresAt).toBeUndefined();
  expect(closed.reviewRevision).toBeUndefined();
  expect(isToolPolicyAvailable({ ...closed, published: true, driftHeld: false })).toBe(false);
});

it('keeps the new run closed when the Pod changes during discovery', async () => {
  await admitted();
  const checked = transport();
  checked.observe.mockResolvedValueOnce(run);
  checked.observe.mockResolvedValueOnce({ ...run, podUid: 'replacement' });
  await expect(captureHostedStart(fixture.store, 'test', serverId, run, checked))
    .rejects.toThrow('Hosted catalogue capture unavailable');
  const current = await policy();
  expect(current.hostedRun).toEqual(run);
  expect(current.catalogue).toBeNull();
  expect(current.published).toBe(false);
});

it('refuses a catalogue claiming a run that has not been saved; replay starts nothing', async () => {
  await admitted();
  const inventory = await discoverInventory(transport().request);
  const forged = envelope('test', `mcp-${serverId}`, 'mcp.server_discovered',
    { serverId, ...inventory, hostedRun: run,
      connectionId: `installed-${serverId}`, accountMode: 'none' });
  const rows = await history(fixture.store, `mcp-${serverId}`, 'test');
  let state = emptyToolPolicy();
  for (const row of rows) state = applyToolPolicy(state, row.event, row.sequence);
  expect(() => applyToolPolicy(state, forged, state.sequence + 1)).toThrow();
  const forgedStart = envelope('test', `mcp-${serverId}`, 'mcp.hosted_start_observed',
    { serverId, ...run, admissionExpiresAt: new Date(Date.now() + 60_000).toISOString() });
  forgedStart.source = 'untrusted';
  forgedStart.principal = { kind: 'human', id: 'attacker' };
  expect(() => applyToolPolicy(state, forgedStart, state.sequence + 1)).toThrow();
  const checked = transport();
  const replayed = await policy();
  expect(replayed.catalogue).toBeNull();
  expect(checked.observe).not.toHaveBeenCalled();
  expect(checked.request).not.toHaveBeenCalled();
});
