import { body, tool, prepare, permit, send, reviewRestoration, publishRestoration,
  restorationDelivery, generationHeaders } from './support/mcp-dispatch-fixture.ts';
import { losslessJson } from '@opencrane/events/lossless-json';
import { mcpCatalogue, readPublication } from '@opencrane/projections';
import { gatewayObservationSchema } from '@opencrane/events';
import type { AppendCommand, StoredEvent } from '@opencrane/event-store';
import { setTimeout as pause } from 'node:timers/promises';
import { z } from 'zod';
import { expect, it, onTestFinished, vi } from 'vitest';
import { mcpCatalogueWatch } from '../src/mcp-catalogue-watch.ts';
import { conversations } from '@opencrane/projections';
import { budgetStopHandler } from '../src/index.ts';
import { decideApproval, history, ingestUsage, readApproval, readToolPolicy }
  from '../src/index.ts';
import { catalogueEvidence, fixture, toolEvidence } from './fixture.ts';
import { grantToolApproval, approvalPermit, verifyRestorationReplay, approvalForReviewedTool,
  verifyCatalogueRecoveryReplay } from './support/mcp-dispatch-assertions.ts';

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function watchesCatalogue(failure: 'drift append' | 'drift saved' | 'failed' | 'stalled' | 'replacement') {
  const setup = await fixture();
  let watch: ReturnType<typeof mcpCatalogueWatch> | undefined;
  let expectedCalls = 0;
  try {
    const headers = await prepare(setup);
    const value = await permit(setup, headers);
    const before = await readToolPolicy(setup.nats.store, 'test', 'fixture');
    const capture = vi.fn().mockResolvedValue(before.catalogue);
    const requireLeader = setup.dispatchOptions.requireLeader.bind(setup.dispatchOptions);
    const options = { serverIds: ['fixture'], capture, timeoutMs: 500, requireLeader };
    watch = mcpCatalogueWatch(setup.nats.store, 'test', options);
    setup.dispatchOptions.requireCatalogue = watch.requireCurrent;
    expect((await send(setup, value)).status).toBe(403);
    const startup = watch.check('fixture');
    expect(watch.check('fixture')).toBe(startup);
    await startup;
    expect(capture).toHaveBeenCalledTimes(1);
    const freshPermit = await permit(setup, headers);
    if (failure === 'replacement') {
      const started = Promise.withResolvers<void>();
      const late = Promise.withResolvers<NonNullable<typeof before.catalogue>>();
      function pendingCapture() {
        started.resolve();
        return late.promise;
      }
      capture.mockImplementation(pendingCapture);
      const checking = watch.check('fixture');
      const cancelled = expect(checking).rejects.toThrow();
      await started.promise;
      watch.close();
      await cancelled;
      capture.mockResolvedValue(before.catalogue);
      watch = mcpCatalogueWatch(setup.nats.store, 'test', options);
      setup.dispatchOptions.requireCatalogue = watch.requireCurrent;
      expect((await send(setup, freshPermit)).status).toBe(403);
      await watch.check('fixture');
      expect(capture).toHaveBeenCalledTimes(3);
      const current = await readToolPolicy(setup.nats.store, 'test', 'fixture');
      late.resolve(before.catalogue!);
      await pause(0);
      const afterLateResult = await readToolPolicy(setup.nats.store, 'test', 'fixture');
      expect(afterLateResult.sequence).toBe(current.sequence);
    } else {
      const append = setup.nats.store.append.bind(setup.nats.store);
      let driftAppendAttempted = false;
      const captureStarted = Promise.withResolvers<void>();
      const stalled = Promise.withResolvers<NonNullable<typeof before.catalogue>>();
      async function failDriftAppend(command: AppendCommand) {
        const event = z.object({ type: z.string() }).parse(command.event);
        if (event.type === 'mcp.tools_changed') {
          driftAppendAttempted = true;
          expect((await send(setup, freshPermit)).status).toBe(403);
          throw new Error('Event store unavailable');
        }
        return append(command);
      }
      if (failure === 'drift append' || failure === 'drift saved') {
        const added = toolEvidence({ name: 'another', reviewed: false, costCents: 0 });
        capture.mockResolvedValue({ ...before.catalogue, ...catalogueEvidence([tool, added]) });
        if (failure === 'drift append') {
          vi.spyOn(setup.nats.store, 'append').mockImplementation(failDriftAppend);
        }
      } else if (failure === 'failed') {
        capture.mockRejectedValue(new Error('Upstream unavailable'));
      } else {
        function stallCapture() {
          captureStarted.resolve();
          return stalled.promise;
        }
        capture.mockImplementation(stallCapture);
      }
      const checkStartedAt = performance.now();
      const checking = watch.check('fixture');
      let refused: Promise<unknown>;
      if (failure === 'drift saved') refused = checking;
      else refused = expect(checking).rejects.toThrow();
      if (failure === 'stalled') {
        await captureStarted.promise;
      }
      await refused;
      if (failure === 'drift append') expect(driftAppendAttempted).toBe(true);
      if (failure === 'stalled') {
        expect(performance.now() - checkStartedAt).toBeLessThan(3000);
        stalled.resolve(before.catalogue!);
        await pause(0);
      }
      expect((await send(setup, freshPermit)).status).toBe(403);
      expect(() => watch!.requireCurrent('fixture')).toThrow();
      if (failure === 'drift saved') {
        const held = await readToolPolicy(setup.nats.store, 'test', 'fixture');
        expect(held.driftHeld).toBe(true);
        expect(held.previousCatalogue).toEqual(before.catalogue);
      } else if (failure !== 'drift append') {
        const failed = await readToolPolicy(setup.nats.store, 'test', 'fixture');
        expect(failed.expiresAt).toBeNull();
        expect(failed.policyRevision).toBeGreaterThan(before.policyRevision);
        capture.mockResolvedValue(before.catalogue);
        await watch.check('fixture');
        const recovered = await readToolPolicy(setup.nats.store, 'test', 'fixture');
        expect(recovered.policyRevision).toBeGreaterThan(before.policyRevision);
        const newPermit = await permit(setup, headers);
        expect((await send(setup, newPermit)).status).toBe(200);
        expectedCalls = 1;
      }
    }
    expect(setup.received()).toBe(expectedCalls);
  } finally {
    vi.restoreAllMocks();
    watch?.close();
    await setup.close();
  }
}

