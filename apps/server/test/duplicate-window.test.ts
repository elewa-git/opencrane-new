import { expect, it } from 'vitest';
import { event, natsFixture } from '@opencrane/event-store/testing';
import { shortenDuplicateWindow, waitForDuplicateWindow }
  from './support/duplicate-window.ts';

async function refusesPopulatedStream() {
  const nats = await natsFixture();
  try {
    const events = [event('already-saved')];
    await nats.seed(events);
    await expect(shortenDuplicateWindow(nats)).rejects.toThrow('empty stream');
    const response = await nats.connection.request('$JS.API.STREAM.INFO.EVENTS');
    expect(response.json()).toMatchObject({
      config: { duplicate_window: 120_000_000_000 },
      state: { messages: 1 },
    });
  } finally {
    await nats.close();
  }
}
it('refuses to shorten a populated stream before changing its duplicate timer',
  refusesPopulatedStream);

async function waitsForStoredRepeat() {
  const nats = await natsFixture();
  try {
    await shortenDuplicateWindow(nats);
    await waitForDuplicateWindow(nats);
    const rows = [];
    for await (const row of nats.store.readStream('assistant-window-probe')) {
      rows.push(row);
    }
    expect(rows).toHaveLength(2);
    expect(rows[1]!.event).toEqual(rows[0]!.event);
    expect(rows[1]!.sequence).toBeGreaterThan(rows[0]!.sequence);
  } finally {
    await nats.close();
  }
}
it('waits until NATS stores the repeated event as a new message', waitsForStoredRepeat);
