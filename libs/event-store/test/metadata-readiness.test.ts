import { afterEach, expect, it, vi } from 'vitest';
import { metadataReady, type Peer } from './cluster-fixture.ts';

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
const ready = {
  config: { max_storage: 1000000 }, memory: 0, storage: 0,
  meta_cluster: { leader: 'peer-1', replicas: [
    { name: 'peer-2', current: true }, { name: 'peer-3', current: true },
  ] },
};

function restoreMonitoring() {
  vi.useRealTimers();
  vi.unstubAllGlobals();
}
afterEach(restoreMonitoring);

function monitoringReplies(replies: unknown[]) {
  let index = 0;
  function fetchMetadata(address: string, options: RequestInit) {
    expect(options.signal).toBeInstanceOf(AbortSignal);
    if (address.endsWith('/healthz?js-meta-only=true')) {
      return Promise.resolve(new Response('ok'));
    }
    expect(address).toBe('http://127.0.0.1:3/jsz');
    const report = replies[Math.min(index, replies.length - 1)];
    index += 1;
    return Promise.resolve(Response.json(report));
  }
  vi.stubGlobal('fetch', fetchMetadata);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
}

async function waitsForNamedCurrentPeersAndStatistics() {
  const noLeader = { ...ready, meta_cluster: { replicas: [] } };
  const missingStatistics = { ...ready, config: undefined };
  const behind = structuredClone(ready);
  behind.meta_cluster.replicas[0]!.current = false;
  const missingName = structuredClone(ready);
  missingName.meta_cluster.replicas[1]!.name = '';
  const duplicate = structuredClone(ready);
  duplicate.meta_cluster.replicas[1]!.name = 'peer-2';
  monitoringReplies([noLeader, missingStatistics, behind, missingName, duplicate, ready]);
  let finished = false;
  function markFinished() {
    finished = true;
  }
  const pending = metadataReady(peer).then(markFinished);
  await vi.advanceTimersByTimeAsync(124);
  expect(finished).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await pending;
  expect(finished).toBe(true);
}
it('waits beyond healthy metadata for named current peers and storage statistics',
  waitsForNamedCurrentPeersAndStatistics);

async function reportsIncompleteMetadataAtTheDeadline() {
  const incomplete = { ...ready, meta_cluster: { replicas: [] } };
  monitoringReplies([incomplete]);
  let failure: unknown;
  function recordFailure(error: unknown) {
    failure = error;
  }
  const pending = metadataReady(peer).catch(recordFailure);
  await vi.advanceTimersByTimeAsync(19_999);
  expect(failure).toBeUndefined();
  await vi.advanceTimersByTimeAsync(1);
  await pending;
  expect(failure).toBeInstanceOf(Error);
  expect(failure).toHaveProperty('message', expect.stringContaining('peer-1'));
  expect(failure).toHaveProperty('message', expect.stringContaining('20000 ms'));
  expect(failure).toHaveProperty('actual', incomplete);
}
it('reports the observed metadata when the bounded wait expires',
  reportsIncompleteMetadataAtTheDeadline);

async function readsCurrentPeersFromTheLeader() {
  monitoringReplies([ready]);
  const follower = structuredClone(ready);
  follower.meta_cluster.leader = 'peer-2';
  follower.meta_cluster.replicas = [
    { name: 'peer-2', current: true }, { name: 'peer-3', current: false },
  ];
  const leader = structuredClone(ready);
  leader.meta_cluster.leader = 'peer-2';
  leader.meta_cluster.replicas[0]!.name = 'peer-1';
  const leaderPeer = { ...peer, name: 'peer-2', monitor: 4 };
  function fetchMetadata(address: string) {
    if (address.endsWith('/healthz?js-meta-only=true')) {
      return Promise.resolve(new Response('ok'));
    }
    if (address === 'http://127.0.0.1:4/jsz') {
      return Promise.resolve(Response.json(leader));
    }
    return Promise.resolve(Response.json(follower));
  }
  vi.stubGlobal('fetch', fetchMetadata);
  const pending = metadataReady(peer, [peer, leaderPeer]);
  const result = pending.then(markFinished);
  let finished = false;
  function markFinished() {
    finished = true;
  }
  await vi.advanceTimersByTimeAsync(0);
  expect(finished).toBe(true);
  await result;
}
it('reads current peer flags from the metadata leader, since followers only track their leader',
  readsCurrentPeersFromTheLeader);

