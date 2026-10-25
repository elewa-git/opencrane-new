import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { jetstreamManager } from '@nats-io/jetstream';
import { event, natsFixture } from '@opencrane/event-store/testing';
import { members, ProjectionRunner } from '@opencrane/projections';
import { database } from '@opencrane/projections/testing';
import { HandlerRuntime, registerHandler, upgradeHandlers } from '@opencrane/handlers';
import { fixture, logger } from '../../libs/handlers/test/helpers.ts';
import { collectEventBackup, descriptorSchema } from './event-backup.ts';
import { restoreEventBackup } from './event-restore.ts';
import { collectUpgradeRecovery } from './upgrade-recovery.ts';
import { checkUpgradeRecovery } from './upgrade-recovery-check.ts';

async function recoversAfterInterruptedUpgrade(lostCompletion: boolean) {
  const source = await fixture();
  const target = await natsFixture({ provision: false });
  const restored = await database('pg');
  const directory = await mkdtemp(join(tmpdir(), 'upgrade-recovery-'));
  let calls = 0;
  function record(_request: unknown, response: import('node:http').ServerResponse) {
    calls++;
    response.end();
  }
  const endpoint = createServer(record);
  endpoint.listen(0, '127.0.0.1');
  await once(endpoint, 'listening');
  const address = endpoint.address();
  if (!address || typeof address === 'string') throw new Error('No fixture endpoint');
  const effectUrl = `http://127.0.0.1:${address.port}`;
  async function externalEffect() {
    await fetch(effectUrl);
  }
  const handlers = [registerHandler('update-openfga', externalEffect)];
  const runtime = await source.runtime(handlers);
  try {
    // Check the recording endpoint before using it to detect accidental reaction calls.
    await externalEffect();
    expect(calls).toBe(1);
    calls = 0;
    await source.append('joined');
    await source.append('other', 'member-bob');
    const history = [];
    for (let index = 0; index < 258; index++) {
      history.push(event(`role-${index}`, 'member-alice', 'member.role_changed'));
    }
    await source.nats.seed(history);
    const previous = JSON.stringify([{ name: 'update-openfga', eventTypes: ['member.joined'] }]);
    await source.db.query(`CREATE TABLE handler_dispatcher (
      id INTEGER PRIMARY KEY, silo TEXT, manifest TEXT, sequence BIGINT)`);
    await source.db.query("INSERT INTO handler_dispatcher VALUES (1, 'test', $1, 260)", [previous]);
    const runner = new ProjectionRunner(source.db, source.nats.reader, logger);
    await runner.initialise(members);
    await runner.run(members);
    const before = await collectUpgradeRecovery(source.nats.reader, source.db);
    const destination = join(directory, 'before-upgrade');
    const backupOptions = { silo: 'test', attempt: 'before-upgrade', destination };
    await collectEventBackup(source.nats.connection, backupOptions);
    const descriptorPath = join(destination, 'descriptor.json');
    const descriptor = descriptorSchema.parse(JSON.parse(await readFile(descriptorPath, 'utf8')));
    await runtime.stop();
    await source.waitForConnectionsClosed();
    await source.crash('upgrade-after-chunk', effectUrl);
    const progress = await source.db.query('SELECT previous, manifest, target, sequence FROM handler_upgrade');
    expect(progress.rows).toMatchObject([{ previous, target: '260', sequence: '256' }]);
    const parked = await source.db.query('SELECT * FROM pgboss.job ORDER BY name, id');
    expect(parked.rows.length).toBeGreaterThan(256);
    for (const row of parked.rows) expect(row['start_after']).toBe(Infinity);
    const incompatible = new HandlerRuntime({ ...runtime.options, handlers: [] });
    await source.waitForConnectionsClosed();
    await expect(upgradeHandlers(incompatible, source.nats.reader))
      .rejects.toThrow('unfinished upgrade uses different subscriptions');
    expect((await source.db.query('SELECT * FROM pgboss.job ORDER BY name, id')).rows)
      .toEqual(parked.rows);
    expect((await source.db.query('SELECT previous, manifest, target, sequence FROM handler_upgrade')).rows)
      .toEqual(progress.rows);
    const restoreOptions = { silo: 'test', directory: destination, disposable: true };
    const request = target.connection.request.bind(target.connection);
    let delivery = '';
    let transfers = 0;
    async function intercept(...args: Parameters<typeof request>) {
      expect(args[0]).not.toMatch(/STREAM\.(DELETE|PURGE)/);
      const reply = await request(...args);
      if (args[0] === '$JS.API.STREAM.RESTORE.EVENTS') {
        transfers++;
        delivery = reply.json<{ deliver_subject: string }>().deliver_subject;
      }
      if (lostCompletion && args[0] === delivery && !args[1]?.length) {
        throw new Error('private-upgrade-recovery-canary');
      }
      return reply;
    }
    vi.spyOn(target.connection, 'request').mockImplementation(intercept);
    if (lostCompletion) {
      await expect(restoreEventBackup(source.nats.connection, target.connection, restoreOptions))
        .rejects.toEqual(new Error('Event restore refused; keep target isolated'));
      expect(transfers).toBe(1);
      // Inspect the populated target without retrying restoration or starting a projection.
      const manager = await jetstreamManager(target.connection);
      expect((await manager.streams.info('EVENTS')).state.messages).toBe(260);
      const tables = await restored.db.query("SELECT to_regclass('projection_checkpoints') AS name");
      expect(tables.rows).toEqual([{ name: null }]);
    } else {
      await restoreEventBackup(source.nats.connection, target.connection, restoreOptions);
      const restoredRunner = new ProjectionRunner(restored.db, target.reader, logger);
      await restoredRunner.initialise(members);
      await restoredRunner.rebuild(members);
      const after = await collectUpgradeRecovery(target.reader, restored.db);
      checkUpgradeRecovery(before, after, descriptor);
      expect(await collectUpgradeRecovery(source.nats.reader, source.db)).toEqual(before);
      const proof = { interrupted: progress.rows, parkedJobs: parked.rows.length,
        incompatibleResume: 'refused; parked jobs unchanged',
        before, after, descriptor, externalCalls: calls };
      await writeFile('.tools/upgrade-recovery-proof.json', JSON.stringify(proof, null, 2),
        { mode: 0o600 });
    }
    expect(calls).toBe(0);
    expect((await source.db.query('SELECT * FROM pgboss.job ORDER BY name, id')).rows)
      .toEqual(parked.rows);
  } finally {
    vi.restoreAllMocks();
    const closed = once(endpoint, 'close');
    endpoint.close();
    endpoint.closeAllConnections();
    await closed;
    await restored.close();
    await target.close();
    await source.close();
    await rm(directory, { recursive: true, force: true });
  }
}
it.each([false, true])('recovers from the pre-upgrade export (lost completion: %s)',
  recoversAfterInterruptedUpgrade);
