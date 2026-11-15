import { expect, it } from 'vitest';
import { natsFixture } from '@opencrane/event-store/testing';
import { envelope } from '@opencrane/models';
import { collectChoices } from '../docs/process/work-pilot-1105-s1/collect-choices.mjs';

async function readsSelectionsFromCategory() {
  const nats = await natsFixture();
  try {
    const initial = envelope('test', 'connection-selection-alice-demo', 'connection.selected', {
      action: 'select', userId: 'alice', serverId: 'demo', connectionId: 'installed',
      profileId: 'personal', profileRevision: 1, expectedSequence: 0,
      allowedAssistantIds: [],
    });
    const other = envelope('test', 'connection-selection-alice-other', 'connection.selected', {
      ...initial.data, serverId: 'other',
    });
    const profile = envelope('test', 'connection-alice-demo-personal', 'connection.revoked', {
      userId: 'alice', serverId: 'demo', profile: 'personal', revokedBy: 'alice', expectedSequence: 0,
    });
    await nats.seed([initial, other, profile]);
    expect(await collectChoices(nats.store, 'demo')).toEqual([{
      sequence: 1, expectedSequence: 0, userId: 'alice', profileId: 'personal',
      allowedAssistantIds: [],
    }]);
  } finally {
    await nats.close();
  }
}
it('collects only this integration’s selection records through the real event store',
  readsSelectionsFromCategory);
