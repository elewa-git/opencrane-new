import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { event, natsFixture } from '@opencrane/event-store/testing';
import { members, ProjectionRunner } from '@opencrane/projections';
import { database } from '@opencrane/projections/testing';
import { registerHandler } from '@opencrane/handlers';
import { fixture, logger } from '../../libs/handlers/test/helpers.ts';
import { collectEventBackup, descriptorSchema, infoSchema } from './event-backup.ts';
import { restoreEventBackup } from './event-restore.ts';
import { collectUpgradeRecovery } from './upgrade-recovery.ts';
import { checkUpgradeRecovery } from './upgrade-recovery-check.ts';
import * as models from '@opencrane/models';
import { recoveryFiles } from './upgrade-recovery-files-fixture.ts';
import { interruptAndRefuse } from './upgrade-recovery-fixture.ts';
import { seedRecoveryBudgets, expectRecoveryMoney } from './upgrade-recovery-budget-fixture.ts';
import { collectBudgetRecovery, checkBudgetRecovery } from './upgrade-recovery-budget.ts';

type SourceFixture = Awaited<ReturnType<typeof fixture>>;

async function captureBeforeUpgrade(source: SourceFixture, directory: string) {
  await source.append('joined');
  await source.append('other', 'member-bob');
  const history = [];
  for (let index = 0; index < 258; index++) {
    history.push(event(`role-${index}`, 'member-alice', 'member.role_changed'));
  }
  await source.nats.seed(history);
  const budgetIds = await seedRecoveryBudgets(source.nats);
  const sequence = await source.nats.reader.head();
  await models.rebuildBudgetProjection(source.db, source.nats.reader, logger);
  await expectRecoveryMoney(source.db, sequence, budgetIds);
  const budgetBefore = await collectBudgetRecovery(source.db);
  const previous = JSON.stringify([{ name: 'update-openfga', eventTypes: ['member.joined'] }]);
  await source.db.query(`CREATE TABLE handler_dispatcher (
    id INTEGER PRIMARY KEY, silo TEXT, manifest TEXT, sequence BIGINT)`);
  await source.db.query("INSERT INTO handler_dispatcher VALUES (1, 'test', $1, $2)",
    [previous, sequence]);
  const runner = new ProjectionRunner(source.db, source.nats.reader, logger);
  await runner.initialise(members);
  await runner.run(members);
  const before = await collectUpgradeRecovery(source.nats.reader, source.db);
  const destination = join(directory, 'before-upgrade');
  const backupOptions = { silo: 'test', attempt: 'before-upgrade', destination };
  await collectEventBackup(source.nats.connection, backupOptions);
  const descriptorPath = join(destination, 'descriptor.json');
  const descriptor = descriptorSchema.parse(JSON.parse(await readFile(descriptorPath, 'utf8')));
  return { before, destination, descriptor, previous, budgetBefore, budgetIds };
}

function observeRestore(target: Awaited<ReturnType<typeof natsFixture>>, lostCompletion: boolean) {
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
  return {
    get transfers() {
      return transfers;
    },
  };
}

