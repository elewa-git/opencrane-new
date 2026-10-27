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
  function fetchRoutes(address: string, options: RequestInit) {
    expect(address).toBe('http://127.0.0.1:3/routez');
    expect(options.signal).toBeInstanceOf(AbortSignal);
    const routes = replies[Math.min(index, replies.length - 1)];
    index += 1;
    const response = Response.json({ routes });
    return Promise.resolve(response);
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

const expected = [
  'peer-2/$SYS', 'peer-2/pooled', 'peer-2/pooled', 'peer-2/pooled',
  'peer-3/$SYS', 'peer-3/pooled', 'peer-3/pooled', 'peer-3/pooled',
];
const extraPooled = [...complete, { remote_name: 'peer-2' }];
const wrongAccount = [...missingPooled, { remote_name: 'peer-2', account: 'OTHER' }];
const missingSystem = [...complete];
missingSystem.splice(1, 1);
const incompleteRoutes = [
  { name: 'missing pooled route', routes: missingPooled, missing: 'peer-2/pooled' },
  { name: 'missing system route', routes: missingSystem, missing: 'peer-2/$SYS' },
  { name: 'extra pooled route', routes: extraPooled, extra: 'peer-2/pooled' },
  { name: 'wrong account with eight routes', routes: wrongAccount,
    missing: 'peer-2/pooled', extra: 'peer-2/OTHER' },
];

async function refusesRoutesThatNeverMatch(scenario: typeof incompleteRoutes[number]) {
  monitoringReplies([scenario.routes]);
  let failure: unknown;
  function recordFailure(error: unknown) {
    failure = error;
  }
  const pending = completeRoutes(peer).catch(recordFailure);
  await vi.advanceTimersByTimeAsync(19_999);
  expect(failure).toBeUndefined();
  await vi.advanceTimersByTimeAsync(1);
  await pending;
  expect(failure).toBeInstanceOf(Error);
  expect(failure).toHaveProperty('message', expect.stringContaining('peer-1'));
  expect(failure).toHaveProperty('expected', expected);
  const actual = [...expected];
  if (scenario.missing) {
    actual.splice(actual.indexOf(scenario.missing), 1);
  }
  if (scenario.extra) {
    actual.push(scenario.extra);
  }
  expect(failure).toHaveProperty('actual', actual.sort());
}
it.each(incompleteRoutes)('reports actual and expected routes at the deadline: $name',
  refusesRoutesThatNeverMatch);

async function acceptsCompleteRoutesWithoutWaiting() {
  monitoringReplies([complete]);
  await completeRoutes(peer);
  expect(performance.now()).toBe(0);
}
it('accepts every required route in any order without waiting', acceptsCompleteRoutesWithoutWaiting);

async function allowsRoutesToFinishAfterTheOldSharedDeadline() {
  const replies: unknown[][] = [];
  for (let index = 0; index < 440; index++) {
    replies.push(missingPooled);
  }
  replies.push(complete);
  monitoringReplies(replies);
  let finished = false;
  function markFinished() {
    finished = true;
  }
  const pending = completeRoutes(peer).then(markFinished);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(finished).toBe(false);
  await vi.advanceTimersByTimeAsync(1_000);
  await pending;
  expect(finished).toBe(true);
}
it('allows a pooled route to finish after the former shared ten-second deadline',
  allowsRoutesToFinishAfterTheOldSharedDeadline);

async function reportsRoutesWhenTheLastMonitoringRequestExpires() {
  monitoringReplies([missingPooled]);
  const fetchRoutes = globalThis.fetch;
  const stalled = Promise.withResolvers<Response>();
  function pauseFinalRequest(...args: Parameters<typeof fetch>) {
    if (performance.now() >= 19_975) {
      return stalled.promise;
    }
    return fetchRoutes(...args);
  }
  vi.stubGlobal('fetch', pauseFinalRequest);
  let failure: unknown;
  function recordFailure(error: unknown) {
    failure = error;
  }
  const pending = completeRoutes(peer).catch(recordFailure);
  await vi.advanceTimersByTimeAsync(19_975);
  expect(failure).toBeUndefined();
  await vi.advanceTimersByTimeAsync(25);
  stalled.reject(new Error('Monitoring request expired'));
  await pending;
  expect(failure).toHaveProperty('message', expect.stringContaining('peer-1'));
  expect(failure).toHaveProperty('expected', expected);
  const actual = [...expected];
  actual.splice(actual.indexOf('peer-2/pooled'), 1);
  expect(failure).toHaveProperty('actual', actual);
}
it('reports the last routes when a monitoring request expires at the deadline',
  reportsRoutesWhenTheLastMonitoringRequestExpires);

async function retriesRouteTimeoutBeforeTheDeadline() {
  monitoringReplies([missingPooled, complete]);
  const fetchRoutes = globalThis.fetch;
  let requests = 0;
  function timeoutSecondRequest(...args: Parameters<typeof fetch>) {
    requests += 1;
    if (requests === 2) {
      return Promise.reject(new DOMException('Monitoring request expired', 'TimeoutError'));
    }
    return fetchRoutes(...args);
  }
  vi.stubGlobal('fetch', timeoutSecondRequest);
  let failure: unknown;
  function recordFailure(error: unknown) {
    failure = error;
  }
  const pending = completeRoutes(peer).catch(recordFailure);
  await vi.advanceTimersByTimeAsync(50);
  await pending;
  expect(failure).toBeUndefined();
  expect(requests).toBe(3);
}
it('retries a route monitoring timeout within the original deadline',
  retriesRouteTimeoutBeforeTheDeadline);

async function retainsRoutesAcrossRequestTimeouts() {
  monitoringReplies([missingPooled]);
  const fetchRoutes = globalThis.fetch;
  let requests = 0;
  function timeoutLaterRequests(...args: Parameters<typeof fetch>) {
    requests += 1;
    if (requests > 1) {
      return Promise.reject(new DOMException('Monitoring request expired', 'TimeoutError'));
    }
    return fetchRoutes(...args);
  }
  vi.stubGlobal('fetch', timeoutLaterRequests);
  let failure: unknown;
  function recordFailure(error: unknown) {
    failure = error;
  }
  const pending = completeRoutes(peer).catch(recordFailure);
  await vi.advanceTimersByTimeAsync(19_999);
  expect(failure).toBeUndefined();
  await vi.advanceTimersByTimeAsync(1);
  await pending;
  const actual = [...expected];
  actual.splice(actual.indexOf('peer-2/pooled'), 1);
  expect(failure).toHaveProperty('actual', actual);
  expect(failure).toHaveProperty('expected', expected);
}
it('retains the last observed routes when later requests time out until expiry',
  retainsRoutesAcrossRequestTimeouts);
