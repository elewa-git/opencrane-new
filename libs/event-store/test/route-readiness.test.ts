import { afterEach, expect, it, vi } from 'vitest';
import { completeRoutes, type Peer } from './cluster-fixture.ts';

// Let the test advance polling time without waiting for the real ten-second limit.
function promiseTimers() {
  function delay(milliseconds: number) {
    function schedule(resolve: () => void) {
      setTimeout(resolve, milliseconds);
    }
    return new Promise<void>(schedule);
  }
  return { setTimeout: delay };
}
vi.mock('node:timers/promises', promiseTimers);

const peer: Peer = { name: 'peer-1', port: 1, route: 2, monitor: 3, reservations: [] };
const complete = [
  { remote_name: 'peer-2' },
  { remote_name: 'peer-2', account: '$SYS' },
  { remote_name: 'peer-3' },
  { remote_name: 'peer-2' },
  { remote_name: 'peer-3', account: '$SYS' },
  { remote_name: 'peer-3' },
  { remote_name: 'peer-2' },
  { remote_name: 'peer-3' },
];
const missingPooled = complete.slice(1);

function restoreMonitoring() {
  vi.useRealTimers();
  vi.unstubAllGlobals();
}
afterEach(restoreMonitoring);

function monitoringReplies(replies: unknown[][]) {
  let index = 0;
  async function fetchRoutes(address: string, options: RequestInit) {
    expect(address).toBe('http://127.0.0.1:3/routez');
    expect(options.signal).toBeInstanceOf(AbortSignal);
    const routes = replies[Math.min(index, replies.length - 1)];
    index += 1;
    return Response.json({ routes });
  }
  vi.stubGlobal('fetch', fetchRoutes);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
}

async function waitsForTheLastPooledRoute() {
  monitoringReplies([missingPooled, missingPooled, complete]);
  let finished = false;
  function markFinished() {
    finished = true;
  }
  let failure: unknown;
  function recordFailure(error: unknown) {
    failure = error;
  }
  const pending = completeRoutes(peer).then(markFinished, recordFailure);
  await vi.advanceTimersByTimeAsync(24);
  expect(finished).toBe(false);
  await vi.advanceTimersByTimeAsync(26);
  await pending;
  expect(failure).toBeUndefined();
  expect(finished).toBe(true);
}
it('waits for the last pooled route before accepting all eight routes',
  waitsForTheLastPooledRoute);