it.each(['drift append', 'drift saved', 'failed', 'stalled', 'replacement'] as const)(
  'holds recording upstream through %s and recaptures on worker replacement', watchesCatalogue, 60_000);

const renewalCases = ['fresh', 'expired observed', 'expired unread', 'expired during append'] as const;

async function checksApprovalAfterRenewal(renewal: typeof renewalCases[number]) {
  const setup = await fixture();
  let watch: ReturnType<typeof mcpCatalogueWatch> | undefined;
  try {
    const headers = await prepare(setup);
    const initial = await readToolPolicy(setup.nats.store, 'test', 'fixture');
    const startedAt = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(startedAt);
    const expiresAt = new Date(startedAt + 10_000).toISOString();
    const initialCapture = { ...initial.catalogue, expiresAt };
    const capture = vi.fn();
    capture.mockResolvedValue(initialCapture);
    const options = { serverIds: ['fixture'], capture,
      requireLeader: setup.dispatchOptions.requireLeader.bind(setup.dispatchOptions) };
    watch = mcpCatalogueWatch(setup.nats.store, 'test', options);
    setup.dispatchOptions.requireCatalogue = watch.requireCurrent;
    await watch.check('fixture');
    const approvalId = await grantToolApproval(setup, headers);
    const before = await readToolPolicy(setup.nats.store, 'test', 'fixture');
    const captureStarted = Promise.withResolvers<void>();
    const captured = Promise.withResolvers<NonNullable<typeof initial.catalogue>>();
    function pendingCapture() {
      captureStarted.resolve();
      return captured.promise;
    }
    capture.mockImplementation(pendingCapture);
    vi.setSystemTime(startedAt + 1000);
    const checking = watch.check('fixture');
    await captureStarted.promise;
    if (renewal === 'expired observed') {
      vi.setSystemTime(startedAt + 10_000);
      expect(() => watch!.requireCurrent('fixture')).toThrow('watch unavailable');
    }
    let finishedAt = startedAt + 10_500;
    if (renewal === 'fresh' || renewal === 'expired during append') finishedAt = startedAt + 9500;
    vi.setSystemTime(finishedAt);
    const append = setup.nats.store.append.bind(setup.nats.store);
    async function crossExpiryDuringAppend(command: AppendCommand) {
      const result = await append(command);
      const event = z.object({ type: z.string() }).parse(command.event);
      if (event.type === 'mcp.catalogue_checked') vi.setSystemTime(startedAt + 10_500);
      return result;
    }
    if (renewal === 'expired during append') {
      const writer = vi.spyOn(setup.nats.store, 'append');
      writer.mockImplementation(crossExpiryDuringAppend);
    }
    const renewed = { ...initial.catalogue!, checkedAt: new Date(finishedAt).toISOString(),
      expiresAt: new Date(startedAt + 11_000).toISOString() };
    captured.resolve(renewed);
    await checking;
    expect(() => watch!.requireCurrent('fixture')).not.toThrow();
    const after = await readToolPolicy(setup.nats.store, 'test', 'fixture');
    const approval = await readApproval(setup.nats.store, 'test', approvalId);
    const response = await approvalPermit(setup, headers, approvalId);
    if (renewal === 'fresh') {
      expect(after.policyRevision).toBe(before.policyRevision);
      expect(approval.state).toBe('approved');
      expect(response.headers.get('x-opencrane-mcp-permit')).toBeTruthy();
    } else {
      expect.soft(after.policyRevision).toBeGreaterThan(before.policyRevision);
      expect.soft(approval.state).toBe('cancelled');
      expect.soft(response.headers.get('x-opencrane-mcp-permit')).toBeNull();
    }
    expect(setup.received()).toBe(0);
  } finally {
    vi.useRealTimers();
    vi.restoreAllMocks();
    watch?.close();
    await setup.close();
  }
}

it.each(renewalCases)('keeps approvals valid only across uninterrupted renewal: %s',
  checksApprovalAfterRenewal);

const finalReadCases = ['fresh', 'expired observed', 'expired unread',
  'expired recovery observed'] as const;

