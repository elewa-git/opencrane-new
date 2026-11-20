import { Pool } from 'pg';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { envelope } from '@opencrane/models';
import { natsFixture } from '@opencrane/event-store/testing';
import { pgDb } from '@opencrane/projections';
import { restoreTargetFixture } from './pilot-restore-target-fixture.ts';
import { packageRestoreTarget } from './pilot-restore-target.ts';
import { restorePilotBackup } from './pilot-restore.ts';
import { replayPilotTables, checkPilotCheckpoints } from './pilot-restore-database.ts';
import { packageDatabaseRoles } from './package-database.ts';
import { manifestSchema } from './scheduled-backup.ts';
import { hashBackupBytes } from './backup-bytes.ts';
import { pilotBackupFixture } from './pilot-restore-fixture.ts';
import { postgresFixtureCommand } from './pilot-restore-postgres-fixture.ts';

vi.mock('./pilot-restore-kube.ts', function kubernetesBoundary() {
  return { restoreKube: kube };
});
vi.mock('./pilot-storage.ts', function objectBoundary() {
  return { pilotStorage: storage };
});
let fixture: Awaited<ReturnType<typeof restoreTargetFixture>>;
let runtime: Awaited<ReturnType<typeof packageRestoreTarget>> | undefined;
let source: Awaited<ReturnType<typeof natsFixture>>;
let admin: Pool;
let ownsGlobals = false;
let interrupted = false;
let imports = 0;
const databases = ['projections', 'handlers', 'openfga', 'pilot_replay', 'pilot_dump'];

async function storage() { return fixture.storage(); }
async function kube(args: string[], _deadline: number, input?: Buffer) {
  if (args[0] === 'scale' && args[1] === 'deployment/openfga') {
    if (args.includes('--replicas=1')) throw new Error('Stop after verified database replacement');
    return '{}';
  }
  if (args[0] === 'exec') {
    expect(input).toBeDefined();
    imports += 1;
    let sql = input!;
    if (interrupted) {
      const text = sql.toString('utf8');
      const firstData = text.indexOf('COPY public.');
      expect(firstData).toBeGreaterThan(0);
      // End only this importer's connection after its schema changes have committed.
      sql = Buffer.from(`${text.slice(0, firstData)}\n` +
        'SELECT pg_terminate_backend(pg_backend_pid());\n');
      interrupted = false;
    }
    return (await postgresFixtureCommand('psql', 'postgres', sql)).toString('utf8');
  }
  return fixture.kube(args);
}
function roleName(role: ReturnType<typeof packageDatabaseRoles>[number]) { return role.name; }
function projectionUrl() {
  const address = new URL(process.env['PG_TEST_URL']!);
  address.pathname = '/projections';
  return address.href;
}
async function resetGlobals() {
  for (const name of databases) await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  for (const role of packageDatabaseRoles()) await admin.query(`DROP ROLE IF EXISTS ${role.name}`);
}
async function setup() {
  fixture = await restoreTargetFixture();
  source = await natsFixture();
  admin = new Pool({ connectionString: process.env['PG_TEST_URL'] });
  for (const setting of ['PROJECTION_PASSWORD', 'SERVER_PASSWORD', 'DISPATCHER_PASSWORD',
    'OPENFGA_PASSWORD']) vi.stubEnv(setting, 'a'.repeat(64));
  const roles = packageDatabaseRoles().map(roleName);
  const existing = await admin.query('SELECT datname FROM pg_database WHERE datname=ANY($1)',
    [databases]);
  const accounts = await admin.query('SELECT rolname FROM pg_roles WHERE rolname=ANY($1)', [roles]);
  expect(existing.rows).toEqual([]);
  expect(accounts.rows).toEqual([]);
  ownsGlobals = true;
  interrupted = false;
  imports = 0;
  const budget = envelope('dev', 'budget-dev', 'budget.ceiling_set', { scope: 'global',
    dailyCeilingCents: 5000, ceilingCents: 500, defaultPayingGroupId: 'personal-default',
    setBy: 'installation' });
  await source.seed([budget]);
  expect(await source.store.head()).toBe(1);
}
async function cleanup() {
  await runtime?.close();
  runtime = undefined;
  if (ownsGlobals) await resetGlobals();
  ownsGlobals = false;
  await admin?.end();
  await source?.close();
  await fixture?.close();
  vi.unstubAllEnvs();
}
beforeEach(setup);
afterEach(cleanup);

