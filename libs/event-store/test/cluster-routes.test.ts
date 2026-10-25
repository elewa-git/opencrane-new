import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { connect as connectTcp } from 'node:net';
import { resolve } from 'node:path';
import { connect as connectTls } from 'node:tls';
import { setTimeout as delay } from 'node:timers/promises';
import { jetstreamManager } from '@nats-io/jetstream';
import { PermissionViolationError, type NatsConnection } from '@nats-io/transport-node';
import { createLogger } from '@opencrane/observability';
import { members, ProjectionRunner } from '@opencrane/projections';
import { database } from '../../projections/test/database.ts';
import { afterAll, beforeAll, expect, it, onTestFinished } from 'vitest';
import { connectNats, createEventStore } from '../src/index.ts';
import { certificates, issueCertificate, sharedCertificates } from './certificates.ts';
import { freePort } from './ports.ts';
import { event } from './testing.ts';

const routeExtensions = 'subjectAltName=DNS:localhost\nextendedKeyUsage=serverAuth,clientAuth\n';
const roles = ['command', 'projection', 'dispatcher', 'computer', 'gateway'];
type Peer = { name: string; port: number; route: number; monitor: number };

async function clusterFixture(missingTrust = false) {
  const directory = await mkdtemp(resolve('.tools/nats-cluster-'));
  const children: ChildProcess[] = [];
  const connections: NatsConnection[] = [];
  async function close() {
    for (const connection of connections) {
      await connection.close();
    }
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const stopped = once(child, 'close');
        child.kill('SIGKILL');
        await stopped;
      }
    }
    await rm(directory, { recursive: true, force: true });
  }
  const peers: Peer[] = [];
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
      const peer = { name: `peer-${index}`, port: await freePort(),
        route: await freePort(), monitor: await freePort() };
      peers.push(peer);
      await issueCertificate(`${directory}/routes`, peer.name, `/CN=${peer.name}`,
        routeExtensions);
    }
    const config = await readFile(resolve('infra/nats/cluster.conf'), 'utf8');
    await writeFile(`${directory}/cluster.conf`, config);
    const policy = await readFile(resolve('infra/nats/nats.conf'), 'utf8');
    await writeFile(`${directory}/nats.conf`, policy);
    for (const peer of peers) {
      const others: Peer[] = [];
      for (const candidate of peers) {
        if (candidate !== peer) others.push(candidate);
      }
      const serverEnv = { ...process.env, ...env(peer, 'server'), ...publicKeys,
        NATS_SERVER_NAME: peer.name, NATS_CLUSTER_NAME: 'route-tests',
        NATS_LISTEN: `127.0.0.1:${peer.port}`, NATS_STORE_DIR: `${directory}/${peer.name}`,
        NATS_ROUTE_LISTEN: `127.0.0.1:${peer.route}`,
        NATS_ROUTE_ADVERTISE: `localhost:${peer.route}`,
        NATS_ROUTE_1: `nats-route://localhost:${others[0]!.route}`,
        NATS_ROUTE_2: `nats-route://localhost:${others[1]!.route}`,
        NATS_ROUTE_CA_FILE: `${directory}/routes/${missingTrust ? 'absent' : 'ca'}.crt`,
        NATS_ROUTE_CERT_FILE: `${directory}/routes/${peer.name}.crt`,
        NATS_ROUTE_KEY_FILE: `${directory}/routes/${peer.name}.key` };
      await startPeer(directory, peer, serverEnv, children);
    }
    return { directory, peers, client, close };
  } catch (error) {
    await close();
    throw error;
  }
}

async function startPeer(directory: string, peer: Peer, env: NodeJS.ProcessEnv,
  children: ChildProcess[]) {
  const child = spawn(resolve('.tools/nats-server'),
    ['-c', `${directory}/cluster.conf`, '-m', `127.0.0.1:${peer.monitor}`], { env });
  children.push(child);
  let ready = false;
  let failed = false;
  function recordOutput(chunk: Buffer) {
    // Keep process output private: startup errors can contain mounted file paths.
    if (chunk.toString().includes('Server is ready')) ready = true;
  }
  function recordFailure() {
    failed = true;
  }
  child.stderr.on('data', recordOutput);
  child.on('error', recordFailure);
  const deadline = Date.now() + 5000;
  while (!ready) {
    if (failed || child.exitCode !== null || Date.now() >= deadline) {
      throw new Error('Cluster peer failed to start');
    }
    await delay(25);
  }
}

