import { expect, it, onTestFinished, vi } from 'vitest';
import type { AppendCommand } from '@opencrane/event-store';
import { natsFixture } from '@opencrane/event-store/testing';
import { parseEventByType } from '@opencrane/events';
import { toolReviewDigest } from '@opencrane/events/mcp-catalogue';
import { envelope, history } from '../src/actor.ts';
import { prepareGatewayConfiguration, PublicationUnavailable } from '../src/gateway-generation.ts';
import { mcpCatalogueWatch } from '../src/mcp-catalogue-watch.ts';
import { publicationDigest, publicationEntry } from '../src/publication.ts';
import { readToolPolicy } from '../src/tool-policy.ts';
import { catalogueEvidence, toolEvidence } from './support/catalogue-evidence.ts';

async function publicationFixture() {
  const nats = await natsFixture();
  onTestFinished(nats.close);
  const tool = toolEvidence({ name: 'read', reviewed: false, readOnly: true, costCents: 0 });
  const evidence = catalogueEvidence([tool]);
  const now = Date.now();
  const catalogue = { ...evidence, serverId: 'fixture', connectionId: 'installed',
    accountMode: 'none' as const, checkedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 300_000).toISOString() };
  await nats.seed([envelope('test', 'mcp-fixture', 'mcp.server_discovered', catalogue)]);
  const policy = await readToolPolicy(nats.store, 'test', 'fixture');
  const choice = { name: tool.name, revision: tool.revision,
    reviewDigest: toolReviewDigest(tool), mode: 'allow' };
  const review = { serverId: 'fixture', connectionId: 'installed', accountMode: 'none',
    catalogueDigest: catalogue.schemaDigest, policyRevision: policy.policyRevision,
    reviewedBy: 'admin', tools: [choice] };
  const reviewed = envelope('test', 'mcp-fixture', 'mcp.server_reviewed', review);
  reviewed.principal = { kind: 'human', id: 'admin' };
  await nats.seed([reviewed]);
  async function publish() {
    const current = await readToolPolicy(nats.store, 'test', 'fixture');
    const entry = publicationEntry(current);
    expect(entry).not.toBeNull();
    const intent = { serverId: 'fixture', publishedBy: 'admin', commandId: 'publish-fixture',
      expectedSequence: current.sequence, reviewRevision: current.reviewRevision,
      fragmentDigest: publicationDigest(entry) };
    await nats.seed([envelope('test', 'mcp-fixture', 'mcp.server_published', intent)]);
  }
  return { nats, catalogue, publish };
}

function catalogueOutcome(input: unknown): unknown {
  const parsed = parseEventByType(input);
  if (!parsed.success) return undefined;
  if (parsed.event.type === 'mcp.tools_changed') return 'changed';
  if (parsed.event.type !== 'mcp.catalogue_checked') return undefined;
  const data = parsed.event.data;
  if (typeof data !== 'object' || data === null) throw new Error('Invalid fixture check');
  return Reflect.get(data, 'outcome');
}

function pausedWatch(setup: Awaited<ReturnType<typeof publicationFixture>>,
  timing: 'capture' | 'append', catalogue = setup.catalogue, writeFails = false) {
  const started = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  const counts = { captures: 0, appends: 0 };
  async function hold() {
    started.resolve();
    await released.promise;
  }
  async function capture() {
    counts.captures += 1;
    if (timing === 'capture') await hold();
    return catalogue;
  }
  const append = setup.nats.store.append.bind(setup.nats.store);
  async function appendCapture(command: AppendCommand) {
    const outcome = catalogueOutcome(command.event);
    if (outcome === 'unchanged' || outcome === 'changed') {
      counts.appends += 1;
      if (timing === 'append') await hold();
      if (writeFails) throw new Error('Fixture catalogue write unavailable');
    }
    return append(command);
  }
  const writer = vi.spyOn(setup.nats.store, 'append');
  writer.mockImplementation(appendCapture);
  async function requireLeader() {}
  const options = { serverIds: ['fixture'], capture, requireLeader };
  const watch = mcpCatalogueWatch(setup.nats.store, 'test', options);
  function close() {
    released.resolve();
    watch.close();
    writer.mockRestore();
    vi.useRealTimers();
  }
  function requireCurrent() {
    watch.requireCurrent('fixture');
  }
  onTestFinished(close);
  return { watch, requireCurrent, started: started.promise, release: released.resolve, counts };
}

async function publishesDuringCapture(timing: 'capture' | 'append') {
  const setup = await publicationFixture();
  const paused = pausedWatch(setup, timing);
  const checking = Promise.allSettled([paused.watch.check('fixture')]);
  await paused.started;
  await setup.publish();
  paused.release();
  const captured = await checking;
  expect(captured[0]?.status).toBe('fulfilled');
  const record = await prepareGatewayConfiguration(
    setup.nats.store, 'test', 'fixture', 'publish-fixture',
  );
  expect(record).toMatchObject({ generation: 1, changeRef: 'publish-fixture' });
  const rows = await history(setup.nats.store, 'mcp-fixture', 'test');
  function failedCheck(row: typeof rows[number]) {
    return catalogueOutcome(row.event) === 'failed';
  }
  expect(rows.filter(failedCheck)).toEqual([]);
  expect(paused.counts).toEqual({ captures: 1, appends: 1 });
  expect(paused.requireCurrent).not.toThrow();
}

it.each(['capture', 'append'] as const)(
  'prepares a publication that overlaps a successful catalogue %s', publishesDuringCapture,
);

function changedCatalogue(catalogue: Awaited<ReturnType<typeof publicationFixture>>['catalogue']) {
  const tool = toolEvidence({ name: 'other', reviewed: false, readOnly: true, costCents: 0 });
  const evidence = catalogueEvidence([tool]);
  return { ...catalogue, ...evidence };
}

async function refusesInterruptedCapture(
  failure: 'expired' | 'changed' | 'replaced' | 'write error',
) {
  const setup = await publicationFixture();
  let catalogue = setup.catalogue;
  if (failure === 'changed') {
    catalogue = changedCatalogue(catalogue);
  }
  const paused = pausedWatch(setup, 'append', catalogue, failure === 'write error');
  const checking = Promise.allSettled([paused.watch.check('fixture')]);
  await paused.started;
  await setup.publish();
  if (failure === 'replaced') {
    const replacement = changedCatalogue(catalogue);
    const discovered = envelope('test', 'mcp-fixture', 'mcp.server_discovered', replacement);
    await setup.nats.seed([discovered]);
  }
  if (failure === 'expired') {
    const expired = Date.now() + 300_001;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(expired);
  }
  paused.release();
  const captured = await checking;
  expect(captured[0]?.status).toBe('rejected');
  const preparation = prepareGatewayConfiguration(
    setup.nats.store, 'test', 'fixture', 'publish-fixture',
  );
  await expect(preparation).rejects.toBeInstanceOf(PublicationUnavailable);
  expect(paused.requireCurrent).toThrow();
  expect(paused.counts).toEqual({ captures: 1, appends: 1 });
}

it.each(['expired', 'changed', 'replaced', 'write error'] as const)(
  'keeps publication held after a catalogue capture is %s', refusesInterruptedCapture,
);
