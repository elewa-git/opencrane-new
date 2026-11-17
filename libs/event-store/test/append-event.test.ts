import { expect, it } from 'vitest';
import { appendEvent, natsFixture } from '@opencrane/event-store/testing';

async function savesSuccessiveEvents() {
  const nats = await natsFixture();
  try {
    const options = { silo: 'acme', subject: 'member-alice', type: 'member.joined',
      data: { memberId: 'alice', role: 'owner', email: 'alice@example.test',
        displayName: 'Alice' }, id: 'first-join' };
    const first = await appendEvent(nats.store, options);
    const second = await appendEvent(nats.store, { ...options, id: 'second-join' });
    expect(first.event).toMatchObject(options);
    expect(second.sequence).toBeGreaterThan(first.sequence);
    expect(await nats.reader.readEvent(first.sequence)).toEqual(first);
    expect(await nats.reader.readEvent(second.sequence)).toEqual(second);
  } finally {
    await nats.close();
  }
}

it('saves named event fields against the latest subject position', savesSuccessiveEvents);
