import { expect, it, vi } from 'vitest';
import { parseEventByType, type EventEnvelope } from '@opencrane/events';
import { grantStream } from '@opencrane/authz';
import { currentAuthority } from '../src/index.ts';
import { catalogueEvidence, fixture, toolEvidence } from './fixture.ts';

function unrelated(index: number): EventEnvelope {
  const id = `unrelated-${index}`;
  const base = { id, commandId: id, silo: 'test', source: 'test', time: '2026-10-04T00:00:00Z',
    principal: { kind: 'system' as const, id: 'seed' }, correlation: {} };
  switch (index % 5) {
    case 0: return { ...base, subject: `member-${id}`, type: 'member.joined', data: { memberId: id, email: `${id}@example.test`, displayName: id, role: 'member' } };
    case 1: return { ...base, subject: `team-${id}`, type: 'team.created', data: { teamId: id, name: id, createdBy: id } };
    case 2: return { ...base, subject: `conversation-${id}`, type: 'conversation.created', data: { conversationId: id, assistantId: id, createdBy: id, mode: 'agent_session' } };
    case 3: return { ...base, subject: grantStream('model', id), type: 'grant.given', data: { resourceType: 'model', resourceId: id, granteeId: id, granteeKind: 'member', grantedBy: id } };
    default: return { ...base, subject: `assistant-${id}`, type: 'assistant.created', data: { assistantId: id, ownerId: id, kind: 'personal' } };
  }
}

it('keeps decisions below the egress and ext_authz bounds with 100,000 unrelated events', async () => {
  const counts: Record<string, number[]> = {};
  const latencies: { times: number[]; bound: number }[] = [];
  for (const seeded of [0, 100_000]) {
    const f = await fixture(1_000_000, 1_000_000);
    try {
      // Equal local history in each run; background replay is outside admission timing.
      await f.stopDispatch(); await f.runtime.stop();
      await f.append('mcp-fixture', 'mcp.server_registered', { serverId: 'fixture', kind: 'remote', locator: 'https://fixture.example.test/mcp', registeredBy: 'alice' });
      const tool = toolEvidence({ name: 'read', reviewed: true, readOnly: true, costCents: 0 });
      const catalogue = catalogueEvidence([tool]);
      await f.append('mcp-fixture', 'mcp.server_discovered', { serverId: 'fixture',
        connectionId: 'installed', accountMode: 'none', ...catalogue });
      await f.append('mcp-fixture', 'mcp.server_published', {
        serverId: 'fixture', publishedBy: 'alice' });
      await f.append('mcp-fixture', 'mcp.tool_mode_set', { serverId: 'fixture',
        connectionId: 'installed', toolName: 'read', toolRevision: tool.revision,
        mode: 'allow', setBy: 'alice' });
      for (const [resourceType, resourceId] of [['mcp_server', 'fixture'], ['destination', 'docs']] as const) {
        for (const [granteeId, granteeKind] of [['alice', 'member'], ['assistant', 'assistant']] as const) {
          const event = await f.append(grantStream(resourceType, resourceId), 'grant.given', { resourceType, resourceId, granteeId, granteeKind, grantedBy: 'alice' });
          await f.auth.handler.handle(event, f.db);
        }
      }
      for (let i = 0; i < 5; i++) expect(parseEventByType(unrelated(i)).success).toBe(true);
      const before = await f.nats.store.head();
      for (let offset = 0; offset < seeded; offset += 100) {
        await f.nats.seed(Array.from({ length: 100 }, (_, i) => unrelated(offset + i)));
      }
      expect(await f.nats.store.head()).toBe(before + seeded);
      const readStream = f.nats.store.readStream.bind(f.nats.store);
      let reads: string[] = [], rows = 0;
      const probe = vi.spyOn(f.nats.store, 'readStream').mockImplementation(async function* (...args) {
        reads.push(args[0]);
        for await (const row of readStream(...args)) {
          if (args[0] !== 'budget-test' && !args[0].startsWith('decision-')) rows++;
          yield row;
        }
      });
      try {
        // Refresh short-lived credentials after seeding; token issuance is outside admission timing.
        const headers = { ...f.headers, authorization: `Bearer ${await f.sign(f.c, 'agentgateway')}`,
          'x-turn-token': await f.sign(f.t, 'decision-service') };
        const calls = {
          model: async () => {
            const response = await fetch(`${f.options.decisionUrl}/authorize`, { method: 'POST', headers,
              body: JSON.stringify({ model: 'gpt-6-luna', input: 'OK', max_output_tokens: 128, stream: true }) });
            expect(response.status, await response.text()).toBe(200);
          },
          mcp: async () => {
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
            const response = await fetch(`${f.options.decisionUrl}/authorize/mcp/fixture/installed`,
              request);
            expect(response.status, await response.text()).toBe(200);
          },
          destinationAuthority: () => currentAuthority(f.nats.store, f.binding, 'alice', 'assistant', 'conversation', 'destination', 'docs'),
        };
        for (const [route, call] of Object.entries(calls)) {
          const times: number[] = [];
          for (let sample = 0; sample < 30; sample++) {
            reads = []; rows = 0;
            const started = performance.now(); await call(); times.push(performance.now() - started);
            expect(reads.some(subject => subject.includes('*') || subject.includes('unrelated'))).toBe(false);
            // Budget append idempotency reads its own growing stream; authority traffic stays constant.
            counts[`${seeded}:${route}`] ??= [];
            counts[`${seeded}:${route}`]!.push(rows);
          }
          times.sort((a, b) => a - b);
          const p50 = times[14]!, p95 = times[28]!;
          console.log(JSON.stringify({ seeded, route, samples: times.length, p50Ms: p50, p95Ms: p95, authorityEvents: rows, authorityStreamReads: reads.filter(subject => subject !== 'budget-test' && !subject.startsWith('decision-')).length }));
          latencies.push({ times, bound: route === 'destinationAuthority' ? 1000 : 2000 });
        }
      } finally { probe.mockRestore(); }
    } finally { await f.close(); }
  }
  for (const route of ['model', 'mcp', 'destinationAuthority']) expect(counts[`100000:${route}`]).toEqual(counts[`0:${route}`]);
  for (const { times, bound } of latencies) {
    expect(times[28]).toBeLessThan(bound / 2);
    expect(times.at(-1)).toBeLessThan(bound);
  }
}, 300_000);
