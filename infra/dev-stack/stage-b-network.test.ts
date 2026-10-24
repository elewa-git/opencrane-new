import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { prepareRemote, exchangeRemote, type RemoteNetwork } from '@opencrane/models';
import { catalogueDigest } from '@opencrane/events/mcp-catalogue';
import { losslessJson } from '@opencrane/events/lossless-json';
import { createDemoServer } from '../../apps/demo-mcp/src/server.ts';
import { catalogue } from '../../apps/demo-mcp/src/tools.ts';
import { stageBNetwork } from './test/stage-b-network.ts';
import { demoLocator } from './test/demo-remote.ts';

async function sharedDemo() {
  const directory = await mkdtemp(`${tmpdir()}/stage-b-network-`);
  const demo = createDemoServer();
  await demo.listen({ path: `${directory}/stage-b-demo.sock` });
  const discovery = await stageBNetwork(directory);
  const dispatch = await stageBNetwork(directory);
  try {
    const before = await call(discovery.network, 'read_fixture_quote');
    assert.equal(before.effectCount, 0);
    await call(dispatch.network, 'change_delivery_slot');
    const after = await call(discovery.network, 'read_fixture_quote');
    assert.equal(after.effectCount, 1);
    assert.equal(after.slot, 'afternoon');
    assert.equal(after.amountCents, 12500);
  } finally {
    await discovery.close();
    await dispatch.close();
    await demo.close();
    await rm(directory, { recursive: true, force: true });
  }
}
test('separate guarded transports reach one demo server and read back its actual effect', sharedDemo);

function definition(tool: typeof catalogue.tools[number]) {
  return { name: tool.name, revision: losslessJson(JSON.stringify(tool)).digest };
}
async function call(network: RemoteNetwork, name: string) {
  const tools = catalogue.tools.map(definition);
  const revision = catalogueDigest(tools);
  const signal = AbortSignal.timeout(5000);
  const target = await prepareRemote(demoLocator, network, signal);
  const args = { quoteId: 'DEMO-001',
    ...(name === 'change_delivery_slot' ? { slot: 'afternoon' } : {}) };
  const params = { name, arguments: args,
    _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } };
  const raw = JSON.stringify({ jsonrpc: '2.0', id: 'transport-check', method: 'tools/call', params });
  const headers = { 'content-type': 'application/json', 'mcp-protocol-version': '2026-07-28',
    'mcp-method': 'tools/call', 'mcp-name': name, 'x-opencrane-mcp-revision': revision };
  const reply = await exchangeRemote(target, raw, headers, network, signal, 1048576);
  const result = JSON.parse(reply.data.toString()) as {
    result: { structuredContent: { effectCount: number; slot: string; amountCents: number } } };
  return result.result.structuredContent;
}

async function refuseMissingDemo() {
  await assert.rejects(stageBNetwork('/missing-stage-b-directory'),
    /Local demo socket unavailable/u);
}
test('missing local transport refuses before services start', refuseMissingDemo);
