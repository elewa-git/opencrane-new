import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, onTestFinished, vi } from 'vitest';
import { natsFixture } from '@opencrane/event-store/testing';
import { egressObservationId, parseEventByType } from '@opencrane/events';
import { startEgress } from '../src/egress-startup.ts';
import { history } from '../src/event-history.ts';

async function setup(fakeTimeouts = false) {
  const nats = await natsFixture();
  const directory = await mkdtemp(join(tmpdir(), 'egress-startup-'));
  let refusals = 0;
  function refused() {
    refusals++;
  }
  // Install before startup so the test also owns the normal receipt retry interval.
  if (fakeTimeouts) {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout',
      'clearTimeout', 'performance', 'Date'] });
  } else {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  }
  const runtime = await startEgress(nats.store, 'test', directory, refused);
  async function cleanup() {
    await runtime.close();
    vi.useRealTimers();
    await nats.close();
    await rm(directory, { recursive: true, force: true });
  }
  onTestFinished(cleanup);
  function refusalCount() {
    return refusals;
  }
  async function register(permitId = randomUUID()) {
    const request = { host: 'registry.npmjs.org', port: 443, permitId,
      expiresAt: Date.now() + 60_000 };
    await runtime.registry.register(request);
    return permitId;
  }
  return { nats, directory, runtime, register, refused, refusalCount };
}

async function recoveredPendingAndTerminal(refused: boolean) {
  const test = await setup();
  const append = test.nats.store.append.bind(test.nats.store);
  function unavailable(): never {
    throw new Error('private-canary');
  }
  const outage = vi.spyOn(test.nats.store, 'append').mockImplementation(unavailable);
  onTestFinished(outage.mockRestore.bind(outage));
  const permit = await test.register();
  test.runtime.registry.closePermit(permit);
  await test.runtime.flush();
  await test.runtime.close();
  const id = egressObservationId('test', permit);
  const file = join(test.directory, 'egress', `${id}.jsonl`);
  const parsed = parseEventByType(JSON.parse(await readFile(file, 'utf8')) as unknown);
  if (!parsed.success) throw new Error('Missing fixture evidence');
  if (refused) {
    // Save another valid close record to make the retained record disagree with the store.
    const event = { ...parsed.event, time: new Date(Date.now() + 1000).toISOString() };
    expect(await append({ event, expectedSequence: 0 })).toMatchObject({ status: 'appended' });
  }
  const maps = vi.spyOn(Map.prototype, 'set');
  onTestFinished(maps.mockRestore.bind(maps));
  const restarted = await startEgress(test.nats.store, 'test', test.directory, test.refused);
  onTestFinished(restarted.close);
  function matchesReceipt(args: unknown[]) {
    return args[0] === id;
  }
  const index = maps.mock.calls.findIndex(matchesReceipt);
  expect(index).toBeGreaterThanOrEqual(0);
  const receipts = maps.mock.contexts[index];
  if (!(receipts instanceof Map)) throw new Error('Missing receipt map');
  expect(receipts.has(id)).toBe(true);
  outage.mockRestore();
  await vi.advanceTimersByTimeAsync(1000);
  await restarted.flush();
  expect(receipts.has(id)).toBe(false);
  expect(test.refusalCount()).toBe(refused ? 2 : 0);
  const rows = await history(test.nats.store, `egress-${permit}`, 'test');
  expect(rows).toHaveLength(1);
  await restarted.close();
  expect(vi.getTimerCount()).toBe(0);
}
it.each([false, true])('keeps recovered receipts pending until terminal; refused: %s',
  recoveredPendingAndTerminal);

async function coalescesAndKeepsOpenReceipts() {
  const test = await setup();
  const first = await test.register();
  const second = await test.register();
  const firstEntered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const read = test.nats.store.readStream.bind(test.nats.store);
  let secondReads = 0;
  async function* holdFirst(...args: Parameters<typeof read>) {
    if (args[0] === `egress-${first}`) {
      firstEntered.resolve();
      await release.promise;
    }
    if (args[0] === `egress-${second}`) secondReads++;
    yield* read(...args);
  }
  const spy = vi.spyOn(test.nats.store, 'readStream').mockImplementation(holdFirst);
  function restore() {
    release.resolve();
    spy.mockRestore();
  }
  onTestFinished(restore);
  test.runtime.registry.closePermit(first);
  await firstEntered.promise;
  const earlier = test.runtime.flush();
  expect(test.runtime.flush()).toBe(earlier);
  const subscriptions = vi.spyOn(earlier, 'catch');
  await vi.advanceTimersByTimeAsync(3000);
  expect(subscriptions).not.toHaveBeenCalled();
  expect(secondReads).toBe(0);
  release.resolve();
  await earlier;
  test.runtime.registry.closePermit(second);
  await test.runtime.flush();
  const rows = await history(test.nats.store, `egress-${second}`, 'test');
  expect(rows).toHaveLength(1);
  expect(test.refusalCount()).toBe(0);
  await test.runtime.close();
  expect(vi.getTimerCount()).toBe(0);
}
it('joins retry batches, keeps empty open receipts and cancels the startup interval',
  coalescesAndKeepsOpenReceipts);

async function shutdownClearsOwnedTimers() {
  const test = await setup(true);
  const release = Promise.withResolvers<void>();
  onTestFinished(release.resolve);
  function recheck() {
    return release.promise;
  }
  const request = { host: 'registry.npmjs.org', port: 443, permitId: randomUUID(),
    expiresAt: Date.now() + 60_000, recheck };
  await test.runtime.registry.register(request);
  // Count the receipt retry, access check, proof watchdog and permit expiry timers.
  expect(vi.getTimerCount()).toBe(4);
  await vi.advanceTimersByTimeAsync(500);
  const closing = test.runtime.close();
  await test.runtime.flush();
  await vi.advanceTimersByTimeAsync(2000);
  await closing;
  expect(vi.getTimerCount()).toBe(0);
  release.resolve();
  await test.runtime.registry.waitForChecks();
  expect(vi.getTimerCount()).toBe(0);
  const rows = await history(test.nats.store, `egress-${request.permitId}`, 'test');
  expect(rows).toHaveLength(1);
  expect(rows[0]!.event.data).toMatchObject({ relay: { reason: 'unavailable' } });
}
it('clears every startup and relay timer even when a recheck finishes after shutdown',
  shutdownClearsOwnedTimers);
