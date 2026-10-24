import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { encodeSession } from '@opencrane/auth';
import { grantStream } from '@opencrane/authz';
import type { AppendCommand, StoredEvent } from '@opencrane/event-store';
import { toolReviewDigest } from '@opencrane/events/mcp-catalogue';
import { gatewayConfigurationWorker, history, prepareGatewayConfiguration,
  publishToolPolicy, readToolPolicy, reviewToolPolicy, readApproval, decideApproval } from '@opencrane/models';
import { fixture, fga } from '@opencrane/models/testing';
import { remoteFixture } from '@opencrane/models/testing/remote-mcp';
import { groups, members, mcpCatalogue } from '@opencrane/projections';
import { expect, it, onTestFinished, vi } from 'vitest';
import { z } from 'zod';
import { buildServer } from '../src/server.ts';
import { discoverInventory } from '../src/integrations/inventory.ts';
import { remoteCatalogueWatch } from '../src/integrations/remote-catalogue-watch.ts';
import { testAuthConfig } from './support/test-auth-config.ts';

type Setup = Awaited<ReturnType<typeof fixture>>;
const grantSubject = grantStream('mcp_server', 'fixture');
const accessPath = '/api/org/integrations/fixture/access/changes';

async function freePort() {
  const listener = createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const address = listener.address();
  if (!address || typeof address === 'string') throw new Error('No fixture port');
  listener.close();
  await once(listener, 'close');
  return address.port;
}

function upstreamReply(method: string) {
  const cache = { resultType: 'complete', ttlMs: 300_000, cacheScope: 'public' };
  if (method === 'server/discover') {
    const experimental = { 'io.opencrane/expectedRevision': {} };
    return { ...cache, supportedVersions: ['2026-07-28'],
      capabilities: { tools: {}, experimental },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'Fixture', version: '1' } } };
  }
  if (method === 'tools/call') return { content: [] };
  const review = { action: 'Read a record', consequence: 'Show the record',
    targetArgument: 'id', fields: ['id'], stepUp: false };
  const tool = { name: 'read', inputSchema: { type: 'object' },
    _meta: { 'io.opencrane/costCents': 0, 'io.opencrane/review': review } };
  return { ...cache, tools: [tool] };
}

async function publication(setup: Setup, mode: 'allow' | 'ask') {
  const policy = await readToolPolicy(setup.nats.store, 'test', 'fixture');
  function choice(tool: NonNullable<NonNullable<typeof policy.catalogue>['tools']>[number]) {
    return { name: tool.name, revision: tool.revision,
      reviewDigest: toolReviewDigest(tool), mode };
  }
  const choices = policy.catalogue!.tools!.map(choice);
  const review = { commandId: 'review', expectedSequence: policy.sequence,
    policyRevision: policy.policyRevision, catalogueDigest: policy.catalogue!.schemaDigest,
    connectionId: 'installed', accountMode: 'none', tools: choices };
  const reviewed = await reviewToolPolicy(setup.nats.store, setup.binding,
    'alice', 'fixture', review);
  expect(reviewed.status).toBe('appended');
  const current = await readToolPolicy(setup.nats.store, 'test', 'fixture');
  const publish = { commandId: 'publish', expectedSequence: current.sequence,
    reviewRevision: current.reviewRevision };
  const published = await publishToolPolicy(setup.nats.store, setup.binding,
    'alice', 'fixture', publish);
  expect(published.status).toBe('appended');
  const record = await prepareGatewayConfiguration(setup.nats.store, 'test', 'fixture', 'publish');
  const controlPort = await freePort();
  const requireLeader = setup.dispatchOptions.requireLeader.bind(setup.dispatchOptions);
  const options = { db: setup.db, mode: 'live' as const, store: setup.nats.store,
    silo: 'test', child: setup.gatewayChild()!, configFile: setup.options.configFile,
    controlPort, settings: setup.options, requireLeader };
  const worker = gatewayConfigurationWorker(options);
  onTestFinished(worker.close);
  setup.dispatchOptions.acknowledged = worker.acknowledged;
  async function acknowledged() {
    await worker.check();
    return worker.acknowledged()?.recordDigest;
  }
  const polling = { timeout: 5000 };
  await expect.poll(acknowledged, polling).toBe(record.recordDigest);
  return record;
}

