import { expect, it, onTestFinished } from 'vitest';
import { fixture } from './fixture.ts';

async function chargesChatReplaysSeparately() {
  const context = await fixture();
  onTestFinished(context.close.bind(context));
  expect(context.actor.state.roots).toHaveLength(0);
  expect((await context.call()).status).toBe(200);
  await context.settled();
  expect(context.actor.state.reservations).toHaveLength(1);
  expect(context.actor.state.reservations[0]?.settledCents).toBe(1);
  // Replay the same HTTP body, as a client would after losing the completed stream.
  expect((await context.call()).status).toBe(200);
  await context.settled();
  expect(context.received()).toBe(2);
  expect(context.actor.state.reservations).toHaveLength(2);
  expect(context.actor.state.reservations[1]?.settledCents).toBe(1);
  expect(context.actor.state.dispatches).toHaveLength(2);
}
it('charges an identical ordinary chat replay again, so automatic retries must stay off',
  chargesChatReplaysSeparately, 120_000);
