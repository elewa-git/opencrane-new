import { execFile, type ChildProcess } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { connect as connectTcp } from 'node:net';
import { connect as connectTls } from 'node:tls';
import { promisify } from 'node:util';
import { jetstreamManager } from '@nats-io/jetstream';
import { PermissionViolationError, type NatsConnection } from '@nats-io/transport-node';
import { createLogger } from '@opencrane/observability';
import { members, ProjectionRunner } from '@opencrane/projections';
import { database } from '../../projections/test/database.ts';
import { afterAll, beforeAll, expect, it, onTestFinished, vi } from 'vitest';
import { createEventStore } from '../src/index.ts';
import { certificates, issueCertificate } from './certificates.ts';
import { clusterFixture, waitForClusterStream } from './cluster-fixture.ts';
import { event } from './testing.ts';

const routeExtensions = 'subjectAltName=DNS:localhost\nextendedKeyUsage=serverAuth,clientAuth\n';
const executeFile = promisify(execFile);

async function connectedPeers(fixture: Awaited<ReturnType<typeof clusterFixture>>) {
  await fixture.ready();
}

// Test authentication before exchanging any events with the route listener.
async function routeAttempt(fixture: Awaited<ReturnType<typeof clusterFixture>>,
  certificate?: string, plaintext = false) {
  const peer = fixture.peers[0]!;
  const ca = await readFile(`${fixture.directory}/routes/ca.crt`);
  let credentials = {};
  if (certificate) {
    credentials = { cert: await readFile(`${certificate}.crt`),
      key: await readFile(`${certificate}.key`) };
  }
  const options = { host: '127.0.0.1', port: peer.route, servername: 'localhost',
    ca, ...credentials };
  const socket = plaintext ? connectTcp(options) : connectTls(options);
  function destroySocket() {
    socket.destroy(new Error('Route probe timed out'));
  }
  const timeout = setTimeout(destroySocket, 3000);
  try {
    return await exchangeRouteConnect(socket);
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
      if (response.includes('PONG') || response.includes('-ERR')) {
        done(response);
      }
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
    socket.write('CONNECT {"name":"route-probe","cluster":"route-tests"}\r\nPING\r\n');
  }
}

let cluster: Awaited<ReturnType<typeof clusterFixture>>;
async function prepareCluster() {
  cluster = await clusterFixture();
  await connectedPeers(cluster);
  const connection = await cluster.client(cluster.peers[0]!);
  const store = await createEventStore(connection);
  await waitForClusterStream(store);
  await replicasAreCurrent(connection);
}
async function closeCluster() {
  await cluster?.close();
}
beforeAll(prepareCluster);
afterAll(closeCluster);

async function startsWithReadyRoutesAndCopies() {
  await connectedPeers(cluster);
  const connection = await cluster.client(cluster.peers[0]!);
  await replicasAreCurrent(connection);
}
it('connects every route and keeps three current copies before any route probe',
  startsWithReadyRoutesAndCopies);

async function refusesPlaintext() {
  expect(await routeAttempt(cluster, undefined, true)).toMatch(/closed|ECONNRESET/);
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

async function issueExpiredRouteCertificate(directory: string) {
  await issueCertificate(directory, 'expired', '/CN=expired', routeExtensions);
  const config = `[ca]
default_ca = test_ca
[test_ca]
database = expired-index.txt
serial = expired-serial.txt
new_certs_dir = .
certificate = ca.crt
private_key = ca.key
default_md = sha256
policy = subject_policy
[subject_policy]
commonName = supplied
`;
  await writeFile(`${directory}/expired-ca.conf`, config);
  await writeFile(`${directory}/expired-index.txt`, '');
  await writeFile(`${directory}/expired-serial.txt`, '01\n');
  // Set both dates in the past so TLS rejects expiry rather than reversed dates.
  const opensslArguments = ['ca', '-batch', '-notext', '-config', 'expired-ca.conf',
    '-in', 'expired.csr', '-out', 'expired.crt', '-extfile', 'expired.ext',
    '-startdate', '20200101000000Z', '-enddate', '20200102000000Z'];
  await executeFile('openssl', opensslArguments, { cwd: directory });
}

async function refusesExpiredCertificate() {
  const directory = `${cluster.directory}/routes`;
  await issueExpiredRouteCertificate(directory);
  const certificate = new X509Certificate(await readFile(`${directory}/expired.crt`));
  const validFrom = Date.parse(certificate.validFrom);
  const validTo = Date.parse(certificate.validTo);
  expect(validFrom).toBeLessThan(validTo);
  expect(validTo).toBeLessThan(Date.now());
  expect(await routeAttempt(cluster, `${directory}/expired`)).toMatch(/certificate expired/i);
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

async function refusesClientCertificate(identity: string) {
  if (identity === 'client-peer') {
    // Isolate route-only trust from the ordinary certificate's name and key usages.
    await issueCertificate(cluster.directory, identity, '/CN=client-peer', routeExtensions);
  }
  expect(await routeAttempt(cluster, `${cluster.directory}/${identity}`))
    .toMatch(/unknown ca|bad certificate/i);
  await connectedPeers(cluster);
}
it.each(['command', 'client-peer'])(
  'refuses the %s client certificate at the route listener', refusesClientCertificate);

async function acceptsValidCertificate() {
  expect(await routeAttempt(cluster, `${cluster.directory}/routes/peer-2`)).toContain('PONG');
  await connectedPeers(cluster);
}
it('accepts a current route certificate for a listed peer', acceptsValidCertificate);

function isClusterDirectory(name: string) {
  return name.startsWith('nats-cluster-missing-');
}

async function refusesMissingTrust() {
  const before = await readdir('.tools');
  const children: ChildProcess[] = [];
  await expect(clusterFixture(true, children)).rejects.toThrow('Route trust file is missing');
  expect(children).toHaveLength(3);
  for (const child of children) {
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  }
  const after = await readdir('.tools');
  expect(after.filter(isClusterDirectory)).toEqual(before.filter(isClusterDirectory));
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
    for (const replica of info.cluster!.replicas!) {
      expect(replica.current).toBe(true);
    }
  }
  await vi.waitFor(replication, { timeout: 5000 });
}

async function appendsAndReplays() {
  const connection = await cluster.client(cluster.peers[0]!);
  const store = await createEventStore(connection);
  await waitForClusterStream(store);
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
  const command = await cluster.client(cluster.peers[0]!);
  const store = await createEventStore(command);
  await waitForClusterStream(store);
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
  expect(await store.head(`member-${identity}`)).toBe(0);
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