async function checksApprovalAfterFinalRead(timing: typeof finalReadCases[number]) {
  const setup = await fixture();
  let watch: ReturnType<typeof mcpCatalogueWatch> | undefined;
  try {
    const headers = await prepare(setup);
    const initial = await readToolPolicy(setup.nats.store, 'test', 'fixture');
    const startedAt = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(startedAt);
    const initialCapture = { ...initial.catalogue,
      expiresAt: new Date(startedAt + 10_000).toISOString() };
    const capture = vi.fn();
    capture.mockResolvedValue(initialCapture);
    const options = { serverIds: ['fixture'], capture,
      requireLeader: setup.dispatchOptions.requireLeader.bind(setup.dispatchOptions) };
    watch = mcpCatalogueWatch(setup.nats.store, 'test', options);
    setup.dispatchOptions.requireCatalogue = watch.requireCurrent;
    await watch.check('fixture');
    const approvalId = await grantToolApproval(setup, headers);
    const before = await readToolPolicy(setup.nats.store, 'test', 'fixture');
    const renewed = { ...initial.catalogue!, checkedAt: new Date(startedAt + 9500).toISOString(),
      expiresAt: new Date(startedAt + 20_000).toISOString() };
    capture.mockResolvedValue(renewed);
    vi.setSystemTime(startedAt + 9500);
    const readStream = setup.nats.store.readStream.bind(setup.nats.store);
    const append = setup.nats.store.append.bind(setup.nats.store);
    let captureSaved = false;
    let readFinished = false;
    async function saveRenewal(command: AppendCommand) {
      const result = await append(command);
      const event = z.object({ type: z.string(), data: z.object({ outcome: z.string() }) })
        .safeParse(command.event);
      if (event.success && event.data.type === 'mcp.catalogue_checked' &&
          event.data.data.outcome === 'unchanged') captureSaved = true;
      return result;
    }
    const writer = vi.spyOn(setup.nats.store, 'append');
    writer.mockImplementation(saveRenewal);
    function requireCurrent() {
      watch!.requireCurrent('fixture');
    }
    async function* finishFinalRead(...parameters: Parameters<typeof readStream>) {
      yield* readStream(...parameters);
      if (parameters[0] !== 'mcp-fixture') return;
      if (!captureSaved || readFinished) return;
      readFinished = true;
      let finishedAt = startedAt + 10_500;
      if (timing === 'fresh') finishedAt = startedAt + 9900;
      vi.setSystemTime(finishedAt);
      if (timing === 'expired observed' || timing === 'expired recovery observed') {
        expect(requireCurrent).toThrow('watch unavailable');
      }
    }
    const reader = vi.spyOn(setup.nats.store, 'readStream');
    reader.mockImplementation(finishFinalRead);
    if (timing === 'expired recovery observed') {
      vi.setSystemTime(startedAt + 10_000);
      expect(requireCurrent).toThrow('watch unavailable');
    }
    const checking = watch.check('fixture');
    if (timing === 'fresh') {
      await checking;
      expect(requireCurrent).not.toThrow();
    } else {
      await expect.soft(checking).rejects.toThrow();
      expect.soft(requireCurrent).toThrow('watch unavailable');
    }
    reader.mockRestore();
    writer.mockRestore();
    expect(readFinished).toBe(true);
    const after = await readToolPolicy(setup.nats.store, 'test', 'fixture');
    const approval = await readApproval(setup.nats.store, 'test', approvalId);
    const response = await approvalPermit(setup, headers, approvalId);
    const value = response.headers.get('x-opencrane-mcp-permit');
    if (value) await send(setup, value);
    if (timing === 'fresh') {
      expect(after.policyRevision).toBe(before.policyRevision);
      expect(approval.state).toBe('approved');
      expect(value).toBeTruthy();
      expect(setup.received()).toBe(1);
    } else {
      expect.soft(after.policyRevision).toBeGreaterThan(before.policyRevision);
      expect.soft(approval.state).toBe('cancelled');
      expect.soft(value).toBeNull();
      expect.soft(setup.received()).toBe(0);
      await watch.check('fixture');
      expect(requireCurrent).not.toThrow();
      const recovered = await readApproval(setup.nats.store, 'test', approvalId);
      expect(recovered.state).toBe('cancelled');
      const retried = await approvalPermit(setup, headers, approvalId);
      expect(retried.headers.get('x-opencrane-mcp-permit')).toBeNull();
      expect(setup.received()).toBe(0);
    }
  } finally {
    vi.useRealTimers();
    vi.restoreAllMocks();
    watch?.close();
    await setup.close();
  }
}

it.each(finalReadCases)('keeps approval safety through the final watch read: %s',
  checksApprovalAfterFinalRead);

async function verifyApprovalRetry(setup: Fixture, headers: Record<string, string>,
  approvalId: string) {
  await setup.refuseMcpConnection();
  const approvalHeaders = { ...headers, 'x-opencrane-approval-id': approvalId };
  const request = { method: 'POST', headers: approvalHeaders, body };
  const response = await fetch(`http://127.0.0.1:${setup.options.port}/mcp/fixture/installed`,
    request);
  expect(response.status).toBe(503);
  await setup.restart();
  await ingestUsage(setup.actor, setup.options.usageFile);
  const current = await readApproval(setup.nats.store, 'test', approvalId);
  expect(current).toMatchObject({ state: 'outcome_unknown', canRetry: true });
  async function fresh() {}
  const retry = await decideApproval(setup.nats.store, 'test', approvalId,
    'alice', 'retry', true, fresh, current, setup.actor.now());
  expect(retry.status).toBe('appended');
  const approved = await readApproval(setup.nats.store, 'test', approvalId);
  expect(approved.state).toBe('approved');
}

const recoveryApprovals = [
  { failure: 'failed', retry: false }, { failure: 'failed', retry: true },
  { failure: 'stalled', retry: false }, { failure: 'stalled', retry: true },
] as const;

