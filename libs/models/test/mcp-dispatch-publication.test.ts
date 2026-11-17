import { body, tool, prepare, permit, send, reviewRestoration, publishRestoration,
  restorationDelivery, generationHeaders, publishedFixture }
  from './support/mcp-dispatch-fixture.ts';
import { readFile } from 'node:fs/promises';
import { applyToolPolicy, mcpCatalogue, readPublication } from '@opencrane/projections';
import { mcpConfigurationObservationSchema } from '@opencrane/events';
import { publicationDigest } from '../src/publication.ts';
import { startDecision } from '../src/decision.ts';
import { envelope } from '../src/actor.ts';
import { recordToolObservation } from '../src/tool-dispatch.ts';
import { gatewayDelivery } from '../src/gateway-delivery.ts';
import type { AppendCommand } from '@opencrane/event-store';
import { z } from 'zod';
import { expect, it, onTestFinished, vi } from 'vitest';
import { mcpCatalogueWatch } from '../src/mcp-catalogue-watch.ts';
import { decideApproval, history, ingestUsage, priceTableId, readApproval, readToolPolicy }
  from '../src/index.ts';
import { catalogueEvidence, fixture, toolEvidence } from './fixture.ts';
import capture from './fixtures/codex-0.159.2-tools-call.json' with { type: 'json' };
import { grantToolApproval, verifyRestorationReplay, gatewayCall, verifyCatalogueRecoveryReplay }
  from './support/mcp-dispatch-assertions.ts';

type Fixture = Awaited<ReturnType<typeof fixture>>;

const restorationCases = ['exact', 'legacy', 'review only', 'intent only', 'new intent',
  'unpublish', 'second drift', 'expired', 'failed check', 'older generation',
  'restart before', 'restart after', 'restart recovery', 'duplicate after drift',
  'drift during final read', 'expired approval'] as const;

type RestorationCase = typeof restorationCases[number];

type RestorationFixture = Awaited<ReturnType<typeof restorationFixture>>;

async function restorationFixture(expireApproval = false) {
  const setup = await fixture();
  async function closeSetup() {
    await setup.close();
  }
  onTestFinished(closeSetup);
  const headers = await prepare(setup);
  const initial = await readToolPolicy(setup.nats.store, 'test', 'fixture');
  const capture = vi.fn();
  capture.mockResolvedValue(initial.catalogue);
  const options = { serverIds: ['fixture'], capture,
    requireLeader: setup.dispatchOptions.requireLeader.bind(setup.dispatchOptions) };
  const watch = mcpCatalogueWatch(setup.nats.store, 'test', options);
  const context = { setup, headers, initial, capture, options, watch };
  function closeWatch() {
    context.watch.close();
  }
  onTestFinished(closeWatch);
  setup.dispatchOptions.requireCatalogue = watch.requireCurrent;
  await watch.check('fixture');
  const approvalId = await grantToolApproval(setup, headers);
  if (expireApproval) {
    const approval = await readApproval(setup.nats.store, 'test', approvalId);
    const options = { now: new Date(approval.request.expiresAt) };
    const expired = await readApproval(setup.nats.store, 'test', approvalId, options);
    expect(expired.state).toBe('expired');
  }
  const added = toolEvidence({ name: 'another', reviewed: false, costCents: 0 });
  const changed = { ...initial.catalogue!, ...catalogueEvidence([tool, added]) };
  capture.mockResolvedValue(changed);
  await watch.check('fixture');
  function requireCurrent() {
    watch.requireCurrent('fixture');
  }
  expect(requireCurrent).toThrow();
  return Object.assign(context, { approvalId, changed });
}

async function restartRestoration(context: RestorationFixture) {
  context.watch.close();
  await context.setup.restart();
  context.watch = mcpCatalogueWatch(context.setup.nats.store, 'test', context.options);
  context.setup.dispatchOptions.requireCatalogue = context.watch.requireCurrent;
  function requireCurrent() {
    context.watch.requireCurrent('fixture');
  }
  expect(requireCurrent).toThrow();
  await context.watch.check('fixture');
}

async function invalidateRestoration(context: RestorationFixture, change: RestorationCase,
  delivery: Awaited<ReturnType<typeof restorationDelivery>>,
  record: Awaited<ReturnType<typeof publishRestoration>>) {
  const { setup, capture, watch } = context;
  let liveRecord = record;
  if (change === 'new intent' || change === 'older generation') {
    const newer = await publishRestoration(setup, 'restore-newer');
    expect(await delivery.observe()).toBeNull();
    if (change === 'older generation') {
      await delivery.deliver(newer);
      liveRecord = newer;
    }
    const before = await readFile(setup.options.configFile);
    const position = await setup.nats.store.head();
    await expect(delivery.deliver(record)).rejects.toThrow('Gateway delivery unavailable');
    expect(await readFile(setup.options.configFile)).toEqual(before);
    expect(await delivery.observe()).toBeNull();
    expect(await setup.nats.store.head()).toBe(position);
    const policy = await readToolPolicy(setup.nats.store, 'test', 'fixture');
    expect(policy).toMatchObject({ driftHeld: true, published: false });
  } else if (change === 'unpublish') {
    await setup.append('mcp-fixture', 'mcp.server_unpublished',
      { serverId: 'fixture', unpublishedBy: 'alice' });
  } else if (change === 'second drift') {
    capture.mockResolvedValue(context.initial.catalogue);
    await watch.check('fixture');
  } else if (change === 'failed check') {
    capture.mockRejectedValueOnce(new Error('Capture unavailable'));
    await expect(watch.check('fixture')).rejects.toThrow();
  } else if (change === 'expired') {
    const checkedAt = new Date(Date.now() - 1000).toISOString();
    const expiresAt = new Date(Date.now() - 1).toISOString();
    await setup.append('mcp-fixture', 'mcp.catalogue_checked', { serverId: 'fixture',
      outcome: 'unchanged', schemaDigest: context.changed.schemaDigest, checkedAt, expiresAt });
  } else if (change === 'restart before') {
    await restartRestoration(context);
  }
  return liveRecord;
}

