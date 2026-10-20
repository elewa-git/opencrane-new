import { once } from 'node:events';
import { mock } from 'node:test';
import * as lifecycle from '../../src/lifecycle.ts';
import * as handlers from '@opencrane/handlers';
import * as models from '@opencrane/models';
import * as eventStore from '@opencrane/event-store';

async function failedWatcher(): Promise<void> {
  process.send?.('watcher-ready');
  await once(process, 'message');
  throw new Error('Fixture watcher read failed');
}

if (process.env['WORKER_TEST_FAULT'] === 'watcher') {
  const lifecycleExports = { ...lifecycle, watchComputers: failedWatcher };
  mock.module('../../src/lifecycle.ts', { namedExports: lifecycleExports });
}

async function failedScan(): Promise<void> {
  process.send?.('scan-ready');
  await once(process, 'message');
  throw new Error('synthetic-private-scan-response');
}

if (process.env['WORKER_TEST_FAULT'] === 'scan') {
  const modelExports = { ...models, scanConnections: failedScan };
  mock.module('@opencrane/models', { namedExports: modelExports });
}

class ObservedRuntime extends handlers.HandlerRuntime {
  override async stop(): Promise<void> {
    await super.stop();
    process.send?.('runtime-stopped');
  }
}

const handlerExports = { ...handlers, HandlerRuntime: ObservedRuntime };
mock.module('@opencrane/handlers', { namedExports: handlerExports });

async function observedConnection(...args: Parameters<typeof eventStore.connectEventStore>) {
  const connected = await eventStore.connectEventStore(...args);
  async function close() {
    process.send?.('storage-closing');
    await connected.close();
  }
  return { ...connected, close };
}

const storeExports = { ...eventStore, connectEventStore: observedConnection };
mock.module('@opencrane/event-store', { namedExports: storeExports });
