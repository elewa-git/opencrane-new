import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { test } from 'vitest';
import { encodeSession } from '@opencrane/auth';
import { testAuthConfig } from '@opencrane/auth/testing';
import { createStore, memberAuthorisation } from '@opencrane/authz';
import { openfga } from '@opencrane/authz/testing';
import { event, natsFixture } from '@opencrane/event-store/testing';
import { createLogger } from '@opencrane/observability';
import { conversationKeys, memoryKeys, memoryProjection, memoryScopeId, ProjectionRunner }
  from '@opencrane/projections';
import { database } from '../../../libs/projections/test/database.ts';
import { personalKeyHandler, memoryCleanupHandler } from '../../ops/test/server.ts';
import { buildServer } from '../src/server.ts';
import { preparePrivateDirectories } from '../../../infra/dev-stack/private-directories.ts';

async function configuredServices() {
  const directory = await mkdtemp('/tmp/private-services-');
  const settings = await preparePrivateDirectories(directory, true);
  const nats = await natsFixture();
  const storage = await database('pg');
  const fga = await openfga();
  const binding = await createStore(fga.apiUrl, 'test');
  const keys = conversationKeys(settings.PERSONAL_KEY_DIRECTORY);
  const memory = memoryKeys(settings.MEMORY_KEY_DIRECTORY);
  const prepare = personalKeyHandler(nats.store, keys);
  const fixture = event('joined', 'member-alice', 'member.joined');
  const joined = { ...fixture, data: { ...fixture.data, personalAssistant: 'none' } };
  const lines: string[] = [];
  function write(line: string) {
    lines.push(line);
  }
  function memberId() {
    return Promise.resolve('alice');
  }
  const destination = { write };
  const logger = createLogger('private-services', { destination, level: 'info' });
  const common = { silo: 'test', store: nats.store, db: storage.db, binding, feed: { memberId } };
  const config = testAuthConfig({ expectedOrgId: 'org-test' });
  const options = { onboarding: { ...common, keys },
    memory: { ...common, keyDirectory: settings.MEMORY_KEY_DIRECTORY },
    logDestination: destination, processOwnsTelemetry: true };
  let app = buildServer(config, options);
  app.log.level = 'info';
  const session = { sub: 'alice', orgId: config.expectedOrgId!, roles: [],
    authTime: 0, exp: 2000000000 };
  const headers = { origin: 'https://app.example.test',
    cookie: `${config.cookieName}=${encodeSession(config, session)}` };
  const canary = 'Private survey and memory fixture';
  const runner = new ProjectionRunner(storage.db, nats.reader, logger);
  const projection = memoryProjection({ decrypt: memory.decrypt });
  try {
    await runner.initialise(projection);
    await nats.seed([joined]);
    await memberAuthorisation(binding).handler.handle(joined, storage.db);
    await prepare.handle(joined, storage.db);
    const filenames = await readdir(settings.PERSONAL_KEY_DIRECTORY);
    assert.equal(filenames.length, 1);
    const keyPath = `${settings.PERSONAL_KEY_DIRECTORY}/${filenames[0]!}`;
    const original = await readFile(keyPath);
    await prepare.handle(joined, storage.db);
    assert.deepEqual(await readFile(keyPath), original);
    const survey = await app.inject({ method: 'POST', url: '/api/onboarding/survey', headers,
      payload: { operation: 'save_step', commandId: 'survey-save', generation: 1,
        expectedPosition: 0, answers: { step: 1, preferredName: canary, pronouns: null } } });
    assert.equal(survey.statusCode, 200, survey.body);
    assert(!survey.body.includes(canary));
    const scopeId = memoryScopeId('test', 'person', 'alice');
    const url = `/api/memory/${scopeId}/facts`;
    const saved = await app.inject({ method: 'POST', url, headers,
      payload: { commandId: 'memory-save', text: canary, kind: 'fact', pinned: false,
        expiresAt: null, sources: [], dependsOn: [] } });
    assert.equal(saved.statusCode, 200, saved.body);
    const receipt = saved.json<{ memoryId: string; revision: number }>();
    assert(!saved.body.includes(canary));
    const identity = { silo: 'test', scopeId, scopeKind: 'person' as const, ownerId: 'alice',
      memoryId: receipt.memoryId, revision: 1 };
    await runner.run(projection);
    const detailUrl = `${url}/${receipt.memoryId}`;
    const detail = await app.inject({ url: detailUrl, headers });
    assert.equal(detail.statusCode, 200, detail.body);
    assert(detail.body.includes(canary));
    await app.close();
    const restarted = await preparePrivateDirectories(directory, false);
    const restartedKeys = conversationKeys(restarted.PERSONAL_KEY_DIRECTORY);
    options.onboarding.keys = restartedKeys;
    app = buildServer(config, options);
    app.log.level = 'info';
    const surveyRead = await app.inject({ url: '/api/onboarding', headers });
    assert.equal(surveyRead.statusCode, 200, surveyRead.body);
    assert(surveyRead.body.includes(canary));
    const reopenedMemory = memoryKeys(restarted.MEMORY_KEY_DIRECTORY);
    const reopenedProjection = memoryProjection({ decrypt: reopenedMemory.decrypt });
    await runner.rebuild(reopenedProjection);
    assert((await app.inject({ url: detailUrl, headers })).body.includes(canary));
    const forget = event('forget', `scope-${scopeId}`, 'memory.forgotten');
    const forgotten = { ...forget, data: { schemaVersion: 1, scopeId,
      scopeKind: 'person', ownerId: 'alice', memoryId: receipt.memoryId,
      expectedRevision: 1, revision: 2 } };
    await nats.seed([forgotten]);
    await runner.run(projection);
    const cleanupKeys = memoryKeys(restarted.MEMORY_KEY_DIRECTORY);
    await memoryCleanupHandler(nats.store, cleanupKeys, storage.db).handle(forgotten, storage.db);
    await runner.rebuild(projection);
    assert.equal(memory.status(identity), 'destroyed');
    await preparePrivateDirectories(directory, false);
    function reprovision() {
      cleanupKeys.provision(identity);
    }
    assert.throws(reprovision, /destroyed/u);
    const afterForget = await app.inject({ url: detailUrl, headers });
    assert.equal(afterForget.statusCode, 200, afterForget.body);
    assert.equal(afterForget.json<{ reason: string }>().reason, 'forgotten');
    assert(!afterForget.body.includes(canary));
    const removed = event('removed', 'member-alice', 'member.removed');
    await nats.seed([removed]);
    await rm(keyPath);
    await prepare.handle(joined, storage.db);
    assert.deepEqual(await readdir(settings.PERSONAL_KEY_DIRECTORY), []);
    assert(lines.length > 0);
    assert(!lines.join('').includes(canary));
    assert(!lines.join('').includes(original.toString('hex')));
    for (const subject of ['personal-alice', `scope-${scopeId}`]) {
      for await (const savedEvent of nats.store.readStream(subject)) {
        assert(!JSON.stringify(savedEvent).includes(canary));
      }
    }
  } finally {
    await app.close();
    await fga.close();
    await storage.close();
    await nats.close();
    await rm(directory, { recursive: true, force: true });
  }
}
test('configured custody serves human routes and shares restart and deletion state', configuredServices);