async function refusesOldApprovalAfterRecovery(testCase: typeof recoveryApprovals[number]) {
  const setup = await fixture();
  let watch: ReturnType<typeof mcpCatalogueWatch> | undefined;
  try {
    const headers = await prepare(setup);
    const initial = await readToolPolicy(setup.nats.store, 'test', 'fixture');
    const capture = vi.fn();
    capture.mockResolvedValue(initial.catalogue);
    const options = { serverIds: ['fixture'], capture, timeoutMs: 500,
      requireLeader: setup.dispatchOptions.requireLeader.bind(setup.dispatchOptions) };
    watch = mcpCatalogueWatch(setup.nats.store, 'test', options);
    setup.dispatchOptions.requireCatalogue = watch.requireCurrent;
    await watch.check('fixture');
    const approvalId = await grantToolApproval(setup, headers);
    if (testCase.retry) await verifyApprovalRetry(setup, headers, approvalId);
    const before = await readToolPolicy(setup.nats.store, 'test', 'fixture');
    const stalled = Promise.withResolvers<NonNullable<typeof initial.catalogue>>();
    if (testCase.failure === 'failed') {
      capture.mockRejectedValue(new Error('Upstream unavailable'));
    } else {
      capture.mockReturnValue(stalled.promise);
    }
    await expect(watch.check('fixture')).rejects.toThrow();
    expect(() => watch!.requireCurrent('fixture')).toThrow();
    capture.mockResolvedValue(initial.catalogue);
    await watch.check('fixture');
    expect(() => watch!.requireCurrent('fixture')).not.toThrow();
    const after = await readToolPolicy(setup.nats.store, 'test', 'fixture');
    expect.soft(after.policyRevision).toBeGreaterThan(before.policyRevision);
    const approval = await readApproval(setup.nats.store, 'test', approvalId);
    expect.soft(approval).toMatchObject({ state: 'cancelled', canRetry: false });
    const response = await approvalPermit(setup, headers, approvalId);
    expect.soft(response.headers.get('x-opencrane-mcp-permit')).toBeNull();
    expect.soft(setup.received()).toBe(0);
  } finally {
    watch?.close();
    await setup.close();
  }
}

it.each(recoveryApprovals)('refuses old approval after watch recovery: $failure, retry $retry',
  refusesOldApprovalAfterRecovery, 45_000);

async function refusesFinalSendDuringLocalHold() {
  const setup = await fixture();
  let watch: ReturnType<typeof mcpCatalogueWatch> | undefined;
  try {
    const headers = await prepare(setup);
    const initial = await readToolPolicy(setup.nats.store, 'test', 'fixture');
    const capture = vi.fn();
    capture.mockResolvedValue(initial.catalogue);
    const options = { serverIds: ['fixture'], capture,
      requireLeader: setup.dispatchOptions.requireLeader.bind(setup.dispatchOptions) };
    watch = mcpCatalogueWatch(setup.nats.store, 'test', options);
    setup.dispatchOptions.requireCatalogue = watch.requireCurrent;
    await watch.check('fixture');
    const value = await permit(setup, headers);
    const before = await readToolPolicy(setup.nats.store, 'test', 'fixture');
    const append = setup.nats.store.append.bind(setup.nats.store);
    let admitted = false;
    async function holdAfterAdmission(command: AppendCommand) {
      const event = z.object({ type: z.string() }).parse(command.event);
      if (event.type === 'mcp.catalogue_checked') throw new Error('Event store unavailable');
      const result = await append(command);
      if (event.type === 'mcp.dispatch_admitted' && result.status === 'appended') {
        admitted = true;
        capture.mockRejectedValue(new Error('Upstream unavailable'));
        await expect(watch!.check('fixture')).rejects.toThrow('Event store unavailable');
      }
      return result;
    }
    const writer = vi.spyOn(setup.nats.store, 'append');
    writer.mockImplementation(holdAfterAdmission);
    const response = await send(setup, value);
    expect(admitted).toBe(true);
    expect.soft(response.status).toBe(403);
    expect.soft(setup.received()).toBe(0);
    const after = await readToolPolicy(setup.nats.store, 'test', 'fixture');
    expect(after.policyRevision).toBe(before.policyRevision);
    expect(() => watch!.requireCurrent('fixture')).toThrow();
  } finally {
    vi.restoreAllMocks();
    watch?.close();
    await setup.close();
  }
}

it('refuses a final send when a local hold arrives after tool admission',
  refusesFinalSendDuringLocalHold);

async function budgetHandlerEndsApproval() {
  const setup = await fixture();
  try {
    const headers = await prepare(setup);
    const approvalId = await grantToolApproval(setup, headers, false);
    const waiting = await readApproval(setup.nats.store, 'test', approvalId);
    await setup.actor.configure({ scope: 'paying_group', scopeId: 'personal-default',
      ceilingCents: 0, setBy: 'alice' });
    const rows = await history(setup.nats.store, 'budget-test', 'test');
    const stop = rows.at(-1)!.event;
    await setup.runner.initialise(conversations);
    await setup.runner.run(conversations);
    await budgetStopHandler(setup.nats.store).handle(stop, setup.db);
    await setup.actor.configure({ scope: 'paying_group', scopeId: 'personal-default',
      ceilingCents: 20000, setBy: 'alice' });
    const approval = await readApproval(setup.nats.store, 'test', approvalId);
    expect(approval.state).toBe('cancelled');
    async function fresh() {}
    const late = await decideApproval(setup.nats.store, 'test', approvalId,
      'alice', 'approved', true, fresh, waiting);
    expect(late.status).toBe('conflict');
    const response = await approvalPermit(setup, headers, approvalId);
    expect(response.status).not.toBe(200);
    expect(setup.received()).toBe(0);
  } finally {
    await setup.close();
  }
}