async function observeRestoration(context: RestorationFixture, change: RestorationCase,
  delivery: Awaited<ReturnType<typeof restorationDelivery>>,
  record: Awaited<ReturnType<typeof publishRestoration>>) {
  const { setup, watch } = context;
  async function acknowledged() {
    expect(await delivery.observe()).not.toBeNull();
  }
  const succeeds = ['exact', 'restart after', 'restart recovery',
    'duplicate after drift', 'drift during final read', 'expired approval'].includes(change);
  if (!succeeds) {
    if (change !== 'intent only') {
      expect(await delivery.observe()).toBeNull();
    }
    return;
  }
  await expect.poll(acknowledged, { timeout: 5000 }).toBeUndefined();
  const restored = await readToolPolicy(setup.nats.store, 'test', 'fixture');
  expect(restored).toMatchObject({ driftHeld: false, published: true });
  if (change === 'drift during final read') {
    await driftDuringFinalRead(context);
    return;
  }
  await watch.check('fixture');
  watch.requireCurrent('fixture');
  const checked = await readToolPolicy(setup.nats.store, 'test', 'fixture');
  await delivery.observe();
  const repeated = await readToolPolicy(setup.nats.store, 'test', 'fixture');
  expect(repeated).toEqual(checked);
  if (change === 'restart after' || change === 'restart recovery') {
    const previousChild = setup.gatewayChild();
    await setup.runner.initialise(mcpCatalogue);
    await setup.runner.run(mcpCatalogue);
    expect(await readPublication(setup.db, 'test', 'fixture')).toMatchObject({ status: 'ready' });
    await restartRestoration(context);
    expect(setup.gatewayChild()).not.toBe(previousChild);
    expect(delivery.acknowledged()).toBeNull();
    const recovered = await readToolPolicy(setup.nats.store, 'test', 'fixture');
    expect(recovered).toMatchObject({ driftHeld: false, published: true,
      configurationObservation: restored.configurationObservation });
    if (change === 'restart recovery') {
      delivery = await restorationDelivery(setup);
      await delivery.deliver(record);
      await delivery.waitForWitness(record);
      await expect.poll(acknowledged, { timeout: 5000 }).toBeUndefined();
      await context.watch.check('fixture');
      await setup.runner.run(mcpCatalogue);
      expect(await readPublication(setup.db, 'test', 'fixture')).toMatchObject({
        status: 'ready', changeRef: 'restore', generation: record.generation,
        recordDigest: record.recordDigest });
      const renewed = await readToolPolicy(setup.nats.store, 'test', 'fixture');
      expect(renewed).toMatchObject({ published: true, driftHeld: false,
        policyRevision: recovered.policyRevision });
      expect(renewed.configurationObservation!.processRef).not.toBe(
        restored.configurationObservation!.processRef);
    }
  } else if (change === 'duplicate after drift') {
    context.capture.mockResolvedValue(context.initial.catalogue);
    await watch.check('fixture');
    expect(await delivery.observe()).toBeNull();
  }
}

async function driftDuringFinalRead(context: RestorationFixture) {
  const { setup, watch } = context;
  const readStream = setup.nats.store.readStream.bind(setup.nats.store);
  const append = setup.nats.store.append.bind(setup.nats.store);
  let captureSaved = false;
  async function saveRenewal(command: AppendCommand) {
    const result = await append(command);
    const event = z.object({ type: z.string() }).parse(command.event);
    if (event.type === 'mcp.catalogue_checked') captureSaved = true;
    return result;
  }
  const writer = vi.spyOn(setup.nats.store, 'append');
  writer.mockImplementation(saveRenewal);
  async function* changeDuringRead(...parameters: Parameters<typeof readStream>) {
    if (parameters[0] === 'mcp-fixture' && captureSaved) {
      captureSaved = false;
      const data = { serverId: 'fixture', previousSchemaDigest: context.changed.schemaDigest,
        newSchemaDigest: context.initial.catalogue!.schemaDigest,
        catalogue: context.initial.catalogue };
      await setup.append('mcp-fixture', 'mcp.tools_changed', data);
    }
    yield* readStream(...parameters);
  }
  const reader = vi.spyOn(setup.nats.store, 'readStream');
  reader.mockImplementation(changeDuringRead);
  try {
    await watch.check('fixture');
  } finally {
    reader.mockRestore();
    writer.mockRestore();
  }
  function requireCurrent() {
    watch.requireCurrent('fixture');
  }
  expect(requireCurrent).toThrow('watch unavailable');
  const policy = await readToolPolicy(setup.nats.store, 'test', 'fixture');
  expect(policy.driftHeld).toBe(true);
}

