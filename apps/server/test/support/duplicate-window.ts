import { expect } from 'vitest';
import { z } from 'zod';
import { envelope } from '@opencrane/models';
import type { natsFixture } from '@opencrane/event-store/testing';

type NatsFixture = Awaited<ReturnType<typeof natsFixture>>;
const streamSchema = z.object({
  config: z.looseObject({ duplicate_window: z.number() }),
});

export async function shortenDuplicateWindow(nats: NatsFixture) {
  const info = await nats.connection.request('$JS.API.STREAM.INFO.EVENTS');
  const stream = streamSchema.parse(info.json());
  expect(stream.config.duplicate_window).toBe(120_000_000_000);
  // Change only this private stream, after normal fixture creation has finished.
  const config = { ...stream.config, duplicate_window: 2_000_000_000 };
  const payload = new TextEncoder().encode(JSON.stringify(config));
  const response = await nats.connection.request('$JS.API.STREAM.UPDATE.EVENTS', payload);
  const updated = streamSchema.parse(response.json());
  expect(updated.config.duplicate_window).toBe(2_000_000_000);
}

export async function waitForDuplicateWindow(nats: NatsFixture) {
  // Keep the probe outside chat history and the permissions rebuilt by these tests.
  const data = { assistantId: 'window-probe', changedBy: 'alice', changedFields: ['model'] };
  const probe = envelope('test', 'assistant-window-probe', 'assistant.settings_changed', data);
  const events = [probe];
  await nats.seed(events);
  const firstPosition = await nats.store.head(probe.subject);
  await nats.seed(events);
  expect(await nats.store.head(probe.subject)).toBe(firstPosition);

  async function repeatPublish() {
    await nats.seed(events);
    return nats.store.head(probe.subject);
  }
  // Require a new stored message, rather than assuming that enough time has passed.
  await expect.poll(repeatPublish, { timeout: 5000, interval: 50 })
    .toBeGreaterThan(firstPosition);
}