it('ends a waiting approval through the saved budget turn stop', budgetHandlerEndsApproval);

const descriptionCanary = 'UNTRUSTED_DESCRIPTION_RELOAD_CANARY';

async function reviewedReloadFixture(setup: Fixture) {
  const headers = await prepare(setup);
  const savedDefinition = z.string().parse(tool.definition);
  const parsed: unknown = JSON.parse(savedDefinition);
  const definition = z.record(z.string(), z.unknown()).parse(parsed);
  definition['description'] = descriptionCanary;
  const encoded = losslessJson(JSON.stringify(definition));
  const declaration = { ...tool, definition: encoded.canonical, revision: encoded.digest };
  const discovery = { serverId: 'fixture', connectionId: 'installed', accountMode: 'none',
    ...catalogueEvidence([declaration]) };
  await setup.append('mcp-fixture', 'mcp.server_discovered', discovery);
  const policy = await readToolPolicy(setup.nats.store, 'test', 'fixture');
  function captureCatalogue() {
    return Promise.resolve(policy.catalogue!);
  }
  const options = { serverIds: ['fixture'], capture: captureCatalogue,
    requireLeader: setup.dispatchOptions.requireLeader.bind(setup.dispatchOptions) };
  const watch = mcpCatalogueWatch(setup.nats.store, 'test', options);
  onTestFinished(watch.close);
  setup.dispatchOptions.requireCatalogue = watch.requireCurrent;
  await watch.check('fixture');
  await reviewRestoration(setup, 'review-reload', 'ask');
  // Start from a callable legacy publication; activation of new servers is separate work.
  await setup.append('mcp-fixture', 'mcp.server_published',
    { serverId: 'fixture', publishedBy: 'alice' });
  await reviewRestoration(setup, 'review-initial-reload', 'ask');
  const delivery = await restorationDelivery(setup);
  const first = await publishRestoration(setup, 'initial-reload');
  await acknowledgeReload(delivery, first);
  Object.assign(headers, generationHeaders(first));
  await watch.check('fixture');
  watch.requireCurrent('fixture');
  return { headers, watch, delivery, first };
}

async function acknowledgeReload(delivery: Awaited<ReturnType<typeof restorationDelivery>>,
  record: Awaited<ReturnType<typeof publishRestoration>>) {
  await delivery.deliver(record);
  await delivery.waitForWitness(record);
  async function acknowledged() {
    expect(await delivery.observe()).not.toBeNull();
  }
  await expect.poll(acknowledged, { timeout: 5000 }).toBeUndefined();
}

async function cancelsApprovalOnSavedReload(approve: boolean, readPending: boolean) {
  const setup = await fixture();
  async function close() {
    await setup.close();
  }
  onTestFinished(close);
  const output: string[] = [];
  function recordOutput(chunk: Buffer) {
    output.push(chunk.toString());
  }
  const child = setup.gatewayChild()!;
  child.stdout?.on('data', recordOutput);
  child.stderr?.on('data', recordOutput);
  const { headers, watch, delivery, first } = await reviewedReloadFixture(setup);
  const approvalId = await approvalForReviewedTool(setup, headers, approve);
  const before = await readToolPolicy(setup.nats.store, 'test', 'fixture');
  const record = await publishRestoration(setup, 'reload');
  expect(record.generation).toBe(first.generation + 1);
  expect(await delivery.observe()).toBeNull();
  await expect(delivery.deliver(first)).rejects.toThrow('Gateway delivery unavailable');
  await setup.append('mcp-fixture', 'mcp.configuration_observed',
    before.configurationObservation);
  await watch.check('fixture');
  function requireCurrent() {
    watch.requireCurrent('fixture');
  }
  expect(requireCurrent).toThrow('watch unavailable');
  const pending = await readToolPolicy(setup.nats.store, 'test', 'fixture');
  expect.soft(pending.policyRevision).toBeGreaterThan(before.policyRevision);
  if (readPending) {
    const cancelled = await readApproval(setup.nats.store, 'test', approvalId);
    expect(cancelled.state).toBe('cancelled');
  }
  await acknowledgeReload(delivery, record);
  await watch.check('fixture');
  watch.requireCurrent('fixture');
  const restored = await readToolPolicy(setup.nats.store, 'test', 'fixture');
  const observedPosition = await setup.nats.store.head();
  await delivery.observe();
  expect(await setup.nats.store.head()).toBe(observedPosition);
  expect(restored.published).toBe(true);
  expect(restored.policyRevision).toBe(pending.policyRevision);
  const old = await readApproval(setup.nats.store, 'test', approvalId);
  expect(old.state).toBe('cancelled');
  async function fresh() {}
  for (const action of ['approved', 'retry'] as const) {
    const result = await decideApproval(setup.nats.store, 'test', approvalId,
      'alice', action, true, fresh, old);
    expect(result.status).toBe('conflict');
  }
  Object.assign(headers, generationHeaders(record));
  const refused = await approvalPermit(setup, headers, approvalId);
  expect(refused.status).not.toBe(200);
  expect(await refused.text()).not.toContain(descriptionCanary);
  const approvalRows = await history(setup.nats.store, `approval-${approvalId}`, 'test');
  expect(JSON.stringify(approvalRows)).not.toContain(descriptionCanary);
  expect(setup.received()).toBe(0);
  const position = await setup.nats.store.head();
  await setup.restart();
  expect(await readToolPolicy(setup.nats.store, 'test', 'fixture')).toEqual(restored);
  expect(await readApproval(setup.nats.store, 'test', approvalId)).toEqual(old);
  expect(await setup.nats.store.head()).toBe(position);
  await verifyRestorationReplay(setup, 0);
  expect(output.join('')).not.toContain(descriptionCanary);
}