async function restoresReviewedDrift(change: RestorationCase) {
  const context = await restorationFixture(change === 'expired approval');
  const { setup, headers, approvalId } = context;
  if (change === 'legacy') {
    await setup.append('mcp-fixture', 'mcp.server_published',
      { serverId: 'fixture', publishedBy: 'alice' });
  } else {
    await reviewRestoration(setup, 'review-restoration');
  }
  if (change !== 'legacy' && change !== 'review only') {
    const record = await publishRestoration(setup, 'restore');
    if (change === 'exact') {
      await refuseUnrelatedRestorationReceipts(setup, headers, record);
    }
    const delivery = await restorationDelivery(setup);
    await delivery.deliver(record);
    await delivery.waitForWitness(record);
    const liveRecord = await invalidateRestoration(context, change, delivery, record);
    if (change !== 'restart before') {
      await delivery.waitForWitness(liveRecord);
    }
    await observeRestoration(context, change, delivery, record);
  }
  const observation = setup.dispatchOptions.acknowledged?.();
  if (observation) Object.assign(headers, generationHeaders(observation));
  const request = { method: 'POST', headers, body };
  const response = await fetch(`${setup.options.decisionUrl}/authorize/mcp/fixture/installed`,
    request);
  if (change === 'exact' || change === 'restart recovery' || change === 'expired approval') {
    expect(response.status, await response.text()).toBe(200);
    const value = response.headers.get('x-opencrane-mcp-permit')!;
    expect((await send(setup, value)).status).toBe(200);
    expect(setup.received()).toBe(1);
    const oldApproval = await readApproval(setup.nats.store, 'test', approvalId);
    let expectedState = 'cancelled';
    if (change === 'expired approval') expectedState = 'expired';
    expect(oldApproval.state).toBe(expectedState);
    if (change === 'restart recovery') {
      await verifyCatalogueRecoveryReplay(setup);
      expect(await readPublication(setup.db, 'test', 'fixture')).toMatchObject({
        status: 'ready', changeRef: 'restore' });
    } else {
      await verifyRestorationReplay(setup);
    }
  } else {
    expect(response.status, await response.text()).toBe(403);
    expect(setup.received()).toBe(0);
  }
}

it.each(restorationCases)('restores drift only through exact live publication: %s',
  restoresReviewedDrift, 60_000);

async function refuseUnrelatedRestorationReceipts(setup: Fixture,
  headers: Record<string, string>, record: Awaited<ReturnType<typeof publishRestoration>>) {
  const policy = await readToolPolicy(setup.nats.store, 'test', 'fixture');
  const member = record.members[0]!;
  const receipt = { serverId: 'fixture', changeRef: member.changeRef,
    reviewRevision: member.entry.reviewRevision, fragmentDigest: member.fragmentDigest,
    sourceSequence: member.sourceSequence, generation: record.generation,
    recordDigest: record.recordDigest, configDigest: 'a'.repeat(64),
    processRef: '00000000-0000-4000-8000-000000000001', observedAt: new Date().toISOString() };
  const substitutions = [{ changeRef: 'unknown' }, { fragmentDigest: 'b'.repeat(64) },
    { reviewRevision: 1 }, { sourceSequence: 1 }, { sourceSequence: policy.sequence + 1000 }];
  for (const substitution of substitutions) {
    const data = { ...receipt, ...substitution };
    await setup.append('mcp-fixture', 'mcp.configuration_observed', data);
    const refused = await readToolPolicy(setup.nats.store, 'test', 'fixture');
    expect(refused).toMatchObject({ driftHeld: true, published: false });
    const request = { method: 'POST', headers, body };
    const response = await fetch(`${setup.options.decisionUrl}/authorize/mcp/fixture/installed`,
      request);
    expect(response.status).toBe(403);
    expect(setup.received()).toBe(0);
  }
  for (const outcome of ['failed', 'unknown']) {
    const invalid = { ...receipt, outcome };
    expect(mcpConfigurationObservationSchema.safeParse(invalid).success).toBe(false);
  }
  for (const silo of ['test', 'other']) {
    const serverId = silo === 'test' ? 'other' : 'fixture';
    const data = { ...receipt, serverId };
    const event = envelope(silo, `mcp-${serverId}`, 'mcp.configuration_observed', data);
    function applyForeignReceipt() {
      return applyToolPolicy(policy, event, policy.sequence + 1);
    }
    expect(applyForeignReceipt).toThrow('identity mismatch');
  }
  const event = envelope('test', 'mcp-fixture', 'mcp.configuration_observed', receipt);
  const expired = { ...policy, expiresAt: event.time };
  const failed = { ...policy, expiresAt: null };
  for (const unavailable of [expired, failed]) {
    const refused = applyToolPolicy(unavailable, event, policy.sequence + 1);
    expect(refused).toMatchObject({ driftHeld: true, published: false });
  }
  const request = { method: 'POST', headers, body };
  const response = await fetch(`${setup.options.decisionUrl}/authorize/mcp/fixture/installed`,
    request);
  expect(response.status).toBe(403);
  expect(setup.received()).toBe(0);
}

async function stopsRootPermit(reason: 'requester_stop' | 'allowance_exhausted') {
  const setup = await fixture();
  try {
    const headers = await prepare(setup);
    const binding = { requesterId: 'alice', conversationId: 'conversation', turnId: 'dispatch',
      threadId: capture.body.params._meta.threadId, assistantId: 'assistant',
      computerId: 'computer', generation: 1, payingGroupId: 'personal-default',
      allowanceCents: 1000 };
    const root = await setup.actor.setRootAllowance(binding, 1);
    const value = await permit(setup, headers);
    if (reason === 'requester_stop') {
      const subject = 'conversation-conversation';
      const payload = { conversationId: 'conversation', turnId: 'dispatch', requestedBy: 'alice' };
      await setup.append(subject, 'agent.turn_stop_requested', payload);
      const position = await setup.nats.store.head(subject);
      await setup.actor.stopRoot(root.rootId, reason, subject, position);
    } else {
      // Save the actor stop directly to isolate the budget check from conversation activity.
      const modelCall = { requesterId: 'alice', conversationId: 'conversation',
        turnId: 'dispatch', threadId: binding.threadId, assistantId: 'assistant',
        computerId: 'computer', generation: 1, payingGroupId: 'personal-default',
        model: 'gpt-6-luna', priceTableId, contextDigest: '0'.repeat(64) };
      await expect(setup.actor.reserve(modelCall, 1001, undefined, undefined, root.rootId))
        .rejects.toThrow('Root budget refused');
    }
    const before = await setup.nats.store.head();
    expect((await send(setup, value)).status).toBe(403);
    expect(setup.received()).toBe(0);
    expect(setup.actor.state.dispatches).toHaveLength(0);
    expect(await setup.nats.store.head()).toBe(before);
    const denied = { method: 'POST', headers, body };
    const response = await fetch(
      `${setup.options.decisionUrl}/authorize/mcp/fixture/installed`, denied);
    expect(response.status).toBe(403);
  } finally {
    await setup.close();
  }
}

