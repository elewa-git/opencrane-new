// A standalone Temporal worker in its own OS process. The crash test spawns
// it and SIGKILLs it mid-activity; the footprint test measures it as the
// stand-in for the per-silo `workers` Deployment.
//   node --experimental-strip-types src/temporal-worker-process.ts <address> <namespace> <taskQueue>
import { Worker, NativeConnection, Runtime, DefaultLogger } from '@temporalio/worker';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
// This file runs straight under Node's type stripping, so relative imports
// need the real .ts extension.
import * as activities from './temporal-workflows/activities.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKFLOWS_PATH = join(__dirname, 'temporal-workflows/workflows.ts');

const [, , addressArg, namespaceArg, taskQueueArg] = process.argv;
if (!addressArg || !namespaceArg || !taskQueueArg) {
  throw new Error('usage: temporal-worker-process <address> <namespace> <taskQueue>');
}
const address: string = addressArg;
const namespace: string = namespaceArg;
const taskQueue: string = taskQueueArg;

async function main(): Promise<void> {
  Runtime.install({ logger: new DefaultLogger('WARN') });
  const connection = await NativeConnection.connect({ address });
  const worker = await Worker.create({
    connection,
    namespace,
    taskQueue,
    workflowsPath: WORKFLOWS_PATH,
    activities,
    maxConcurrentActivityTaskExecutions: 100,
    maxConcurrentWorkflowTaskExecutions: 100,
  });
  console.log('WORKER ready');
  await worker.run();
}

main().catch((err: unknown) => {
  console.error('WORKER fatal', err);
  process.exit(1);
});
