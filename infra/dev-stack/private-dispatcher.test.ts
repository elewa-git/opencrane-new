import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HandlerRuntime, prepareDispatcher, registerHandler } from '@opencrane/handlers';
import { createLogger } from '@opencrane/observability';
import { dispatcherHandlerNames } from '../../apps/ops/src/dispatcher-handlers.ts';
import { database } from '../../libs/projections/test/database.ts';

async function noReaction() {
  throw new Error('Manifest preparation must not run reactions');
}
function handler(name: ReturnType<typeof dispatcherHandlerNames>[number]) {
  return registerHandler(name, noReaction);
}
async function manifest() {
  const storage = await database('pg');
  const logs: string[] = [];
  function write(value: string) { logs.push(value); }
  const logger = createLogger('private-manifest', { destination: { write } });
  const privateEnv = { PERSONAL_KEY_DIRECTORY: '/private-fixture/personal',
    MEMORY_KEY_DIRECTORY: '/private-fixture/memory' };
  const names = dispatcherHandlerNames(privateEnv);
  const handlers = names.map(handler);
  const runtime = new HandlerRuntime({ db: storage.db, silo: 'test', logger, handlers });
  async function saved() {
    return storage.db.query('SELECT * FROM handler_dispatcher');
  }
  try {
    assert.equal(await prepareDispatcher(runtime), true);
    const original = await saved();
    const text = JSON.stringify(original.rows);
    assert.match(text, /prepare-personal-key/u);
    assert.match(text, /cleanup-memory/u);
    assert.equal(await prepareDispatcher(runtime), true);
    assert.deepEqual((await saved()).rows, original.rows);
    const oldNames = dispatcherHandlerNames({});
    const oldHandlers = oldNames.map(handler);
    const oldRuntime = new HandlerRuntime({ db: storage.db, silo: 'test', logger,
      handlers: oldHandlers });
    await storage.db.query('DELETE FROM handler_dispatcher');
    assert.equal(await prepareDispatcher(oldRuntime), true);
    await storage.db.query('UPDATE handler_dispatcher SET sequence=12');
    const old = await saved();
    assert.equal(await prepareDispatcher(runtime), false);
    assert.deepEqual((await saved()).rows, old.rows);
    assert.match(logs.join(''), /upgrade-handlers --confirm-writers-stopped/u);
    assert.doesNotMatch(logs.join(''), /private-fixture/u);
  } finally {
    await storage.close();
  }
}
test('fresh manifests register private reactions; existing manifests require upgrade without reset',
  manifest);