async function recoversAfterInterruptedUpgrade(fault: string) {
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
  const runtimeOptions = { retryLimit: 5 };
  const runtime = await source.runtime(handlers, runtimeOptions);
  try {
    // Check the recording endpoint before using it to detect accidental reaction calls.
    await externalEffect();
    expect(calls).toBe(1);
    calls = 0;
    const fileFixture = await recoveryFiles(source, directory);
    const captured = await captureBeforeUpgrade(source, directory);
    await fileFixture.capture(captured.destination);
    const { before, destination, descriptor, previous, budgetBefore, budgetIds } = captured;
    const actorStart = vi.spyOn(models.BudgetActor.prototype, 'start');
    const targetAppend = vi.spyOn(target.store, 'append');
    const budgetReplay = vi.spyOn(models, 'rebuildBudgetProjection');
    const { progress, parked } = await interruptAndRefuse(source, runtime, effectUrl, previous,
      descriptor.lastSequence);
    const restoreOptions = { silo: 'test', directory: destination, disposable: true };
    const observed = observeRestore(target, fault === 'events');
    const archivePath = join(destination, 'events.snapshot');
    const archive = await readFile(archivePath);
    await writeFile(archivePath, archive.subarray(0, -1));
    await expect(restoreEventBackup(source.nats.connection, target.connection, restoreOptions))
      .rejects.toEqual(new Error('Event restore refused; keep target isolated'));
    expect(observed.transfers).toBe(0);
    await writeFile(archivePath, archive);
    if (fault === 'events') {
      await expect(restoreEventBackup(source.nats.connection, target.connection, restoreOptions))
        .rejects.toEqual(new Error('Event restore refused; keep target isolated'));
      expect(observed.transfers).toBe(1);
      expect(budgetReplay).not.toHaveBeenCalled();
      // Inspect the populated target without retrying restoration or starting a projection.
      const reply = await target.connection.request('$JS.API.STREAM.INFO.EVENTS', '{}');
      const info = infoSchema.parse(reply.json<unknown>());
      expect(info.state.messages).toBe(descriptor.eventCount);
      for (const table of ['projection_checkpoints', 'model_budgets', 'model_budget_calls',
        'model_budget_effects', 'model_current_effects']) {
        const tables = await restored.db.query('SELECT to_regclass($1) AS name', [table]);
        expect(tables.rows).toEqual([{ name: null }]);
      }
      const proof = { outcome: 'uncertain; target isolated', transfers: observed.transfers,
        targetEvents: descriptor.eventCount, projectionStarted: false, externalCalls: calls };
      await writeFile('.tools/upgrade-recovery-uncertain.json', JSON.stringify(proof, null, 2),
        { mode: 0o600 });
    } else {
      const proof = await restoreEventBackup(source.nats.connection, target.connection, restoreOptions);
      if (fault === 'objects') {
        await expect(fileFixture.restore(target, proof, true))
          .rejects.toEqual(new Error('Object restore refused; keep target isolated'));
        expect(budgetReplay).not.toHaveBeenCalled();
        await fileFixture.expectIsolated(restored.db);
        return;
      }
      await fileFixture.restore(target, proof);
      expect(observed.transfers).toBe(1);
      const restoredRunner = new ProjectionRunner(restored.db, target.reader, logger);
      await restoredRunner.initialise(members);
      await restoredRunner.rebuild(members);
      const budgetRebuilds = [];
      const fileRebuilds = [];
      for (let rebuild = 0; rebuild < 2; rebuild++) {
        const result = await models.rebuildBudgetProjection(restored.db, target.reader, logger);
        const budgetAfter = await collectBudgetRecovery(restored.db);
        checkBudgetRecovery(budgetBefore, budgetAfter, descriptor.lastSequence);
        await expectRecoveryMoney(restored.db, descriptor.lastSequence, budgetIds);
        budgetRebuilds.push(budgetAfter);
        fileRebuilds.push(await fileFixture.rebuild(target, restored.db));
        if (rebuild === 1) expect(result.changed).toBe(false);
      }
      expect(budgetReplay).toHaveBeenCalledTimes(2);
      expect(await collectBudgetRecovery(source.db)).toEqual(budgetBefore);
      const after = await collectUpgradeRecovery(target.reader, restored.db);
      checkUpgradeRecovery(before, after, descriptor);
      expect(await collectUpgradeRecovery(source.nats.reader, source.db)).toEqual(before);
      const proof = { interrupted: progress.rows, parkedJobs: parked.rows.length,
        incompatibleResume: 'refused; parked jobs unchanged',
        before, after, descriptor, budgetBefore, budgetRebuilds, fileRebuilds, externalCalls: calls };
      await writeFile('.tools/upgrade-recovery-proof.json', JSON.stringify(proof, null, 2),
        { mode: 0o600 });
    }
    if (fault === 'events') await fileFixture.expectIsolated(restored.db);
    expect(calls).toBe(0);
    expect(actorStart).not.toHaveBeenCalled();
    expect(targetAppend).not.toHaveBeenCalled();
    expect((await source.db.query('SELECT * FROM pgboss.job ORDER BY name, id')).rows)
      .toEqual(parked.rows);
    const dispatcher = await source.db.query('SELECT manifest, sequence FROM handler_dispatcher');
    expect(dispatcher.rows).toEqual([{ manifest: previous, sequence: String(descriptor.lastSequence) }]);
    expect((await source.db.query('SELECT previous, manifest, target, sequence FROM handler_upgrade')).rows)
      .toEqual(progress.rows);
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
it.each(['none', 'events', 'objects'])('recovers from the pre-upgrade export (fault: %s)',
  recoversAfterInterruptedUpgrade, 90_000);
