import { expect, it } from 'vitest';
import { setImmediate } from 'node:timers/promises';
import { readBeforeDeadline, systemClock } from '../src/index.ts';
import { manualClock, manualStoreTime, natsFixture } from './testing.ts';

async function manualSleep() {
  const clock = manualClock();
  let awake = false;
  function wake() {
    awake = true;
  }
  const sleeping = clock.sleep(20).then(wake);
  clock.advance(19);
  await setImmediate();
  expect(awake).toBe(false);
  clock.advance(1);
  await sleeping;
  expect(clock.now()).toBe(20);
}
it('wakes a manual sleep only when its time arrives', manualSleep);

async function abortSleep() {
  const clock = manualClock();
  const controller = new AbortController();
  const sleeping = clock.sleep(20, controller.signal);
  const refused = expect(sleeping).rejects.toThrow('cancelled');
  controller.abort(new Error('cancelled'));
  await refused;
  clock.advance(20);
}
it('cancels manual sleeps', abortSleep);

async function stoppedRead() {
  const clock = manualClock();
  const pending = Promise.withResolvers<number>();
  function read() {
    return pending.promise;
  }
  const result = readBeforeDeadline(read, 2000, undefined, clock);
  await setImmediate();
  clock.advance(1999);
  pending.resolve(42);
  await expect(result).resolves.toBe(42);
}
it('keeps a pending read alive while its manual deadline has not arrived', stoppedRead);

async function expiredRead() {
  const clock = manualClock();
  function read(): Promise<never> {
    return new Promise<never>(() => {});
  }
  const result = readBeforeDeadline(read, 2000, undefined, clock);
  const refused = expect(result).rejects.toThrow();
  clock.advance(2001);
  await refused;
}
it('stops an unanswered read when the manual deadline passes', expiredRead);

async function fixtureClock() {
  const clock = manualClock();
  const fixture = await natsFixture({ clock });
  try {
    expect(fixture.store.clock).toBe(clock);
    expect(fixture.reader.clock).toBe(clock);
    expect(await fixture.store.head()).toBe(0);
  } finally {
    await fixture.close();
  }
}
it('hands the selected clock to both fixture stores', fixtureClock);

async function realClock() {
  const started = performance.now();
  expect(systemClock.now()).toBeGreaterThanOrEqual(started);
  await systemClock.sleep(1);
  const controller = new AbortController();
  controller.abort();
  await expect(systemClock.sleep(1000, controller.signal)).rejects.toThrow();
}
it('uses the existing monotonic time and cancellable real timers by default', realClock);

async function independentFixtureClocks() {
  const first = await natsFixture();
  try {
    const second = await natsFixture();
    try {
      const firstClock = first.store.clock;
      const secondClock = second.store.clock;
      const firstReader = Object.getOwnPropertyDescriptor(firstClock, 'now');
      const secondReader = Object.getOwnPropertyDescriptor(secondClock, 'now');
      const adapterReader = Object.getOwnPropertyDescriptor(systemClock, 'now');
      const firstTime = manualStoreTime(first.store, 1_000_000);
      firstTime.advance(2000);
      expect(Object.getOwnPropertyDescriptor(secondClock, 'now')).toEqual(secondReader);
      expect(Object.getOwnPropertyDescriptor(systemClock, 'now')).toEqual(adapterReader);
      const secondTime = manualStoreTime(second.store, 2_000_000);
      expect(first.store.clock.now()).toBe(1_002_000);
      expect(first.reader.clock.now()).toBe(1_002_000);
      expect(second.store.clock.now()).toBe(2_000_000);
      expect(second.reader.clock.now()).toBe(2_000_000);
      expect(Object.getOwnPropertyDescriptor(systemClock, 'now')).toEqual(adapterReader);
      firstTime.restore();
      expect(Object.getOwnPropertyDescriptor(firstClock, 'now')).toEqual(firstReader);
      expect(second.store.clock.now()).toBe(2_000_000);
      secondTime.advance(1000);
      expect(second.store.clock.now()).toBe(2_001_000);
      secondTime.restore();
      expect(Object.getOwnPropertyDescriptor(secondClock, 'now')).toEqual(secondReader);
      expect(Object.getOwnPropertyDescriptor(firstClock, 'now')).toEqual(firstReader);
      expect(Object.getOwnPropertyDescriptor(systemClock, 'now')).toEqual(adapterReader);
    } finally {
      await second.close();
    }
  } finally {
    await first.close();
  }
}
it('keeps default fixture clocks independent through advances and restoration',
  independentFixtureClocks);
