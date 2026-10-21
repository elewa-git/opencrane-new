import { PGlite } from '@electric-sql/pglite';
import { natsFixture } from '@opencrane/event-store/testing';
import { envelope, history, readToolPolicy } from '@opencrane/models';
import { remoteFixture } from '@opencrane/models/testing/remote-mcp';
import { mcpCatalogue, pgliteDb } from '@opencrane/projections';
import { expect, it, onTestFinished, vi } from 'vitest';
import { discoverInventory } from '../src/integrations/inventory.ts';
import { remoteCatalogueWatch } from '../src/integrations/remote-catalogue-watch.ts';

async function fixture(ttlMs = 600_000) {
  const nats = await natsFixture();
  const engine = new PGlite();
  const db = pgliteDb(engine);
  const remote = await remoteFixture();
  await mcpCatalogue.create(db);
  let description = 'Original';
  function reply(method: string) {
    const cache = { resultType: 'complete', ttlMs, cacheScope: 'public' };
    if (method === 'server/discover') {
      return { ...cache, supportedVersions: ['2026-07-28'], capabilities: { tools: {} },
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'Fixture', version: '1' } } };
    }
    return { ...cache, tools: [{ name: 'read', description, inputSchema: { type: 'object' },
      _meta: { 'io.opencrane/costCents': 0, 'io.opencrane/review': {
        action: 'Read', consequence: 'Reads a record', fields: [], stepUp: false,
      } } }] };
  }
  remote.respond(reply);
  async function call(method: string) { return JSON.stringify(reply(method)); }
  async function append(serverId: string, type: string, data: unknown, silo = 'test') {
    const event = envelope(silo, `mcp-${serverId}`, type, data);
    const expectedSequence = await nats.store.head(event.subject);
    const result = await nats.store.append({ event, expectedSequence });
    if (result.status !== 'appended') throw new Error('Fixture append failed');
    await mcpCatalogue.apply(db, event, result.sequence);
  }
  async function register(serverId: string, silo = 'test') {
    await append(serverId, 'mcp.server_registered', { serverId, kind: 'remote',
      locator: 'https://mcp.example.test/mcp', registeredBy: 'admin' }, silo);
    const inventory = await discoverInventory(call);
    await append(serverId, 'mcp.server_discovered', { ...inventory, serverId,
      connectionId: `installed-${serverId}`, accountMode: 'none' }, silo);
  }
  const requireLeader = vi.fn().mockResolvedValue(undefined);
  const watch = remoteCatalogueWatch(db, nats.store, 'test', requireLeader, remote.network);
  async function cleanup() {
    watch.close();
    vi.restoreAllMocks();
    vi.useRealTimers();
    await remote.close();
    await engine.close();
    await nats.close();
  }
  onTestFinished(cleanup);
  return { nats, db, remote, watch, register, requireLeader,
    change: function change() { description = 'Changed'; } };
}

async function lateRegistration() {
  const setup = await fixture();
  const { watch } = setup;
  await watch.check();
  await setup.register('late');
  expect(() => watch.requireCurrent('late')).toThrow();
  const first = watch.check();
  expect(watch.check()).toBe(first);
  await first;
  watch.requireCurrent('late');
  expect(setup.remote.calls).toHaveLength(2);
  const before = await readToolPolicy(setup.nats.store, 'test', 'late');
  const start = Date.now();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(start + 270_000);
  await watch.check();
  vi.setSystemTime(start + 310_000);
  watch.requireCurrent('late');
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
  expect(() => watch.requireCurrent('late')).toThrow();
}
it('adds late registrations, shares captures, renews beyond five minutes and removes rows',
  lateRegistration);

async function boundedRows() {
  const setup = await fixture();
  await setup.register('foreign', 'other');
  for (let index = 0; index < 33; index++) {
    await setup.register(`server-${String(index).padStart(2, '0')}`);
  }
  await setup.watch.check();
  setup.watch.requireCurrent('server-00');
  expect(() => setup.watch.requireCurrent('server-32')).toThrow();
  expect(() => setup.watch.requireCurrent('foreign')).toThrow();
  expect(() => setup.watch.requireCurrent('missing')).toThrow();
  expect(setup.remote.calls).toHaveLength(64);
}
it('bounds same-silo rows and refuses overflow, foreign and missing servers', boundedRows);

async function heldWatch(mode: 'zero' | 'drift' | 'leader' | 'restart') {
  const setup = await fixture(mode === 'zero' ? 0 : 600_000);
  await setup.register('held');
  await setup.watch.check();
  if (mode === 'drift') {
    setup.change();
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
    expect(() => replacement.requireCurrent('held')).toThrow();
  }
  expect(() => setup.watch.requireCurrent('held')).toThrow();
}
it.each(['zero', 'drift', 'leader', 'restart'] as const)(
  'keeps remote calls held after %s', heldWatch);
