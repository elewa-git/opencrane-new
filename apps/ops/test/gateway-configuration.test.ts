import { expect, it, onTestFinished, vi } from 'vitest';
import { lostReplyStore, natsFixture } from '@opencrane/event-store/testing';
import { catalogueDigest, toolReviewDigest } from '@opencrane/events/mcp-catalogue';
import { losslessJson } from '@opencrane/events/lossless-json';
import { envelope, history, publicationEntry, readToolPolicy }
  from '@opencrane/models';
import { prepareGatewayConfigurationHandler } from '../src/gateway-configuration.ts';

async function serialPublications() {
  const nats = await natsFixture();
  onTestFinished(nats.close.bind(nats));
  const faulty = await lostReplyStore(nats.connection);
  const handler = prepareGatewayConfigurationHandler(faulty.store, 'test');
  function unusedQuery(): Promise<never> {
    return Promise.reject(new Error('Preparation must not write SQL'));
  }
  const transaction = { query: unusedQuery };
  async function publish(serverId: string) {
    const definition = '{"inputSchema":{"type":"object"},"name":"read"}';
    const tool = { name: 'read', definition, revision: losslessJson(definition).digest,
      reviewed: false, costCents: 0 };
    const now = Date.now();
    const catalogue = { serverId, connectionId: 'installed', accountMode: 'none',
      tools: [tool], toolCount: 1, schemaDigest: catalogueDigest([tool]),
      checkedAt: new Date(now).toISOString(), expiresAt: new Date(now + 300_000).toISOString() };
    await nats.seed([envelope('test', `mcp-${serverId}`, 'mcp.server_discovered', catalogue)]);
    const policyRevision = await nats.store.head(`mcp-${serverId}`);
    const review = { serverId, connectionId: 'installed', accountMode: 'none',
      catalogueDigest: catalogue.schemaDigest, policyRevision, reviewedBy: 'admin',
      tools: [{ name: 'read', revision: tool.revision, mode: 'block',
        reviewDigest: toolReviewDigest(tool) }] };
    const reviewed = envelope('test', `mcp-${serverId}`, 'mcp.server_reviewed', review);
    reviewed.principal = { kind: 'human', id: 'admin' };
    await nats.seed([reviewed]);
    const policy = await readToolPolicy(nats.store, 'test', serverId);
    const intent = { serverId, publishedBy: 'admin', commandId: `publish-${serverId}`,
      expectedSequence: policy.sequence, reviewRevision: policy.reviewRevision,
      fragmentDigest: publicationDigest(publicationEntry(policy)) };
    const event = envelope('test', `mcp-${serverId}`, 'mcp.server_published', intent);
    await nats.seed([event]);
    return event;
  }
  const alpha = await publish('alpha');
  const bravo = await publish('bravo');
  function unavailableRead(): never {
    throw new Error('PRIVATE-ERROR-CANARY');
  }
  const failedRead = vi.spyOn(faulty.store, 'readStream');
  failedRead.mockImplementationOnce(unavailableRead);
  await expect(handler.handle(alpha, transaction)).rejects.toThrow('Gateway preparation unavailable');
  failedRead.mockRestore();
  faulty.loseNextReply();
  await handler.handle(alpha, transaction);
  await handler.handle(bravo, transaction);
  const rows = await history(nats.store, 'gateway-config-test', 'test');
  expect(rows).toHaveLength(2);
  expect(rows[0]!.event.data).toMatchObject({ generation: 1, members: [{ changeRef: 'publish-alpha' }] });
  expect(rows[1]!.event.data).toMatchObject({ generation: 2,
    members: [{ changeRef: 'publish-alpha' }, { changeRef: 'publish-bravo' }] });
  await nats.seed([envelope('test', 'mcp-alpha', 'mcp.server_unpublished',
    { serverId: 'alpha', unpublishedBy: 'admin' })]);
  await handler.handle(alpha, transaction);
  expect(await history(nats.store, 'gateway-config-test', 'test')).toHaveLength(2);
  const charlie = await publish('charlie');
  await handler.handle(charlie, transaction);
  const later = await history(nats.store, 'gateway-config-test', 'test');
  expect(later[2]!.event.data).toMatchObject({ generation: 3,
    members: [{ changeRef: 'publish-bravo' }, { changeRef: 'publish-charlie' }] });
  const legacy = envelope('test', 'mcp-legacy', 'mcp.server_published',
    { serverId: 'legacy', publishedBy: 'admin' });
  await nats.seed([legacy]);
  await handler.handle(legacy, transaction);
  const stale = await publish('stale');
  const mode = { serverId: 'stale', toolName: 'read', mode: 'block', setBy: 'admin' };
  await nats.seed([envelope('test', 'mcp-stale', 'mcp.tool_mode_set', mode)]);
  await handler.handle(stale, transaction);
  expect(await history(nats.store, 'gateway-config-test', 'test')).toHaveLength(3);
}
it('prepares serial publications and drops withdrawn members without preparing withdrawal',
  serialPublications);

function publicationDigest(value: unknown) {
  const encoded = JSON.stringify(value);
  return losslessJson(encoded).digest;
}
