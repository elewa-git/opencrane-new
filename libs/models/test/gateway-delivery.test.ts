import { readFile, rename, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { expect, it, onTestFinished } from 'vitest';
import { natsFixture } from '@opencrane/event-store/testing';
import { envelope, history } from '../src/actor.ts';
import { publicationDigest } from '../src/publication.ts';
import { gatewayConfigurationCurrent, prepareGatewayConfiguration }
  from '../src/gateway-generation.ts';
import { gatewayDelivery } from '../src/gateway-delivery.ts';
import { freePort, gatewayFixture } from './gateway-delivery-fixture.ts';

async function fixture() {
  const nats = await natsFixture();
  onTestFinished(nats.close);
  const setup = await gatewayFixture();
  const digest = 'a'.repeat(64);
  const entry = { serverId: 'alpha', connectionId: 'installed', accountMode: 'none' as const,
    reviewRevision: 1, catalogueDigest: digest, tools: [
      { name: 'read', mode: 'allow' as const, revision: digest, reviewDigest: digest },
      { name: 'delete', mode: 'block' as const, revision: digest, reviewDigest: digest },
    ] };
  await nats.seed([envelope('test', 'mcp-alpha', 'mcp.server_published',
    { serverId: 'alpha', publishedBy: 'admin' })]);
  const member = { entry, sourceSequence: await nats.store.head('mcp-alpha'),
    fragmentDigest: publicationDigest(entry), changeRef: 'publish-alpha' };
  const saved = { changeRef: 'publish-alpha', generation: 1, rendererVersion: '1' as const,
    members: [member] };
  const record = { ...saved, recordDigest: publicationDigest(saved) };
  await nats.seed([envelope('test', 'gateway-config-test', 'gateway.configuration_requested', record)]);
  const settings = { ...setup.options,
    memoryRoute: { serverId: 'memory', connectionId: 'internal', upstream: 'unused' } };
  const options = { store: nats.store, silo: 'test', child: setup.child,
    configFile: setup.options.configFile, controlPort: await freePort(), settings };
  const delivery = gatewayDelivery(options);
  await delivery.deliver(record);
  async function acknowledged() {
    expect(await delivery.observe()).not.toBeNull();
  }
  return { ...setup, nats, record, delivery, options, acknowledged };
}

async function recordsOnlyLiveAcknowledgement() {
  const setup = await fixture();
  const subject = 'gateway-config-test';
  expect(await history(setup.nats.store, subject, 'test')).toHaveLength(1);
  await expect.poll(setup.acknowledged, { timeout: 5000 }).toBeUndefined();
  const rows = await history(setup.nats.store, subject, 'test');
  expect(rows).toHaveLength(2);
  expect(rows[1]!.event.type).toBe('gateway.configuration_observed');
  expect(rows[1]!.event.data).toMatchObject({ generation: 1,
    recordDigest: setup.record.recordDigest, outcome: 'loaded' });
  expect(await setup.delivery.observe()).toEqual(rows[1]);
  expect(await gatewayConfigurationCurrent(setup.nats.store, 'test', setup.record)).toBe(true);
  expect(await prepareGatewayConfiguration(setup.nats.store, 'test', 'alpha', 'publish-alpha'))
    .toEqual(setup.record);
  const restarted = gatewayDelivery(setup.options);
  expect(await restarted.observe()).toBeNull();
  const bytes = await readFile(setup.options.configFile);
  await restarted.deliver(setup.record, 'replay');
  expect(await restarted.observe()).toBeNull();
  expect(await readFile(setup.options.configFile)).toEqual(bytes);
  expect(await history(setup.nats.store, subject, 'test')).toHaveLength(2);
  await setup.gateway.stop('SIGKILL');
  expect(await setup.delivery.observe()).toBeNull();
}
it('records one exact live observation; replay and another process cannot acknowledge',
  recordsOnlyLiveAcknowledgement);

async function sends(setup: Awaited<ReturnType<typeof fixture>>, method: string,
  extra: string[]) {
  const headers = ['authorization', `Bearer ${setup.pass}`, 'content-type', 'application/json',
    'mcp-protocol-version', '2026-07-28', 'x-request-id', 'fixture', ...extra];
  return new Promise<number>(send);
  function send(resolve: (status: number) => void, reject: (error: Error) => void) {
    const options = { hostname: '127.0.0.1', port: setup.options.settings.port,
      path: '/mcp/alpha/installed', method, headers, signal: AbortSignal.timeout(2000) };
    function received(response: import('node:http').IncomingMessage) {
      response.resume();
      response.on('end', completed);
      function completed() { resolve(response.statusCode!); }
    }
    const outgoing = request(options, received);
    outgoing.on('error', reject);
    outgoing.end('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"read"}}');
  }
}

async function enforcesRenderedRules() {
  const setup = await fixture();
  await expect.poll(setup.acknowledged, { timeout: 5000 }).toBeUndefined();
  const allowed = ['mcp-method', 'tools/call', 'mcp-name', 'read'];
  expect(await sends(setup, 'POST', allowed)).toBe(200);
  function dispatched(item: typeof setup.traffic[number]) { return item.path.startsWith('/dispatch'); }
  expect(setup.traffic.filter(dispatched)).toHaveLength(1);
  const refused = [[], ['mcp-name', 'read'], ['mcp-method', 'tools/call'],
    ['mcp-method', 'tools/list', 'mcp-name', 'read'],
    ['mcp-method', 'tools/call', 'mcp-name', 'delete'],
    ['mcp-method', 'tools/call', 'mcp-name', 'unreviewed'],
    [...allowed, 'mcp-name', 'read'], [...allowed, 'mcp-name', ''],
    [...allowed, 'mcp-method', 'tools/call'], [...allowed, 'mcp-method', '']];
  for (const headers of refused) {
    expect(await sends(setup, 'POST', headers)).toBeGreaterThanOrEqual(400);
  }
  for (const method of ['GET', 'PUT', 'DELETE']) {
    expect(await sends(setup, method, allowed)).toBeGreaterThanOrEqual(400);
  }
  expect(setup.traffic.filter(dispatched)).toHaveLength(1);
  const identity = { 'x-opencrane-gateway-generation': '1',
    'x-opencrane-record-digest': setup.record.recordDigest, 'x-opencrane-server-id': 'alpha',
    'x-opencrane-connection-id': 'installed', 'x-opencrane-review-revision': '1' };
  for (const copies of [1, 2]) {
    const spoofed = [...allowed, 'x-private-canary', 'CLIENT-HEADER-CANARY'];
    for (const name of Object.keys(identity)) {
      for (let index = 0; index < copies; index++) {
        spoofed.push(name, 'CLIENT-HEADER-CANARY');
      }
    }
    expect(await sends(setup, 'POST', spoofed)).toBe(200);
    expect(setup.traffic.at(-2)!.headers).toMatchObject(identity);
  }
  const outbound = setup.traffic.filter(dispatched);
  for (const item of outbound) {
    expect(Object.keys(item.headers).sort()).toEqual(['accept', 'content-length', 'content-type',
      'host', 'mcp-method', 'mcp-name', 'mcp-protocol-version', 'x-request-id']);
  }
  const evidence = JSON.stringify([await readFile(setup.options.configFile, 'utf8'),
    setup.traffic, setup.logs]);
  for (const canary of ['KEY-FILE-CANARY', 'CLIENT-HEADER-CANARY', 'CATALOGUE-CANARY']) {
    expect(evidence).not.toContain(canary);
  }
}
it('enforces reviewed rules before an allow-all stub and removes spoofed identity headers',
  enforcesRenderedRules);

async function rejectsStaleOrWrongWitnesses() {
  const setup = await fixture();
  await expect.poll(setup.acknowledged, { timeout: 5000 }).toBeUndefined();
  const bytes = await readFile(setup.options.configFile, 'utf8');
  const sibling = `${setup.options.configFile}.test`;
  await writeFile(sibling, '{"invalid":true}', { mode: 0o600 });
  await rename(sibling, setup.options.configFile);
  function rejected() { expect(setup.logs.join('')).toContain('Failed to reload config'); }
  await expect.poll(rejected, { timeout: 5000 }).toBeUndefined();
  expect(await sends(setup, 'POST', ['mcp-method', 'tools/call', 'mcp-name', 'read'])).toBe(200);
  await setup.nats.seed([envelope('test', 'mcp-alpha', 'mcp.server_unpublished',
    { serverId: 'alpha', unpublishedBy: 'admin' })]);
  expect(await setup.delivery.observe()).toBeNull();
  expect(await gatewayConfigurationCurrent(setup.nats.store, 'test', setup.record)).toBe(false);
  expect(await history(setup.nats.store, 'gateway-config-test', 'test')).toHaveLength(2);
  expect(bytes).toContain(setup.record.recordDigest);
}
it('keeps old routes on rejected reload and refuses acknowledgement after withdrawal',
  rejectsStaleOrWrongWitnesses);
