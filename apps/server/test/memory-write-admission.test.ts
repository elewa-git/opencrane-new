import { afterEach, expect, it, vi } from 'vitest';
import { acquireMemoryWrite, MemoryBusy } from '../src/memory/admission.ts';

const releases: (() => void)[] = [];
function cleanup() {
  for (const release of releases.splice(0)) {
    release();
  }
  vi.useRealTimers();
}
afterEach(cleanup);

async function admit(member: string, scope: string) {
  const release = await acquireMemoryWrite('test', member, scope);
  releases.push(release);
  return release;
}
function releaseWrite(release: () => void) {
  const index = releases.indexOf(release);
  releases.splice(index, 1);
  release();
}

async function memberLimits() {
  vi.useFakeTimers();
  const first = await admit('bob', 'personal');
  await expect(admit('bob', 'personal')).rejects.toBeInstanceOf(MemoryBusy);
  const waiting = admit('bob', 'notes');
  const refused = expect(waiting).rejects.toBeInstanceOf(MemoryBusy);
  await admit('alice', 'personal');
  await vi.advanceTimersByTimeAsync(100);
  await refused;
  releaseWrite(first);
  await admit('bob', 'notes');
}

async function orderedAdmission() {
  vi.useFakeTimers();
  const first = await admit('bob', 'personal');
  await admit('alice', 'personal');
  await admit('eve', 'personal');
  await admit('frank', 'personal');
  const waitingBob = admit('bob', 'group');
  const waitingCarol = admit('carol', 'personal');
  releaseWrite(first);
  const bobRelease = await waitingBob;
  const newcomer = admit('dave', 'personal');
  releaseWrite(bobRelease);
  const carolRelease = await waitingCarol;
  releaseWrite(carolRelease);
  await newcomer;
}

async function boundedWait() {
  vi.useFakeTimers();
  const first = await admit('bob', 'personal');
  await admit('alice', 'personal');
  await admit('eve', 'personal');
  await admit('frank', 'personal');
  const refusals: Promise<void>[] = [];
  for (let index = 0; index < 8; index++) {
    const waiting = admit(`waiting-${index}`, 'personal');
    refusals.push(expect(waiting).rejects.toBeInstanceOf(MemoryBusy));
  }
  await expect(admit('overflow', 'personal')).rejects.toBeInstanceOf(MemoryBusy);
  await expect(admit('waiting-0', 'personal')).rejects.toBeInstanceOf(MemoryBusy);
  await vi.advanceTimersByTimeAsync(100);
  await Promise.all(refusals);
  releaseWrite(first);
  await admit('waiting-0', 'personal');
}

it('allows one write per member and scope, leaving room for another member', memberLimits);
it('gives a released process slot to the oldest eligible waiting write', orderedAdmission);
it('bounds the queue and removes timed-out writes without occupying a slot', boundedWait);

async function manyScopesCannotFillQueue() {
  vi.useFakeTimers();
  await admit('bob', 'personal');
  await admit('carol', 'personal');
  await admit('dave', 'personal');
  const eveRelease = await admit('eve', 'personal');
  let refusedCount = 0;
  function refused(error: unknown) {
    expect(error).toBeInstanceOf(MemoryBusy);
    refusedCount++;
  }
  const bobWaits: Promise<void>[] = [];
  for (let index = 0; index < 8; index++) {
    const waiting = admit('bob', `group-${index}`);
    bobWaits.push(waiting.then(undefined, refused));
  }
  const aliceWait = admit('alice', 'personal');
  const aliceResult = Promise.allSettled([aliceWait]);
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(refusedCount).toBe(7);
    await vi.advanceTimersByTimeAsync(20);
    releaseWrite(eveRelease);
    const results = await aliceResult;
    expect(results[0]?.status).toBe('fulfilled');
  } finally {
    await vi.advanceTimersByTimeAsync(100);
    await Promise.all(bobWaits);
    await aliceResult;
  }
  // Check that an expired queue entry no longer reserves the member's next wait.
  const nextBobWait = admit('bob', 'another-group');
  const nextBobRefusal = expect(nextBobWait).rejects.toBeInstanceOf(MemoryBusy);
  await vi.advanceTimersByTimeAsync(100);
  await nextBobRefusal;
}

it('limits one member to one queued write across nine scopes while another member waits',
  manyScopesCannotFillQueue);
