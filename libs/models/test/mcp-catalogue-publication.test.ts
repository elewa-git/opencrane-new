import { expect, it, onTestFinished, vi } from 'vitest';
import type { AppendCommand } from '@opencrane/event-store';
import { natsFixture } from '@opencrane/event-store/testing';
import { parseEventByType } from '@opencrane/events';
import { toolReviewDigest } from '@opencrane/events/mcp-catalogue';
import { envelope, history } from '../src/actor.ts';
import { prepareGatewayConfiguration } from '../src/gateway-generation.ts';
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
    accountMode: 'none', checkedAt: new Date(now).toISOString(),
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

async function publishesDuringCapture(timing: 'capture' | 'append') {
  const { nats, catalogue, publish } = await publicationFixture();
  const started = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  let captures = 0;
  let captureAppends = 0;
  async function hold() {
    started.resolve();
    await released.promise;
  }
  async function capture() {
    captures += 1;
    if (timing === 'capture') await hold();
    return catalogue;
  }
  const append = nats.store.append.bind(nats.store);
  async function appendCapture(command: AppendCommand) {
    const parsed = parseEventByType(command.event);
    if (parsed.success && parsed.event.type === 'mcp.catalogue_checked') {
      const data = parsed.event.data as { outcome: string };
      if (data.outcome === 'unchanged') {
        captureAppends += 1;
        if (timing === 'append') await hold();
      }
    }
    return append(command);
  }
  const writer = vi.spyOn(nats.store, 'append');
  writer.mockImplementation(appendCapture);
  async function requireLeader() {}
  const options = { serverIds: ['fixture'], capture, requireLeader };
  const watch = mcpCatalogueWatch(nats.store, 'test', options);
  try {
    const checking = watch.check('fixture');
    await started.promise;
    await publish();
    released.resolve();
    const captured = await Promise.allSettled([checking]);
    expect.soft(captured[0]?.status).toBe('fulfilled');
    const record = await prepareGatewayConfiguration(
      nats.store, 'test', 'fixture', 'publish-fixture',
    );
    expect(record).toMatchObject({ generation: 1, changeRef: 'publish-fixture' });
    const rows = await history(nats.store, 'mcp-fixture', 'test');
    function failedCheck(row: typeof rows[number]) {
      return row.event.type === 'mcp.catalogue_checked' &&
        Reflect.get(row.event.data as object, 'outcome') === 'failed';
    }
    expect(rows.filter(failedCheck)).toEqual([]);
    expect(captures).toBe(1);
    expect(captureAppends).toBe(1);
  } finally {
    released.resolve();
    watch.close();
    writer.mockRestore();
  }
}

it.each(['capture', 'append'] as const)(
  'prepares a publication that overlaps a successful catalogue %s', publishesDuringCapture,
);