async function peerNames(peer: Peer) {
  const response = await fetch(`http://127.0.0.1:${peer.monitor}/routez`);
  const result = await response.json() as { routes: { remote_name: string }[] };
  const names = new Set<string>();
  for (const route of result.routes) names.add(route.remote_name);
  return [...names].sort();
}

async function connectedPeers(fixture: Awaited<ReturnType<typeof clusterFixture>>) {
  for (const peer of fixture.peers) {
    const expected: string[] = [];
    for (const candidate of fixture.peers) {
      if (candidate !== peer) expected.push(candidate.name);
    }
    async function names() {
      return peerNames(peer);
    }
    await expect.poll(names, { timeout: 5000 }).toEqual(expected);
  }
}

// Read the route listener's INFO, then test authentication before exchanging any events.
async function routeAttempt(fixture: Awaited<ReturnType<typeof clusterFixture>>,
  certificate?: string, plaintext = false) {
  const peer = fixture.peers[0]!;
  const socket = connectTcp(peer.route, '127.0.0.1');
  const timeout = setTimeout(destroySocket, 3000);
  function destroySocket() {
    socket.destroy(new Error('Route probe timed out'));
  }
  try {
    await once(socket, 'data');
    let transport = socket;
    if (!plaintext) {
      const ca = await readFile(`${fixture.directory}/routes/ca.crt`);
      let credentials = {};
      if (certificate) {
        credentials = { cert: await readFile(`${certificate}.crt`),
          key: await readFile(`${certificate}.key`) };
      }
      transport = connectTls({ socket, servername: 'localhost', ca, ...credentials });
    }
    return await exchangeRouteConnect(transport);
  } finally {
    clearTimeout(timeout);
    socket.destroy();
  }
}

function exchangeRouteConnect(socket: ReturnType<typeof connectTcp>) {
  return new Promise<string>(finish);
  function finish(done: (result: string) => void) {
    function received(chunk: Buffer) {
      const response = chunk.toString();
      if (response.includes('PONG') || response.includes('-ERR')) done(response);
    }
    function refused(error: Error) {
      done(error.message);
    }
    function closed() {
      done('closed');
    }
    socket.on('data', received);
    socket.on('error', refused);
    socket.on('close', closed);
    socket.write('CONNECT {"name":"route-probe"}\r\nPING\r\n');
  }
}

let cluster: Awaited<ReturnType<typeof clusterFixture>>;
async function prepareCluster() {
  cluster = await clusterFixture();
  await connectedPeers(cluster);
}
async function closeCluster() {
  await cluster?.close();
}
beforeAll(prepareCluster);
afterAll(closeCluster);

async function refusesPlaintext() {
  expect(await routeAttempt(cluster, undefined, true)).not.toContain('PONG');
  await connectedPeers(cluster);
}
it('refuses a plaintext route in a working cluster', refusesPlaintext);

async function refusesAbsentCertificate() {
  expect(await routeAttempt(cluster)).toMatch(/certificate required|did not return a certificate/i);
  await connectedPeers(cluster);
}
it('refuses a route without a certificate', refusesAbsentCertificate);

async function refusesForeignCertificate() {
  const directory = `${cluster.directory}/foreign`;
  await mkdir(directory);
  await certificates(directory);
  await issueCertificate(directory, 'peer', '/CN=peer', routeExtensions);
  expect(await routeAttempt(cluster, `${directory}/peer`)).toMatch(/unknown ca|bad certificate/i);
  await connectedPeers(cluster);
}
it('refuses a foreign route CA with the right peer name and key usages',
  refusesForeignCertificate);

async function refusesExpiredCertificate() {
  const directory = `${cluster.directory}/routes`;
  await issueCertificate(directory, 'expired', '/CN=expired', routeExtensions, -1);
  expect(await routeAttempt(cluster, `${directory}/expired`)).toMatch(/expired certificate/i);
  await connectedPeers(cluster);
}
it('refuses an expired route certificate with the right name and issuer',
  refusesExpiredCertificate);

async function refusesWrongName() {
  const directory = `${cluster.directory}/routes`;
  const extensions = routeExtensions.replace('DNS:localhost', 'DNS:wrong.invalid');
  await issueCertificate(directory, 'wrong-name', '/CN=wrong-name', extensions);
  expect(await routeAttempt(cluster, `${directory}/wrong-name`)).toContain('Authorization Violation');
  await connectedPeers(cluster);
}
it('refuses a trusted route certificate for an unlisted peer name', refusesWrongName);

