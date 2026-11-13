import { appendFile } from 'node:fs/promises';
import type { EventStore } from '@opencrane/event-store';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseEventByType, type EventEnvelope } from '@opencrane/events';
import { grantStream } from '@opencrane/authz';
import { currentAuthority } from '@opencrane/models';
import {
  reviewCatalogue, catalogueEvidence, fixture, toolEvidence,
} from '../../../libs/models/test/fixture.ts';

type ModelFixture = Awaited<ReturnType<typeof fixture>>;

async function mockTesting(importOriginal: () => Promise<
  typeof import('@opencrane/event-store/testing')>) {
  const original = await importOriginal();
  async function natsFixture() {
    const nats = await original.natsFixture();
    if (process.env['SPIKE_BACKEND'] !== 'postgres') {
      return nats;
    }
    const connectionString = process.env['SPIKE_PG_URL'];
    if (!connectionString) {
      throw new Error('Set SPIKE_PG_URL to the private measurement container');
    }
    const { postgresFixture } = await import('../src/postgres-fixture.ts');
    const postgres = await postgresFixture(connectionString);
    async function close() {
      await postgres.close();
      await nats.close();
    }
    // Keep NATS for the idle dispatcher. Measured log calls use PostgreSQL.
    // Callbacks omit accessSubjects here, so PostgreSQL latency evidence remains PARTIAL.
    const store = postgres.store as unknown as EventStore;
    return { ...nats, store, seed: postgres.seed, close };
  }
  return { ...original, natsFixture };
}
vi.mock('@opencrane/event-store/testing', mockTesting);

function unrelated(index: number): EventEnvelope {
  const id = `unrelated-${index}`;
  const base = {
    id, commandId: id, silo: 'test', source: 'test', time: '2026-10-04T00:00:00Z',
    principal: { kind: 'system' as const, id: 'seed' }, correlation: {},
  };
  switch (index % 5) {
    case 0:
      return { ...base, subject: `member-${id}`, type: 'member.joined',
        data: { memberId: id, email: `${id}@example.test`, displayName: id, role: 'member' } };
    case 1:
      return { ...base, subject: `team-${id}`, type: 'team.created',
        data: { teamId: id, name: id, createdBy: id } };
    case 2:
      return { ...base, subject: `conversation-${id}`, type: 'conversation.created',
        data: { conversationId: id, assistantId: id, createdBy: id, mode: 'agent_session' } };
    case 3:
      return { ...base, subject: grantStream('model', id), type: 'grant.given',
        data: { resourceType: 'model', resourceId: id, granteeId: id,
          granteeKind: 'member', grantedBy: id } };
    default:
      return { ...base, subject: `assistant-${id}`, type: 'assistant.created',
        data: { assistantId: id, ownerId: id, kind: 'personal' } };
  }
}

async function prepareFixture(f: ModelFixture) {
  // Equal local history in each run; background replay is outside admission timing.
  await f.stopDispatch();
  await f.runtime.stop();
  await f.append('mcp-fixture', 'mcp.server_registered', {
    serverId: 'fixture', kind: 'remote', locator: 'https://fixture.example.test/mcp',
    registeredBy: 'alice',
  });
  const tool = toolEvidence({ name: 'read', reviewed: true, readOnly: true, costCents: 0 });
  const catalogue = catalogueEvidence([tool]);
  await f.append('mcp-fixture', 'mcp.server_discovered', {
    serverId: 'fixture', connectionId: 'installed', accountMode: 'none', ...catalogue,
  });
  await reviewCatalogue(f);
  await f.append('mcp-fixture', 'mcp.server_published', {
    serverId: 'fixture', publishedBy: 'alice',
  });
  await f.append('mcp-fixture', 'mcp.tool_mode_set', {
    serverId: 'fixture', connectionId: 'installed', toolName: 'read',
    toolRevision: tool.revision, mode: 'allow', setBy: 'alice',
  });
  await f.append('mcp-fixture', 'mcp.server_published', {
    serverId: 'fixture', publishedBy: 'alice',
  });
  const resources = [['mcp_server', 'fixture'], ['destination', 'docs']] as const;
  const grantees = [['alice', 'member'], ['assistant', 'assistant']] as const;
  for (const [resourceType, resourceId] of resources) {
    for (const [granteeId, granteeKind] of grantees) {
      const data = { resourceType, resourceId, granteeId, granteeKind, grantedBy: 'alice' };
      const event = await f.append(grantStream(resourceType, resourceId), 'grant.given', data);
      await f.auth.handler.handle(event, f.db);
    }
  }
}

async function seedUnrelated(f: ModelFixture, seeded: number) {
  for (let index = 0; index < 5; index++) {
    expect(parseEventByType(unrelated(index)).success).toBe(true);
  }
  const before = await f.nats.store.head();
  for (let offset = 0; offset < seeded; offset += 100) {
    function batchEvent(_unused: unknown, index: number) {
      return unrelated(offset + index);
    }
    const batch = Array.from({ length: 100 }, batchEvent);
    await f.nats.seed(batch);
  }
  expect(await f.nats.store.head()).toBe(before + seeded);
}

