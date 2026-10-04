import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { remoteFixture } from './support/remote-mcp.ts';
import { guardedMcp } from '../src/integrations/guarded-mcp.ts';
import { publishedGateway } from '../src/integrations/published-gateway.ts';
import type { RemoteNetwork } from '../src/integrations/remote.ts';
import { copyFile } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import { fixture } from '@opencrane/models/testing';
import { currentPublication, publicationStatus, history, approvalCards, decideApproval } from '@opencrane/models';
import { approvalJourney } from '../../../infra/dev-stack/approval-journey.ts';

const config = vi.hoisted((): { directory: string; settings: Record<string, string>; network: RemoteNetwork } => ({ directory: '', settings: {}, network: {} }));
vi.mock('../../../infra/dev-stack/mcp-fixture.ts', () => ({ fixtureNetwork: () => Promise.resolve(config.network), fixtureCalls: () => Promise.resolve('[]') }));
vi.mock('../../../infra/dev-stack/config.ts', () => ({
  get directory() { return config.directory; }, readEnv: () => Promise.resolve(config.settings),
}));

it('sets up the approval journey with a reviewed, acknowledged publication', async () => {
  const f = await fixture(2000, 20000, false, 'gpt-6-luna', false, 'reactions');
  const remote = await remoteFixture();
  config.network = remote.network;
  await f.stopGateway();
  const adapter = await guardedMcp(f.nats.store, 'test', f.takeMcpPermit, remote.network);
  const gateway = await publishedGateway(f.nats.store, 'test', adapter.host, f.options);
  let stopped = false;
  const reconcile = (async () => { while (!stopped) { await gateway.reconcile(); await delay(20); } })();
  config.directory = dirname(f.options.configFile);
  config.settings = { OPENFGA_API_URL: f.binding.apiUrl, OPENFGA_STORE_ID: f.binding.storeId, OPENFGA_MODEL_ID: f.binding.authorizationModelId, MODEL_STUB_PORT: f.options.upstream!.split(':')[1]!, MODEL_GATEWAY_PORT: String(f.options.port) };
  await copyFile(`${config.directory}/issuer.pem`, `${config.directory}/token-signing-key.pem`);
  try {
    const result = await approvalJourney([], f.nats.store, f.auth, async (type, subject, data) => { await f.append(subject, type, data); },
      { silo: 'test', origin: 'https://lifecycle.test', requesterId: 'alice', assistantId: 'assistant', computerId: 'computer', generation: 1, adminId: 'alice' });
    const rows = await history(f.nats.store, `mcp-${result.serverId}`, 'test');
    const publication = await currentPublication(f.nats.store, 'test', result.serverId);
    expect(publication?.desired.transport).toBe('guarded-https');
    expect(publication?.desired.tools.map(tool => tool.mode).sort()).toEqual(['allow', 'ask']);
    expect(await publicationStatus(f.nats.store, 'test', result.serverId)).toMatchObject({ state: 'ready', digest: publication?.digest });
    expect(rows.map(row => row.event.type)).toEqual(['mcp.server_registered', 'mcp.server_discovered', 'mcp.server_published', 'mcp.configuration_applied']);
    const call = async (name: string) => {
      const body = JSON.stringify({ jsonrpc: '2.0', id: 'journey-test', method: 'tools/call', params: { name,
        arguments: { order: 'Order-42', note: 'Reviewed note' },
        _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} } } });
      const response = await fetch(`http://127.0.0.1:${f.options.port}${result.desired.route}`, { method: 'POST',
        headers: { ...f.headers, 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call', 'mcp-name': name }, body });
      await response.arrayBuffer(); return response.status;
    };
    expect(await call('write')).toBe(403);
    const cards = await approvalCards(f.nats.store, 'test', 'conversation', 'alice', f.keys);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ state: 'requested', review: { action: 'Update order note', target: 'Order-42' } });
    expect(remote.calls.filter(call => call.method === 'tools/call')).toHaveLength(0);
    expect((await decideApproval(f.nats.store, 'test', cards[0]!.approvalId, 'alice', 'approved', false, () => Promise.resolve())).status).toBe('appended');
    expect(await call('write')).toBe(200);
    expect(await call('write')).toBe(403);
    expect(await call('read')).toBe(200);
    expect(remote.calls.filter(call => call.method === 'tools/call')).toHaveLength(2);
    expect(remote.pinned.every(ip => ip === '93.184.216.34')).toBe(true);
  } finally { stopped = true; await reconcile; await gateway.stop(); await adapter.close(); await remote.close(); await f.close(); }
}, 40_000);
