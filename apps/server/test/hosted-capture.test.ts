import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { natsFixture } from '@opencrane/event-store/testing';
import { envelope, history, toolPolicyFromRows } from '@opencrane/models';
import { discoverInventory } from '../src/integrations/inventory.ts';
import { captureHostedStart } from '../src/integrations/hosted-capture.ts';

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
    'io.opencrane/review': { stepUp: false, scopes: [], risk: 'low' } } };
let fixture: Awaited<ReturnType<typeof natsFixture>>;

function transport(currentRun = run, definition: unknown = tool) {
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

async function admitted() {
  const registration = { serverId, kind: 'hosted', locator, registeredBy: 'admin',
    installation: { attemptId: 1, platform: 'linux/amd64',
      upstream: { host: 'api.example.com', port: 443 } } };
  await save('mcp.server_registered', registration, 0);
  const checkedAt = new Date(Date.now() - 1000).toISOString();
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
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
  const wrongPod = transport({ ...run, podUid: 'replacement' });
  await expect(captureHostedStart(fixture.store, 'test', serverId, run, wrongPod))
    .rejects.toThrow();
  expect(wrongPod.request).not.toHaveBeenCalled();
  expect((await policy()).catalogue).toBeNull();
});