function observeReads(store: EventStore) {
  const readStream = store.readStream.bind(store);
  let reads: string[] = [];
  let rows = 0;
  async function* countAuthorityReads(...args: Parameters<typeof readStream>) {
    reads.push(args[0]);
    for await (const row of readStream(...args)) {
      if (args[0] !== 'budget-test' && !args[0].startsWith('decision-')) {
        rows++;
      }
      yield row;
    }
  }
  const spy = vi.spyOn(store, 'readStream');
  spy.mockImplementation(countAuthorityReads);
  function reset() {
    reads = [];
    rows = 0;
  }
  function snapshot() {
    return { reads, rows };
  }
  function close() {
    spy.mockRestore();
  }
  return { reset, snapshot, close };
}

async function decisionCalls(f: ModelFixture) {
  // Refresh credentials after seeding; token issuance is outside admission timing.
  const headers = { ...f.headers, authorization: `Bearer ${await f.sign(f.c, 'agentgateway')}`,
    'x-turn-token': await f.sign(f.t, 'decision-service') };
  async function model() {
    const body = { model: 'gpt-6-luna', input: 'OK', max_output_tokens: 128, stream: true };
    const request = { method: 'POST', headers, body: JSON.stringify(body) };
    const response = await fetch(`${f.options.decisionUrl}/authorize`, request);
    expect(response.status, await response.text()).toBe(200);
  }
  async function mcp() {
    const metadata = {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientCapabilities': {},
      threadId: 'thread', callId: 'call_probe_1',
    };
    const params = { name: 'read', arguments: {}, _meta: metadata };
    const body = { jsonrpc: '2.0', id: 1, method: 'tools/call', params };
    const requestHeaders = { ...headers, 'mcp-protocol-version': '2026-07-28',
      'mcp-method': 'tools/call', 'mcp-name': 'read' };
    const request = { method: 'POST', headers: requestHeaders, body: JSON.stringify(body) };
    const response = await fetch(`${f.options.decisionUrl}/authorize/mcp/fixture/installed`, request);
    expect(response.status, await response.text()).toBe(200);
  }
  function destinationAuthority() {
    return currentAuthority(f.nats.store, f.binding, 'alice', 'assistant', 'conversation',
      'destination', 'docs');
  }
  return { model, mcp, destinationAuthority };
}

function readsUnrelatedSubject(subject: string) {
  return subject.includes('*') || subject.includes('unrelated');
}

function ascending(first: number, second: number) {
  return first - second;
}

describe.each(['jetstream', 'postgres'])('%s', volumeSuite);

function volumeSuite(backend: string) {
  function chooseBackend() {
    process.env['SPIKE_BACKEND'] = backend;
  }
  beforeEach(chooseBackend);
  async function measureDecisions() {
    const counts: Record<string, number[]> = {};
    const latencies: { times: number[]; bound: number }[] = [];
    for (const seeded of [0, 100_000]) {
      const f = await fixture(1_000_000, 1_000_000);
      try {
        await prepareFixture(f);
        await seedUnrelated(f, seeded);
        const probe = observeReads(f.nats.store);
        try {
          const calls = await decisionCalls(f);
          for (const [route, call] of Object.entries(calls)) {
            const times: number[] = [];
            for (let sample = 0; sample < 30; sample++) {
              probe.reset();
              const started = performance.now();
              await call();
              times.push(performance.now() - started);
              const observed = probe.snapshot();
              expect(observed.reads.some(readsUnrelatedSubject)).toBe(false);
              // Budget history grows; the other authority traffic must stay constant.
              counts[`${seeded}:${route}`] ??= [];
              counts[`${seeded}:${route}`]!.push(observed.rows);
            }
            times.sort(ascending);
            const p50 = times[14]!;
            const p95 = times[28]!;
            const observed = probe.snapshot();
            const result = { backend, seeded, route, samples: times.length, p50Ms: p50,
              p95Ms: p95, maxMs: times.at(-1), timesMs: times,
              authorityEvents: observed.rows, authorityStreamReads: observed.reads.length };
            console.log(JSON.stringify(result));
            const output = `${JSON.stringify(result)}\n`;
            await appendFile('spikes/s0-9-postgres-event-store/results/latency.jsonl', output);
            latencies.push({ times, bound: route === 'destinationAuthority' ? 1000 : 2000 });
          }
        } finally {
          probe.close();
        }
      } finally {
        await f.close();
      }
    }
    for (const route of ['model', 'mcp', 'destinationAuthority']) {
      expect(counts[`100000:${route}`]).toEqual(counts[`0:${route}`]);
    }
    for (const { times, bound } of latencies) {
      expect(times[28]).toBeLessThan(bound / 2);
      expect(times.at(-1)).toBeLessThan(bound);
    }
  }
  it('keeps decisions below the egress and ext_authz bounds with 100,000 unrelated events',
    measureDecisions, 300_000);
}
