import assert from 'node:assert/strict';
import { test } from 'vitest';
import { HandlerRuntime, prepareDispatcher, registerHandler } from '@opencrane/handlers';
import { createLogger } from '@opencrane/observability';
import { dispatcherHandlerNames } from '../src/dispatcher-handlers.ts';
import { preparePrivateDispatcher } from '../../../infra/dev-stack/private-dispatcher.ts';
import { database } from '../../../libs/projections/test/database.ts';

function noReaction(): Promise<void> {
  return Promise.reject(new Error('Manifest preparation must not run reactions'));
}
function handler(name: ReturnType<typeof dispatcherHandlerNames>[number]) {
  return registerHandler(name, noReaction);
}
async function manifest() {
  const storage = await database('pg');
  const logs: string[] = [];
  function write(value: string) {
    logs.push(value);
  }
  const logger = createLogger('private-manifest', { destination: { write }, level: 'info' });
  const privateEnv = { PERSONAL_KEY_DIRECTORY: '/private-fixture/personal',
    MEMORY_KEY_DIRECTORY: '/private-fixture/memory' };
  const names = dispatcherHandlerNames(privateEnv);
  const handlers = names.map(handler);
  const runtime = new HandlerRuntime({ db: storage.db, silo: 'test', logger, handlers });
  async function saved() {
    return storage.db.query('SELECT * FROM handler_dispatcher');
  }
  try {
    const current = await storage.db.query<{ name: string }>('SELECT current_database() AS name');
    const url = new URL(process.env['PG_TEST_URL']!);
    url.pathname = `/${current.rows[0]!.name}`;
    const env = { ...privateEnv, DATABASE_URL: url.href, SILO_ID: 'test' };
    await preparePrivateDispatcher(env);
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
    await assert.rejects(preparePrivateDispatcher(env), /stopped-services upgrade\/backfill/u);
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
