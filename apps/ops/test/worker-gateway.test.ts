import { fork, type ForkOptions } from 'node:child_process';
import { once } from 'node:events';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { databases, until } from '@opencrane/authz/testing';
import { natsFixture, freePort, tcpProxy } from '@opencrane/event-store/testing';
import { provisionDispatcher } from '@opencrane/handlers';
import { connectProjectionDb } from '@opencrane/projections';
import { catalogueDigest, toolReviewDigest } from '@opencrane/events/mcp-catalogue';
import { losslessJson } from '@opencrane/events/lossless-json';
import { envelope, gatewayDelivery, history, publicationEntry, readToolPolicy } from '@opencrane/models';
import { expect, it, onTestFinished } from 'vitest';
import { gatewayFixture } from '../../../libs/models/test/gateway-delivery-fixture.ts';
import { gatewayConfigurationSchema } from '@opencrane/events';

type PausedConnection = 'pull' | 'watcher';

async function fixture(contentSetting?: string, pausePreparation = false,
  pausedConnection?: PausedConnection) {
  const storage = await databases();
  const jobsUrl = storage.queue.options.connectionString!;
  const contentUrl = await storage.postgres();
  const content = connectProjectionDb(contentUrl, failed);
  function failed() {
    throw new Error('Fixture connection lost');
  }
  const role = `reader_${randomUUID().replaceAll('-', '')}`;
  await storage.queue.query(`CREATE ROLE ${role} LOGIN PASSWORD 'content-canary'`);
  const readerUrl = new URL(contentUrl);
  readerUrl.username = role;
  readerUrl.password = 'content-canary';
  const nats = await natsFixture();
  function natsAddress() {
    return { host: '127.0.0.1', port: Number(nats.env().NATS_URL.split(':')[1]) };
  }
  const proxy = pausedConnection ? await tcpProxy(natsAddress) : undefined;
  const directory = await mkdtemp(`${tmpdir()}/worker-gateway-`);
  const keyOptions = { namedCurve: 'P-256', privateKeyEncoding: {
    type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } } as const;
  const key = generateKeyPairSync('ec', keyOptions);
  await writeFile(`${directory}/key.pem`, key.privateKey);
  const commandEnv: Record<string, string> = {};
  for (const [name, value] of Object.entries(nats.env())) {
    commandEnv[`COMMAND_${name}`] = value;
  }
  if (proxy && pausedConnection === 'watcher') {
    commandEnv['COMMAND_NATS_URL'] = `127.0.0.1:${proxy.port}`;
  }
  const readinessFile = `${directory}/dispatcher-ready`;
  const recoveryFile = `${directory}/dispatcher-recovery`;
  const env = { ...process.env, ...nats.env('dispatcher'), ...commandEnv,
    DEV_DISPATCHER_READY_FILE: readinessFile,
    DEV_JETSTREAM_RECOVERY_FILE: recoveryFile,
    DATABASE_URL: jobsUrl, CONTENT_DATABASE_URL: contentSetting ?? readerUrl.href,
    SILO_ID: 'test', OPENFGA_API_URL: 'http://unused',
    OPENFGA_STORE_ID: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    OPENFGA_MODEL_ID: '01ARZ3NDEKTSV4RRFFQ69G5FAV', KUBECONFIG: '/unused',
    KUBE_NAMESPACE: 'test', TOKEN_SIGNING_KEY_FILE: `${directory}/key.pem`,
    TOKEN_ISSUER: 'https://test.example', LOG_LEVEL: 'info',
    WORKER_TEST_FAULT: pausePreparation ? 'preparation' : '',
    CONNECTION_CUSTODY_FILE: '', MEMORY_KEY_DIRECTORY: '', PERSONAL_KEY_DIRECTORY: '',
    MODEL_DECISION_URL: '', MCP_KUBE_NAMESPACE: '' };
  if (proxy && pausedConnection === 'pull') env.NATS_URL = `127.0.0.1:${proxy.port}`;
  if (pausedConnection === 'pull') env.WORKER_TEST_FAULT = 'pull';
  const preload = new URL('./support/worker-faults.ts', import.meta.url);
  const execArgv = ['--experimental-strip-types', '--experimental-test-module-mocks',
    '--import', preload.href];
  const options: ForkOptions = { env, execArgv, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] };
  await provisionDispatcher(nats.connection);
  const filename = new URL('../src/worker.ts', import.meta.url);
  const child = fork(filename, ['dispatcher'], options);
  const exited = once(child, 'exit');
  const preparing = Promise.withResolvers<void>();
  const pullInboxes: string[] = [];
  function message(value: unknown) {
    if (value === 'preparing') preparing.resolve();
    if (typeof value === 'object' && value !== null && 'pullInbox' in value &&
        typeof value.pullInbox === 'string') {
      pullInboxes.push(value.pullInbox);
    }
  }
  child.on('message', message);
  let output = '';
  function collect(chunk: Buffer) {
    output += chunk.toString();
  }
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);
  async function close() {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await exited;
    }
    await content.close();
    await storage.queue.query(`DROP ROLE ${role}`);
    await storage.close();
    await proxy?.close();
    await nats.close();
    await rm(directory, { recursive: true, force: true });
  }
  onTestFinished(close);
  async function ready() {
    if (child.exitCode !== null) throw new Error(output);
    const result = await storage.queue.query<{ name: string | null }>(
      "SELECT to_regclass('handler_dispatcher') AS name");
    return result.rows[0]?.['name'] !== null;
  }
  async function preparePublication(serverId: string) {
    const definition = '{"inputSchema":{"type":"object"},"name":"read"}';
    const tool = { name: 'read', definition, revision: losslessJson(definition).digest,
      reviewed: false, costCents: 0 };
    const now = Date.now();
    const catalogue = { serverId, connectionId: 'installed', accountMode: 'none',
      tools: [tool], toolCount: 1, schemaDigest: catalogueDigest([tool]),
      checkedAt: new Date(now).toISOString(), expiresAt: new Date(now + 300_000).toISOString() };
    await nats.seed([envelope('test', `mcp-${serverId}`, 'mcp.server_discovered', catalogue)]);
    const review = { serverId, connectionId: 'installed', accountMode: 'none',
      catalogueDigest: catalogue.schemaDigest, policyRevision: await nats.store.head(`mcp-${serverId}`),
      reviewedBy: 'admin', tools: [{ name: 'read', revision: tool.revision, mode: 'block',
        reviewDigest: toolReviewDigest(tool) }] };
    const reviewed = envelope('test', `mcp-${serverId}`, 'mcp.server_reviewed', review);
    reviewed.principal = { kind: 'human', id: 'admin' };
    await nats.seed([reviewed]);
    const policy = await readToolPolicy(nats.store, 'test', serverId);
    const encoded = JSON.stringify(publicationEntry(policy));
    const intent = { serverId, publishedBy: 'admin', commandId: `publish-${serverId}`,
      expectedSequence: policy.sequence, reviewRevision: policy.reviewRevision,
      fragmentDigest: losslessJson(encoded).digest };
    return envelope('test', `mcp-${serverId}`, 'mcp.server_published', intent);
  }
  async function publish(serverId: string) {
    const event = await preparePublication(serverId);
    await nats.seed([event]);
    return event;
  }
  async function waitingLocks() {
    const result = await content.db.query<{ count: number }>(`SELECT count(*)::int AS count
      FROM pg_locks WHERE locktype = 'advisory' AND NOT granted
      AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`);
    return result.rows[0]!.count;
  }
  async function latest() {
    const rows = await history(nats.store, 'gateway-config-test', 'test');
    for (const row of rows.reverse()) {
      if (row.event.type === 'gateway.configuration_requested') {
        return gatewayConfigurationSchema.parse(row.event.data);
      }
    }
    return null;
  }
  function logs() {
    return output;
  }
  function pauseResponses(paused: boolean) {
    if (!proxy) throw new Error('This fixture has no isolated NATS connection');
    proxy.pauseResponses(paused);
  }
  return { storage, content, readerUrl, nats, child, exited, ready, publish, preparePublication,
    waitingLocks, latest, logs, preparing: preparing.promise, pauseResponses, readinessFile,
    recoveryFile, proxy, pullInboxes };
}