it.each([[false, false], [true, false], [false, true], [true, true]])(
  'cancels old approvals on saved reload (approved %s, read pending %s)',
  cancelsApprovalOnSavedReload, 60_000);

async function preservesApprovalForOtherReload(serverId: string) {
  const setup = await fixture();
  try {
    const { headers, first } = await reviewedReloadFixture(setup);
    const approvalId = await approvalForReviewedTool(setup, headers, true);
    const before = await readToolPolicy(setup.nats.store, 'test', 'fixture');
    const approved = await readApproval(setup.nats.store, 'test', approvalId);
    const registration = { serverId, kind: 'remote',
      locator: 'https://other.example.test/mcp', registeredBy: 'alice' };
    await setup.append(`mcp-${serverId}`, 'mcp.server_registered', registration);
    const discovery = { ...before.catalogue!, serverId };
    await setup.append(`mcp-${serverId}`, 'mcp.server_discovered', discovery);
    await reviewRestoration(setup, 'review-other', 'ask', serverId);
    const record = await publishRestoration(setup, 'reload-other', serverId);
    expect(record.generation).toBe(first.generation + 1);
    expect(record.members[0]).toEqual(first.members[0]);
    const delivery = await restorationDelivery(setup, false);
    await delivery.deliver(record);
    await delivery.waitForWitness(record);
    async function acknowledged() {
      expect(await delivery.observe()).not.toBeNull();
    }
    await expect.poll(acknowledged, { timeout: 5000 }).toBeUndefined();
    const observation = await delivery.observe();
    const { outcome: _outcome, ...observed } =
      gatewayObservationSchema.parse(observation!.event.data);
    const expectedReceipt = { ...before.configurationObservation!, ...observed };
    const rows = await history(setup.nats.store, 'mcp-fixture', 'test');
    const receipt = rows.at(-1)!;
    expect(receipt.event.type).toBe('mcp.configuration_observed');
    expect(receipt.event.data).toEqual(expectedReceipt);
    expect(receipt.sequence).toBeGreaterThan(before.sequence);
    const expectedPolicy = { ...before, sequence: receipt.sequence,
      configurationObservation: expectedReceipt };
    expect(await readToolPolicy(setup.nats.store, 'test', 'fixture')).toEqual(expectedPolicy);
    expect(await readApproval(setup.nats.store, 'test', approvalId)).toEqual(approved);
    Object.assign(headers, generationHeaders(record));
    const response = await approvalPermit(setup, headers, approvalId);
    expect(response.status).toBe(200);
    const value = response.headers.get('x-opencrane-mcp-permit')!;
    expect((await send(setup, value)).status).toBe(200);
    expect((await send(setup, value)).status).toBe(403);
    expect(setup.received()).toBe(1);
  } finally {
    await setup.close();
  }
}

it.each(['odoo', 'memory'])('keeps another server approval through %s reload',
  preservesApprovalForOtherReload, 60_000);

async function preservesConsumedApproval() {
  const setup = await fixture();
  try {
    const headers = await prepare(setup);
    await reviewRestoration(setup, 'review-consumed', 'ask');
    const approvalId = await approvalForReviewedTool(setup, headers, true);
    const response = await approvalPermit(setup, headers, approvalId);
    const value = response.headers.get('x-opencrane-mcp-permit')!;
    expect((await send(setup, value)).status).toBe(200);
    const before = await readApproval(setup.nats.store, 'test', approvalId);
    expect(before.state).toBe('outcome_unknown');
    const rows = await history(setup.nats.store, `approval-${approvalId}`, 'test');
    await publishRestoration(setup, 'reload-consumed');
    expect(await readApproval(setup.nats.store, 'test', approvalId)).toEqual(before);
    expect(await history(setup.nats.store, `approval-${approvalId}`, 'test')).toEqual(rows);
    expect((await send(setup, value)).status).toBe(403);
    expect(setup.received()).toBe(1);
  } finally {
    await setup.close();
  }
}

it('keeps a consumed approval and its historical outcome through reload',
  preservesConsumedApproval, 60_000);

async function refusesReloadDuringFinalRead() {
  const setup = await fixture();
  try {
    const { headers, watch } = await reviewedReloadFixture(setup);
    const approvalId = await approvalForReviewedTool(setup, headers, true);
    const readStream = setup.nats.store.readStream.bind(setup.nats.store);
    const append = setup.nats.store.append.bind(setup.nats.store);
    let captureSaved = false;
    let changed = false;
    async function saveCapture(command: AppendCommand) {
      const result = await append(command);
      const event = z.object({ type: z.string() }).parse(command.event);
      if (event.type === 'mcp.catalogue_checked') captureSaved = true;
      return result;
    }
    async function* reloadDuringRead(...parameters: Parameters<typeof readStream>) {
      if (parameters[0] === 'mcp-fixture' && captureSaved && !changed) {
        changed = true;
        await publishRestoration(setup, 'reload-final-read');
      }
      yield* readStream(...parameters);
    }
    const writer = vi.spyOn(setup.nats.store, 'append');
    const reader = vi.spyOn(setup.nats.store, 'readStream');
    writer.mockImplementation(saveCapture);
    reader.mockImplementation(reloadDuringRead);
    try {
      await watch.check('fixture');
    } finally {
      writer.mockRestore();
      reader.mockRestore();
    }
    expect(changed).toBe(true);
    function requireCurrent() {
      watch.requireCurrent('fixture');
    }
    expect(requireCurrent).toThrow('watch unavailable');
    const approval = await readApproval(setup.nats.store, 'test', approvalId);
    expect(approval.state).toBe('cancelled');
    expect((await approvalPermit(setup, headers, approvalId)).status).not.toBe(200);
    expect(setup.received()).toBe(0);
  } finally {
    await setup.close();
  }
}

