import { expect, it } from 'vitest';
import { event, natsFixture } from '@opencrane/event-store/testing';
import type { EventEnvelope } from '@opencrane/events';
import { history, lifecycleHandlers } from '../src/lifecycle.ts';

const noSql = { query: () => Promise.reject(new Error('Unexpected SQL')) };
async function oldLossKeepsNewClaim() {
  const nats = await natsFixture();
  try {
    const loss: EventEnvelope = event('old-loss', 'computer-assistant', 'computer.lost');
    loss.data = { assistantId: 'assistant', computerId: 'computer' };
    const claim: EventEnvelope = event('new-claim', loss.subject, 'computer.claimed');
    claim.data = { assistantId: 'assistant', computerId: 'computer', generation: 2,
      tokenId: 'token:new' };
    await nats.seed([loss, claim]);
    const before = await nats.store.head();
    const claimHandler = lifecycleHandlers(nats.store)[1];
    await claimHandler.handle(loss, noSql);
    expect(await nats.store.head()).toBe(before);
    expect(await history(nats.store, loss.subject)).toHaveLength(2);
  } finally {
    await nats.close();
  }
}
it('an old computer loss keeps a later claim', oldLossKeepsNewClaim);

async function oldAssistantAfterOwnerRemoval() {
  const nats = await natsFixture();
  try {
    const assistant: EventEnvelope = event('old-assistant', 'assistant-personal', 'assistant.created');
    assistant.data = { assistantId: 'personal', ownerId: 'alice', kind: 'personal' };
    await nats.seed([assistant, event('removed-owner', 'member-alice', 'member.removed')]);
    const before = await nats.store.head();
    await lifecycleHandlers(nats.store)[1].handle(assistant, noSql);
    expect(await nats.store.head()).toBe(before);
  } finally {
    await nats.close();
  }
}
it('does not claim a computer for an old assistant whose owner was removed',
  oldAssistantAfterOwnerRemoval);
