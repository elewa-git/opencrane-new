import { createServer } from 'node:net';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { setTimeout as pause } from 'node:timers/promises';
import type { AppendCommand } from '@opencrane/event-store';
import { grantStream } from '@opencrane/authz';
import { toolReviewDigest } from '@opencrane/events/mcp-catalogue';
import { decideApproval, gatewayDelivery, history, prepareGatewayConfiguration,
  publishToolPolicy, readApproval, readToolPolicy, reviewToolPolicy } from '@opencrane/models';
import { fixture } from '@opencrane/models/testing';
import { remoteFixture } from '@opencrane/models/testing/remote-mcp';
import { mcpCatalogue } from '@opencrane/projections';
import { expect, it, onTestFinished, vi } from 'vitest';
import { z } from 'zod';
import { discoverInventory } from '../src/integrations/inventory.ts';
import { remoteCatalogueWatch } from '../src/integrations/remote-catalogue-watch.ts';

function restoreClock() {
  vi.useRealTimers();
}

function advanceToNextCheck() {
  const options = { toFake: ['Date' as const] };
  vi.useFakeTimers(options);
  onTestFinished(restoreClock);
  vi.setSystemTime(Date.now() + 270_000);
}

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('No fixture port');
  }
  server.close();
  await once(server, 'close');
  return address.port;
}

type Setup = Awaited<ReturnType<typeof fixture>>;

async function dispatchFixture(mode: 'allow' | 'ask' = 'allow') {
  const setup = await fixture();
  onTestFinished(setup.close.bind(setup));
  const remote = await remoteFixture();
  onTestFinished(remote.close);
  let declaration: Record<string, unknown> = { 'io.opencrane/expectedRevision': {} };
  let ttlMs = 300_000;
  function reply(method: string) {
    const cache = { resultType: 'complete', ttlMs, cacheScope: 'public' };
    if (method === 'server/discover') {
      return { ...cache, supportedVersions: ['2026-07-28'],
        capabilities: { tools: {}, experimental: declaration },
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'Fixture', version: '1' } } };
    }
    const review = { action: 'Read a record', consequence: 'Show the record',
      targetArgument: 'id', fields: ['id'], stepUp: false };
    const tool = { name: 'read', inputSchema: { type: 'object' },
      _meta: { 'io.opencrane/costCents': 0, 'io.opencrane/review': review } };
    return { ...cache, tools: [tool] };
  }
  remote.respond(reply);
  function call(method: string) {
    return Promise.resolve(JSON.stringify(reply(method)));
  }
  await mcpCatalogue.create(setup.db);
  const registration = { serverId: 'fixture', kind: 'remote',
    locator: 'https://mcp.example.test/mcp', registeredBy: 'alice' };
  await setup.append('mcp-fixture', 'mcp.server_registered', registration);
  const inventory = await discoverInventory(call);
  const discovery = { ...inventory, serverId: 'fixture',
    connectionId: 'installed', accountMode: 'none' };
  await setup.append('mcp-fixture', 'mcp.server_discovered', discovery);
  const rows = await history(setup.nats.store, 'mcp-fixture', 'test');
  for (const row of rows) {
    await mcpCatalogue.apply(setup.db, row.event, row.sequence);
  }
  const requireLeader = setup.dispatchOptions.requireLeader.bind(setup.dispatchOptions);
  const watch = remoteCatalogueWatch(setup.db, setup.nats.store, 'test',
    requireLeader, remote.network);
  onTestFinished(watch.close);
  await watch.check();
  const record = await reviewAndPublish(setup, mode);
  await deliverConfiguration(setup, record);
  setup.dispatchOptions.routes.length = 0;
  setup.dispatchOptions.remoteNetwork = remote.network;
  setup.dispatchOptions.requireCatalogue = watch.requireCurrent;
  for (const [granteeId, granteeKind] of [['alice', 'member'], ['assistant', 'assistant']]) {
    const grant = { resourceType: 'mcp_server', resourceId: 'fixture',
      granteeId, granteeKind, grantedBy: 'alice' };
    const event = await setup.append(grantStream('mcp_server', 'fixture'), 'grant.given', grant);
    await setup.auth.handler.handle(event, setup.db);
  }
  const callBody = { jsonrpc: '2.0', id: 'read', method: 'tools/call',
    params: { name: 'read', arguments: { id: 'record' }, _meta: { threadId: setup.t.thread,
      callId: 'tool-call-read', 'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientCapabilities': {} } } };
  const raw = JSON.stringify(callBody);
  const headers = { ...setup.headers,
    'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call', 'mcp-name': 'read',
    'x-opencrane-gateway-generation': String(record.generation),
    'x-opencrane-record-digest': record.recordDigest, 'x-opencrane-server-id': 'fixture',
    'x-opencrane-connection-id': 'installed',
    'x-opencrane-review-revision': String(record.members[0]!.entry.reviewRevision) };
  async function admission(approvalId?: string) {
    const token = await setup.sign(setup.t, 'decision-service');
    const requestHeaders = { ...headers, 'x-turn-token': token,
      ...(approvalId ? { 'x-opencrane-approval-id': approvalId } : {}) };
    const request = { method: 'POST', headers: requestHeaders, body: raw };
    return fetch(`${setup.options.decisionUrl}/authorize/mcp/fixture/installed`, request);
  }
  async function send(permit: string) {
    const headers = { 'content-type': 'application/json', 'x-opencrane-mcp-permit': permit };
    const request = { method: 'POST', headers, body: raw };
    return fetch(`${setup.options.decisionUrl}/dispatch/mcp/fixture/installed`, request);
  }
  function changeContract(changed: boolean) {
    declaration = {};
    if (changed) {
      declaration = { 'io.opencrane/expectedRevision': { version: 'unsupported' } };
    }
  }
  function shortTtl() {
    ttlMs = 500;
  }
  return { setup, remote, watch, admission, send, changeContract, shortTtl };
}