it.each(['requester_stop', 'allowance_exhausted'] as const)(
  'refuses an old MCP permit and a new grant after its root stops: %s', stopsRootPermit);

async function nextCarriedGeneration(context: Awaited<ReturnType<typeof publishedFixture>>) {
  const { recordDigest: _digest, ...previous } = context.record;
  const saved = { ...previous, generation: previous.generation + 1, changeRef: 'carried-next' };
  const record = { ...saved, recordDigest: publicationDigest(saved) };
  await context.setup.append('gateway-config-test', 'gateway.configuration_requested', record);
  return record;
}

async function acceptsCurrentAndCarriedGeneration() {
  const context = await publishedFixture();
  const { setup, delivery } = context;
  expect(await gatewayCall(context)).toBe(200);
  expect(setup.received()).toBe(1);
  await expectDispatchStarted(setup, context.record, 0);
  const next = await nextCarriedGeneration(context);
  expect(await gatewayCall(context)).toBe(403);
  const writing = delivery.deliver(next);
  expect(delivery.acknowledged()).toBeNull();
  await writing;
  expect(delivery.acknowledged()).toBeNull();
  await delivery.waitForWitness(next);
  expect(await gatewayCall(context)).toBe(403);
  expect(await delivery.observe()).not.toBeNull();
  const request = { method: 'POST', headers: { ...context.headers, ...context.constants }, body };
  const old = await fetch(`${setup.options.decisionUrl}/authorize/mcp/fixture/installed`, request);
  expect(old.status).toBe(403);
  expect(await gatewayCall(context)).toBe(200);
  expect(setup.received()).toBe(2);
  await expectDispatchStarted(setup, next, 1);
  const rows = await history(setup.nats.store, 'mcp-fixture', 'test');
  function isReceipt(row: typeof rows[number]) {
    return row.event.type === 'mcp.configuration_observed';
  }
  const receipts = rows.filter(isReceipt);
  expect(receipts).toHaveLength(2);
  expect(receipts[0]!.event.data).toMatchObject({ generation: context.record.generation,
    recordDigest: context.record.recordDigest });
  expect(receipts[1]!.event.data).toMatchObject({ generation: next.generation,
    recordDigest: next.recordDigest, changeRef: context.record.members[0]!.changeRef });
  const position = await setup.nats.store.head();
  expect(await delivery.observe()).not.toBeNull();
  expect(await setup.nats.store.head()).toBe(position);
}

it('accepts only the current acknowledged generation, including a carried member',
  acceptsCurrentAndCarriedGeneration);

async function expectDispatchStarted(setup: Fixture,
  record: Awaited<ReturnType<typeof publishRestoration>>, requestIndex: number) {
  const request = setup.providerRequests()[requestIndex]!;
  const requestId = z.string().parse(request.correlationHeaders['x-request-id']);
  const rows = await history(setup.nats.store, `decision-${requestId}`, 'test');
  function isStarted(row: typeof rows[number]) {
    return row.event.type === 'tool.dispatch_started';
  }
  const started = rows.filter(isStarted);
  expect(started).toHaveLength(1);
  expect(started[0]!.event.data).toEqual({ requestId, serverId: 'fixture',
    connectionId: 'installed', generation: record.generation, recordDigest: record.recordDigest,
    reviewRevision: record.members[0]!.entry.reviewRevision });
  expect(rows[0]!.event.type).toBe('decision.recorded');
  expect(started[0]!.sequence).toBeGreaterThan(rows[0]!.sequence);
}

const constantChanges = ['missing', 'generation', 'record-digest', 'server-id',
  'connection-id', 'review-revision', 'duplicate'] as const;

async function refusesInvalidConstants(change: typeof constantChanges[number]) {
  const context = await publishedFixture();
  const headers: Record<string, string> = { ...context.headers, ...context.constants };
  let key = `x-opencrane-${change}`;
  if (change === 'generation') key = 'x-opencrane-gateway-generation';
  if (change === 'missing') {
    for (const name of Object.keys(context.constants)) delete headers[name];
  } else if (change === 'duplicate') {
    const value = headers['x-opencrane-gateway-generation']!;
    headers['x-opencrane-gateway-generation'] = `${value}, ${value}`;
  } else {
    headers[key] = 'wrong';
  }
  const request = { method: 'POST', headers, body };
  const response = await fetch(
    `${context.setup.options.decisionUrl}/authorize/mcp/fixture/installed`, request);
  expect(response.status).toBe(403);
  expect(context.setup.received()).toBe(0);
}

it.each(constantChanges)('refuses publication constants: %s', refusesInvalidConstants);

async function refusesSpoofedNewGeneration(copies: number) {
  const context = await publishedFixture();
  const next = await nextCarriedGeneration(context);
  const constants: Record<string, string | string[]> = generationHeaders(next);
  constants['x-opencrane-gateway-generation'] = Array<string>(copies).fill('2');
  expect(await gatewayCall(context, constants)).toBe(403);
  expect(context.setup.received()).toBe(0);
}

