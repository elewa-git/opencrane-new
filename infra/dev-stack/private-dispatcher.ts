import type { HandlerName } from '@opencrane/events';
import { HandlerRuntime, prepareDispatcher, registerHandler } from '@opencrane/handlers';
import { createLogger } from '@opencrane/observability';
import { connectProjectionDb } from '@opencrane/projections';
import { dispatcherHandlerNames } from '../../apps/ops/src/dispatcher-handlers.ts';

function noReaction(): Promise<void> {
  return Promise.reject(new Error('Startup must not run reactions'));
}
function subscription(name: HandlerName) {
  return registerHandler(name, noReaction);
}
export async function preparePrivateDispatcher(env: Record<string, string>) {
  const logger = createLogger('dev-private-dispatcher');
  function databaseFailed() {
    logger.error('Private dispatcher setup database unavailable');
  }
  const storage = connectProjectionDb(env['DATABASE_URL']!, databaseFailed);
  const names = dispatcherHandlerNames(env);
  const handlers = names.map(subscription);
  const runtime = new HandlerRuntime({ db: storage.db, logger, silo: env['SILO_ID']!, handlers });
  async function prepare() {
    if (!await prepareDispatcher(runtime)) {
      throw new Error('Private handlers require stopped-services upgrade/backfill; do not reset data');
    }
  }
  try {
    await storage.db.lock!('handler-dispatcher', prepare);
  } catch {
    throw new Error('Private dispatcher setup unavailable; check stopped-services upgrade/backfill');
  } finally {
    await storage.close();
  }
}
