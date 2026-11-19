import { Pool } from 'pg';
import { expect, it } from 'vitest';
import { natsFixture } from '@opencrane/event-store/testing';
import { database } from '@opencrane/projections/testing';
import { BudgetActor } from '@opencrane/models';
import { replayPilotTables, replayPilotDatabase } from './pilot-restore-database.ts';

async function comparisonFixture() {
  const events = await natsFixture();
  const current = await database('pg');
  const admin = new Pool({ connectionString: process.env['PG_TEST_URL'] });
  const lock = await admin.connect();
  await lock.query("SELECT pg_advisory_lock(hashtext('pilot_restore'))");
  const createdRoles: string[] = [];
  for (const role of ['projection', 'server']) {
    const found = await admin.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [role]);
    if (found.rows.length) continue;
    await admin.query(`CREATE ROLE ${role}`);
    createdRoles.push(role);
  }
  const existing = await admin.query("SELECT 1 FROM pg_database WHERE datname='pilot_replay'");
  expect(existing.rows).toEqual([]);
  const name = await current.db.query<{ name: string }>('SELECT current_database() AS name');
  const url = new URL(process.env['PG_TEST_URL']!);
  url.pathname = `/${name.rows[0]!.name}`;
  const actor = new BudgetActor(events.store, 'test');
  await actor.start(5000, 500, 'personal-default');
  const sequence = await events.store.head();
  await replayPilotTables(current.db, events.store, sequence);
  async function snapshot() {
    const tables = await current.db.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename");
    const saved: Record<string, unknown[]> = {};
    for (const { tablename } of tables.rows) {
      const result = await current.db.query(`SELECT * FROM "${tablename}" t ORDER BY to_jsonb(t)`);
      saved[tablename] = result.rows;
    }
    return saved;
  }
  async function compare() {
    await replayPilotDatabase(admin, url.href, events.store, sequence, false);
  }
  async function close() {
    await admin.query('DROP DATABASE IF EXISTS pilot_replay WITH (FORCE)');
    await current.close();
    for (const role of createdRoles) await admin.query(`DROP ROLE ${role}`);
    await lock.query("SELECT pg_advisory_unlock(hashtext('pilot_restore'))");
    lock.release();
    await admin.end();
    await events.close();
  }
  return { current, events, sequence, compare, snapshot, close };
}

async function refusesChangedDump(kind: string) {
  const fixture = await comparisonFixture();
  try {
    if (kind === 'cents') {
      await fixture.current.db.query(`UPDATE model_budgets
        SET state=jsonb_set(state, '{ceilingCents}', '5001')`);
    } else {
      await fixture.current.db.query('CREATE TABLE retained_application (amount_cents INTEGER)');
      await fixture.current.db.query('INSERT INTO retained_application VALUES (1234)');
    }
    const before = await fixture.snapshot();
    await expect(fixture.compare()).rejects.toThrow('Replayed content differs');
    await fixture.current.reopen();
    expect(await fixture.snapshot()).toEqual(before);
    expect(await fixture.events.store.head()).toBe(fixture.sequence);
  } finally {
    await fixture.close();
  }
}
it.each(['cents', 'application table'])(
  'production dump-versus-replay comparison refuses altered %s without replacing content',
  refusesChangedDump);

async function acceptsEqualDump() {
  const fixture = await comparisonFixture();
  try {
    const before = await fixture.snapshot();
    await fixture.compare();
    await fixture.current.reopen();
    expect(await fixture.snapshot()).toEqual(before);
    expect(await fixture.events.store.head()).toBe(fixture.sequence);
  } finally {
    await fixture.close();
  }
}
it('production dump-versus-replay comparison accepts an unchanged dump', acceptsEqualDump);
