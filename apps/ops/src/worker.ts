import { scanConnections, connectionCleanupHandler, connectionCustodyFromFile,
  budgets, ownershipSeedHandler, ownershipConfirmationHandler, settlementHandler, modelGrantHandler,
  providerDefaultHandler, initialiseBudgetProjection, budgetStopHandler } from '@opencrane/models';
import { setTimeout as delay } from 'node:timers/promises';
import { connectNats, createEventStore } from '@opencrane/event-store';
import { connectEventStore, type EventStore } from '@opencrane/event-store';
import { connectProjectionDb, ProjectionRunner, auditTrail, groups, providers, members,
  mcpCatalogue, computers, modelAccess, egressPolicy, delegations, routines,
  conversations, childRequests, files, personalSettings, conversationKeys, memoryKeys,
  memoryProjection,
  type Projection, type Db,
} from '@opencrane/projections';
import { dispatch, HandlerRuntime } from '@opencrane/handlers';
import { memberAuthorisation } from '@opencrane/authz';
import { tokenIssuer } from '@opencrane/auth';
import { createLogger } from '@opencrane/observability';
import { scanNightlyMemory } from './nightly-memory.ts';
import { SandboxClient } from './kubernetes.ts';
import { lifecycleHandlers, watchComputers } from './lifecycle.ts';
import { personalKeyHandler } from './personal-keys.ts';
import { departureCleanupHandler } from './departure-cleanup.ts';
import { memoryCleanupHandler, recoverMemoryCleanup } from './memory-cleanup.ts';
import { McpKubernetes } from './mcp-kubernetes.ts';
import { prepareGatewayConfigurationHandler } from './gateway-configuration.ts';
import { stopMcpInstanceHandler } from './mcp-stop.ts';
import { dispatcherHandlerNames } from './dispatcher-handlers.ts';
import type { Handler } from '@opencrane/handlers';
import type { HandlerName } from '@opencrane/events';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
const mode = process.argv[2];
const modes = ['members', 'mcp-catalogue', 'computers', 'dispatcher', 'budgets',
  'conversations', 'audit', 'files', 'memory', 'delegations', 'routines'];
