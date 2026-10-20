import { once } from 'node:events';
import { mock } from 'node:test';
import * as lifecycle from '../../src/lifecycle.ts';
import * as handlers from '@opencrane/handlers';

async function failedWatcher(): Promise<void> {
  process.send?.('watcher-ready');
  await once(process, 'message');
  throw new Error('Fixture watcher read failed');
}

if (process.env['WORKER_TEST_FAULT'] === 'watcher') {
  const lifecycleExports = { ...lifecycle, watchComputers: failedWatcher };
  mock.module('../../src/lifecycle.ts', { namedExports: lifecycleExports });
}

class ObservedRuntime extends handlers.HandlerRuntime {
  override async stop(): Promise<void> {
    await super.stop();
    process.send?.('runtime-stopped');
  }
}

const handlerExports = { ...handlers, HandlerRuntime: ObservedRuntime };
mock.module('@opencrane/handlers', { namedExports: handlerExports });
