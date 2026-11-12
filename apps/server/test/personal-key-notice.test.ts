import { expect, it, onTestFinished } from 'vitest';
import { fixture } from '@opencrane/models/testing';
import { personalKeyFixture } from './support/personal-key.ts';
import { personalConnectionNeeds } from '../src/chat/personal-connection-needs.ts';

async function missingKeyExplainsConnection() {
  const runtime = await fixture();
  onTestFinished(runtime.close.bind(runtime));
  const setup = await personalKeyFixture(runtime);
  await setup.publish();
  await setup.project();
  await setup.grant('alice');
  await setup.grant('assistant', 'assistant');
  const options = { silo: 'test', store: setup.nats.store, db: setup.db,
    binding: setup.binding };
  const needs = await personalConnectionNeeds(options, 'alice', 'assistant');
  expect(needs).toEqual([{ serverId: setup.serverId, name: 'OpenCrane demo' }]);
}
it('tells a granted member without a key which server needs a connection',
  missingKeyExplainsConnection, 120_000);
