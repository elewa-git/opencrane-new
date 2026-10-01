import { startTemporalDev, type TestTemporalDev } from './temporal.ts';
// Shared setup for the Temporal test files: a production-shaped server on a
// real local PostgreSQL, an in-process worker, and a client. Mirrors
// src/pg.ts's role for the pg-boss tests: real local processes, no Docker.
import { Connection, Client as WorkflowClient } from '@temporalio/client';
import { Worker, NativeConnection, Runtime, DefaultLogger, type WorkerOptions } from '@temporalio/worker';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { startTemporalServer, type ServerMode, type TestTemporalServer } from './temporal-server.ts';
import * as activities from './temporal-workflows/activities.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const WORKFLOWS_PATH = join(__dirname, 'temporal-workflows/workflows.ts');

let runtimeInstalled = false;
/** Keep the SDK quiet except for warnings (the default is very chatty). */
export function installQuietRuntime(): void {
  if (runtimeInstalled) return;
  Runtime.install({ logger: new DefaultLogger('WARN') });
  runtimeInstalled = true;
}

export interface TemporalTestSetup {
  server: TestTemporalServer | TestTemporalDev;
  worker: Worker;
  nativeConnection: NativeConnection;
  connection: Connection;
  client: WorkflowClient;
  taskQueue: string;
  namespace: string;
  stop: () => Promise<void>;
}

export async function setupTemporalTest(
  label: string,
  taskQueue: string,
  opts: { mode?: ServerMode; worker?: Partial<WorkerOptions> } = {},
): Promise<TemporalTestSetup> {
  installQuietRuntime();
  const server = process.env.S08_TEMPORAL_BACKEND === 'dev'
    ? await startTemporalDev(label)
    : await startTemporalServer(label, opts.mode === undefined ? {} : { mode: opts.mode });
  let nativeConnection: NativeConnection;
  try { nativeConnection = await NativeConnection.connect({ address: server.address }); }
  catch (error) { await server.stop(); throw error; }
  try {
  const worker = await Worker.create({
    connection: nativeConnection,
    namespace: server.namespace,
    taskQueue,
    workflowsPath: WORKFLOWS_PATH,
    activities,
    maxConcurrentActivityTaskExecutions: 100,
    maxConcurrentWorkflowTaskExecutions: 100,
    maxConcurrentLocalActivityExecutions: 100,
    ...opts.worker,
  });
  const workerRun = worker.run();
  // If the worker dies, surface it instead of letting tests hang.
  workerRun.catch((err) => console.error('temporal worker stopped with error', err));

  const connection = await Connection.connect({ address: server.address });
  const client = new WorkflowClient({ connection, namespace: server.namespace });

  return {
    server,
    worker,
    nativeConnection,
    connection,
    client,
    taskQueue,
    namespace: server.namespace,
    stop: async () => {
      worker.shutdown();
      await workerRun.catch(() => undefined);
      await activities.closeBudgetPools().catch(() => undefined);
      await connection.close();
      await nativeConnection.close();
      await server.stop();
    },
  };
  } catch (error) {
    await nativeConnection.close();
    await server.stop();
    throw error;
  }
}
