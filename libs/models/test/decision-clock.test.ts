import { expect, it, vi } from 'vitest';
import { manualClock } from '@opencrane/event-store/testing';
import { fixture } from './fixture.ts';

async function decisionDeadline(expired: boolean) {
  const clock = manualClock(Math.ceil(performance.now()) + 5000);
  const setup = await fixture(2000, 20000, false, 'gpt-6-luna', false,
    'manual', 'sales', undefined, { clock });
  const started = clock.now();
  const sleep = vi.spyOn(clock, 'sleep');
  const read = setup.nats.store.readStream.bind(setup.nats.store);
  let deadline: number | undefined;
  async function* readComputer(...args: Parameters<typeof read>) {
    if (args[0] === 'computer-assistant' && deadline === undefined) {
      deadline = args[2];
      if (expired) clock.advance(2001);
    }
    yield* read(...args);
  }
  const reading = vi.spyOn(setup.nats.store, 'readStream').mockImplementation(readComputer);
  try {
    const request = { method: 'POST', headers: setup.headers,
      body: JSON.stringify({ model: 'gpt-6-luna', input: 'OK', max_output_tokens: 128, stream: true }) };
    const response = await fetch(`${setup.options.decisionUrl}/authorize`, request);
    const responseText = await response.text();
    expect(deadline).toBe(started + 10_000);
    expect(sleep).toHaveBeenCalledWith(2000, expect.any(AbortSignal));
    // Summary catch-up has its own ten-second limit; its caller still has two seconds.
    if (expired) {
      expect(response.status).toBe(503);
      expect(setup.actor.state.reservations).toHaveLength(0);
    } else {
      expect(response.status, responseText).toBe(200);
      expect(setup.actor.state.reservations).toHaveLength(1);
    }
  } finally {
    reading.mockRestore();
    await setup.close();
  }
}
it.each([false, true])('uses manual time for decision admission (expired: %s)', decisionDeadline,
  40_000);