async function dumpedDatabase(altered: boolean) {
  for (const role of packageDatabaseRoles()) await admin.query(`CREATE ROLE ${role.name}`);
  await admin.query('CREATE DATABASE projections OWNER projection');
  const content = new Pool({ connectionString: projectionUrl() });
  try {
    await replayPilotTables(pgDb(content), source.store, 1);
    if (altered) {
      await content.query("UPDATE model_budgets SET state=jsonb_set(state,'{ceilingCents}','501')");
    }
    const bytes = await postgresFixtureCommand('pg_dump', 'projections');
    const roles = [];
    for (const role of packageDatabaseRoles()) roles.push(`CREATE ROLE ${role.name};`);
    const prefix = `${roles.join('\n')}\nCREATE DATABASE handlers;\nCREATE DATABASE openfga;\n`;
    return Buffer.concat([Buffer.from(prefix), bytes]);
  } finally {
    await content.end();
  }
}
async function backupOptions(altered = false) {
  const bytes = await dumpedDatabase(altered);
  const options = await pilotBackupFixture(source.connection);
  const path = join(options.directory, options.id, 'manifest.json');
  const manifest = manifestSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  manifest.parts.database.byteCount = bytes.length;
  manifest.parts.database.sha256 = hashBackupBytes(bytes);
  await writeFile(join(options.directory, options.id, 'database'), bytes);
  await writeFile(path, JSON.stringify(manifest));
  await resetGlobals();
  for (const [name, value] of Object.entries(fixture.environment)) vi.stubEnv(name, value);
  vi.stubEnv('PROJECTION_DATABASE_URL', projectionUrl());
  runtime = await packageRestoreTarget(options);
  return options;
}
async function checkedMoney(expectedCents: number) {
  const content = new Pool({ connectionString: projectionUrl() });
  try {
    const money = await content.query<{ state: { ceilingCents: number } }>(
      'SELECT state FROM model_budgets');
    expect(money.rows[0]?.state.ceilingCents).toBe(expectedCents);
    await checkPilotCheckpoints(pgDb(content), 1);
  } finally {
    await content.end();
  }
  expect(await fixture.nats.store.head()).toBe(1);
  expect((await fixture.state()).opened).toBe(false);
}
async function refusesAlteredDump() {
  const options = await backupOptions(true);
  await expect(restorePilotBackup(options, runtime!.target)).rejects.toMatchObject({
    stage: 'database', cause: { message: 'Replayed content differs' },
  });
  await runtime!.close();
  runtime = undefined;
  await checkedMoney(501);
  expect(imports).toBe(1);
}
it('production database import refuses altered dumped cents before replacement or admission',
  refusesAlteredDump, 120_000);

async function resumesDatabaseStage(stage: string) {
  const options = await backupOptions();
  interrupted = stage === 'import';
  const message = interrupted ? 'PostgreSQL fixture operation failed'
    : 'Stop after verified database replacement';
  await expect(restorePilotBackup(options, runtime!.target)).rejects.toMatchObject({
    stage: 'database', cause: { message },
  });
  await runtime!.close();
  runtime = undefined;
  expect((await fixture.state()).opened).toBe(false);
  if (stage === 'import') {
    const partial = new Pool({ connectionString: projectionUrl() });
    try {
      const result = await partial.query('SELECT count(*)::int AS count FROM model_budgets');
      expect(result.rows).toEqual([{ count: 0 }]);
    } finally {
      await partial.end();
    }
  } else {
    await checkedMoney(500);
  }
  runtime = await packageRestoreTarget(options);
  await expect(restorePilotBackup(options, runtime.target)).rejects.toMatchObject({
    stage: 'database', cause: { message: 'Stop after verified database replacement' },
  });
  await runtime.close();
  runtime = undefined;
  await checkedMoney(500);
  expect(imports).toBe(2);
}
it.each(['import', 'replacement'])(
  'production restore resumes after interrupted database %s while admission stays closed',
  resumesDatabaseStage, 120_000);