async function gatewayFixture(mode: 'allow' | 'ask' = 'allow') {
  const setup = await fixture();
  onTestFinished(setup.close.bind(setup));
  const remote = await remoteFixture();
  onTestFinished(remote.close);
  remote.respond(upstreamReply);
  function discovery(method: string) {
    return Promise.resolve(JSON.stringify(upstreamReply(method)));
  }
  await setup.runner.initialise(members);
  await setup.runner.initialise(groups);
  await mcpCatalogue.create(setup.db);
  const registration = { serverId: 'fixture', kind: 'remote',
    locator: 'https://mcp.example.test/mcp', registeredBy: 'alice' };
  await setup.append('mcp-fixture', 'mcp.server_registered', registration);
  const inventory = await discoverInventory(discovery);
  const discovered = { ...inventory, serverId: 'fixture',
    connectionId: 'installed', accountMode: 'none' };
  await setup.append('mcp-fixture', 'mcp.server_discovered', discovered);
  const rows = await history(setup.nats.store, 'mcp-fixture', 'test');
  for (const row of rows) {
    await mcpCatalogue.apply(setup.db, row.event, row.sequence);
  }
  const requireLeader = setup.dispatchOptions.requireLeader.bind(setup.dispatchOptions);
  const watch = remoteCatalogueWatch(setup.db, setup.nats.store, 'test',
    requireLeader, remote.network);
  onTestFinished(watch.close);
  await watch.check();
  setup.dispatchOptions.routes.length = 0;
  setup.dispatchOptions.remoteNetwork = remote.network;
  setup.dispatchOptions.requireCatalogue = watch.requireCurrent;
  const record = await publication(setup, mode);
  const commands = serverCommands(setup);
  const call = gatewayCall.bind(undefined, setup);
  return { setup, remote, watch, record, ...commands, call };
}

function serverCommands(setup: Setup) {
  const authOptions = { expectedOrgId: 'org-test' };
  const config = testAuthConfig(authOptions);
  function memberId() {
    return Promise.resolve('alice');
  }
  const access = { silo: 'test', store: setup.nats.store, db: setup.db,
    binding: setup.binding, feed: { memberId } };
  const serverOptions = { modelAccess: access, groups: access };
  const app = buildServer(config, serverOptions);
  async function closeApp() {
    await app.close();
  }
  onTestFinished(closeApp);
  const session = { sub: 'alice', orgId: 'org-test', roles: [],
    authTime: 1790856000, exp: 2000000000 };
  const headers = { origin: 'https://app.example.test',
    cookie: `${config.cookieName}=${encodeSession(config, session)}` };
  let counter = 0;
  async function command(url: string, payload: Record<string, unknown>, apply = true) {
    const commandId = `change-${++counter}`;
    const request = { method: 'POST' as const, url, headers,
      payload: { ...payload, commandId } };
    const response = await app.inject(request);
    expect(response.statusCode, response.body).toBe(200);
    const receipt = response.json<{ sequence: number; changeId: string }>();
    const original = await setup.nats.store.readEvent(receipt.sequence);
    expect(original.event.id).toBe(receipt.changeId);
    await setup.runner.run(members);
    await setup.runner.run(groups);
    if (apply) {
      await setup.auth.handler.handle(original.event, setup.db);
    }
    let statusUrl = `${url}/${commandId}`;
    if (url.startsWith('/api/groups')) {
      statusUrl = `/api/groups/sales/changes/${commandId}`;
    }
    const statusRequest = { method: 'GET' as const, url: statusUrl, headers };
    async function originalReceipt(applied = apply) {
      const response = await app.inject(statusRequest);
      expect(response.statusCode).toBe(200);
      const status = response.json<unknown>();
      const expected = { ...receipt, projection: {
        content: 'current', iam: applied ? 'current' : 'applying' } };
      expect(status).toMatchObject(expected);
    }
    const initialReceipt = originalReceipt.bind(undefined, apply);
    await expect.poll(initialReceipt).toBeUndefined();
    const currentReceipt = originalReceipt.bind(undefined, true);
    return { original, currentReceipt };
  }
  async function grant(kind: string, action = 'grant', apply = true) {
    const ids: Record<string, string> = { member: 'alice', assistant: 'assistant', team: 'sales' };
    const expectedSequence = await setup.nats.store.head(grantSubject);
    const payload = { granteeKind: kind, granteeId: ids[kind], action, expectedSequence };
    return command(accessPath, payload, apply);
  }
  async function membership(action: string, apply = true) {
    const payload = { action, memberId: 'alice' };
    return command('/api/groups/sales', payload, apply);
  }
  async function team() {
    const payload = { groupId: 'sales', name: 'Sales' };
    await command('/api/groups', payload);
    await membership('add');
  }
  return { grant, membership, team };
}

