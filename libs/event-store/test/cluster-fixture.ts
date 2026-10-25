import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { JetStreamApiError } from '@nats-io/jetstream';
import type { NatsConnection } from '@nats-io/transport-node';
import { expect, vi } from 'vitest';
import { connectNats, type EventStore } from '../src/index.ts';
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
    async function allReady() {
      for (const peer of peers) {
        await completeRoutes(peer);
        await metadataReady(peer);
      }
    }
    await vi.waitFor(allReady, { timeout: 10_000 });
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

async function completeRoutes(peer: Peer) {
  const response = await fetch(`http://127.0.0.1:${peer.monitor}/routez`,
    { signal: AbortSignal.timeout(1000) });
  const result: unknown = await response.json();
  if (!result || typeof result !== 'object' || !('routes' in result) ||
    !Array.isArray(result.routes)) {
    throw new Error('Invalid route monitoring response');
  }
  const expected: string[] = [];
  for (let index = 1; index <= 3; index++) {
    const peerName = `peer-${index}`;
    if (peerName !== peer.name) {
      const pooledRoute = `${peerName}/pooled`;
      expected.push(pooledRoute, pooledRoute, pooledRoute);
      expected.push(`${peerName}/$SYS`);
    }
  }
  const actual: string[] = [];
  for (const route of result.routes) {
    actual.push(routeDescription(route));
  }
  expect(actual.sort()).toEqual(expected.sort());
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

async function metadataReady(peer: Peer) {
  const address = `http://127.0.0.1:${peer.monitor}`;
  const response = await fetch(`${address}/healthz?js-meta-only=true`,
    { signal: AbortSignal.timeout(1000) });
  expect(response.status).toBe(200);
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

export async function waitForClusterStream(store: Pick<EventStore, 'ensureStream'>) {
  async function placementReady() {
    try {
      await store.ensureStream({ replicas: 3 });
      return true;
    } catch (error) {
      // Wait only after an explicit placement refusal, never a timeout or lost reply.
      if (error instanceof JetStreamApiError && error.status === 400 &&
        error.code === 10005 &&
        error.apiError().description === 'no suitable peers for placement, peer offline') {
        return false;
      }
      throw error;
    }
  }
  await vi.waitUntil(placementReady, { timeout: 5000 });
}