it.each([1, 2])('refuses spoofed unacknowledged constants with %s copies',
  refusesSpoofedNewGeneration);

async function refusesConstantsOnLegacy(name: string) {
  const setup = await fixture();
  onTestFinished(setup.close.bind(setup));
  const headers = await prepare(setup);
  const constants = { ...headers, [name]: '1' };
  const request = { method: 'POST', headers: constants, body };
  const response = await fetch(`${setup.options.decisionUrl}/authorize/mcp/fixture/installed`,
    request);
  expect(response.status).toBe(403);
  expect(setup.received()).toBe(0);
}

const legacyConstants = ['x-opencrane-gateway-generation', 'x-opencrane-record-digest',
  'x-opencrane-server-id', 'x-opencrane-connection-id', 'x-opencrane-review-revision'];

it.each(legacyConstants)('refuses a constant on a legacy publication: %s',
  refusesConstantsOnLegacy);

async function refusesGenerationDuringDispatch(afterAdmission: boolean) {
  const context = await publishedFixture();
  const { setup } = context;
  const headers = { ...context.headers, ...context.constants };
  const value = await permit(setup, headers);
  const append = setup.nats.store.append.bind(setup.nats.store);
  async function changeAfterAdmission(command: AppendCommand) {
    const result = await append(command);
    const event = z.object({ type: z.string() }).parse(command.event);
    if (event.type === 'mcp.dispatch_admitted') await nextCarriedGeneration(context);
    return result;
  }
  if (afterAdmission) {
    vi.spyOn(setup.nats.store, 'append').mockImplementation(changeAfterAdmission);
  } else {
    await nextCarriedGeneration(context);
  }
  try {
    expect((await send(setup, value)).status).toBe(403);
    expect((await send(setup, value)).status).toBe(403);
    expect(setup.received()).toBe(0);
  } finally {
    vi.restoreAllMocks();
  }
}

it.each([false, true])('refuses changed gateway generation after admission: %s',
  refusesGenerationDuringDispatch);

async function consumesPublishedPermitOnce(concurrent: boolean) {
  const context = await publishedFixture();
  const { setup } = context;
  const headers = { ...context.headers, ...context.constants };
  const value = await permit(setup, headers);
  let replies;
  if (concurrent) {
    replies = await Promise.all([send(setup, value), send(setup, value)]);
  } else {
    replies = [await send(setup, value), await send(setup, value)];
  }
  function status(reply: Response) {
    return reply.status;
  }
  const statuses = replies.map(status);
  expect(statuses.sort()).toEqual([200, 403]);
  expect(setup.received()).toBe(1);
  await expectDispatchStarted(setup, context.record, 0);
  const unused = await permit(setup, headers);
  const restarted = await startDecision(setup.actor, setup.identity, setup.binding,
    0, setup.keys, undefined, setup.dispatchOptions);
  onTestFinished(restarted.close);
  const request = { method: 'POST', headers: { 'x-opencrane-mcp-permit': unused }, body };
  const response = await fetch(`${restarted.url}/dispatch/mcp/fixture/installed`, request);
  expect(response.status).toBe(403);
  expect(setup.received()).toBe(1);
}

it.each([false, true])('consumes a published permit once, concurrent: %s',
  consumesPublishedPermitOnce);

async function waitsForDispatchStartReply() {
  const context = await publishedFixture();
  const { setup } = context;
  const saved = Promise.withResolvers<string>();
  const release = Promise.withResolvers<void>();
  const append = setup.nats.store.append.bind(setup.nats.store);
  async function holdStartReply(command: AppendCommand) {
    const result = await append(command);
    const event = z.object({ type: z.string(), subject: z.string() }).parse(command.event);
    if (event.type === 'tool.dispatch_started') {
      saved.resolve(event.subject);
      await release.promise;
    }
    return result;
  }
  const writer = vi.spyOn(setup.nats.store, 'append').mockImplementation(holdStartReply);
  const dispatch = gatewayCall(context);
  function repliedTooSoon(): never {
    throw new Error('Gateway replied before saving the start');
  }
  try {
    const subject = await Promise.race([saved.promise, dispatch.then(repliedTooSoon)]);
    const rows = await history(setup.nats.store, subject, 'test');
    expect(rows.at(-1)!.event.type).toBe('tool.dispatch_started');
    expect(setup.received()).toBe(0);
  } finally {
    release.resolve();
    writer.mockRestore();
  }
  expect(await dispatch).toBe(200);
  expect(setup.received()).toBe(1);
  await expectDispatchStarted(setup, context.record, 0);
  async function recordsOutcome() {
    await ingestUsage(setup.actor, setup.options.usageFile);
    const subject = await saved.promise;
    const rows = await history(setup.nats.store, subject, 'test');
    expect(rows.at(-1)!.event.type).toBe('tool.dispatch_recorded');
    expect(rows).toHaveLength(3);
  }
  await expect.poll(recordsOutcome).toBeUndefined();
  await verifyRestorationReplay(setup);
}

it('saves tool.dispatch_started before any upstream byte and keeps the outcome last',
  waitsForDispatchStartReply, 60_000);

const startFailures = ['lost reply', 'throw', 'conflict', 'rejected', 'withdrawal',
  'access revoked', 'acknowledgement lost', 'new generation', 'backend changed'] as const;