async function sharedLock(preparationFirst: boolean) {
  const setup = await fixture(undefined, preparationFirst);
  await until(setup.ready);
  await setup.publish('alpha');
  async function firstGeneration() {
    return (await setup.latest())?.generation === 1;
  }
  await until(firstGeneration);
  const record = (await setup.latest())!;
  const gateway = await gatewayFixture();
  const deliveryDb = connectProjectionDb(setup.readerUrl.href, connectionFailed);
  function connectionFailed() {
    throw new Error('Delivery connection lost');
  }
  onTestFinished(deliveryDb.close);
  const held = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  let leadershipChecks = 0;
  async function requireLeader() {
    leadershipChecks++;
    if (!preparationFirst && leadershipChecks === 2) {
      entered.resolve();
      await held.promise;
    }
    await deliveryDb.db.query('SELECT 1');
  }
  const delivery = gatewayDelivery({ store: setup.nats.store, db: deliveryDb.db, silo: 'test',
    child: gateway.child, configFile: gateway.options.configFile, settings: gateway.options,
    mode: 'live', controlPort: await freePort(), requireLeader });
  const before = await readFile(gateway.options.configFile);
  if (preparationFirst) {
    await setup.publish('bravo');
    await setup.preparing;
  }
  function outcome(error: unknown) {
    return error;
  }
  const replacing = delivery.deliver(record).catch(outcome);
  try {
    if (!preparationFirst) {
      await entered.promise;
      await setup.publish('bravo');
    }
    await expect.poll(setup.waitingLocks, { timeout: 5000 }).toBe(1);
    expect((await setup.latest())?.generation).toBe(1);
    expect(await readFile(gateway.options.configFile)).toEqual(before);
  } finally {
    held.resolve();
    if (preparationFirst) setup.child.send('release-preparation');
    await replacing;
  }
  if (preparationFirst) {
    expect(await replacing).toBeInstanceOf(Error);
    expect(await readFile(gateway.options.configFile)).toEqual(before);
    expect(await delivery.observe()).toBeNull();
  } else {
    expect(await replacing).toBeUndefined();
  }
  async function secondGeneration() {
    return (await setup.latest())?.generation === 2;
  }
  await until(secondGeneration);
  const tables = await setup.storage.queue.query(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename");
  expect(tables.rows).toEqual([
    { tablename: 'handler_dispatcher' }, { tablename: 'handler_receipts' },
  ]);
  expect((await setup.content.db.query("SELECT to_regclass('handler_dispatcher') AS name"))
    .rows[0]?.['name']).toBeNull();
  expect((await setup.storage.queue.query('SELECT * FROM pgboss.job')).rows.length).toBeGreaterThan(0);
  expect(setup.logs()).not.toContain(setup.readerUrl.href);
  expect(setup.logs()).not.toContain('content-canary');
}
it.each([false, true])('shares the production content lock; preparation first: %s', sharedLock);

async function refusesConfiguration(value: string) {
  const setup = await fixture(value);
  function stopped() {
    return setup.child.exitCode !== null;
  }
  await until(stopped, 5000);
  await setup.exited;
  expect(setup.child.exitCode).toBe(1);
  expect(setup.logs()).toContain('CONTENT_DATABASE_URL');
  expect(setup.logs()).not.toContain('private-canary');
  expect((await setup.storage.queue.query<{ name: string | null }>(
      "SELECT to_regclass('handler_dispatcher') AS name"))
    .rows[0]?.['name']).toBeNull();
}
it.each(['', 'https://private-canary.invalid/content', 'postgres://user:private-canary@%',
  'postgres://user:private-canary@127.0.0.1:1/content'])(
  'refuses missing, malformed or unavailable content configuration: %s', refusesConfiguration);

async function lostContent() {
  const setup = await fixture();
  await until(setup.ready);
  const killed = await setup.content.db.query(`SELECT pg_terminate_backend(pid)
    FROM pg_stat_activity WHERE usename = $1`, [setup.readerUrl.username]);
  expect(killed.rows.length).toBeGreaterThan(0);
  function stopped() {
    return setup.child.exitCode !== null;
  }
  await until(stopped, 5000);
  await setup.exited;
  expect(setup.child.exitCode).toBe(1);
  await setup.publish('alpha');
  expect(await setup.latest()).toBeNull();
  expect(await history(setup.nats.store, 'gateway-config-test', 'test')).toEqual([]);
  expect((await setup.storage.queue.query('SELECT * FROM handler_receipts')).rows).toEqual([]);
  expect(setup.logs()).not.toContain('content-canary');
}
it('stops without publishing or acknowledging when the content connection is lost', lostContent);

async function lostConnectionWithQueuedPublication() {
  const setup = await fixture();
  await until(setup.ready);
  const held = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  async function holdDeliveryLock() {
    entered.resolve();
    await held.promise;
  }
  const replacement = setup.content.db.lock!('gateway-configuration:test', holdDeliveryLock);
  await entered.promise;
  try {
    const event = await setup.publish('alpha');
    await expect.poll(setup.waitingLocks, { timeout: 5000 }).toBe(1);
    const database = setup.readerUrl.pathname.slice(1);
    await setup.storage.queue.query(`ALTER DATABASE ${database} ALLOW_CONNECTIONS false`);
    await setup.content.db.query(`SELECT pg_terminate_backend(pid)
      FROM pg_stat_activity WHERE usename = $1`, [setup.readerUrl.username]);
    async function unfinishedJob() {
      const result = await setup.storage.queue.query<{ state: string }>(
        'SELECT state FROM pgboss.job WHERE name = $1', ['prepare-gateway-configuration']);
      return result.rows[0]?.state;
    }
    await expect.poll(unfinishedJob, { timeout: 5000 }).toBe('retry');
    expect(await setup.latest()).toBeNull();
    const receipts = await setup.storage.queue.query(
      'SELECT * FROM handler_receipts WHERE event_id = $1', [event.id]);
    expect(receipts.rows).toEqual([]);
    expect(setup.logs()).not.toContain(setup.readerUrl.href);
    expect(setup.logs()).not.toContain('content-canary');
  } finally {
    held.resolve();
    await replacement;
    setup.child.kill('SIGTERM');
    await setup.exited;
  }
}
it('keeps a queued publication unfinished when its content lock connection is lost',
  lostConnectionWithQueuedPublication);

type WorkerFixture = Awaited<ReturnType<typeof fixture>>;

async function waitForWorker(setup: WorkerFixture) {
  async function markedReady() {
    if (setup.child.exitCode !== null) throw new Error(setup.logs());
    try {
      return (await readFile(setup.readinessFile, 'utf8')) === String(setup.child.pid);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      return false;
    }
  }
  await until(markedReady);
}

async function waitForLog(setup: WorkerFixture, message: string) {
  function logged() {
    if (setup.child.exitCode !== null) throw new Error(setup.logs());
    return setup.logs().includes(message);
  }
  await until(logged);
}

async function waitForGeneration(setup: WorkerFixture, generation: number) {
  async function saved() {
    if (setup.child.exitCode !== null) throw new Error(setup.logs());
    return (await setup.latest())?.generation === generation;
  }
  await until(saved);
}

async function checkpoint(setup: WorkerFixture) {
  const result = await setup.storage.queue.query<{ sequence: string }>(
    'SELECT sequence FROM handler_dispatcher',
  );
  return Number(result.rows[0]?.sequence);
}

async function recoversPull() {
  const setup = await fixture(undefined, false, 'pull');
  await waitForWorker(setup);
  async function waitingForPublication() {
    const info = await setup.nats.dispatcherInfo();
    return info.ack_floor.stream_seq === 6 && info.num_waiting === 1;
  }
  const first = await setup.publish('alpha');
  await waitForGeneration(setup, 1);
  const second = await setup.preparePublication('bravo');
  await until(waitingForPublication);
  expect(await checkpoint(setup)).toBe(6);

  setup.pauseResponses(true);
  await setup.nats.seed([second]);
  await waitForLog(setup, 'Retrying dispatcher pull after JetStream failure');
  expect(setup.logs()).toContain('heartbeats missed');
  expect(await readFile(setup.recoveryFile, 'utf8')).toContain('dispatcher pull: retrying');
  expect(await checkpoint(setup)).toBe(6);
  const interrupted = await setup.nats.dispatcherInfo();
  expect(interrupted.ack_floor.stream_seq).toBe(6);
  expect(interrupted.delivered.stream_seq).toBe(7);
  expect(interrupted.num_ack_pending).toBe(1);
  setup.pauseResponses(false);

  await waitForGeneration(setup, 2);
  async function caughtUp() {
    const info = await setup.nats.dispatcherInfo();
    return info.ack_floor.stream_seq === 8 && info.num_ack_pending === 0;
  }
  await until(caughtUp);
  const acknowledged = await setup.nats.dispatcherInfo();
  // The consumer counted the interrupted delivery as well as each acknowledged event.
  expect(acknowledged.ack_floor.consumer_seq).toBeGreaterThan(8);
  expect(await setup.nats.store.head()).toBe(8);
  expect(await checkpoint(setup)).toBe(8);
  const effects = await history(setup.nats.store, 'gateway-config-test', 'test');
  expect(effects).toHaveLength(2);
  expect(effects.map(({ sequence }) => sequence)).toEqual([4, 8]);
  const receipts = await setup.storage.queue.query<{ event_id: string }>(
    `SELECT event_id FROM handler_receipts WHERE handler = 'prepare-gateway-configuration'`,
  );
  expect(receipts.rows).toHaveLength(2);
  expect(receipts.rows).toEqual(expect.arrayContaining([
    { event_id: first.id }, { event_id: second.id },
  ]));
  expect(await readFile(setup.readinessFile, 'utf8')).toBe(String(setup.child.pid));
  expect(await readFile(setup.recoveryFile, 'utf8')).toContain('dispatcher pull: recovered');
}
it('resumes the same durable pull after missed heartbeats and applies each event once',
  recoversPull);

async function recoversWatcher() {
  const setup = await fixture(undefined, false, 'watcher');
  await waitForWorker(setup);
  setup.pauseResponses(true);
  await waitForLog(setup, 'Retrying computer watcher read after JetStream failure');
  setup.pauseResponses(false);
  await waitForLog(setup, 'Computer watcher read recovered');
  expect(await readFile(setup.recoveryFile, 'utf8')).toContain('computer watcher read: recovered');
  await setup.publish('alpha');
  await waitForGeneration(setup, 1);
  expect(await readFile(setup.readinessFile, 'utf8')).toBe(String(setup.child.pid));
}
it('keeps the worker running when the computer watcher times out reading stream info',
  recoversWatcher);

async function stopsAfterPersistentFailure() {
  const setup = await fixture(undefined, false, 'pull');
  await waitForWorker(setup);
  setup.pauseResponses(true);
  function stopped() {
    return setup.child.exitCode !== null;
  }
  await until(stopped, 15_000);
  await setup.exited;
  expect(setup.child.exitCode).toBe(1);
  expect(setup.logs()).toContain('Dispatcher pull recovery exhausted');
  expect(setup.logs()).toContain('heartbeats missed');
  const attempts = setup.logs().match(/Retrying dispatcher pull after JetStream failure/g);
  expect(attempts).toHaveLength(4);
  await expect(readFile(setup.readinessFile)).rejects.toThrow('ENOENT');
  expect(await readFile(setup.recoveryFile, 'utf8')).toContain('dispatcher pull: exhausted');
  expect(await checkpoint(setup)).toBe(0);
}
it('stops with a failed exit and withdraws readiness after persistent pull failure',
  stopsAfterPersistentFailure);

async function stopsAfterServerLoss() {
  const setup = await fixture();
  await waitForWorker(setup);
  await setup.nats.stop();
  function stopped() {
    return setup.child.exitCode !== null;
  }
  await until(stopped, 15_000);
  await setup.exited;
  expect(setup.child.exitCode).toBe(1);
  expect(setup.logs()).toMatch(/(Dispatcher pull|Computer watcher read) recovery exhausted/);
  await expect(readFile(setup.readinessFile)).rejects.toThrow('ENOENT');
}
it('stops when the NATS server disappears and does not come back', stopsAfterServerLoss);

async function pendingPublication(setup: WorkerFixture) {
  const first = await setup.publish('alpha');
  await waitForGeneration(setup, 1);
  const second = await setup.preparePublication('bravo');
  async function waiting() {
    const info = await setup.nats.dispatcherInfo();
    return info.ack_floor.stream_seq === 6 && info.num_waiting === 1;
  }
  await until(waiting);
  expect(await checkpoint(setup)).toBe(6);
  return { first, second };
}

async function expectBothPublications(setup: WorkerFixture, eventIds: string[]) {
  await waitForGeneration(setup, 2);
  async function caughtUp() {
    const info = await setup.nats.dispatcherInfo();
    return info.ack_floor.stream_seq === 8 && info.num_ack_pending === 0;
  }
  await until(caughtUp);
  expect(await checkpoint(setup)).toBe(8);
  expect(await setup.nats.store.head()).toBe(8);
  const effects = await history(setup.nats.store, 'gateway-config-test', 'test');
  function position(effect: { sequence: number }) {
    return effect.sequence;
  }
  expect(effects.map(position)).toEqual([4, 8]);
  const receipts = await setup.storage.queue.query<{ event_id: string }>(
    `SELECT event_id FROM handler_receipts WHERE handler = 'prepare-gateway-configuration'`,
  );
  function eventId(receipt: { event_id: string }) {
    return receipt.event_id;
  }
  const receivedIds = receipts.rows.map(eventId);
  expect(receivedIds.sort()).toEqual(eventIds.sort());
  expect(await readFile(setup.readinessFile, 'utf8')).toBe(String(setup.child.pid));
}

async function resumesAfterSocketDrop() {
  const setup = await fixture(undefined, false, 'pull');
  await waitForWorker(setup);
  const { first, second } = await pendingPublication(setup);
  setup.pauseResponses(true);
  await setup.nats.seed([second]);
  async function delivered() {
    return (await setup.nats.dispatcherInfo()).delivered.stream_seq === 7;
  }
  await until(delivered);
  setup.proxy!.dropConnections();
  setup.pauseResponses(false);
  expect(await checkpoint(setup)).toBe(6);
  await waitForLog(setup, 'Retrying dispatcher pull after JetStream failure');
  await expectBothPublications(setup, [first.id, second.id]);
  expect(setup.logs()).toContain('Dispatcher pull recovered');
  const acknowledged = await setup.nats.dispatcherInfo();
  expect(acknowledged.ack_floor.consumer_seq).toBeGreaterThan(8);
}
it('closes a pull interrupted by a dropped socket and resumes from the durable position',
  resumesAfterSocketDrop);

async function exhaustsSocketDrops() {
  const setup = await fixture(undefined, false, 'pull');
  await waitForWorker(setup);
  for (let index = 0; index < 5; index++) {
    function pulled() {
      return setup.pullInboxes.length > index;
    }
    await until(pulled);
    setup.proxy!.dropConnections();
  }
  await expect.poll(() => setup.child.exitCode, { timeout: 3000 }).toBe(1);
  expect(new Set(setup.pullInboxes).size).toBe(5);
  expect(setup.logs()).toContain('Dispatcher pull recovery exhausted');
  expect(setup.logs().match(/Retrying dispatcher pull after JetStream failure/g)).toHaveLength(4);
  await expect(readFile(setup.readinessFile)).rejects.toThrow('ENOENT');
  expect(await readFile(setup.recoveryFile, 'utf8')).toContain('dispatcher pull: exhausted');
  expect(await checkpoint(setup)).toBe(0);
  expect((await setup.nats.dispatcherInfo()).ack_floor.stream_seq).toBe(0);
}
it('charges repeated socket drops to the pull budget and withdraws readiness', exhaustsSocketDrops);

async function resumesAfterUncertainAck(delivered: boolean) {
  const setup = await fixture(undefined, false, 'pull');
  await waitForWorker(setup);
  const { first, second } = await pendingPublication(setup);
  const lock = await setup.storage.queue.connect();
  try {
    await lock.query('BEGIN');
    await lock.query('SELECT id FROM handler_dispatcher FOR UPDATE');
    await setup.nats.seed([second]);
    async function dispatchIsWaitingForCommit() {
      const waiting = await setup.storage.queue.query(`SELECT pid FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'
          AND query LIKE 'SELECT silo, manifest, sequence%FOR UPDATE'`);
      return waiting.rows.length === 1;
    }
    await until(dispatchIsWaitingForCommit);
    if (delivered) setup.pauseResponses(true);
    else setup.proxy!.pauseRequests();
  } finally {
    await lock.query('ROLLBACK');
    lock.release();
  }
  async function committed() {
    return (await checkpoint(setup)) === 7;
  }
  await until(committed);
  if (delivered) {
    async function acknowledged() {
      return (await setup.nats.dispatcherInfo()).ack_floor.stream_seq === 7;
    }
    await until(acknowledged);
  }
  const interrupted = await setup.nats.dispatcherInfo();
  expect(interrupted.ack_floor.stream_seq).toBe(delivered ? 7 : 6);
  await waitForLog(setup, 'Retrying dispatcher acknowledgement after JetStream failure');
  // Discard the withheld bytes. A fresh connection cannot receive the original reply.
  setup.proxy!.dropConnections();
  setup.pauseResponses(false);
  await expectBothPublications(setup, [first.id, second.id]);
  expect(setup.logs()).toContain('Dispatcher acknowledgement recovered');
}
it.each([true, false])('resumes after a lost acknowledgement reply, broker acknowledged: %s',
  resumesAfterUncertainAck);

const changedCheckpoints = [
  ['silo', "UPDATE handler_dispatcher SET silo = 'another-silo'",
    'Dispatcher state changed during dispatch', [{ sequence: '6' }]],
  ['manifest', "UPDATE handler_dispatcher SET manifest = 'changed'",
    'Dispatcher state changed during dispatch', [{ sequence: '6' }]],
  ['row', 'DELETE FROM handler_dispatcher', 'Dispatcher state changed during dispatch', []],
  ['sequence', 'UPDATE handler_dispatcher SET sequence = 5',
    'Dispatcher event sequence gap', [{ sequence: '5' }]],
] as const;

async function refusesChangedCheckpoint(
  _change: string, mutation: string, reason: string, expectedRows: readonly { sequence: string }[],
) {
  const setup = await fixture();
  await waitForWorker(setup);
  const { second } = await pendingPublication(setup);
  await setup.storage.queue.query(mutation);
  await setup.nats.seed([second]);
  await expect.poll(() => setup.child.exitCode, { timeout: 3000 }).toBe(1);
  expect(setup.logs()).toContain(reason);
  const rows = await setup.storage.queue.query('SELECT sequence FROM handler_dispatcher');
  expect(rows.rows).toEqual(expectedRows);
  const info = await setup.nats.dispatcherInfo();
  expect(info.delivered.stream_seq).toBe(7);
  expect(info.ack_floor.stream_seq).toBe(6);
  expect((await setup.latest())?.generation).toBe(1);
  await expect(readFile(setup.readinessFile)).rejects.toThrow('ENOENT');
}
it.each(changedCheckpoints)('refuses a changed checkpoint %s after readiness',
  refusesChangedCheckpoint);

async function diagnosesSignalledExit() {
  const setup = await fixture();
  await waitForWorker(setup);
  setup.child.kill('SIGKILL');
  await setup.exited;
  await expect(waitForWorker(setup)).rejects.toThrow('Dispatcher exited with signal SIGKILL');
}
it('reports a signalled worker exit when polling readiness', diagnosesSignalledExit);