async function refusesClientCertificate() {
  expect(await routeAttempt(cluster, `${cluster.directory}/command`))
    .toMatch(/unknown ca|bad certificate/i);
  // Isolate route-only trust from the ordinary certificate's name and key usages.
  await issueCertificate(cluster.directory, 'client-peer', '/CN=client-peer', routeExtensions);
  expect(await routeAttempt(cluster, `${cluster.directory}/client-peer`))
    .toMatch(/unknown ca|bad certificate/i);
  await connectedPeers(cluster);
}
it('refuses client CA certificates even with a matching route name and usages',
  refusesClientCertificate);

async function acceptsValidCertificate() {
  expect(await routeAttempt(cluster, `${cluster.directory}/routes/peer-2`)).toContain('PONG');
  await connectedPeers(cluster);
}
it('accepts a current route certificate for a listed peer', acceptsValidCertificate);

async function refusesMissingTrust() {
  await expect(clusterFixture(true)).rejects.toThrow('Cluster peer failed to start');
  await connectedPeers(cluster);
}
it('fails startup when route trust is missing', refusesMissingTrust);

async function replicasAreCurrent(connection: NatsConnection) {
  const manager = await jetstreamManager(connection);
  async function replication() {
    const info = await manager.streams.info('EVENTS');
    expect(info.config.num_replicas).toBe(3);
    expect(info.cluster?.leader).toMatch(/^peer-[123]$/);
    expect(info.cluster?.replicas).toHaveLength(2);
    for (const replica of info.cluster!.replicas!) expect(replica.current).toBe(true);
  }
  await expect.poll(replication, { timeout: 5000 }).toBeUndefined();
}

async function appendsAndReplays() {
  const connection = await cluster.client(cluster.peers[0]!);
  const store = await createEventStore(connection);
  await store.ensureStream({ replicas: 3 });
  await replicasAreCurrent(connection);
  const joined = event('cluster-joined');
  expect(await store.append({ event: joined, expectedSequence: 0 }))
    .toEqual({ status: 'appended', sequence: 1 });
  expect(await store.append({ event: event('stale'), expectedSequence: 0 }))
    .toMatchObject({ status: 'conflict' });
  const readerConnection = await cluster.client(cluster.peers[2]!, 'projection');
  const reader = await createEventStore(readerConnection);
  const storage = await database('pg');
  try {
    const logger = createLogger('cluster-replay', { level: 'silent' });
    const runner = new ProjectionRunner(storage.db, reader, logger);
    await runner.initialise(members);
    await runner.run(members);
    const before = await storage.db.query('SELECT * FROM members');
    expect(before.rows).toHaveLength(1);
    expect(before.rows[0]).toMatchObject({ member_id: 'alice', status: 'joined' });
    await runner.rebuild(members);
    expect((await storage.db.query('SELECT * FROM members')).rows).toEqual(before.rows);
    expect(await runner.checkpoint(members)).toBe(1);
    expect(await reader.head()).toBe(1);
  } finally {
    await storage.close();
  }
  await replicasAreCurrent(connection);
}
it('keeps three current copies, refuses a stale append and rebuilds a projection',
  appendsAndReplays);

async function refusesPublish(identity: string) {
  const connection = await cluster.client(cluster.peers[1]!, identity);
  const statuses = connection.status();
  async function permissionError() {
    for await (const status of statuses) {
      if (status.type === 'error' && status.error instanceof PermissionViolationError) {
        return status.error;
      }
    }
    throw new Error('Connection closed without a publish refusal');
  }
  const refusal = permissionError();
  const subject = `ev.member.${identity}`;
  connection.publish(subject, JSON.stringify(event(`forbidden-${identity}`, `member-${identity}`)));
  await expect(refusal).resolves.toMatchObject({ operation: 'publish', subject });
  const command = await cluster.client(cluster.peers[0]!);
  const store = await createEventStore(command);
  expect(await store.head(subject.replace('ev.member.', 'member-'))).toBe(0);
}
it.each(['computer', 'gateway', 'projection', 'dispatcher'])(
  '%s still cannot publish events through cluster routes', refusesPublish);

async function refusesReplicaMismatch() {
  const isolated = await clusterFixture();
  onTestFinished(isolated.close);
  await connectedPeers(isolated);
  const connection = await isolated.client(isolated.peers[0]!);
  const store = await createEventStore(connection);
  await store.ensureStream({ replicas: 1 });
  const manager = await jetstreamManager(connection);
  const before = await manager.streams.info('EVENTS');
  await expect(store.ensureStream({ replicas: 3 })).rejects.toThrow(/num_replicas/);
  const after = await manager.streams.info('EVENTS');
  expect(after.config).toEqual(before.config);
  expect(after.config.num_replicas).toBe(1);
}
it('refuses to verify an existing single-copy stream as three copies without repair',
  refusesReplicaMismatch);
