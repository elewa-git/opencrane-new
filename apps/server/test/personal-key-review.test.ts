import { reviewedToolChoices } from '@opencrane/projections';
import { toolReviewDigest } from '@opencrane/events/mcp-catalogue';
import { expect, it, onTestFinished, vi } from 'vitest';
import { history, readToolPolicy, toolPolicyFromRows } from '@opencrane/models';
import { remoteCatalogueWatch } from '../src/integrations/remote-catalogue-watch.ts';
import { personalKeyFixture } from './support/personal-key.ts';

async function personalReviewSurvives() {
  const setup = await personalKeyFixture();
  await setup.review();
  await setup.project();
  async function leader() {}
  const watch = remoteCatalogueWatch(setup.db, setup.nats.store, 'test', leader, setup.remote.network);
  onTestFinished(watch.close);
  function restoreClock() {
    vi.useRealTimers();
  }
  onTestFinished(restoreClock);
  await watch.check();
  const after = await readToolPolicy(setup.nats.store, 'test', setup.serverId);
  expect(after).toMatchObject({ accountMode: 'personal', identityTool: 'who_am_i' });
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now() + 140_000);
  await watch.check();
  const replayedRows = await history(setup.nats.store, `mcp-${setup.serverId}`, 'test');
  const replayed = toolPolicyFromRows(replayedRows);
  expect(replayed).toMatchObject({ accountMode: 'personal', identityTool: 'who_am_i' });
}
it('marks a server through product commands and keeps the choice through recheck and replay',
  personalReviewSurvives, 120_000);

async function refusesUnsafeIdentityChoice(guard: 'write' | 'charged') {
  const setup = await personalKeyFixture();
  const rows = await history(setup.nats.store, `mcp-${setup.serverId}`, 'test');
  const policy = toolPolicyFromRows(rows);
  function identity(tool: { name: string }) { return tool.name === 'who_am_i'; }
  const chosen = policy.tools.find(identity)!;
  if (guard === 'write') chosen.readOnly = false;
  else delete chosen.costCents;
  const tools = [];
  for (const declaration of policy.catalogue!.tools!) {
    tools.push({ name: declaration.name, revision: declaration.revision,
      reviewDigest: toolReviewDigest(declaration), mode: 'block' as const });
  }
  const review = { serverId: setup.serverId, connectionId: policy.connectionId!,
    catalogueDigest: policy.catalogue!.schemaDigest, accountMode: 'personal' as const,
    identityTool: 'who_am_i', policyRevision: policy.policyRevision, reviewedBy: 'admin', tools };
  // Keep every choice blocked so the separate Allow cost guard cannot mask this check.
  expect(reviewedToolChoices(policy, review, Date.now())).toBeNull();
}
it.each(['write', 'charged'] as const)(
  'refuses a %s tool as the reviewed identity tool', refusesUnsafeIdentityChoice, 120_000);
