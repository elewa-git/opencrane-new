import { eventEnvelopeSchema, gatewayConfigurationSchema } from '@opencrane/events';
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
if (process.env['WORKER_TEST_FAULT'] !== 'preparation') {
  mock.module('@opencrane/event-store', { namedExports: storeExports });
}

if (process.env['WORKER_TEST_FAULT'] === 'preparation') {
  const original = eventStore.connectEventStore;
  async function pausedConnection(...args: Parameters<typeof original>) {
    const connected = await original(...args);
    const append = connected.store.append.bind(connected.store);
    async function pausedAppend(command: Parameters<typeof append>[0]) {
      const schema = eventEnvelopeSchema(gatewayConfigurationSchema);
      const parsed = schema.safeParse(command.event);
      if (parsed.success && parsed.data.type === 'gateway.configuration_requested' &&
          parsed.data.data.generation === 2) {
        process.send?.('preparing');
        await once(process, 'message');
      }
      return append(command);
    }
    connected.store.append = pausedAppend;
    return connected;
  }
  const pausedExports = { ...eventStore, connectEventStore: pausedConnection };
  mock.module('@opencrane/event-store', { namedExports: pausedExports });
}
