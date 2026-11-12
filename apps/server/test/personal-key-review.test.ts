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
  onTestFinished(vi.useRealTimers);
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