it('refuses a saved reload during the final awaited watch read',
  refusesReloadDuringFinalRead, 60_000);

async function publishedWatchFixture(mode = 'allow') {
  const setup = await fixture();
  async function closeSetup() {
    await setup.close();
  }
  onTestFinished(closeSetup);
  const headers = await prepare(setup);
  const initial = await readToolPolicy(setup.nats.store, 'test', 'fixture');
  let captured = initial.catalogue!;
  let unavailable = false;
  function captureCatalogue() {
    if (unavailable) {
      return Promise.reject(new Error('Catalogue unavailable'));
    }
    return Promise.resolve(captured);
  }
  function setCapture(catalogue: typeof captured) {
    captured = catalogue;
  }
  function setUnavailable(value: boolean) {
    unavailable = value;
  }
  const options = { serverIds: ['fixture'], capture: captureCatalogue,
    requireLeader: setup.dispatchOptions.requireLeader.bind(setup.dispatchOptions) };
  const firstWatch = mcpCatalogueWatch(setup.nats.store, 'test', options);
  onTestFinished(firstWatch.close);
  await firstWatch.check('fixture');
  await reviewRestoration(setup, 'review-watch-restart', mode);
  const record = await publishRestoration(setup, 'publish-watch-restart');
  const delivery = await restorationDelivery(setup);
  await acknowledgeReload(delivery, record);
  Object.assign(headers, generationHeaders(record));
  const before = await readToolPolicy(setup.nats.store, 'test', 'fixture');
  expect(before.published).toBe(true);
  expect(before.previousCatalogue).toBeNull();
  firstWatch.close();

  const restarted = mcpCatalogueWatch(setup.nats.store, 'test', options);
  onTestFinished(restarted.close);
  setup.dispatchOptions.requireCatalogue = restarted.requireCurrent;
  function requireCurrent() {
    restarted.requireCurrent('fixture');
  }
  expect(requireCurrent).toThrow('watch unavailable');
  return { setup, headers, before, restarted, requireCurrent, setCapture, setUnavailable };
}

async function keepsPublicationAfterWatchRestart() {
  const { setup, headers, before, restarted, requireCurrent } = await publishedWatchFixture();
  await restarted.check('fixture');
  const after = await readToolPolicy(setup.nats.store, 'test', 'fixture');
  expect(after).toMatchObject({ published: true, driftHeld: false,
    policyRevision: before.policyRevision,
    configurationObservation: before.configurationObservation });
  const saved = await history(setup.nats.store, 'mcp-fixture', 'test');
  function afterPublication(row: StoredEvent) {
    return row.sequence > before.sequence;
  }
  const later = saved.filter(afterPublication);
  expect(later).toHaveLength(1);
  expect(later[0]!.event).toMatchObject({ type: 'mcp.catalogue_checked',
    data: { outcome: 'unchanged' } });
  expect(requireCurrent).not.toThrow();
  const value = await permit(setup, headers);
  expect((await send(setup, value)).status).toBe(200);
  await verifyCatalogueRecoveryReplay(setup);
  const status = await readPublication(setup.db, 'test', 'fixture');
  expect(status).toMatchObject({ status: 'ready', changeRef: 'publish-watch-restart' });
}

it('keeps acknowledged publication after an unchanged watch restart',
  keepsPublicationAfterWatchRestart, 60_000);

async function recoversPublicationAfterFailedCheck() {
  const context = await publishedWatchFixture();
  const { setup, headers, before, restarted, requireCurrent } = context;
  context.setUnavailable(true);
  await expect(restarted.check('fixture')).rejects.toThrow('Catalogue unavailable');
  expect(requireCurrent).toThrow('watch unavailable');
  const held = await readToolPolicy(setup.nats.store, 'test', 'fixture');
  expect(held.expiresAt).toBeNull();
  expect(held.policyRevision).toBeGreaterThan(before.policyRevision);
  const request = { method: 'POST', headers, body };
  const refused = await fetch(`${setup.options.decisionUrl}/authorize/mcp/fixture/installed`, request);
  expect(refused.status).toBe(403);
  expect(setup.received()).toBe(0);
  await setup.runner.initialise(mcpCatalogue);
  await setup.runner.run(mcpCatalogue);
  const unavailable = await readPublication(setup.db, 'test', 'fixture');
  expect(unavailable).toMatchObject({ status: 'disabled' });
  context.setUnavailable(false);
  await restarted.check('fixture');
  const recovered = await readToolPolicy(setup.nats.store, 'test', 'fixture');
  expect(recovered).toMatchObject({ published: true, driftHeld: false,
    configurationObservation: before.configurationObservation });
  expect(recovered.policyRevision).toBeGreaterThan(before.policyRevision);
  expect(requireCurrent).not.toThrow();
  const value = await permit(setup, headers);
  expect((await send(setup, value)).status).toBe(200);
  await verifyCatalogueRecoveryReplay(setup);
  const status = await readPublication(setup.db, 'test', 'fixture');
  expect(status).toMatchObject({ status: 'ready', changeRef: 'publish-watch-restart' });
}

