import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import ts from 'typescript';
import { JetStreamApiError, jetstreamManager } from '@nats-io/jetstream';
import { expect, it, vi } from 'vitest';
import { connectNats, createEventStore, isEventStoreUnavailable } from '@opencrane/event-store';
import { provisionDispatcher } from '@opencrane/handlers';
import { natsFixture } from '../../libs/event-store/test/testing.ts';
import { clusterFixture } from '../../libs/event-store/test/cluster-fixture.ts';
import { waitForClusterStream } from '../../libs/event-store/test/cluster-stream.ts';

type Bootstrap = {
  provisionEvents(): Promise<void>;
  bootstrapOwner(owner: typeof binding): Promise<void>;
  main(): Promise<void>;
};
const binding = { silo: 'test', apiUrl: 'http://openfga:8080', storeId: 'store',
  authorizationModelId: 'model' };

function clusterSettings(cluster: Awaited<ReturnType<typeof clusterFixture>>) {
  return {
    NATS_URL: `127.0.0.1:${cluster.peers[0]!.port}`,
    NATS_CA_FILE: `${cluster.directory}/ca.crt`,
    NATS_CERT_FILE: `${cluster.directory}/command.crt`,
    NATS_KEY_FILE: `${cluster.directory}/command.key`,
    NATS_NKEY_SEED_FILE: `${cluster.directory}/command.seed`,
    NATS_INBOX_PREFIX: '_INBOX.command',
  };
}

async function streamInfo(connection: Awaited<ReturnType<typeof connectNats>>) {
  const reply = await connection.request('$JS.API.STREAM.INFO.EVENTS');
  return reply.json<{ config: { num_replicas: number }; created: string;
    state: { consumer_count: number } }>();
}

type ReadinessFixture = { replies: unknown[]; elapsed: number; failure?: Error };
type PlacementFixture = { failure: Error; refusals: number; attempts: number };

