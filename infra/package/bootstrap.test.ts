import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';
import { connectNats, createEventStore } from '@opencrane/event-store';
import { provisionDispatcher } from '@opencrane/handlers';
import { clusterFixture } from '../../libs/event-store/test/cluster-fixture.ts';

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

type ReadinessFixture = { replies: unknown[]; elapsed: number };

async function bootstrapFixture(env: NodeJS.ProcessEnv, readiness?: ReadinessFixture) {
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
          const reply = readiness!.replies.shift();
          return { json: () => reply } as Awaited<ReturnType<typeof connected.request>>;
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
    '@opencrane/event-store': { connectNats: connection, createEventStore },
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