async function refusesAfterDispatchStart(change: typeof startFailures[number]) {
  const context = await publishedFixture();
  const { setup, delivery } = context;
  const headers = { ...context.headers, ...context.constants };
  const value = await permit(setup, headers);
  const append = setup.nats.store.append.bind(setup.nats.store);
  let subject = '';
  let attempts = 0;
  async function interruptStart(command: AppendCommand) {
    const event = z.object({ type: z.string(), subject: z.string() }).parse(command.event);
    if (event.type !== 'tool.dispatch_started') return append(command);
    subject = event.subject;
    attempts++;
    if (change === 'conflict') return { status: 'conflict' as const };
    if (change === 'rejected') {
      return { status: 'rejected' as const, reason: 'duplicate_id' as const };
    }
    const result = await append(command);
    expect(result.status).toBe('appended');
    expect(setup.received()).toBe(0);
    if (change === 'lost reply') {
      return { status: 'unavailable' as const, cause: new Error('START_REPLY_CANARY') };
    }
    if (change === 'throw') throw new Error('START_REPLY_CANARY');
    if (change === 'withdrawal') {
      await setup.append('mcp-fixture', 'mcp.server_unpublished',
        { serverId: 'fixture', unpublishedBy: 'alice' });
    } else if (change === 'access revoked') {
      await setup.append('member-alice', 'member.removed',
        { memberId: 'alice', removedBy: 'alice' });
    } else if (change === 'acknowledgement lost') {
      delivery.close();
    } else if (change === 'new generation') {
      await nextCarriedGeneration(context);
    } else if (change === 'backend changed') {
      setup.options.mcpRoutes[0]!.generation = 'instance-2';
    }
    return result;
  }
  const writer = vi.spyOn(setup.nats.store, 'append').mockImplementation(interruptStart);
  try {
    const first = await send(setup, value);
    expect(first.status).toBe(403);
    expect(await first.json()).toEqual({});
    expect((await send(setup, value)).status).toBe(403);
  } finally {
    writer.mockRestore();
  }
  expect(attempts).toBe(1);
  expect(setup.received()).toBe(0);
  const rows = await history(setup.nats.store, subject, 'test');
  if (change === 'conflict' || change === 'rejected') {
    expect(rows).toHaveLength(1);
  } else {
    expect(rows).toHaveLength(3);
    expect(rows[2]!.event.type).toBe('tool.dispatch_recorded');
    expect(rows[2]!.event.data).toMatchObject({
      outcome: 'not_dispatched', evidence: 'dispatch_refused',
    });
    const event = rows[1]!.event;
    expect(event.type).toBe('tool.dispatch_started');
    const requestId = z.object({ requestId: z.string() }).parse(event.data).requestId;
    expect(event.id).toBe(`${requestId}:tool-dispatch-started`);
    expect(event.commandId).toBe(event.id);
  }
}

it.each(startFailures)('sends nothing after tool.dispatch_started: %s',
  refusesAfterDispatchStart);

async function refusesGenerationDuringLastMcpRead(afterStart: boolean) {
  const context = await publishedFixture();
  const { setup, delivery } = context;
  const headers = { ...context.headers, ...context.constants };
  const value = await permit(setup, headers);
  const encoded = value.split('.')[0]!;
  const decoded: unknown = JSON.parse(Buffer.from(encoded, 'base64url').toString());
  const { requestId } = z.object({ requestId: z.string() }).parse(decoded);
  const append = setup.nats.store.append.bind(setup.nats.store);
  const head = setup.nats.store.head.bind(setup.nats.store);
  const waiting = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let admitted = false;
  let started = false;
  let gatewayChecked = false;
  let held = false;
  async function noteAppend(command: AppendCommand) {
    const result = await append(command);
    const event = z.object({ type: z.string() }).parse(command.event);
    if (event.type === 'mcp.dispatch_admitted') {
      admitted = true;
    }
    if (event.type === 'tool.dispatch_started') {
      started = true;
    }
    return result;
  }
  async function holdMcpRead(...parameters: Parameters<typeof head>) {
    const position = await head(...parameters);
    if (parameters[0] === 'gateway-config-test' && admitted && (!afterStart || started)) {
      gatewayChecked = true;
    }
    if (parameters[0] === 'mcp-fixture' && gatewayChecked && !held) {
      held = true;
      waiting.resolve();
      await release.promise;
    }
    return position;
  }
  const writer = vi.spyOn(setup.nats.store, 'append').mockImplementation(noteAppend);
  const reader = vi.spyOn(setup.nats.store, 'head').mockImplementation(holdMcpRead);
  const dispatch = send(setup, value);
  function repliedTooSoon(): never {
    throw new Error('Dispatch replied before the MCP read barrier');
  }
  try {
    await Promise.race([waiting.promise, dispatch.then(repliedTooSoon)]);
    const mcpPosition = await head('mcp-fixture');
    const acknowledgement = delivery.acknowledged();
    const next = await nextCarriedGeneration(context);
    expect(next.generation).toBe(context.record.generation + 1);
    expect(await head('mcp-fixture')).toBe(mcpPosition);
    expect(delivery.acknowledged()).toEqual(acknowledgement);
    expect(await head('gateway-config-test')).toBeGreaterThan(acknowledgement!.position);
    release.resolve();
    const response = await dispatch;
    expect.soft(response.status).toBe(403);
    expect.soft(setup.received()).toBe(0);
    const rows = await history(setup.nats.store, `decision-${requestId}`, 'test');
    function isStarted(row: typeof rows[number]) {
      return row.event.type === 'tool.dispatch_started';
    }
    expect(rows.filter(isStarted)).toHaveLength(afterStart ? 1 : 0);
    if (afterStart) {
      expect(rows).toHaveLength(3);
      expect(rows[2]!.event.type).toBe('tool.dispatch_recorded');
      expect(rows[2]!.event.data).toMatchObject({
        requestId, outcome: 'not_dispatched', evidence: 'dispatch_refused',
      });
    }
    expect((await send(setup, value)).status).toBe(403);
  } finally {
    release.resolve();
    await dispatch;
    reader.mockRestore();
    writer.mockRestore();
  }
}

