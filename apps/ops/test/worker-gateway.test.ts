import { fork, type ForkOptions } from 'node:child_process';
import { once } from 'node:events';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { databases, until } from '@opencrane/authz/testing';
import { natsFixture, freePort } from '@opencrane/event-store/testing';
import { provisionDispatcher } from '@opencrane/handlers';
import { connectProjectionDb } from '@opencrane/projections';
import { catalogueDigest, toolReviewDigest } from '@opencrane/events/mcp-catalogue';
import { losslessJson } from '@opencrane/events/lossless-json';
import { envelope, gatewayDelivery, history, publicationEntry, readToolPolicy } from '@opencrane/models';
import { expect, it, onTestFinished } from 'vitest';
import { gatewayFixture } from '../../../libs/models/test/gateway-delivery-fixture.ts';
import { gatewayConfigurationSchema } from '@opencrane/events';

async function fixture(contentSetting?: string, pausePreparation = false) {
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
  const directory = await mkdtemp(`${tmpdir()}/worker-gateway-`);
  const keyOptions = { namedCurve: 'P-256', privateKeyEncoding: {
    type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } } as const;
  const key = generateKeyPairSync('ec', keyOptions);
  await writeFile(`${directory}/key.pem`, key.privateKey);
  const commandEnv: Record<string, string> = {};
  for (const [name, value] of Object.entries(nats.env())) {
    commandEnv[`COMMAND_${name}`] = value;
  }
  const env = { ...process.env, ...nats.env('dispatcher'), ...commandEnv,
    DATABASE_URL: jobsUrl, CONTENT_DATABASE_URL: contentSetting ?? readerUrl.href,
    SILO_ID: 'test', OPENFGA_API_URL: 'http://unused',
    OPENFGA_STORE_ID: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    OPENFGA_MODEL_ID: '01ARZ3NDEKTSV4RRFFQ69G5FAV', KUBECONFIG: '/unused',
    KUBE_NAMESPACE: 'test', TOKEN_SIGNING_KEY_FILE: `${directory}/key.pem`,
    TOKEN_ISSUER: 'https://test.example', LOG_LEVEL: 'info',
    WORKER_TEST_FAULT: pausePreparation ? 'preparation' : '',
    CONNECTION_CUSTODY_FILE: '', MEMORY_KEY_DIRECTORY: '', PERSONAL_KEY_DIRECTORY: '',
    MODEL_DECISION_URL: '', MCP_KUBE_NAMESPACE: '' };
  const preload = new URL('./support/worker-faults.ts', import.meta.url);
  const execArgv = ['--experimental-strip-types', '--experimental-test-module-mocks',
    '--import', preload.href];
  const options: ForkOptions = { env, execArgv, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] };
  await provisionDispatcher(nats.connection);
  const filename = new URL('../src/worker.ts', import.meta.url);
  const child = fork(filename, ['dispatcher'], options);
  const exited = once(child, 'exit');
  const preparing = Promise.withResolvers<void>();
  function message(value: unknown) {
    if (value === 'preparing') preparing.resolve();
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
    await nats.close();
    await rm(directory, { recursive: true, force: true });
  }
  onTestFinished(close);
  async function ready() {
    if (child.exitCode !== null) throw new Error(output);
    const result = await storage.queue.query("SELECT to_regclass('handler_dispatcher') AS name");
    return result.rows[0]?.['name'] !== null;
  }
  async function publish(serverId: string) {
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
    const event = envelope('test', `mcp-${serverId}`, 'mcp.server_published', intent);
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
  return { storage, content, readerUrl, nats, child, exited, ready, publish, waitingLocks,
    latest, logs, preparing: preparing.promise };
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
  expect((await setup.storage.queue.query("SELECT to_regclass('mcp_servers') AS name"))
    .rows[0]?.['name']).toBeNull();
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
  expect((await setup.storage.queue.query("SELECT to_regclass('handler_dispatcher') AS name"))
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