async function reviewAndPublish(setup: Setup, mode: 'allow' | 'ask') {
  const policy = await readToolPolicy(setup.nats.store, 'test', 'fixture');
  function choice(tool: NonNullable<NonNullable<typeof policy.catalogue>['tools']>[number]) {
    return { name: tool.name, revision: tool.revision,
      reviewDigest: toolReviewDigest(tool), mode };
  }
  const review = { commandId: 'review', expectedSequence: policy.sequence,
    policyRevision: policy.policyRevision, catalogueDigest: policy.catalogue!.schemaDigest,
    connectionId: 'installed', accountMode: 'none', tools: policy.catalogue!.tools!.map(choice) };
  const reviewedResult = await reviewToolPolicy(setup.nats.store, setup.binding,
    'alice', 'fixture', review);
  expect(reviewedResult.status).toBe('appended');
  const reviewed = await readToolPolicy(setup.nats.store, 'test', 'fixture');
  const publication = { commandId: 'publish', expectedSequence: reviewed.sequence,
    reviewRevision: reviewed.reviewRevision };
  const publishedResult = await publishToolPolicy(setup.nats.store, setup.binding,
    'alice', 'fixture', publication);
  expect(publishedResult.status).toBe('appended');
  return prepareGatewayConfiguration(setup.nats.store, 'test', 'fixture', 'publish');
}

async function deliverConfiguration(setup: Setup,
  record: Awaited<ReturnType<typeof reviewAndPublish>>) {
  const controlPort = await freePort();
  const options = { db: setup.db, mode: 'live' as const, store: setup.nats.store,
    silo: 'test', child: setup.gatewayChild()!, configFile: setup.options.configFile,
    controlPort, settings: setup.options };
  const delivery = gatewayDelivery(options);
  onTestFinished(delivery.close);
  setup.dispatchOptions.acknowledged = delivery.acknowledged;
  await delivery.deliver(record);
  const config = await readFile(setup.options.configFile, 'utf8');
  const path = /\/configuration\/\d+\/[a-f0-9-]+/u.exec(config)![0];
  async function acknowledged() {
    const response = await fetch(`http://127.0.0.1:${controlPort}${path}`);
    expect(response.status).toBe(200);
    expect(await delivery.observe()).not.toBeNull();
  }
  const polling = { timeout: 5000 };
  await expect.poll(acknowledged, polling).toBeUndefined();
}