it.each([false, true])('refuses a saved generation during the last MCP read, after start: %s',
  refusesGenerationDuringLastMcpRead);

async function ordersDispatchAtLastGatewayRead(savedAfterRead: boolean) {
  const context = await publishedFixture();
  const { setup, delivery } = context;
  const headers = { ...context.headers, ...context.constants };
  const value = await permit(setup, headers);
  const append = setup.nats.store.append.bind(setup.nats.store);
  const head = setup.nats.store.head.bind(setup.nats.store);
  const waiting = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let started = false;
  let gatewayChecked = false;
  let mcpChecked = false;
  let held = false;
  let subject = '';
  async function noteStart(command: AppendCommand) {
    const result = await append(command);
    const event = z.object({ type: z.string(), subject: z.string() }).parse(command.event);
    if (event.type === 'tool.dispatch_started') {
      started = true;
      subject = event.subject;
    }
    return result;
  }
  async function holdLastGatewayRead(...parameters: Parameters<typeof head>) {
    if (started && parameters[0] === 'gateway-config-test') {
      gatewayChecked = true;
    }
    if (gatewayChecked && parameters[0] === 'mcp-fixture') {
      mcpChecked = true;
    }
    if (parameters[0] !== 'gateway-config-test' || !mcpChecked || held) {
      return head(...parameters);
    }
    held = true;
    if (savedAfterRead) {
      const position = await head(...parameters);
      waiting.resolve();
      await release.promise;
      return position;
    }
    waiting.resolve();
    await release.promise;
    return head(...parameters);
  }
  const writer = vi.spyOn(setup.nats.store, 'append').mockImplementation(noteStart);
  const reader = vi.spyOn(setup.nats.store, 'head').mockImplementation(holdLastGatewayRead);
  const dispatch = send(setup, value);
  function repliedTooSoon(): never {
    throw new Error('Dispatch replied before the final gateway read barrier');
  }
  try {
    await Promise.race([waiting.promise, dispatch.then(repliedTooSoon)]);
    const mcpPosition = await head('mcp-fixture');
    const acknowledgement = delivery.acknowledged();
    const next = await nextCarriedGeneration(context);
    expect(next.generation).toBe(context.record.generation + 1);
    expect(await head('mcp-fixture')).toBe(mcpPosition);
    expect(delivery.acknowledged()).toEqual(acknowledgement);
    expect(await head('gateway-config-test')).toBeGreaterThan(acknowledgement!.position);
    expect(setup.received()).toBe(0);
    release.resolve();
    const response = await dispatch;
    expect(response.status).toBe(savedAfterRead ? 200 : 403);
    expect(setup.received()).toBe(savedAfterRead ? 1 : 0);
    const rows = await history(setup.nats.store, subject, 'test');
    expect(rows[1]!.event.type).toBe('tool.dispatch_started');
    expect(rows[1]!.event.data).toMatchObject({ generation: context.record.generation });
    if (savedAfterRead) {
      expect(rows).toHaveLength(2);
    } else {
      expect(rows).toHaveLength(3);
      expect(rows[2]!.event.type).toBe('tool.dispatch_recorded');
      expect(rows[2]!.event.data).toMatchObject({
        outcome: 'not_dispatched', evidence: 'dispatch_refused',
      });
    }
    expect((await send(setup, value)).status).toBe(403);
    expect(setup.received()).toBe(savedAfterRead ? 1 : 0);
  } finally {
    release.resolve();
    await dispatch;
    reader.mockRestore();
    writer.mockRestore();
  }
}

it.each([false, true])('orders dispatch at the last gateway read, saved after read: %s',
  ordersDispatchAtLastGatewayRead);

async function refusesCompetingOutcome(afterRead: boolean) {
  const context = await publishedFixture();
  const { setup } = context;
  const headers = { ...context.headers, ...context.constants };
  const value = await permit(setup, headers);
  const encoded = value.split('.')[0]!;
  const decoded: unknown = JSON.parse(Buffer.from(encoded, 'base64url').toString());
  const { requestId } = z.object({ requestId: z.string() }).parse(decoded);
  const subject = `decision-${requestId}`;
  const append = setup.nats.store.append.bind(setup.nats.store);
  const readEvent = setup.nats.store.readEvent.bind(setup.nats.store);
  const observation = { id: requestId, toolOutcome: 'outcome_unknown' as const,
    evidence: 'transport_uncertain' as const, observedAt: new Date().toISOString(),
    durationMs: 0 };
  let admitted = false;
  let recorded = false;
  let startResult: string | undefined;
  async function saveOutcome() {
    recorded = true;
    await recordToolObservation(setup.actor, observation);
  }
  async function appendWithOutcome(command: AppendCommand) {
    const result = await append(command);
    const event = z.object({ type: z.string() }).parse(command.event);
    if (event.type === 'mcp.dispatch_admitted') {
      admitted = true;
      if (!afterRead) {
        await saveOutcome();
      }
    }
    if (event.type === 'tool.dispatch_started') {
      startResult = result.status;
    }
    return result;
  }
  async function readWithOutcome(...parameters: Parameters<typeof readEvent>) {
    const row = await readEvent(...parameters);
    if (afterRead && admitted && !recorded && row.event.subject === subject) {
      await saveOutcome();
    }
    return row;
  }
  const writer = vi.spyOn(setup.nats.store, 'append').mockImplementation(appendWithOutcome);
  const reader = vi.spyOn(setup.nats.store, 'readEvent').mockImplementation(readWithOutcome);
  try {
    expect((await send(setup, value)).status).toBe(403);
    expect((await send(setup, value)).status).toBe(403);
    expect(recorded).toBe(true);
    expect(setup.received()).toBe(0);
    if (afterRead) {
      expect(startResult).toBe('conflict');
    } else {
      expect(startResult).toBeUndefined();
    }
    const rows = await history(setup.nats.store, subject, 'test');
    expect(rows).toHaveLength(2);
    expect(rows[1]!.event.type).toBe('tool.dispatch_recorded');
  } finally {
    reader.mockRestore();
    writer.mockRestore();
  }
}

