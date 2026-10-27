import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import type { NatsConnection } from '@nats-io/transport-node';
import { expect, vi } from 'vitest';
import { connectNats } from '../src/index.ts';
import { certificates, issueCertificate, sharedCertificates } from './certificates.ts';
import { reservePort } from './ports.ts';

const routeExtensions = 'subjectAltName=DNS:localhost\nextendedKeyUsage=serverAuth,clientAuth\n';
const roles = ['command', 'projection', 'dispatcher', 'computer', 'gateway'];
type PortReservation = Awaited<ReturnType<typeof reservePort>>;
export type Peer = { name: string; port: number; route: number; monitor: number;
  reservations: PortReservation[] };

export async function clusterFixture(missingTrust = false, children: ChildProcess[] = []) {
  const prefix = missingTrust ? 'nats-cluster-missing-' : 'nats-cluster-';
  const directory = await mkdtemp(resolve(`.tools/${prefix}`));
  const connections: NatsConnection[] = [];
  const reservations: PortReservation[] = [];
  const running = new Map<string, { env: NodeJS.ProcessEnv; child: ChildProcess }>();
  async function stop(peer: Peer) {
    const owned = running.get(peer.name);
    if (!owned || !peers.includes(peer)) {
      throw new Error('Cannot stop an unowned peer');
    }
    await stopChild(owned.child);
  }
  async function restart(peer: Peer) {
    const owned = running.get(peer.name);
    if (!owned || !peers.includes(peer) ||
      (owned.child.exitCode === null && owned.child.signalCode === null)) {
      throw new Error('Cannot restart a running or unowned peer');
    }
    owned.child = await startPeer(directory, owned.env, children);
  }
  async function ready() {
    for (const peer of peers) {
      await completeRoutes(peer);
      await metadataReady(peer, peers);
    }
  }
  async function close() {
    try {
      for (const connection of connections) {
        await connection.close();
      }
    } finally {
      try {
        for (const child of children) {
          await stopChild(child);
        }
      } finally {
        try {
          await releaseReservations(reservations);
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      }
    }
  }
  const peers: Peer[] = [];
  async function reservePeerPort() {
    const reservation = await reservePort();
    reservations.push(reservation);
    return reservation;
  }
  function env(peer: Peer, identity = 'command') {
    return {
      NATS_URL: `127.0.0.1:${peer.port}`,
      NATS_CA_FILE: `${directory}/ca.crt`,
      NATS_CERT_FILE: `${directory}/${identity}.crt`,
      NATS_KEY_FILE: `${directory}/${identity}.key`,
      NATS_NKEY_SEED_FILE: `${directory}/${identity}.seed`,
      NATS_INBOX_PREFIX: `_INBOX.${identity}`,
    };
  }
  async function client(peer: Peer, identity = 'command') {
    const connection = await connectNats(env(peer, identity));
    connections.push(connection);
    return connection;
  }
  try {
    await sharedCertificates(directory);
    await mkdir(`${directory}/routes`, { mode: 0o700 });
    await certificates(`${directory}/routes`);
    const publicKeys: NodeJS.ProcessEnv = {};
    for (const role of roles) {
      publicKeys[`NATS_${role.toUpperCase()}_NKEY`] =
        await readFile(`${directory}/${role}.pub`, 'utf8');
    }
    for (let index = 1; index <= 3; index++) {
      const clientPort = await reservePeerPort();
      const routePort = await reservePeerPort();
      const monitorPort = await reservePeerPort();
      const peer = { name: `peer-${index}`, port: clientPort.port,
        route: routePort.port, monitor: monitorPort.port,
        reservations: [clientPort, routePort, monitorPort] };
      peers.push(peer);
      await issueCertificate(`${directory}/routes`, peer.name, `/CN=${peer.name}`,
        routeExtensions);
    }
    const config = await readFile(resolve('infra/nats/cluster.conf'), 'utf8');
    await writeFile(`${directory}/cluster.conf`, `${config}\nhttp: $NATS_TEST_MONITOR\n`);
    const policy = await readFile(resolve('infra/nats/nats.conf'), 'utf8');
    await writeFile(`${directory}/nats.conf`, policy);
    for (const peer of peers) {
      const others: Peer[] = [];
      for (const candidate of peers) {
        if (candidate !== peer) {
          others.push(candidate);
        }
      }
      const serverEnv = { ...process.env, ...env(peer, 'server'), ...publicKeys,
        NATS_SERVER_NAME: peer.name, NATS_CLUSTER_NAME: 'route-tests',
        NATS_TEST_MONITOR: `127.0.0.1:${peer.monitor}`,
        NATS_LISTEN: `127.0.0.1:${peer.port}`, NATS_STORE_DIR: `${directory}/${peer.name}`,
        NATS_ROUTE_LISTEN: `127.0.0.1:${peer.route}`,
        NATS_ROUTE_ADVERTISE: `localhost:${peer.route}`,
        NATS_ROUTE_1: `nats-route://localhost:${others[0]!.route}`,
        NATS_ROUTE_2: `nats-route://localhost:${others[1]!.route}`,
        NATS_ROUTE_CA_FILE: `${directory}/routes/ca.crt`,
        NATS_ROUTE_CERT_FILE: `${directory}/routes/${peer.name}.crt`,
        NATS_ROUTE_KEY_FILE: `${directory}/routes/${peer.name}.key` };
      if (missingTrust && peer.name === 'peer-3') {
        serverEnv.NATS_ROUTE_CA_FILE = `${directory}/routes/absent.crt`;
      }
      await releaseReservations(peer.reservations);
      const child = await startPeer(directory, serverEnv, children);
      running.set(peer.name, { env: serverEnv, child });
    }
    await ready();
    return { directory, peers, client, close, stop, restart, ready };
  } catch (error) {
    await close();
    throw error;
  }
}

export async function completeRoutes(peer: Peer) {
  const expected: string[] = [];
  for (let index = 1; index <= 3; index++) {
    const peerName = `peer-${index}`;
    if (peerName !== peer.name) {
      const pooledRoute = `${peerName}/pooled`;
      expected.push(pooledRoute, pooledRoute, pooledRoute);
      expected.push(`${peerName}/$SYS`);
    }
  }
  expected.sort();
  const deadline = performance.now() + 20_000;
  let actual: string[] = [];
  // Allow each peer's pooled connections to finish without accepting a partial route list.
  while (true) {
    const requestRemaining = deadline - performance.now();
    if (requestRemaining <= 0) {
      break;
    }
    const requestTimeout = Math.min(1000, Math.ceil(requestRemaining));
    try {
      actual = await currentRoutes(peer, requestTimeout);
    } catch (error) {
      if (performance.now() < deadline) {
        throw error;
      }
      break;
    }
    if (isDeepStrictEqual(actual, expected)) {
      return;
    }
    const remaining = deadline - performance.now();
    if (remaining > 0) {
      await delay(Math.min(25, remaining));
    }
  }
  expect(actual, `Routes for ${peer.name} did not become complete within 20000 ms`)
    .toEqual(expected);
}

async function currentRoutes(peer: Peer, timeout: number) {
  const response = await fetch(`http://127.0.0.1:${peer.monitor}/routez`,
    { signal: AbortSignal.timeout(timeout) });
  const result: unknown = await response.json();
  if (!result || typeof result !== 'object' || !('routes' in result) ||
    !Array.isArray(result.routes)) {
    throw new Error('Invalid route monitoring response');
  }
  const actual: string[] = [];
  for (const route of result.routes) {
    actual.push(routeDescription(route));
  }
  return actual.sort();
}

function routeDescription(route: unknown) {
  if (!route || typeof route !== 'object' || !('remote_name' in route) ||
    typeof route.remote_name !== 'string') {
    throw new Error('Missing remote peer name');
  }
  let account = 'pooled';
  if ('account' in route) {
    expect(typeof route.account).toBe('string');
    account = String(route.account);
  }
  return `${route.remote_name}/${account}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function hasPlacementStatistics(value: unknown) {
  return isRecord(value) && value['disabled'] !== true && isRecord(value['config']) &&
    typeof value['config']['max_storage'] === 'number' &&
    typeof value['memory'] === 'number' && typeof value['storage'] === 'number';
}

function metadataIsReady(value: unknown) {
  if (!isRecord(value) || !hasPlacementStatistics(value)) {
    return false;
  }
  const metadata = value['meta_cluster'];
  if (!isRecord(metadata) || typeof metadata['leader'] !== 'string' ||
    !/^peer-[123]$/u.test(metadata['leader']) || !Array.isArray(metadata['replicas'])) {
    return false;
  }
  const names = new Set([metadata['leader']]);
  for (const replica of metadata['replicas']) {
    if (!isRecord(replica) || typeof replica['name'] !== 'string' ||
      !/^peer-[123]$/u.test(replica['name']) || replica['current'] !== true ||
      replica['offline'] === true) {
      return false;
    }
    names.add(replica['name']);
  }
  return names.size === 3;
}

export async function metadataReady(peer: Peer, peers: Peer[] = [peer]) {
  const address = `http://127.0.0.1:${peer.monitor}`;
  const deadline = performance.now() + 20_000;
  let actual: unknown;
  let health = 0;
  while (performance.now() < deadline) {
    const remaining = deadline - performance.now();
    const timeout = Math.min(1000, Math.ceil(remaining));
    try {
      const options = { signal: AbortSignal.timeout(timeout) };
      const response = await fetch(`${address}/healthz?js-meta-only=true`, options);
      health = response.status;
      const report = await fetch(`${address}/jsz`, options);
      expect(report.status).toBe(200);
      actual = await report.json();
      let leaderReport = actual;
      if (isRecord(actual) && isRecord(actual['meta_cluster'])) {
        const leaderName = actual['meta_cluster']['leader'];
        function isLeader(candidate: Peer) {
          return candidate.name === leaderName;
        }
        const leader = peers.find(isLeader);
        if (leader && leader !== peer) {
          const leaderAddress = `http://127.0.0.1:${leader.monitor}/jsz`;
          const leaderResponse = await fetch(leaderAddress, options);
          expect(leaderResponse.status).toBe(200);
          leaderReport = await leaderResponse.json();
        }
      }
      // Read current flags on the leader: followers only track their own link to it.
      if (health === 200 && hasPlacementStatistics(actual) && metadataIsReady(leaderReport) &&
        performance.now() < deadline) {
        return;
      }
    } catch (error) {
      if (performance.now() < deadline) {
        throw error;
      }
      break;
    }
    const pollRemaining = deadline - performance.now();
    if (pollRemaining > 0) {
      await delay(Math.min(25, pollRemaining));
    }
  }
  const expected = { health: 200, metadata: 'named leader, three current peers and storage statistics' };
  expect(actual, `Metadata for ${peer.name} did not become ready within 20000 ms (health ${health})`)
    .toEqual(expected);
}

async function releaseReservations(reservations: PortReservation[]) {
  for (const reservation of reservations) {
    await reservation.release();
  }
}

async function startPeer(directory: string, env: NodeJS.ProcessEnv,
  children: ChildProcess[]) {
  const child = spawn(resolve('.tools/nats-server'),
    ['-c', `${directory}/cluster.conf`], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  children.push(child);
  let output = "";
  let ready = false;
  let failed = false;
  let stopped = false;
  function recordOutput(chunk: Buffer) {
    // Keep process output private: startup errors can contain mounted file paths.
    output += chunk.toString();
    if (output.includes('Server is ready')) {
      ready = true;
    }
  }
  function recordFailure() {
    failed = true;
  }
  function recordStopped() {
    stopped = true;
  }
  child.stderr.on('data', recordOutput);
  child.on('error', recordFailure);
  child.on('close', recordStopped);
  const deadline = Date.now() + 5000;
  while (!ready) {
    if (failed || stopped || Date.now() >= deadline) {
      if (output.includes(`${directory}/routes/absent.crt`)) {
        throw new Error('Route trust file is missing');
      }
      if (output.includes('address already in use')) {
        throw new Error('Cluster peer listening port is already in use');
      }
      throw new Error('Cluster peer failed to start');
    }
    await delay(25);
  }
  return child;
}

async function stopChild(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill('SIGKILL');
  function hasStopped() {
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  }
  await vi.waitFor(hasStopped, { timeout: 5000, interval: 25 });
}

export { waitForClusterStream } from './cluster-stream.ts';