async function holdsChangedContract(changed: boolean, finalSend: boolean) {
  const context = await dispatchFixture();
  const { setup, remote, watch } = context;
  advanceToNextCheck();
  const allowed = await context.admission();
  expect(allowed.status, await allowed.text()).toBe(200);
  const permit = z.string().parse(allowed.headers.get('x-opencrane-mcp-permit'));
  const before = await readToolPolicy(setup.nats.store, 'test', 'fixture');
  context.changeContract(changed);
  const captures = remote.connections();
  let startChecked = false;
  let response: Response;
  if (finalSend) {
    const append = setup.nats.store.append.bind(setup.nats.store);
    async function changeAfterStart(command: AppendCommand) {
      const result = await append(command);
      const event = z.object({ type: z.string() }).parse(command.event);
      if (event.type === 'tool.dispatch_started') {
        startChecked = true;
        await watch.check();
      }
      return result;
    }
    const writer = vi.spyOn(setup.nats.store, 'append');
    writer.mockImplementation(changeAfterStart);
    try {
      response = await context.send(permit);
    } finally {
      writer.mockRestore();
    }
    expect(startChecked).toBe(true);
  } else {
    await watch.check();
    response = await context.send(permit);
  }
  expect(response.status).toBe(403);
  const after = await readToolPolicy(setup.nats.store, 'test', 'fixture');
  expect(after.catalogue!.schemaDigest).toBe(before.catalogue!.schemaDigest);
  expect(after.driftHeld).toBe(true);
  expect(after.catalogue!.discoverResult).not.toBe(before.catalogue!.discoverResult);
  const discoverySchema = z.object({ capabilities: z.object({
    experimental: z.record(z.string(), z.unknown()),
  }) });
  const latest = discoverySchema.parse(JSON.parse(after.catalogue!.discoverResult!));
  let expectedContract: Record<string, unknown> = {};
  if (changed) {
    expectedContract = { 'io.opencrane/expectedRevision': { version: 'unsupported' } };
  }
  expect(latest.capabilities.experimental).toEqual(expectedContract);
  expect(after.policyRevision).toBeGreaterThan(before.policyRevision);
  expect((await context.admission()).status).toBe(403);
  expect(remote.connections()).toBe(captures + 2);
  expect(setup.received()).toBe(0);
  for (const call of remote.calls) {
    expect(['server/discover', 'tools/list']).toContain(call.method);
  }
}
it.each([[false, false], [true, false], [false, true], [true, true]])(
  'holds changed contract (changed %s, after saved start %s) without a tool connection',
  holdsChangedContract, 60_000);

async function refreshesShortTtl() {
  const context = await dispatchFixture('ask');
  const { setup, remote, watch } = context;
  advanceToNextCheck();
  context.shortTtl();
  await watch.check();
  const asked = await context.admission();
  const answer = z.object({ approvalId: z.string() }).parse(await asked.json());
  const current = await readApproval(setup.nats.store, 'test', answer.approvalId);
  async function fresh() {}
  const result = await decideApproval(setup.nats.store, 'test', answer.approvalId,
    'alice', 'approved', true, fresh, current, setup.actor.now());
  expect(result.status).toBe('appended');
  const approved = await readApproval(setup.nats.store, 'test', answer.approvalId);
  expect(approved.state).toBe('approved');
  const before = await readToolPolicy(setup.nats.store, 'test', 'fixture');
  const startedAt = Date.now();
  const calls = remote.calls.length;
  const errors = vi.fn();
  for (let refresh = 1; refresh <= 6; refresh++) {
    vi.setSystemTime(startedAt + refresh * 250);
    watch.tick(errors);
    function captureCount() {
      return remote.calls.length;
    }
    await expect.poll(captureCount).toBe(calls + refresh * 2);
    await watch.check();
    async function saved() {
      const policy = await readToolPolicy(setup.nats.store, 'test', 'fixture');
      expect(policy.checkedAt).toBe(new Date().toISOString());
      expect(Date.parse(policy.expiresAt!)).toBeGreaterThan(Date.now());
    }
    await expect.poll(saved).toBeUndefined();
    watch.requireCurrent('fixture');
    expect((await readToolPolicy(setup.nats.store, 'test', 'fixture')).policyRevision)
      .toBe(before.policyRevision);
    expect(await readApproval(setup.nats.store, 'test', answer.approvalId)).toEqual(approved);
    await pause(0);
  }
  expect(errors).not.toHaveBeenCalled();
  expect((await context.admission(answer.approvalId)).status).toBe(200);
  expect(setup.received()).toBe(0);
}
it('keeps a 500 ms catalogue and its approved request current across repeated ticks',
  refreshesShortTtl, 60_000);
