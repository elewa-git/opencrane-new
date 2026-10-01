import { setTimeout as delay } from 'node:timers/promises';
import { connectNats, createEventStore } from '@opencrane/event-store';
import { connectProjectionDb, ProjectionRunner, members, mcpCatalogue } from '@opencrane/projections';
import { dispatch, HandlerRuntime } from '@opencrane/handlers';
import { memberAuthorisation } from '@opencrane/authz';
import { createLogger } from '@opencrane/observability';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
const mode = process.argv[2];
if (mode !== 'members' && mode !== 'mcp-catalogue' && mode !== 'dispatcher') {
  throw new Error('Expected members, mcp-catalogue or dispatcher');
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
try {
  if (mode === 'dispatcher') {
    const silo = required('SILO_ID');
    const authorisation = memberAuthorisation({ silo, apiUrl: required('OPENFGA_API_URL'),
      storeId: required('OPENFGA_STORE_ID'), authorizationModelId: required('OPENFGA_MODEL_ID') });
    runtime = new HandlerRuntime({ db: db.db, logger, silo, handlers: [authorisation.handler] });
    await runtime.start();
    await runtime.work();
    await dispatch(connection, runtime, stop.signal);
  } else {
    const projection = mode === 'members' ? members : mcpCatalogue;
    const runner = new ProjectionRunner(db.db, store, logger);
    await db.db.lock!('initialise', (locked) => new ProjectionRunner(locked, store, logger).initialise(projection));
    while (!stop.signal.aborted) {
      await runner.run(projection, { signal: stop.signal });
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
  await connection.close();
  await db.close();
}
