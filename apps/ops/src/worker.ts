import { budgets, ownershipSeedHandler, settlementHandler, modelGrantHandler,
  initialiseBudgetProjection } from '@opencrane/models';
import { setTimeout as delay } from 'node:timers/promises';
import { connectNats, createEventStore } from '@opencrane/event-store';
import { connectEventStore } from '@opencrane/event-store';
import { connectProjectionDb, ProjectionRunner, auditTrail, groups, providers, members, mcpCatalogue, computers,
  conversations, files } from '@opencrane/projections';
import { dispatch, HandlerRuntime } from '@opencrane/handlers';
import { memberAuthorisation } from '@opencrane/authz';
import { tokenIssuer } from '@opencrane/auth';
import { createLogger } from '@opencrane/observability';
import { SandboxClient } from './kubernetes.ts';
import { lifecycleHandlers, watchComputers } from './lifecycle.ts';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
const mode = process.argv[2];
if (!['members', 'mcp-catalogue', 'computers', 'dispatcher', 'budgets', 'conversations', 'audit', 'files'].includes(mode ?? '')) {
  throw new Error('Expected members, mcp-catalogue, computers, budgets or dispatcher');
}
const logger = createLogger(`worker-${mode}`);
const stop = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => stop.abort());
const db = connectProjectionDb(required('DATABASE_URL'), (error) => {
  logger.error({ err: error }, 'Worker database connection failed');
  process.exitCode = 1;
  stop.abort();
});
const connection = await connectNats();
const store = await createEventStore(connection);
let runtime: HandlerRuntime | undefined;
let commands: Awaited<ReturnType<typeof connectEventStore>> | undefined;
let watcher: Promise<void> | undefined;
try {
  if (mode === 'dispatcher') {
    const silo = required('SILO_ID');
    const authorisation = memberAuthorisation({ silo, apiUrl: required('OPENFGA_API_URL'),
      storeId: required('OPENFGA_STORE_ID'), authorizationModelId: required('OPENFGA_MODEL_ID') });
    const commandEnv = Object.fromEntries(Object.entries(process.env)
      .filter(([name]) => name.startsWith('COMMAND_')).map(([name, value]) => [name.slice(8), value]));
    commands = await connectEventStore(commandEnv);
    const kube = new SandboxClient(required('KUBECONFIG'), required('KUBE_NAMESPACE'),
      process.env['COMPUTER_POOL'] ?? 'computer', process.env['COMPUTER_STORAGE'] ?? '10Gi');
    const tokens = await tokenIssuer({ privateKeyPath: required('TOKEN_SIGNING_KEY_FILE'),
      issuer: required('TOKEN_ISSUER') });
    const handlers = [authorisation.handler, ownershipSeedHandler(commands.store),
      modelGrantHandler(commands.store), ...lifecycleHandlers(commands.store)];
    const decisionUrl = process.env['MODEL_DECISION_URL'];
    if (decisionUrl) {
      handlers.push(settlementHandler(decisionUrl));
    }
    runtime = new HandlerRuntime({ db: db.db, logger, silo, handlers });
    await runtime.start();
    await runtime.work();
    const idleMs = Number(process.env['COMPUTER_IDLE_MS'] ?? 900_000);
    if (!Number.isSafeInteger(idleMs) || idleMs < 1) throw new Error('COMPUTER_IDLE_MS must be positive');
    watcher = watchComputers(commands.store, kube, tokens, (id, token) => kube.credentials(id, token), silo, idleMs, stop.signal);
    await Promise.race([dispatch(connection, runtime, stop.signal), watcher]);
  } else {
    const projection = mode === 'files' ? files : mode === 'audit' ? auditTrail : mode === 'conversations' ? conversations : mode === 'members' ? members : mode === 'budgets' ? budgets : mode === 'computers' ? computers : mcpCatalogue;
    const runner = new ProjectionRunner(db.db, store, logger);
    // Workers may initialise the same schema together, so hold the DB lock through migration.
    await db.db.lock!('initialise', async (locked) => {
      const lockedRunner = new ProjectionRunner(locked, store, logger);
      await lockedRunner.initialise(projection);
    });
    async function initialiseGroups(locked: import('@opencrane/projections').Db) {
      const groupRunner = new ProjectionRunner(locked, store, logger);
      await groupRunner.initialise(groups);
      await groupRunner.initialise(providers);
    }
    if (mode === 'members') await db.db.lock!('initialise', initialiseGroups);
    if (mode === 'budgets') await initialiseBudgetProjection(db.db, store, logger);
    while (!stop.signal.aborted) {
      await runner.run(projection, { signal: stop.signal });
      if (mode === 'members') {
        await runner.run(groups, { signal: stop.signal });
        await runner.run(providers, { signal: stop.signal });
      }
      await delay(100, undefined, { signal: stop.signal });
    }
  }
} catch (error) {
  if (!(stop.signal.aborted && error instanceof Error && error.name === 'AbortError')) {
    logger.error({ err: error }, 'Worker failed; inspect service health before restarting');
    process.exitCode = 1;
  }
} finally {
  await runtime?.stop();
  await watcher;
  await commands?.close();
  await connection.close();
  await db.close();
}