async function gatewayCall(setup: Setup, approvalId?: string) {
  const callId = randomUUID();
  const body = { jsonrpc: '2.0', id: callId, method: 'tools/call',
    params: { name: 'read', arguments: { id: 'record' }, _meta: {
      threadId: setup.t.thread, callId,
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientCapabilities': {} } } };
  const raw = JSON.stringify(body);
  const token = await setup.sign(setup.t, 'decision-service');
  const headers = { ...setup.headers, 'x-turn-token': token,
    'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call', 'mcp-name': 'read',
    ...(approvalId ? { 'x-opencrane-approval-id': approvalId } : {}) };
  const request = { method: 'POST', headers, body: raw };
  const before = await setup.nats.store.head();
  const response = await fetch(`http://127.0.0.1:${setup.options.port}/mcp/fixture/installed`,
    request);
  await response.text();
  const events: StoredEvent[] = [];
  const last = await setup.nats.store.head();
  for (let sequence = before + 1; sequence <= last; sequence++) {
    events.push(await setup.nats.store.readEvent(sequence));
  }
  function decision(row: typeof events[number]) {
    return row.event.type === 'decision.recorded';
  }
  const admitted = events.find(decision);
  expect(admitted).toBeDefined();
  const evidence = await history(setup.nats.store, admitted!.event.subject, 'test');
  return { status: response.status, raw, evidence };
}

type Context = Awaited<ReturnType<typeof gatewayFixture>>;

async function allowed(context: Context) {
  const before = context.remote.received.length;
  const result = await context.call();
  const savedEvidence = JSON.stringify(result.evidence);
  expect(result.status, savedEvidence).toBe(200);
  expect(context.remote.received).toHaveLength(before + 1);
  const expectedBytes = Buffer.from(result.raw);
  expect(context.remote.received.at(-1)!.raw).toEqual(expectedBytes);
  const admission = { outcome: 'allow' };
  expect(result.evidence[0]!.event.data).toMatchObject(admission);
  expect(result.evidence[1]!.event.type).toBe('tool.dispatch_started');
  const finalSend = { outcome: 'responded', evidence: 'adapter_response_received' };
  expect(result.evidence[2]!.event.data).toMatchObject(finalSend);
  expect(context.setup.received()).toBe(0);
}

async function denied(context: Context) {
  const before = context.remote.received.length;
  const connections = context.remote.connections();
  const result = await context.call();
  expect(result.status).toBe(403);
  expect(result.evidence).toHaveLength(1);
  const admission = { outcome: 'deny' };
  expect(result.evidence[0]!.event.data).toMatchObject(admission);
  expect(context.remote.received).toHaveLength(before);
  expect(context.remote.connections()).toBe(connections);
}

async function requiresBothSides(first: string) {
  const context = await gatewayFixture();
  if (first === 'team') {
    await context.team();
  }
  await context.grant(first);
  await denied(context);
  let second = 'assistant';
  if (first === 'assistant') {
    second = 'member';
  }
  await context.grant(second);
  await allowed(context);
}
it.each(['member', 'assistant', 'team'])(
  'requires both grant sides through the published route, starting with %s', requiresBothSides, 60_000);

async function heldCall(context: Context, change: () => Promise<unknown>, expected = 403,
  approvalId?: string) {
  const append = context.setup.nats.store.append.bind(context.setup.nats.store);
  let changedAt = 0;
  async function changeAfterStart(command: AppendCommand) {
    const result = await append(command);
    const event = z.object({ type: z.string() }).parse(command.event);
    if (event.type === 'tool.dispatch_started') {
      changedAt = performance.now();
      await change();
    }
    return result;
  }
  const writer = vi.spyOn(context.setup.nats.store, 'append');
  writer.mockImplementation(changeAfterStart);
  const before = context.remote.received.length;
  const connections = context.remote.connections();
  try {
    const result = await context.call(approvalId);
    expect(changedAt).toBeGreaterThan(0);
    expect(performance.now() - changedAt).toBeLessThan(2000);
    expect(result.status).toBe(expected);
    const admission = { outcome: 'allow' };
    expect(result.evidence[0]!.event.data).toMatchObject(admission);
    expect(result.evidence[1]!.event.type).toBe('tool.dispatch_started');
    if (expected === 403) {
      expect.soft(result.evidence).toHaveLength(3);
      const refusal = { outcome: 'not_dispatched', evidence: 'adapter_dispatch_refused' };
      expect.soft(result.evidence[2]?.event.data).toMatchObject(refusal);
      expect(context.remote.received).toHaveLength(before);
      expect(context.remote.connections()).toBe(connections);
    } else {
      expect(context.remote.received).toHaveLength(before + 1);
      const expectedBytes = Buffer.from(result.raw);
      expect(context.remote.received.at(-1)!.raw).toEqual(expectedBytes);
    }
  } finally {
    writer.mockRestore();
  }
}

async function revokesBeforeSend(kind: string) {
  const context = await gatewayFixture();
  const team = kind === 'team' || kind === 'membership';
  if (team) {
    await context.team();
  }
  await context.grant(team ? 'team' : 'member');
  await context.grant('assistant');
  await allowed(context);
  async function revoke() {
    if (kind === 'membership') {
      await context.membership('remove', false);
    } else {
      await context.grant(kind, 'revoke', false);
    }
    const person = await context.setup.auth.use('person', 'alice', 'mcp_server', 'fixture');
    const assistant = await context.setup.auth.use('assistant', 'assistant', 'mcp_server', 'fixture');
    expect(person.allowed).toBe(true);
    expect(assistant.allowed).toBe(true);
  }
  await heldCall(context, revoke);
  const started = performance.now();
  await denied(context);
  expect(performance.now() - started).toBeLessThan(2000);
  if (kind === 'team') {
    // Apply the revoked grant before leaving and joining again; the grant stays revoked.
    const rows = await history(context.setup.nats.store, grantSubject, 'test');
    await context.setup.auth.handler.handle(rows.at(-1)!.event, context.setup.db);
    await context.membership('remove');
    await context.membership('add');
    await denied(context);
  }
}
it.each(['member', 'assistant', 'team', 'membership'])(
  'refuses fresh and held calls with IAM application paused after %s removal',
  revokesBeforeSend, 60_000);

async function preservesAccess() {
  const context = await gatewayFixture();
  await context.grant('member');
  await context.grant('assistant');
  await allowed(context);
  const before = await readToolPolicy(context.setup.nats.store, 'test', 'fixture');
  const captures = context.remote.calls.length;
  function restoreClock() {
    vi.useRealTimers();
  }
  onTestFinished(restoreClock);
  // Advance Date alone to make the next capture due while real service timers keep running.
  vi.setSystemTime(Date.now() + 270_000);
  await context.watch.check();
  expect(context.remote.calls).toHaveLength(captures + 2);
  const after = await readToolPolicy(context.setup.nats.store, 'test', 'fixture');
  expect(after.sequence).toBeGreaterThan(before.sequence);
  expect(after.policyRevision).toBe(before.policyRevision);
  expect(after.checkedAt).not.toBe(before.checkedAt);
  await allowed(context);
  async function output() {
    const data = { conversationId: 'conversation', turnId: 'turn', messageId: 'progress',
      ciphertext: 'ZmFrZS1jaXBoZXJ0ZXh0', keyId: 'key:1', contentType: 'text' };
    await context.setup.append('conversation-conversation', 'agent.message_delta', data);
  }
  await heldCall(context, output, 200);
}
it('preserves access after an unchanged refresh and during conversation output',
  preservesAccess, 60_000);

async function refusesStaleCatalogue() {
  const context = await gatewayFixture();
  await context.grant('member');
  await context.grant('assistant');
  await allowed(context);
  async function expire() {
    const policy = await readToolPolicy(context.setup.nats.store, 'test', 'fixture');
    const data = { serverId: 'fixture', schemaDigest: policy.catalogue!.schemaDigest,
      outcome: 'unchanged', checkedAt: new Date(Date.now() - 1000).toISOString(),
      expiresAt: new Date(Date.now() - 1).toISOString() };
    await context.setup.append('mcp-fixture', 'mcp.catalogue_checked', data);
  }
  await heldCall(context, expire);
  await denied(context);
}
it('refuses stale catalogues at admission and final send', refusesStaleCatalogue, 60_000);

async function refusesIamOutage() {
  const context = await gatewayFixture();
  await context.grant('member');
  await context.grant('assistant');
  await allowed(context);
  try {
    const pauseIam = fga.pause.bind(fga);
    await heldCall(context, pauseIam);
    await denied(context);
  } finally {
    await fga.resume();
  }
}
it('refuses an IAM outage at admission and final send', refusesIamOutage, 60_000);

async function keepsSeparateDirectGrant() {
  const context = await gatewayFixture();
  await context.team();
  await context.grant('team');
  await context.grant('member');
  await context.grant('assistant');
  await allowed(context);
  await context.membership('remove');
  await allowed(context);
}
it('keeps a separate direct grant after team membership removal is applied',
  keepsSeparateDirectGrant, 60_000);

async function approveCall(context: Context, approvalId: string, action: 'approved' | 'retry') {
  const setup = context.setup;
  const current = await readApproval(setup.nats.store, 'test', approvalId);
  async function fresh() {
    const permission = await setup.auth.use('person', 'alice', 'mcp_server', 'fixture');
    expect(permission.allowed).toBe(true);
  }
  return decideApproval(setup.nats.store, 'test', approvalId, 'alice', action,
    true, fresh, current, setup.actor.now());
}

function overlapApprovalRefusal(setup: Setup) {
  const append = setup.nats.store.append.bind(setup.nats.store);
  const checkingDispatch = Promise.withResolvers<void>();
  const refusalSaved = Promise.withResolvers<void>();
  async function overlapRefusal(command: AppendCommand) {
    const event = z.object({ type: z.string(),
      data: z.object({ outcome: z.string().optional() }) }).parse(command.event);
    // Save the competing refusal after NATS captures the global position for admission.
    if (event.type === 'decision.recorded' && event.data.outcome === 'ask') {
      await checkingDispatch.promise;
      const result = await append(command);
      refusalSaved.resolve();
      return result;
    }
    if (event.type === 'budget.call_dispatch_admitted' && command.checkAccess) {
      const checkAccess = command.checkAccess;
      async function saveCompetingRefusal() {
        checkingDispatch.resolve();
        await refusalSaved.promise;
        await checkAccess();
      }
      const checkedCommand = { ...command, checkAccess: saveCompetingRefusal };
      const result = await append(checkedCommand);
      return result;
    }
    return append(command);
  }
  const writer = vi.spyOn(setup.nats.store, 'append');
  writer.mockImplementation(overlapRefusal);
  function restoreWriter() {
    checkingDispatch.resolve();
    refusalSaved.resolve();
    writer.mockRestore();
  }
  onTestFinished(restoreWriter);
}

async function recoversUnsentApproval(overlap = false) {
  const context = await gatewayFixture('ask');
  const setup = context.setup;
  await context.grant('member');
  await context.grant('assistant');
  const requested = await context.call();
  expect(requested.status).toBe(403);
  const approvalId = requested.evidence[0]!.event.correlation.approval!;
  expect(approvalId).toBeDefined();
  expect((await approveCall(context, approvalId, 'approved')).status).toBe('appended');
  try {
    const pauseIam = fga.pause.bind(fga);
    await heldCall(context, pauseIam, 403, approvalId);
  } finally {
    await fga.resume();
  }
  const approval = await readApproval(setup.nats.store, 'test', approvalId);
  expect(approval).toMatchObject({ state: 'outcome_unknown', canRetry: true });
  expect(approval.uses).toHaveLength(1);
  expect((await approveCall(context, approvalId, 'retry')).status).toBe('appended');
  expect((await approveCall(context, approvalId, 'retry')).status).toBe('conflict');
  const before = context.remote.received.length;
  if (overlap) {
    overlapApprovalRefusal(setup);
  }
  const first = context.call(approvalId);
  const second = context.call(approvalId);
  const replies = await Promise.all([first, second]);
  function status(reply: Awaited<ReturnType<typeof context.call>>) {
    return reply.status;
  }
  const statuses = replies.map(status);
  expect(statuses.sort()).toEqual([200, 403]);
  expect(context.remote.received).toHaveLength(before + 1);
  const used = await readApproval(setup.nats.store, 'test', approvalId);
  expect(used).toMatchObject({ state: 'outcome_unknown', canRetry: false });
  expect(used.uses).toHaveLength(2);
  const connections = context.remote.connections();
  expect((await context.call(approvalId)).status).toBe(403);
  expect(context.remote.received).toHaveLength(before + 1);
  expect(context.remote.connections()).toBe(connections);
  const budget = await history(setup.nats.store, 'budget-test', 'test');
  function reserved(row: StoredEvent) {
    return row.event.type === 'budget.reserved';
  }
  expect(budget.filter(reserved)).toHaveLength(0);
}
it('restores one approval retry after IAM refuses a saved start without sending',
  recoversUnsentApproval.bind(undefined, false), 60_000);
it('keeps one approval retry when the competing refusal overlaps budget admission',
  recoversUnsentApproval.bind(undefined, true), 60_000);

async function restoresGrant() {
  const context = await gatewayFixture();
  await context.grant('member');
  await context.grant('assistant');
  await allowed(context);
  await context.grant('member', 'revoke');
  await denied(context);
  const restored = await context.grant('member', 'grant', false);
  await denied(context);
  await context.setup.auth.handler.handle(restored.original.event, context.setup.db);
  await expect.poll(restored.currentReceipt).toBeUndefined();
  await allowed(context);
}
it('restores a revoked grant only after its original content and IAM receipts are current',
  restoresGrant, 60_000);

async function boundsToolHistory(historyMs: number, accessMs: number, expectedAllowed: boolean) {
  const context = await gatewayFixture();
  await context.grant('member');
  await context.grant('assistant');
  const store = context.setup.nats.store;
  const originalRead = store.readStream.bind(store);
  const requestStarted = performance.now();
  let elapsed = 0;
  let accessStarted = false;
  const historyAccessStates: boolean[] = [];
  // Advance decision time only at these reads; keep real service timers running.
  function currentTime() {
    return requestStarted + elapsed;
  }
  async function* slowHistory(...parameters: Parameters<typeof originalRead>) {
    const subject = parameters[0];
    if (subject === 'member-alice' && !accessStarted) {
      accessStarted = true;
      elapsed += accessMs;
    }
    const fullHistory = subject === 'conversation-conversation' && parameters[1] === 1;
    if (fullHistory) {
      historyAccessStates.push(accessStarted);
    }
    yield* originalRead(...parameters);
    if (fullHistory) {
      elapsed += historyMs;
    }
  }
  const clock = vi.spyOn(performance, 'now');
  const read = vi.spyOn(store, 'readStream');
  clock.mockImplementation(currentTime);
  read.mockImplementation(slowHistory);
  try {
    if (expectedAllowed) {
      await allowed(context);
    } else {
      await denied(context);
    }
    expect(elapsed).toBe(historyMs + accessMs);
    expect(historyAccessStates).toEqual([false]);
    expect(context.setup.actor.state.reservations).toHaveLength(0);
  } finally {
    read.mockRestore();
    clock.mockRestore();
  }
}
const toolHistoryBudgets = [[0, 0, true], [2100, 0, false], [1900, 200, false]] as const;
it.each(toolHistoryBudgets)(
  'keeps tool history within the shared budget (%i ms history, %i ms access)',
  boundsToolHistory, 60_000);
