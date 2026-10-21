import { z } from 'zod';
import { databases } from '@opencrane/authz/testing';
import { natsFixture } from '@opencrane/event-store/testing';
import { envelope, history, readToolPolicy } from '@opencrane/models';
import { remoteFixture } from '@opencrane/models/testing/remote-mcp';
import { mcpCatalogue, pgDb } from '@opencrane/projections';
import { expect, it, onTestFinished, vi } from 'vitest';
import { discoverInventory } from '../src/integrations/inventory.ts';
import { remoteCatalogueWatch } from '../src/integrations/remote-catalogue-watch.ts';

async function fixture(ttlMs = 600_000) {
  const nats = await natsFixture();
  const storage = await databases();
  const db = pgDb(storage.queue);
  const remote = await remoteFixture();
  await mcpCatalogue.create(db);
  let description = 'Original';
  let costCents: number | undefined = 0;
  let action = 'Read';
  function reply(method: string) {
    const cache = { resultType: 'complete', ttlMs, cacheScope: 'public' };
    if (method === 'server/discover') {
      return { ...cache, supportedVersions: ['2026-07-28'], capabilities: { tools: {} },
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'Fixture', version: '1' } } };
    }
    return { ...cache, tools: [{ name: 'read', description, inputSchema: { type: 'object' },
      _meta: { 'io.opencrane/costCents': costCents, 'io.opencrane/review': {
        action, consequence: 'Reads a record', targetArgument: 'record',
        fields: ['record'], stepUp: false,
      } } }] };
  }
  remote.respond(reply);
  function call(method: string) {
    const resultJson = JSON.stringify(reply(method));
    return Promise.resolve(resultJson);
  }
  async function append(serverId: string, type: string, data: unknown, silo = 'test') {
    const event = envelope(silo, `mcp-${serverId}`, type, data);
    const expectedSequence = await nats.store.head(event.subject);
    const result = await nats.store.append({ event, expectedSequence });
    if (result.status !== 'appended') {
      throw new Error('Fixture append failed');
    }
    await mcpCatalogue.apply(db, event, result.sequence);
  }
  async function register(serverId: string, silo = 'test') {
    await append(serverId, 'mcp.server_registered', { serverId, kind: 'remote',
      locator: 'https://mcp.example.test/mcp', registeredBy: 'admin' }, silo);
    const inventory = await discoverInventory(call);
    expect(inventory.tools).toHaveLength(1);
    await append(serverId, 'mcp.server_discovered', { ...inventory, serverId,
      connectionId: `installed-${serverId}`, accountMode: 'none' }, silo);
  }
  const requireLeader = vi.fn();
  requireLeader.mockResolvedValue(undefined);
  const watch = remoteCatalogueWatch(db, nats.store, 'test', requireLeader, remote.network);
  async function cleanup() {
    watch.close();
    vi.restoreAllMocks();
    vi.useRealTimers();
    await remote.close();
    await storage.close();
    await nats.close();
  }
  onTestFinished(cleanup);
  function change(mode: string) {
    if (mode === 'cost') {
      costCents = undefined;
    } else if (mode === 'details') {
      action = 'Inspect';
    } else if (mode === 'restore') {
      description = 'Original';
    } else {
      description = 'Changed';
    }
  }
  return { nats, db, remote, watch, register, requireLeader, change };
}

function expectHeld(watch: ReturnType<typeof remoteCatalogueWatch>, serverId: string) {
  function requireCurrent() {
    watch.requireCurrent(serverId);
  }
  expect(requireCurrent).toThrow();
}

async function lateRegistration() {
  const setup = await fixture();
  const { watch } = setup;
  await watch.check();
  await setup.register('late');
  expectHeld(watch, 'late');
  const first = watch.check();
  const concurrent = watch.check();
  await Promise.all([first, concurrent]);
  watch.requireCurrent('late');
  expect(setup.remote.calls).toHaveLength(2);
  const before = await readToolPolicy(setup.nats.store, 'test', 'late');
  const start = Date.now();
  vi.useFakeTimers({ toFake: ['Date'] });
  for (let elapsed = 1000; elapsed <= 310_000; elapsed += 1000) {
    vi.setSystemTime(start + elapsed);
    await watch.check();
    watch.requireCurrent('late');
  }
  const after = await readToolPolicy(setup.nats.store, 'test', 'late');
  expect(after.policyRevision).toBe(before.policyRevision);
  expect(setup.remote.calls).toHaveLength(4);
  for (const call of setup.remote.calls) {
    expect(call.headers.authorization).toBeUndefined();
    expect(call.hostname).toBe('mcp.example.test');
    expect(['server/discover', 'tools/list']).toContain(call.method);
  }
  await setup.db.query('DELETE FROM mcp_catalogue WHERE server_id = $1', ['late']);
  await watch.check();
  expectHeld(watch, 'late');
}
it('adds late registrations, shares captures, renews beyond five minutes and removes rows',
  lateRegistration);