if (!modes.includes(mode ?? '')) {
  throw new Error(
    `Expected one of: ${modes.join(', ')}`,
  );
}
const logger = createLogger(`worker-${mode}`);
function workerProjection() {
  if (mode === 'memory') {
    const directory = process.env['MEMORY_KEY_DIRECTORY']?.trim();
    if (!directory) {
      logger.warn('Memory reads unavailable: MEMORY_KEY_DIRECTORY is not configured');
      return undefined;
    }
    const keys = memoryKeys(directory);
    const custody = { decrypt: keys.decrypt };
    return memoryProjection(custody);
  }
  const projections: Record<string, Projection> = {
    files, audit: auditTrail, conversations, members, budgets, delegations, routines,
    computers, 'mcp-catalogue': mcpCatalogue,
  };
  if (!mode) {
    return undefined;
  }
  return projections[mode];
}
const stop = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => stop.abort());
const db = connectProjectionDb(required('DATABASE_URL'), (error) => {
  logger.error({ err: error }, 'Worker database connection failed');
  process.exitCode = 1;
  stop.abort();
});
let connection: Awaited<ReturnType<typeof connectNats>> | undefined;
let content: ReturnType<typeof connectProjectionDb> | undefined;
let runtime: HandlerRuntime | undefined;
let commands: Awaited<ReturnType<typeof connectEventStore>> | undefined;
let watcher: Promise<void> | undefined;
let connectionScan: Promise<void> | undefined;
async function runProjectionWorker(projection: Projection, store: EventStore) {
  const runner = new ProjectionRunner(db.db, store, logger);
  // Hold the database lock while creating shared tables. Other workers may start together.
  async function initialiseProjection(locked: Db) {
    const lockedRunner = new ProjectionRunner(locked, store, logger);
    await lockedRunner.initialise(projection);
  }
  await db.db.lock!('initialise', initialiseProjection);
  async function initialiseGroups(locked: Db) {
    const groupRunner = new ProjectionRunner(locked, store, logger);
    await groupRunner.initialise(personalSettings);
    await groupRunner.initialise(groups);
    await groupRunner.initialise(providers);
    await groupRunner.initialise(modelAccess);
    await groupRunner.initialise(egressPolicy);
  }
  if (mode === 'members') {
    await db.db.lock!('initialise', initialiseGroups);
  }
  if (mode === 'conversations') {
    // Build this table with the writer account; the server can only read projections.
    async function initialiseChildRequests(locked: Db) {
      const childRunner = new ProjectionRunner(locked, store, logger);
      await childRunner.initialise(childRequests);
    }
    await db.db.lock!('initialise', initialiseChildRequests);
  }
  if (mode === 'budgets') {
    await initialiseBudgetProjection(db.db, store, logger);
  }
  while (!stop.signal.aborted) {
    await runner.run(projection, { signal: stop.signal });
    if (mode === 'conversations') {
      await runner.run(childRequests, { signal: stop.signal });
    }
    if (mode === 'members') {
      await runner.run(personalSettings, { signal: stop.signal });
      await runner.run(groups, { signal: stop.signal });
      await runner.run(providers, { signal: stop.signal });
      await runner.run(modelAccess, { signal: stop.signal });
      await runner.run(egressPolicy, { signal: stop.signal });
    }
    await delay(100, undefined, { signal: stop.signal });
  }
}
function contentDatabaseUrl() {
  const value = required('CONTENT_DATABASE_URL');
  try {
    const url = new URL(value);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) ||
        !url.hostname || url.pathname.length < 2) {
      throw new Error('Invalid database address');
    }
    return value;
  } catch {
    // Keep credentials out of the startup log, including URL parser errors.
    throw new Error('Invalid CONTENT_DATABASE_URL');
  }
}
function contentFailed() {
  logger.error('Worker content database connection failed');
  process.exitCode = 1;
  stop.abort();
}
try {
  if (mode === 'dispatcher') {
    content = connectProjectionDb(contentDatabaseUrl(), contentFailed);
    try {
      await content.db.query('SELECT 1');
    } catch {
      throw new Error('CONTENT_DATABASE_URL unavailable');
    }
  }
  connection = await connectNats();
  const store = await createEventStore(connection);
  if (mode === 'dispatcher') {
    const silo = required('SILO_ID');
    const commandEnv = Object.fromEntries(Object.entries(process.env)
      .filter(([name]) => name.startsWith('COMMAND_')).map(([name, value]) => [name.slice(8), value]));
    commands = await connectEventStore(commandEnv);
    const binding = { silo, apiUrl: required('OPENFGA_API_URL'),
      storeId: required('OPENFGA_STORE_ID'), authorizationModelId: required('OPENFGA_MODEL_ID') };
    const authorisation = memberAuthorisation(binding, commands.store);
    const kube = new SandboxClient(required('KUBECONFIG'), required('KUBE_NAMESPACE'),
      process.env['COMPUTER_POOL'] ?? 'computer', process.env['COMPUTER_STORAGE'] ?? '10Gi');
    const tokens = await tokenIssuer({ privateKeyPath: required('TOKEN_SIGNING_KEY_FILE'),
      issuer: required('TOKEN_ISSUER') });
    const available = [prepareGatewayConfigurationHandler(commands.store, silo, content!.db),
      authorisation.handler, ownershipSeedHandler(commands.store),
      ownershipConfirmationHandler(commands.store), budgetStopHandler(commands.store),
      providerDefaultHandler(commands.store, binding), modelGrantHandler(commands.store),
      ...lifecycleHandlers(commands.store), departureCleanupHandler(commands.store, authorisation)];
    const mcpNamespace = process.env['MCP_KUBE_NAMESPACE']?.trim();
    if (mcpNamespace) {
      const mcpKube = new McpKubernetes(mcpNamespace);
      available.push(stopMcpInstanceHandler(commands.store, silo, mcpKube));
    }
    const personalDirectory = process.env['PERSONAL_KEY_DIRECTORY']?.trim();
    if (personalDirectory) {
      const keys = conversationKeys(personalDirectory);
      available.push(personalKeyHandler(commands.store, keys));
    }
    const custodyFile = process.env['CONNECTION_CUSTODY_FILE']?.trim();
    let custody: Awaited<ReturnType<typeof connectionCustodyFromFile>>;
    let connectionCleanupAvailable = false;
    if (custodyFile) {
      custody = await connectionCustodyFromFile(custodyFile);
      if (custody) {
        available.push(connectionCleanupHandler(commands.store, db.db, custody, silo));
        connectionCleanupAvailable = true;
      } else {
        logger.warn('Connection cleanup disabled: custody file is missing');
      }
    }
    const memoryDirectory = process.env['MEMORY_KEY_DIRECTORY']?.trim();
    if (memoryDirectory) {
      available.push(memoryCleanupHandler(commands.store, memoryKeys(memoryDirectory)));
    }
    const decisionUrl = process.env['MODEL_DECISION_URL'];
    if (decisionUrl) {
      available.push(settlementHandler(decisionUrl));
    }
    const names = dispatcherHandlerNames(process.env, connectionCleanupAvailable);
    function findHandler(name: HandlerName): Handler {
      function matches(handler: Handler) {
        return handler.name === name;
      }
      const handler = available.find(matches);
      if (!handler) {
        throw new Error(`Dispatcher handler missing: ${name}`);
      }
      return handler;
    }
    const handlers = names.map(findHandler);
    runtime = new HandlerRuntime({ db: db.db, logger, silo, handlers });
    await runtime.start();
    const idleMs = Number(process.env['COMPUTER_IDLE_MS'] ?? 900_000);
    if (!Number.isSafeInteger(idleMs) || idleMs < 1) throw new Error('COMPUTER_IDLE_MS must be positive');
    const dispatcherRuntime = runtime;
    const commandStore = commands.store;
    async function startWorkers() {
      if (custody) {
        function scanFailed() {
          logger.error('Connection custody scan failed');
          process.exitCode = 1;
          stop.abort();
        }
        // Let dispatch start even while custody is slow. Shutdown waits for the current page.
        const scanning = scanConnections(commandStore, db.db, custody, logger,
          silo, stop.signal);
        connectionScan = scanning.catch(scanFailed);
      }
      if (memoryDirectory) {
        const saved = await db.db.query<{ sequence: string }>(
          'SELECT sequence FROM handler_dispatcher WHERE id=1',
        );
        const checkpoint = Number(saved.rows[0]?.sequence);
        if (!Number.isSafeInteger(checkpoint) || checkpoint < 0) {
          throw new Error('Dispatcher checkpoint is invalid for cleanup recovery');
        }
        await recoverMemoryCleanup(dispatcherRuntime, store, checkpoint);
      }
      await dispatcherRuntime.work();
      async function scanNightly(occurrence: Date) {
        await scanNightlyMemory(db.db, commandStore, silo, occurrence);
      }
      await dispatcherRuntime.startNightly(scanNightly);
      function deliverCredentials(id: string, token: import('@opencrane/auth').IssuedToken) {
        return kube.credentials(id, token, tokens.jwks.keys[0]);
      }
      watcher = watchComputers(commandStore, kube, tokens, deliverCredentials,
        silo, idleMs, stop.signal);
      function watcherFailed(error: unknown) {
        logger.error({ err: error }, 'Computer watcher failed');
        process.exitCode = 1;
        stop.abort();
      }
      void watcher.catch(watcherFailed);
    }
    await dispatch(connection, runtime, stop.signal, startWorkers);
  } else {
    const projection = workerProjection();
    if (projection) {
      await runProjectionWorker(projection, store);
    }
  }
} catch (error) {
  if (!(stop.signal.aborted && error instanceof Error && error.name === 'AbortError')) {
    logger.error({ err: error }, 'Worker failed; inspect service health before restarting');
    process.exitCode = 1;
  }
} finally {
  stop.abort();
  // Drain every background task before closing storage, even when another task failed.
  const tasks = await Promise.allSettled([runtime?.stop(), watcher, connectionScan]);
  for (const task of tasks) {
    if (task.status === 'rejected') {
      logger.error('Worker background task failed during shutdown');
      process.exitCode = 1;
      break;
    }
  }
  const closed = await Promise.allSettled([
    commands?.close(), connection?.close(), content?.close(), db.close(),
  ]);
  for (const result of closed) {
    if (result.status === 'rejected') {
      logger.error('Worker connection failed during shutdown');
      process.exitCode = 1;
    }
  }
}