async function retriesAnExpiredMonitoringRequest() {
  monitoringReplies([ready]);
  const fetchMetadata = globalThis.fetch;
  let first = true;
  function fetchWithFirstTimeout(...args: Parameters<typeof fetch>) {
    if (first) {
      first = false;
      return Promise.reject(new DOMException('Monitoring request expired', 'TimeoutError'));
    }
    return fetchMetadata(...args);
  }
  vi.stubGlobal('fetch', fetchWithFirstTimeout);
  let failure: unknown;
  function recordFailure(error: unknown) {
    failure = error;
  }
  const pending = metadataReady(peer).catch(recordFailure);
  await vi.advanceTimersByTimeAsync(25);
  await pending;
  expect(failure).toBeUndefined();
}
it('retries an expired monitoring request within the original metadata deadline',
  retriesAnExpiredMonitoringRequest);

async function retainsMetadataWhenLaterRequestsExpire() {
  const incomplete = { ...ready, meta_cluster: { replicas: [] } };
  monitoringReplies([incomplete]);
  const fetchMetadata = globalThis.fetch;
  let replies = 0;
  function expireLaterRequests(...args: Parameters<typeof fetch>) {
    replies += 1;
    if (replies > 2) {
      return Promise.reject(new DOMException('Monitoring request expired', 'TimeoutError'));
    }
    return fetchMetadata(...args);
  }
  vi.stubGlobal('fetch', expireLaterRequests);
  let failure: unknown;
  function recordFailure(error: unknown) {
    failure = error;
  }
  const pending = metadataReady(peer).catch(recordFailure);
  await vi.advanceTimersByTimeAsync(19_999);
  expect(failure).toBeUndefined();
  await vi.advanceTimersByTimeAsync(1);
  await pending;
  expect(failure).toHaveProperty('actual', incomplete);
  expect(failure).toHaveProperty('message', expect.stringContaining('TimeoutError'));
}
it('retains observed metadata and request timeout details at the original deadline',
  retainsMetadataWhenLaterRequestsExpire);

async function reportsBothPeerAndLeaderAtExpiry() {
  monitoringReplies([ready]);
  const follower = structuredClone(ready);
  follower.meta_cluster.leader = 'peer-2';
  const leader = structuredClone(ready);
  leader.meta_cluster.leader = 'peer-2';
  leader.meta_cluster.replicas[0]!.name = 'peer-1';
  const offlineLeader = {
    ...leader,
    meta_cluster: {
      ...leader.meta_cluster,
      replicas: [
        { name: 'peer-1', current: false, offline: true },
        { name: 'peer-3', current: true },
      ],
    },
  };
  const leaderPeer = { ...peer, name: 'peer-2', monitor: 4 };
  function fetchMetadata(address: string) {
    if (address.endsWith('/healthz?js-meta-only=true')) {
      return Promise.resolve(new Response('ok'));
    }
    if (address === 'http://127.0.0.1:4/jsz') {
      return Promise.resolve(Response.json(offlineLeader));
    }
    return Promise.resolve(Response.json(follower));
  }
  vi.stubGlobal('fetch', fetchMetadata);
  let failure: unknown;
  function recordFailure(error: unknown) {
    failure = error;
  }
  const pending = metadataReady(peer, [peer, leaderPeer]).catch(recordFailure);
  await vi.advanceTimersByTimeAsync(19_999);
  expect(failure).toBeUndefined();
  await vi.advanceTimersByTimeAsync(1);
  await pending;
  const observations = {
    peer: { name: 'peer-1', report: follower },
    leader: { name: 'peer-2', report: offlineLeader },
  };
  expect(failure).toHaveProperty('message', expect.stringContaining(JSON.stringify(observations)));
  expect(failure).toHaveProperty('actual', follower);
}
it('reports the queried peer and the leader with its offline peer when readiness expires',
  reportsBothPeerAndLeaderAtExpiry);