async function boundedRows() {
  const setup = await fixture();
  await setup.register('foreign', 'other');
  for (let index = 0; index < 33; index++) {
    await setup.register(`server-${String(index).padStart(2, '0')}`);
  }
  const failed = vi.fn();
  const polling = setInterval(setup.watch.tick, 100, failed);
  function stopPolling() {
    clearInterval(polling);
  }
  onTestFinished(stopPolling);
  await setup.watch.check();
  expect(failed).not.toHaveBeenCalled();
  setup.watch.requireCurrent('server-00');
  expectHeld(setup.watch, 'server-32');
  expectHeld(setup.watch, 'foreign');
  expectHeld(setup.watch, 'missing');
  expect(setup.remote.calls).toHaveLength(64);
}
it('bounds same-silo rows and refuses overflow, foreign and missing servers', boundedRows);

async function heldWatch(mode: 'zero' | 'drift' | 'cost' | 'details' | 'leader' | 'restart') {
  const setup = await fixture(mode === 'zero' ? 0 : 600_000);
  await setup.register('held');
  await setup.watch.check();
  if (['drift', 'cost', 'details'].includes(mode)) {
    setup.change(mode);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 270_000);
    await setup.watch.check();
    const rows = await history(setup.nats.store, 'mcp-held', 'test');
    expect(rows.at(-1)?.event.type).toBe('mcp.tools_changed');
  }
  if (mode === 'leader') {
    setup.requireLeader.mockRejectedValue(new Error('Lost lease'));
    await expect(setup.watch.check()).rejects.toThrow();
  }
  if (mode === 'restart') {
    setup.watch.close();
    const replacement = remoteCatalogueWatch(setup.db, setup.nats.store, 'test',
      setup.requireLeader, setup.remote.network);
    onTestFinished(replacement.close);
    expectHeld(replacement, 'held');
  }
  expectHeld(setup.watch, 'held');
}
it.each(['zero', 'drift', 'cost', 'details', 'leader', 'restart'] as const)(
  'keeps remote calls held after %s', heldWatch);

async function unavailableRows() {
  const setup = await fixture();
  await setup.register('held');
  await setup.watch.check();
  const before = await readToolPolicy(setup.nats.store, 'test', 'held');
  const reader = vi.spyOn(setup.db, 'query');
  reader.mockRejectedValue(new Error('ROW_SECRET_CANARY'));
  await expect(setup.watch.check()).rejects.toThrow('Catalogue rows unavailable');
  expectHeld(setup.watch, 'held');
  reader.mockRestore();
  await setup.watch.check();
  const after = await readToolPolicy(setup.nats.store, 'test', 'held');
  expect(after.policyRevision).toBeGreaterThan(before.policyRevision);
  const saved = await history(setup.nats.store, 'mcp-held', 'test');
  expect(JSON.stringify(saved)).not.toContain('ROW_SECRET_CANARY');
}
it('invalidates old approvals after a row-read failure', unavailableRows);

async function failedDriftAppend() {
  const setup = await fixture();
  await setup.register('held');
  await setup.watch.check();
  setup.change('drift');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now() + 270_000);
  const append = setup.nats.store.append.bind(setup.nats.store);
  async function refuseDrift(command: Parameters<typeof append>[0]) {
    const event = z.object({ type: z.string() }).parse(command.event);
    if (event.type === 'mcp.tools_changed') {
      expectHeld(setup.watch, 'held');
      throw new Error('Store unavailable');
    }
    return append(command);
  }
  const writer = vi.spyOn(setup.nats.store, 'append');
  writer.mockImplementation(refuseDrift);
  await expect(setup.watch.check()).rejects.toThrow();
  writer.mockRestore();
  await setup.db.query("UPDATE mcp_catalogue SET source_kind = 'hosted'");
  await setup.watch.check();
  await setup.db.query("UPDATE mcp_catalogue SET source_kind = 'remote'");
  setup.change('restore');
  vi.setSystemTime(Date.now() + 5000);
  await setup.watch.check();
  expectHeld(setup.watch, 'held');
}
it('keeps an unsaved drift hold through row removal and an unchanged recapture', failedDriftAppend);

async function refusesWildcardRow() {
  const setup = await fixture();
  await setup.register('held');
  await setup.db.query("UPDATE mcp_catalogue SET server_id = '*'");
  const reader = vi.spyOn(setup.nats.store, 'readStream');
  await expect(setup.watch.check()).rejects.toThrow('Catalogue rows unavailable');
  expect(reader).not.toHaveBeenCalled();
}
it('refuses a wildcard catalogue id before reading event history', refusesWildcardRow);
