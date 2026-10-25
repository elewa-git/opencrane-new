import { connectionCustody } from '../../../../libs/models/src/connection-custody.ts';
import { randomUUID } from 'node:crypto';
import { databases } from '@opencrane/authz/testing';
import { natsFixture } from '@opencrane/event-store/testing';
import * as projections from '@opencrane/projections';
import * as handlers from '@opencrane/handlers';
import * as models from '@opencrane/models';
import { createLogger } from '@opencrane/observability';
import { PgBoss, TestClock } from 'pg-boss';
import { onTestFinished, vi } from 'vitest';
import { scheduleNightly } from '../../../../libs/handlers/src/queue.ts';
import { scanNightlyMemory } from '../../src/nightly-memory.ts';

export async function reactionWorker(pauseHandlers = false) {
  const storage = await databases();
  const contentUrl = await storage.postgres();
  const content = projections.connectProjectionDb(contentUrl, connectionFailed);
  function connectionFailed() {
    throw new Error('Fixture connection lost');
  }
  const role = `reader_${randomUUID().replaceAll('-', '')}`;
  await storage.queue.query(`CREATE ROLE ${role} LOGIN PASSWORD 'synthetic-reader'`);
  const readerUrl = new URL(contentUrl);
  readerUrl.username = role;
  readerUrl.password = 'synthetic-reader';
  const reader = projections.connectProjectionDb(readerUrl.href, connectionFailed);
  const nats = await natsFixture();
  const clock = new TestClock('2026-10-12T02:00:00Z');
  const loggerOptions = { level: 'silent' };
  const logger = createLogger('reaction-worker-test', loggerOptions);
  const keyring = { currentKeyId: 'test', keys: { test: Buffer.alloc(32) } };
  const custody = connectionCustody('http://127.0.0.1:1', 'test', keyring, '/unused');
  const candidates = vi.spyOn(custody, 'candidates');
  const emptyPage = { status: 'listed' as const, stages: [], continuation: undefined };
  candidates.mockResolvedValue(emptyPage);
  const recover = vi.spyOn(custody, 'recover');
  const remove = vi.spyOn(custody, 'remove');
  const ordering: string[] = [];
  let boss: PgBoss;
  let ready = Promise.withResolvers<void>();
  let running: Promise<unknown> | undefined;
  let workerContent: ReturnType<typeof projections.connectProjectionDb>;
  let scan: (occurrence: Date) => Promise<void>;
  const previousExitCode = process.exitCode;
  const previousArguments = process.argv;
  const signalListeners = new Map([
    ['SIGINT' as const, process.listeners('SIGINT')],
    ['SIGTERM' as const, process.listeners('SIGTERM')],
  ]);

  function connect(url: string, failed: () => void) {
    const connected = projections.connectProjectionDb(url, failed);
    if (url === readerUrl.href) {
      workerContent = connected;
    }
    async function close() {
      ordering.push(url === readerUrl.href ? 'content-close' : 'jobs-close');
      await connected.close();
    }
    return { ...connected, close };
  }
  function selectionTime() {
    return new Date(clock.now());
  }
  async function timedScan(...args: Parameters<typeof scanNightlyMemory>) {
    await scanNightlyMemory(args[0], args[1], args[2], args[3], selectionTime);
  }
  // Replace the wall clock only; keep the real queue, callback and failed-trigger recovery.
  class Runtime extends handlers.HandlerRuntime {
    override async work(concurrency = 4) {
      if (!pauseHandlers) await super.work(concurrency);
    }
    override async startNightly(callback: (occurrence: Date) => Promise<void>) {
      scan = callback;
      const options = { connectionString: storage.queue.options.connectionString!,
        clock, schedule: false };
      boss = new PgBoss(options);
      await boss.start();
      await scheduleNightly(boss, 'test', callback);
      ready.resolve();
    }
    override async stop() {
      await boss?.stop();
      await super.stop();
      ordering.push('runtime-stopped');
    }
  }
  async function watch(...args: Parameters<typeof import('../../src/lifecycle.ts').watchComputers>) {
    const signal = args[6];
    await new Promise<void>(wait);
    function wait(resolve: () => void) {
      if (signal.aborted) {
        resolve();
      } else {
        signal.addEventListener('abort', resolve, { once: true });
      }
    }
    ordering.push('watcher-stopped');
  }
  function loadCustody() {
    return Promise.resolve(custody);
  }
  function issuer() {
    const tokens = { jwks: { keys: [] } };
    return Promise.resolve(tokens);
  }
  const projectionExports = { ...projections, connectProjectionDb: connect };
  const handlerExports = { ...handlers, HandlerRuntime: Runtime };
  const modelExports = { ...models, connectionCustodyFromFile: loadCustody };
  function projectionModule() {
    return projectionExports;
  }
  function handlerModule() {
    return handlerExports;
  }
  function modelModule() {
    return modelExports;
  }
  function nightlyModule() {
    return { scanNightlyMemory: timedScan };
  }
  async function lifecycleModule() {
    const original = await vi.importActual<typeof import('../../src/lifecycle.ts')>(
      '../../src/lifecycle.ts');
    return { ...original, watchComputers: watch };
  }
  async function authModule() {
    const original = await vi.importActual<typeof import('@opencrane/auth')>('@opencrane/auth');
    return { ...original, tokenIssuer: issuer };
  }
  vi.doMock('@opencrane/projections', projectionModule);
  vi.doMock('@opencrane/handlers', handlerModule);
  vi.doMock('@opencrane/models', modelModule);
  vi.doMock('../../src/nightly-memory.ts', nightlyModule);
  vi.doMock('../../src/lifecycle.ts', lifecycleModule);
  vi.doMock('@opencrane/auth', authModule);
  for (const [name, value] of Object.entries(nats.env('dispatcher'))) {
    vi.stubEnv(name, value);
  }
  for (const [name, value] of Object.entries(nats.env())) {
    vi.stubEnv(`COMMAND_${name}`, value);
  }
  const settings = { DATABASE_URL: storage.queue.options.connectionString!,
    CONTENT_DATABASE_URL: readerUrl.href, SILO_ID: 'test', OPENFGA_API_URL: 'http://unused',
    OPENFGA_STORE_ID: '01ARZ3NDEKTSV4RRFFQ69G5FAV', OPENFGA_MODEL_ID: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    KUBECONFIG: '/unused', KUBE_NAMESPACE: 'test', TOKEN_SIGNING_KEY_FILE: '/unused',
    TOKEN_ISSUER: 'https://test.example', CONNECTION_CUSTODY_FILE: '/synthetic',
    PERSONAL_KEY_DIRECTORY: '', MEMORY_KEY_DIRECTORY: '', MODEL_DECISION_URL: '',
    MCP_KUBE_NAMESPACE: '' };
  for (const [name, value] of Object.entries(settings)) {
    vi.stubEnv(name, value);
  }
  process.argv = [process.execPath, 'worker.ts', 'dispatcher'];
  await handlers.provisionDispatcher(nats.connection);
  async function start() {
    vi.resetModules();
    ready = Promise.withResolvers<void>();
    running = import('../../src/worker.ts');
    await Promise.race([ready.promise, running]);
  }
  async function stop() {
    if (!running) {
      return;
    }
    const previous = signalListeners.get('SIGTERM')!;
    for (const listener of process.listeners('SIGTERM')) {
      if (!previous.includes(listener)) {
        listener('SIGTERM');
      }
    }
    await running;
    running = undefined;
    for (const [signal, previous] of signalListeners) {
      for (const listener of process.listeners(signal)) {
        if (!previous.includes(listener)) {
          process.removeListener(signal, listener);
        }
      }
    }
  }
  async function close() {
    await stop();
    vi.doUnmock('@opencrane/projections');
    vi.doUnmock('@opencrane/handlers');
    vi.doUnmock('@opencrane/models');
    vi.doUnmock('../../src/nightly-memory.ts');
    vi.doUnmock('../../src/lifecycle.ts');
    vi.doUnmock('@opencrane/auth');
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    process.argv = previousArguments;
    process.exitCode = previousExitCode;
    await reader.close();
    await content.db.query(`DROP OWNED BY ${role}`);
    await content.close();
    await storage.queue.query(`DROP ROLE ${role}`);
    await storage.close();
    await nats.close();
  }
  onTestFinished(close);
  async function grantReads() {
    await content.db.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${role}`);
  }
  async function loseContent() {
    const identity = await workerContent.db.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    await content.db.query('SELECT pg_terminate_backend($1)', [identity.rows[0]!.pid]);
    await running;
  }
  return { storage, content, reader, nats, logger, clock, custody, candidates, recover, remove,
    ordering, start, stop, grantReads,
    resumeHandlers() {
      pauseHandlers = false;
    },
    scan(occurrence: Date) {
      return scan(occurrence);
    },
    boss() {
      return boss;
    },
    loseContent };
}
