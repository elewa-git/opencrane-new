import { expect, it, vi } from 'vitest';
import { mcpCatalogue, readPublication } from '@opencrane/projections';
import { publicationFixture } from './support/publication-fixture.ts';

async function freshPublication() {
  const context = await publicationFixture();
  await context.publish(409);
  await context.review(true);
  const reviewed = await context.policy();
  for (const tool of reviewed.tools) {
    const current = await context.policy();
    const payload = { expectedSequence: current.sequence, connectionId: 'installed',
      toolName: tool.name, toolRevision: tool.revision,
      mode: tool.name === 'read' ? 'allow' : 'ask' };
    await context.post('/tools', payload);
  }
  await context.grant('member');
  await context.grant('assistant');
  // Save the complete review as the publication screen does after changing individual rules.
  await context.review();
  const record = await context.publish();
  expect(record!.generation).toBe(1);
  await context.project();
  expect(await context.status()).toMatchObject({ status: 'applying' });
  expect(await context.policy()).toMatchObject({ published: false });
  expect(await context.turn()).not.toHaveProperty('tools');
  await context.acknowledge(record!);
  await context.project();
  expect(await context.status()).toMatchObject({ status: 'ready', generation: 1 });
  expect.soft(await context.policy()).toMatchObject({ published: true });
  expect.soft(await context.catalogue.tools('test', 'fixture')).toMatchObject({ published: true });
  const rows = await context.catalogue.rows('test');
  expect.soft(rows[0]).toMatchObject({ status: { kind: 'ready' } });
  expect(await context.turn()).toMatchObject({ tools: [{ modes: { read: 'allow', write: 'ask' } }] });
  await context.setup.runner.rebuild(mcpCatalogue);
  expect(await context.status()).toMatchObject({ status: 'ready', generation: 1 });
  expect(await context.turn()).toHaveProperty('tools');
}
it('offers a fresh reviewed and granted policy only after its first gateway acknowledgement',
  freshPublication, 60_000);

async function readyPublication() {
  const context = await publicationFixture();
  await context.review();
  await context.grant('member');
  await context.grant('assistant');
  const record = await context.publish();
  await context.acknowledge(record!);
  await context.project();
  expect(await context.status()).toMatchObject({ status: 'ready' });
  expect(await context.turn()).toHaveProperty('tools');
  return context;
}

async function withdrawnReview(change: 'withdrawal' | 'catalogue') {
  const context = await readyPublication();
  if (change === 'withdrawal') {
    const withdrawal = { serverId: 'fixture', unpublishedBy: 'alice' };
    await context.setup.append('mcp-fixture', 'mcp.server_unpublished', withdrawal);
  } else {
    const current = await context.policy();
    const changed = { serverId: 'fixture', previousSchemaDigest: current.catalogue!.schemaDigest,
      newSchemaDigest: 'a'.repeat(64) };
    await context.setup.append('mcp-fixture', 'mcp.tools_changed', changed);
  }
  // Keep the catalogue row behind the event log to exercise the bridge's own check.
  expect(await context.turn()).not.toHaveProperty('tools');
  expect(await context.policy()).toMatchObject({ published: false });
  await context.project();
  expect(await context.status()).not.toMatchObject({ status: 'ready' });
  expect(await context.turn()).not.toHaveProperty('tools');
}
it.each(['withdrawal', 'catalogue'] as const)(
  'stops using a ready policy after %s changes even before projection catches up',
  withdrawnReview, 60_000);

async function staleGeneration() {
  const context = await readyPublication();
  const previous = await context.policy();
  const receipt = previous.configurationObservation!;
  const next = await context.publish();
  expect(next!.generation).toBe(2);
  expect(await context.delivery.observe()).toBeNull();
  await context.setup.append('mcp-fixture', 'mcp.configuration_observed', receipt);
  await context.project();
  expect(await context.policy()).toMatchObject({ published: false });
  expect(await context.status()).toMatchObject({ status: 'applying', generation: 2 });
  expect(await context.turn()).not.toHaveProperty('tools');
  await context.acknowledge(next!);
  await context.project();
  expect(await context.status()).toMatchObject({ status: 'ready', generation: 2 });
  expect(await context.turn()).toHaveProperty('tools');
}
it('keeps replacement unpublished when the old gateway generation acknowledges',
  staleGeneration, 60_000);

async function requiresBothGrants(granteeKind: 'member' | 'assistant') {
  const context = await readyPublication();
  await context.grant(granteeKind, 'revoke');
  expect(await context.turn()).not.toHaveProperty('tools');
  await context.grant(granteeKind);
  expect(await context.turn()).toHaveProperty('tools');
}
it.each(['member', 'assistant'] as const)(
  'offers no tools while the %s grant is withdrawn', requiresBothGrants, 60_000);

async function expiredPolicy() {
  const context = await readyPublication();
  const policy = await context.policy();
  const expiredAt = new Date(policy.expiresAt!);
  const status = await readPublication(context.setup.db, 'test', 'fixture', expiredAt);
  expect(status).toMatchObject({ status: 'disabled' });
  const clock = vi.spyOn(Date, 'now');
  clock.mockReturnValue(expiredAt.getTime());
  try {
    const rows = await context.catalogue.rows('test');
    expect(rows[0]).toMatchObject({ status: { kind: 'disabled' } });
    expect(await context.turn()).not.toHaveProperty('tools');
  } finally {
    clock.mockRestore();
  }
}
it('does not report ready from matching receipts after the catalogue expires',
  expiredPolicy, 60_000);