it.each([false, true])('keeps a competing outcome last, saved after decision read: %s',
  refusesCompetingOutcome);

async function refusesDuringFinalPublishedRead(
  change: 'withdrawal' | 'acknowledgement' | 'expiry',
) {
  const context = await publishedFixture();
  const { setup, delivery } = context;
  const headers = { ...context.headers, ...context.constants };
  const value = await permit(setup, headers);
  const append = setup.nats.store.append.bind(setup.nats.store);
  const head = setup.nats.store.head.bind(setup.nats.store);
  let started = false;
  let gatewayChecked = false;
  let changed = false;
  async function noteStart(command: AppendCommand) {
    const result = await append(command);
    const event = z.object({ type: z.string() }).parse(command.event);
    if (event.type === 'tool.dispatch_started') started = true;
    return result;
  }
  async function changeDuringRead(...parameters: Parameters<typeof head>) {
    const position = await head(...parameters);
    if (!started || changed) return position;
    if (parameters[0] === 'gateway-config-test') {
      gatewayChecked = true;
      if (change === 'withdrawal') {
        changed = true;
        await setup.append('mcp-fixture', 'mcp.server_unpublished',
          { serverId: 'fixture', unpublishedBy: 'alice' });
      }
    } else if (parameters[0] === 'mcp-fixture' && gatewayChecked) {
      changed = true;
      if (change === 'expiry') {
        vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3000);
      } else {
        delivery.close();
      }
    }
    return position;
  }
  const writer = vi.spyOn(setup.nats.store, 'append').mockImplementation(noteStart);
  const reader = vi.spyOn(setup.nats.store, 'head').mockImplementation(changeDuringRead);
  try {
    expect((await send(setup, value)).status).toBe(403);
    expect((await send(setup, value)).status).toBe(403);
    expect(changed).toBe(true);
    expect(setup.received()).toBe(0);
  } finally {
    reader.mockRestore();
    writer.mockRestore();
    vi.restoreAllMocks();
  }
}

it.each(['withdrawal', 'acknowledgement', 'expiry'] as const)(
  'refuses a final read change after tool.dispatch_started: %s', refusesDuringFinalPublishedRead);

async function refusesRejectedGeneration() {
  const context = await publishedFixture();
  const next = await nextCarriedGeneration(context);
  const { setup, delivery } = context;
  const logs: string[] = [];
  function record(chunk: Buffer) {
    logs.push(chunk.toString());
  }
  setup.gatewayChild()!.stdout?.on('data', record);
  setup.gatewayChild()!.stderr?.on('data', record);
  const settings = { ...delivery.options.settings, keyFile: `${setup.options.configFile}.missing` };
  const options = { ...delivery.options, settings };
  const rejected = gatewayDelivery(options);
  await rejected.deliver(next);
  function reloadRejected() {
    return logs.join('').includes('Failed to reload config');
  }
  await expect.poll(reloadRejected, { timeout: 5000 }).toBe(true);
  expect(await rejected.observe()).toBeNull();
  expect(rejected.acknowledged()).toBeNull();
  expect(await gatewayCall(context)).toBe(403);
  expect(setup.received()).toBe(0);
}

it('refuses an old gateway route after its replacement configuration is rejected',
  refusesRejectedGeneration);

async function refusesWithdrawnPublishedPermit() {
  const context = await publishedFixture();
  const { setup } = context;
  const headers = { ...context.headers, ...context.constants };
  const value = await permit(setup, headers);
  const withdrawal = { serverId: 'fixture', unpublishedBy: 'alice' };
  await setup.append('mcp-fixture', 'mcp.server_unpublished', withdrawal);
  expect((await send(setup, value)).status).toBe(403);
  expect(await gatewayCall(context)).toBe(403);
  expect(setup.received()).toBe(0);
}

it('refuses withdrawal before admitting a published permit', refusesWithdrawnPublishedPermit);

async function keepsApprovalAcrossCarriedGeneration() {
  const context = await publishedFixture('ask');
  const { setup, delivery } = context;
  const headers = { ...context.headers, ...context.constants };
  const request = { method: 'POST', headers, body };
  const response = await fetch(`${setup.options.decisionUrl}/authorize/mcp/fixture/installed`,
    request);
  const data: unknown = await response.json();
  const { approvalId } = z.object({ approvalId: z.string() }).parse(data);
  const before = await readApproval(setup.nats.store, 'test', approvalId);
  expect(before.state).toBe('requested');
  const next = await nextCarriedGeneration(context);
  await delivery.deliver(next);
  await delivery.waitForWitness(next);
  expect(await delivery.observe()).not.toBeNull();
  const after = await readApproval(setup.nats.store, 'test', approvalId);
  expect(after.request).toEqual(before.request);
  expect(after.state).toBe('requested');
  async function fresh() {}
  const result = await decideApproval(setup.nats.store, 'test', approvalId,
    'alice', 'approved', true, fresh, after, setup.actor.now());
  expect(result.status).toBe('appended');
  const currentHeaders = { ...context.headers, ...generationHeaders(next) };
  const value = await permit(setup, currentHeaders);
  expect((await send(setup, value)).status).toBe(200);
  expect(setup.received()).toBe(1);
}

it('keeps a waiting approval bound to its review across a carried generation',
  keepsApprovalAcrossCarriedGeneration);
