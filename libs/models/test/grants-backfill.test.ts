import type { EventEnvelope } from '@opencrane/events';
import { expect, it } from 'vitest';
import { event, natsFixture } from '@opencrane/event-store/testing';
import { history, modelGrantHandler } from '../src/index.ts';
import { grantStream } from '@opencrane/authz';

const noSql = { query: () => Promise.reject(new Error('Unexpected SQL')) };
async function oldCreationPreservesRevocation(type: string) {
  const nats = await natsFixture();
  try {
    const memberId = type === 'silo.owner_bootstrapped' ? 'bootstrap-owner' : 'alice';
    const trigger: EventEnvelope = event('old-creation', `member-${memberId}`, type);
    let granteeId = memberId;
    let granteeKind = 'member';
    if (type === 'assistant.created') {
      trigger.subject = 'assistant-test';
      trigger.data = { assistantId: 'test', ownerId: memberId, kind: 'personal' };
      granteeId = 'test';
      granteeKind = 'assistant';
    }
    const subject = grantStream('model', 'gpt-6-luna');
    const revoked: EventEnvelope = event('later-revocation', subject, 'grant.revoked');
    revoked.data = { resourceType: 'model', resourceId: 'gpt-6-luna', granteeId,
      granteeKind, revokedBy: 'alice' };
    await nats.seed([trigger, revoked]);
    await modelGrantHandler(nats.store).handle(trigger, noSql);
    expect(await history(nats.store, subject, 'test')).toHaveLength(1);
  } finally {
    await nats.close();
  }
}
it.each(['member.joined', 'silo.owner_bootstrapped', 'assistant.created'])(
  'old %s does not replace a later model revocation', oldCreationPreservesRevocation);

async function removedMemberGetsNoGrant(type: string) {
  const nats = await natsFixture();
  try {
    const memberId = type === 'silo.owner_bootstrapped' ? 'bootstrap-owner' : 'alice';
    const trigger: EventEnvelope = event('old-member', `member-${memberId}`, type);
    await nats.seed([trigger, event('removed-member', trigger.subject, 'member.removed')]);
    await modelGrantHandler(nats.store).handle(trigger, noSql);
    expect(await history(nats.store, 'grant-*', 'test')).toEqual([]);
  } finally {
    await nats.close();
  }
}
it.each(['member.joined', 'silo.owner_bootstrapped'])(
  'old %s does not give models to a removed member', removedMemberGetsNoGrant);

async function removedAssistantOwnerGetsNoGrant() {
  const nats = await natsFixture();
  try {
    const joined = event('assistant-owner-join', 'member-alice', 'member.joined');
    const assistant: EventEnvelope = event('personal-assistant', 'assistant-personal', 'assistant.created');
    assistant.data = { assistantId: 'personal', ownerId: 'alice', kind: 'personal' };
    const removed = event('assistant-owner-removal', 'member-alice', 'member.removed');
    await nats.seed([joined, assistant, removed]);
    const handler = modelGrantHandler(nats.store);
    await handler.handle(assistant, noSql);
    expect(await history(nats.store, 'grant-*', 'test')).toEqual([]);
    await nats.seed([event('assistant-owner-rejoin', 'member-alice', 'member.joined')]);
    await handler.handle(assistant, noSql);
    const grants = await history(nats.store, 'grant-*', 'test');
    expect(grants.length).toBeGreaterThan(0);
    for (const row of grants) {
      expect(row.event.data).toMatchObject({ granteeKind: 'assistant', granteeId: 'personal' });
    }
  } finally {
    await nats.close();
  }
}
it('creates initial personal assistant grants only after its removed owner rejoins',
  removedAssistantOwnerGetsNoGrant);