async function bootstrapFixture(env: NodeJS.ProcessEnv, readiness?: ReadinessFixture,
  placement?: PlacementFixture) {
  const files = new Map<string, string>();
  const actions: string[] = [];
  async function mkdirFixture(path: string, options: { mode: number }) {
    assert.equal(options.mode, 0o700);
    actions.push(path);
  }
  async function writeFixture(path: string, contents: string, options: { mode: number }) {
    assert.equal(options.mode, 0o600);
    actions.push(path);
    files.set(path, contents);
  }
  function executeFixture(program: string, args: string[], options: { env: NodeJS.ProcessEnv },
    callback: (error: null, result: object) => void) {
    assert.equal(program, process.execPath);
    assert.deepEqual(Array.from(args),
      ['--experimental-strip-types', 'infra/dev-stack/owner-bootstrap.ts']);
    assert.equal(options.env['DEV_STACK_DIR'], '/tmp/package-bootstrap');
    assert.equal(options.env['DEV_STACK_ID'], 'owner');
    actions.push('owner command');
    callback(null, {});
  }
  async function connection() {
    actions.push('NATS connection');
    const connected = await connectNats(env);
    if (readiness) {
      const request = connected.request.bind(connected);
      async function requestFixture(...args: Parameters<typeof connected.request>) {
        if (args[0] === 'bootstrap.meta') {
          if (readiness!.failure) {
            throw readiness!.failure;
          }
          const reply = readiness!.replies.shift();
          return { json: () => reply } as Awaited<ReturnType<typeof connected.request>>;
        }
        if (args[0] === '$JS.API.STREAM.CREATE.EVENTS' && placement) {
          placement.attempts += 1;
          if (placement.attempts <= placement.refusals) {
            throw placement.failure;
          }
        }
        return request(...args);
      }
      vi.spyOn(connected, 'request').mockImplementation(requestFixture);
    }
    return connected;
  }
  class Pool {
    constructor() {
      actions.push('database');
      throw new Error('Unexpected database access');
    }
  }
  class Clock extends Date {
    static override now() {
      return readiness?.elapsed ?? Date.now();
    }
  }
  async function advanceClock(milliseconds: number) {
    readiness!.elapsed += milliseconds;
  }
  const replacements: Record<string, unknown> = {
    'node:fs/promises': { mkdir: mkdirFixture, writeFile: writeFixture },
    'node:child_process': { execFile: executeFixture },
    '@opencrane/event-store': { connectNats: connection, createEventStore, isEventStoreUnavailable },
    '@opencrane/handlers': { provisionDispatcher },
    '@opencrane/authz': {}, pg: { Pool },
    ...(readiness ? { 'node:timers/promises': { setTimeout: advanceClock } } : {}),
  };
  const file = 'infra/package/bootstrap.ts';
  const source = await readFile(file, 'utf8');
  const body = source.slice(0, source.indexOf('await main().catch('));
  const compiled = ts.transpileModule(
    `${body}\nexport { provisionEvents, bootstrapOwner, main };`,
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const exports = {} as Bootstrap;
  const nativeRequire = createRequire(resolve(file));
  function fixtureRequire(specifier: string) {
    return replacements[specifier] ?? nativeRequire(specifier);
  }
  runInNewContext(compiled.outputText, { exports, require: fixtureRequire,
    process: { env, execPath: process.execPath }, Buffer, console, Date: Clock, setTimeout });
  return { ...exports, files, actions };
}

for (const replicas of ['1', '3']) {
  async function carriesReplicaChoice() {
    const cluster = await clusterFixture();
    try {
      const env = { ...clusterSettings(cluster), NATS_REPLICAS: replicas,
        COMMAND_NATS_REPLICAS: replicas, PROJECTION_DATABASE_URL: 'postgres://fixture' };
      const bootstrap = await bootstrapFixture(env);
      await bootstrap.provisionEvents();
      const connection = await cluster.client(cluster.peers[0]!);
      const stream = await streamInfo(connection);
      expect(stream.config.num_replicas).toBe(Number(replicas));
      const accountReply = await connection.request('$JS.API.INFO');
      expect(accountReply.json<{ streams: number }>().streams).toBe(1);
      const consumerReply = await connection.request('$JS.API.CONSUMER.INFO.EVENTS.handler-dispatcher');
      const consumer = consumerReply.json<{ config: { num_replicas?: number };
        cluster?: { replicas?: unknown[] } }>();
      expect(consumer.config.num_replicas ?? 0).toBe(0);
      expect(consumer.cluster?.replicas?.length ?? 0).toBe(Number(replicas) - 1);
    } finally {
      await cluster.close();
    }
  }
  it(`bootstrap provisions R${replicas} and lets the dispatcher inherit it`, carriesReplicaChoice);

  async function keepsOwnerReplicaChoice() {
    const env = { NATS_URL: 'tls://nats:4222', NATS_CA_FILE: '/private/ca.crt',
      NATS_CERT_FILE: '/private/command.crt', NATS_KEY_FILE: '/private/command.key',
      NATS_NKEY_SEED_FILE: '/private/command.seed', NATS_INBOX_PREFIX: '_INBOX.command',
      NATS_REPLICAS: replicas, COMMAND_NATS_REPLICAS: replicas,
      PROJECTION_DATABASE_URL: 'postgres://fixture' };
    const bootstrap = await bootstrapFixture(env);
    await bootstrap.bootstrapOwner(binding);
    const settings = bootstrap.files.get('/tmp/package-bootstrap/command.env');
    expect(settings?.split('\n')).toContain(`NATS_REPLICAS=${replicas}`);
    expect(bootstrap.actions.at(-1)).toBe('owner command');
  }
  it(`owner bootstrap keeps R${replicas} in its executed private settings`, keepsOwnerReplicaChoice);
}

const invalidSettings = [
  [undefined, undefined], ['1', undefined], [undefined, '3'],
  ['', ''], ['2', '2'], ['5', '5'], ['03', '03'], ['private-canary', 'private-canary'],
  ['1', '3'], ['3', '1'],
];
for (const [runtime, command] of invalidSettings) {
  async function refusesBeforeWrites() {
    const bootstrap = await bootstrapFixture({ NATS_REPLICAS: runtime,
      COMMAND_NATS_REPLICAS: command });
    const expected = /^Invalid package NATS replica settings$/u;
    await expect(bootstrap.main()).rejects.toThrow(expected);
    await expect(bootstrap.provisionEvents()).rejects.toThrow(expected);
    await expect(bootstrap.bootstrapOwner(binding)).rejects.toThrow(expected);
    expect(bootstrap.actions).toEqual([]);
  }
  it(`bootstrap refuses invalid or conflicting settings ${runtime}/${command}`,
    refusesBeforeWrites);
}

async function preservesExistingStream() {
  const cluster = await clusterFixture();
  try {
    const connection = await cluster.client(cluster.peers[0]!);
    const store = await createEventStore(connection);
    await store.ensureStream({ replicas: 1 });
    const before = await streamInfo(connection);
    const bootstrap = await bootstrapFixture({ ...clusterSettings(cluster),
      NATS_REPLICAS: '3', COMMAND_NATS_REPLICAS: '3' });
    await expect(bootstrap.provisionEvents()).rejects.toThrow(/num_replicas/u);
    const after = await streamInfo(connection);
    expect(after.config).toEqual(before.config);
    expect(after.state).toEqual(before.state);
    expect(after.created).toEqual(before.created);
    expect(after.state.consumer_count).toBe(0);
    expect(bootstrap.files.size).toBe(0);
  } finally {
    await cluster.close();
  }
}
it('bootstrap refuses an existing R1 stream without changing it or adding a consumer',
  preservesExistingStream);

async function refusesWhenMetadataNeverBecomesReady() {
  const cluster = await clusterFixture();
  try {
    const readiness = { replies: [], elapsed: 0 };
    const bootstrap = await bootstrapFixture({ ...clusterSettings(cluster),
      NATS_REPLICAS: '3', COMMAND_NATS_REPLICAS: '3' }, readiness);
    await expect(bootstrap.provisionEvents()).rejects.toThrow(
      'JetStream did not become ready for R3 within 120000 ms');
    const connection = await cluster.client(cluster.peers[0]!);
    const reply = await connection.request('$JS.API.INFO');
    expect(reply.json<{ streams: number }>().streams).toBe(0);
    expect(bootstrap.files.size).toBe(0);
  } finally {
    await cluster.close();
  }
}
it('bootstrap refuses before creating a stream when metadata readiness expires',
  refusesWhenMetadataNeverBecomesReady);

function metadataReport(leader: string, current: boolean, offline = false) {
  const followers = [
    { name: 'peer-2', current, offline }, { name: 'peer-3', current, offline },
  ];
  return { server: { name: 'peer-1', cluster: 'route-tests' },
    data: { meta_cluster: { leader, replicas: followers } } };
}

async function preparePlacementStatistics(cluster: Awaited<ReturnType<typeof clusterFixture>>) {
  // Prepare real storage statistics before testing readiness with an injected clock.
  const connection = await cluster.client(cluster.peers[0]!);
  const store = await createEventStore(connection);
  await waitForClusterStream(store);
  const manager = await jetstreamManager(connection);
  await manager.streams.delete('EVENTS');
  const reply = await connection.request('$JS.API.INFO');
  expect(reply.json<{ streams: number }>().streams).toBe(0);
}

async function waitsUntilMetadataLeaderHasEnoughCurrentPeers() {
  const cluster = await clusterFixture();
  try {
    await preparePlacementStatistics(cluster);
    const noLeader = metadataReport('', true);
    const missingPeer = metadataReport('peer-1', true);
    missingPeer.data.meta_cluster.replicas.pop();
    const behind = metadataReport('peer-1', false);
    const offline = metadataReport('peer-1', true, true);
    const duplicate = metadataReport('peer-1', true);
    duplicate.data.meta_cluster.replicas[1] = duplicate.data.meta_cluster.replicas[0]!;
    const follower = metadataReport('peer-2', true);
    const ready = metadataReport('peer-1', true);
    const replies = [null, noLeader, missingPeer, behind, offline, duplicate, follower, ready];
    const readiness = { replies, elapsed: 0 };
    const bootstrap = await bootstrapFixture({ ...clusterSettings(cluster),
      NATS_REPLICAS: '3', COMMAND_NATS_REPLICAS: '3' }, readiness);
    await bootstrap.provisionEvents();
    const connection = await cluster.client(cluster.peers[0]!);
    const stream = await streamInfo(connection);
    expect(stream.config.num_replicas).toBe(3);
    expect(stream.state.consumer_count).toBe(1);
    expect(readiness.replies).toEqual([]);
    expect(readiness.elapsed).toBe(1400);
  } finally {
    await cluster.close();
  }
}
it('bootstrap waits for the metadata leader to report enough current online peers',
  waitsUntilMetadataLeaderHasEnoughCurrentPeers);

async function provisionsStandalone() {
  const fixture = await natsFixture();
  try {
    const bootstrap = await bootstrapFixture({ ...fixture.env(),
      NATS_REPLICAS: '1', COMMAND_NATS_REPLICAS: '1' });
    await bootstrap.provisionEvents();
    const stream = await streamInfo(fixture.connection);
    expect(stream.config.num_replicas).toBe(1);
    expect(stream.state.consumer_count).toBe(1);
  } finally {
    await fixture.close();
  }
}
it('bootstrap provisions a standalone R1 server without a metadata group', provisionsStandalone);

async function preservesReadinessRefusals() {
  const cluster = await clusterFixture();
  try {
    const failure = new Error('Monitoring access refused');
    const readiness = { replies: [], elapsed: 0, failure };
    const bootstrap = await bootstrapFixture({ ...clusterSettings(cluster),
      NATS_REPLICAS: '3', COMMAND_NATS_REPLICAS: '3' }, readiness);
    await expect(bootstrap.provisionEvents()).rejects.toBe(failure);
    const connection = await cluster.client(cluster.peers[0]!);
    const reply = await connection.request('$JS.API.INFO');
    expect(reply.json<{ streams: number }>().streams).toBe(0);
    expect(readiness.elapsed).toBe(0);
  } finally {
    await cluster.close();
  }
}
it('bootstrap preserves a readiness refusal without retrying or creating a stream',
  preservesReadinessRefusals);

const peerOffline = 'no suitable peers for placement, peer offline';

function placementRefusal() {
  return new JetStreamApiError({ code: 400, err_code: 10005, description: peerOffline });
}

async function provisionsAfterPlacementStatisticsArrive() {
  const cluster = await clusterFixture();
  try {
    await preparePlacementStatistics(cluster);
    const readiness = { replies: [metadataReport('peer-1', true)], elapsed: 0 };
    const placement = { failure: placementRefusal(), refusals: 2, attempts: 0 };
    const bootstrap = await bootstrapFixture({ ...clusterSettings(cluster),
      NATS_REPLICAS: '3', COMMAND_NATS_REPLICAS: '3' }, readiness, placement);
    await bootstrap.provisionEvents();
    const connection = await cluster.client(cluster.peers[0]!);
    const stream = await streamInfo(connection);
    expect(stream.config.num_replicas).toBe(3);
    expect(stream.state.consumer_count).toBe(1);
    expect(placement.attempts).toBe(3);
    expect(readiness.elapsed).toBe(400);
  } finally {
    await cluster.close();
  }
}
it('bootstrap creates R3 when a placement refusal clears before the deadline',
  provisionsAfterPlacementStatisticsArrive);

async function refusesPlacementAtTheOriginalDeadline() {
  const cluster = await clusterFixture();
  try {
    const replies: unknown[] = Array<null>(599).fill(null);
    replies.push(metadataReport('peer-1', true));
    const readiness = { replies, elapsed: 0 };
    const placement = { failure: placementRefusal(), refusals: Infinity, attempts: 0 };
    const bootstrap = await bootstrapFixture({ ...clusterSettings(cluster),
      NATS_REPLICAS: '3', COMMAND_NATS_REPLICAS: '3' }, readiness, placement);
    await expect(bootstrap.provisionEvents()).rejects.toThrow(
      'JetStream R3 stream placement refused within 120000 ms bootstrap deadline');
    expect(readiness.elapsed).toBe(120000);
    expect(placement.attempts).toBe(1);
    const connection = await cluster.client(cluster.peers[0]!);
    const reply = await connection.request('$JS.API.INFO');
    expect(reply.json<{ streams: number }>().streams).toBe(0);
    expect(bootstrap.files.size).toBe(0);
  } finally {
    await cluster.close();
  }
}
it('bootstrap refuses persistent placement failures at the original readiness deadline',
  refusesPlacementAtTheOriginalDeadline);

const creationFailures = [
  new Error(peerOffline),
  new Error('timeout'),
  new JetStreamApiError({ code: 403, err_code: 10005, description: peerOffline }),
  new JetStreamApiError({ code: 400, err_code: 10023, description: peerOffline }),
  new JetStreamApiError({ code: 503, err_code: 10008, description: 'JetStream unavailable' }),
  new JetStreamApiError({ code: 400, err_code: 10005,
    description: 'no suitable peers for placement, insufficient storage' }),
];

async function preservesOtherCreationFailures(failure: Error) {
  const cluster = await clusterFixture();
  try {
    const readiness = { replies: [metadataReport('peer-1', true)], elapsed: 0 };
    const placement = { failure, refusals: 1, attempts: 0 };
    const bootstrap = await bootstrapFixture({ ...clusterSettings(cluster),
      NATS_REPLICAS: '3', COMMAND_NATS_REPLICAS: '3' }, readiness, placement);
    await expect(bootstrap.provisionEvents()).rejects.toBe(failure);
    expect(placement.attempts).toBe(1);
    expect(readiness.elapsed).toBe(0);
    const connection = await cluster.client(cluster.peers[0]!);
    const reply = await connection.request('$JS.API.INFO');
    expect(reply.json<{ streams: number }>().streams).toBe(0);
  } finally {
    await cluster.close();
  }
}
it.each(creationFailures)('bootstrap preserves other creation failures without retry: %s',
  preservesOtherCreationFailures);

async function refusesR1PlacementWithoutRetry() {
  const fixture = await natsFixture({ provision: false });
  try {
    const readiness = { replies: [metadataReport('peer-1', true)], elapsed: 0 };
    const placement = { failure: placementRefusal(), refusals: 1, attempts: 0 };
    const bootstrap = await bootstrapFixture({ ...fixture.env(),
      NATS_REPLICAS: '1', COMMAND_NATS_REPLICAS: '1' }, readiness, placement);
    await expect(bootstrap.provisionEvents()).rejects.toBe(placement.failure);
    expect(placement.attempts).toBe(1);
    expect(readiness.elapsed).toBe(0);
    const reply = await fixture.connection.request('$JS.API.INFO');
    expect(reply.json<{ streams: number }>().streams).toBe(0);
  } finally {
    await fixture.close();
  }
}
it('bootstrap preserves an R1 placement refusal without retry', refusesR1PlacementWithoutRetry);