it('recovers acknowledged publication after a failed restart check without changing tools',
  recoversPublicationAfterFailedCheck, 60_000);

async function holdsChangedToolsAfterWatchRestart(revert: boolean) {
  const context = await publishedWatchFixture();
  const { setup, headers, before, restarted, requireCurrent } = context;
  const added = toolEvidence({ name: 'unreviewed', reviewed: false, costCents: 0 });
  const changed = { ...before.catalogue!, ...catalogueEvidence([tool, added]) };
  context.setCapture(changed);
  await restarted.check('fixture');
  const held = await readToolPolicy(setup.nats.store, 'test', 'fixture');
  expect(held).toMatchObject({ published: false, driftHeld: true,
    previousCatalogue: before.catalogue, catalogue: changed });
  expect(held.configurationObservation).toBeUndefined();
  expect(held.tools).toContainEqual({ name: 'unreviewed', revision: added.revision,
    reviewed: false, costCents: 0, mode: 'block', readOnly: false, suggestion: 'ask' });
  context.setUnavailable(true);
  await expect(restarted.check('fixture')).rejects.toThrow('Catalogue unavailable');
  context.setUnavailable(false);
  if (revert) {
    context.setCapture(before.catalogue!);
  }
  await restarted.check('fixture');
  expect(requireCurrent).toThrow('watch unavailable');
  const stillHeld = await readToolPolicy(setup.nats.store, 'test', 'fixture');
  expect(stillHeld).toMatchObject({ published: false, driftHeld: true });
  const request = { method: 'POST', headers, body };
  const response = await fetch(`${setup.options.decisionUrl}/authorize/mcp/fixture/installed`, request);
  expect(response.status).toBe(403);
  expect(setup.received()).toBe(0);
  await verifyCatalogueRecoveryReplay(setup, 0);
}

it.each([false, true])(
  'holds changed unreviewed tools after restart and later recovery (reverted %s)',
  holdsChangedToolsAfterWatchRestart, 60_000);

async function endsAcknowledgedApprovalAfterCheckFailure(failure: 'capture' | 'membership') {
  const context = await publishedWatchFixture('ask');
  const { setup, headers, restarted } = context;
  await restarted.check('fixture');
  const request = { method: 'POST', headers, body };
  const response = await fetch(`${setup.options.decisionUrl}/authorize/mcp/fixture/installed`, request);
  const answer = z.object({ approvalId: z.string() }).parse(await response.json());
  const current = await readApproval(setup.nats.store, 'test', answer.approvalId);
  async function fresh() {}
  const result = await decideApproval(setup.nats.store, 'test', answer.approvalId,
    'alice', 'approved', true, fresh, current, setup.actor.now());
  expect(result.status).toBe('appended');
  if (failure === 'membership') {
    await restarted.reconcile([]);
    expect(context.requireCurrent).toThrow('watch unavailable');
    await restarted.reconcile(['fixture']);
  } else {
    context.setUnavailable(true);
    await expect(restarted.check('fixture')).rejects.toThrow('Catalogue unavailable');
    context.setUnavailable(false);
  }
  await restarted.check('fixture');
  const recovered = await readToolPolicy(setup.nats.store, 'test', 'fixture');
  expect(recovered.published).toBe(true);
  const ended = await readApproval(setup.nats.store, 'test', answer.approvalId);
  expect(ended).toMatchObject({ state: 'cancelled', canRetry: false });
  const refused = await approvalPermit(setup, headers, answer.approvalId);
  expect(refused.headers.get('x-opencrane-mcp-permit')).toBeNull();
  expect(setup.received()).toBe(0);
}

it.each(['capture', 'membership'] as const)(
  'keeps old approvals ended when acknowledged publication recovers after %s failure',
  endsAcknowledgedApprovalAfterCheckFailure, 60_000);

async function recordsExpiredEvidenceBeforeRestartRenewal() {
  const context = await publishedWatchFixture();
  const { setup, before, restarted, requireCurrent } = context;
  const checkedAt = new Date(Date.now() - 2000).toISOString();
  const expiresAt = new Date(Date.now() - 1000).toISOString();
  const expired = { serverId: 'fixture', outcome: 'unchanged',
    schemaDigest: before.catalogue!.schemaDigest, checkedAt, expiresAt };
  await setup.append('mcp-fixture', 'mcp.catalogue_checked', expired);
  const position = await setup.nats.store.head('mcp-fixture');
  await restarted.check('fixture');
  const saved = await history(setup.nats.store, 'mcp-fixture', 'test');
  function afterExpiry(row: StoredEvent) {
    return row.sequence > position;
  }
  const renewal = saved.filter(afterExpiry);
  expect(renewal).toHaveLength(2);
  expect(renewal[0]!.event).toMatchObject({ type: 'mcp.catalogue_checked',
    data: { outcome: 'failed' } });
  expect(renewal[1]!.event).toMatchObject({ type: 'mcp.catalogue_checked',
    data: { outcome: 'unchanged' } });
  const recovered = await readToolPolicy(setup.nats.store, 'test', 'fixture');
  expect(recovered.published).toBe(true);
  expect(recovered.policyRevision).toBeGreaterThan(before.policyRevision);
  expect(requireCurrent).not.toThrow();
}

it('records expired evidence before saving successful restart renewal',
  recordsExpiredEvidenceBeforeRestartRenewal, 60_000);
