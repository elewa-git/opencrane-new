import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { Pool } from 'pg';
import { z } from 'zod';
import { natsFixture } from '@opencrane/event-store/testing';
import { database } from '@opencrane/projections/testing';
import { pilotBackupFixture } from './pilot-restore-fixture.ts';
import { lockPackageTestRoles, unlockPackageTestRoles }
  from './pilot-restore-postgres-fixture.ts';

const held = ['server', 'worker-dispatcher', 'worker-members', 'worker-mcp-catalogue',
  'worker-computers', 'worker-conversations', 'worker-files', 'worker-budgets',
  'worker-audit', 'backup-catalogue'];
const stateSchema = z.object({ account: z.string(), identityReads: z.int(),
  writer: z.string().nullable(), pod: z.string().nullable(), readOnly: z.boolean(),
  reader: z.boolean(), models: z.boolean(), opened: z.boolean() });

async function kubernetesFixture(directory: string) {
  const kubeFile = join(directory, 'kube.json');
  await writeFile(kubeFile, JSON.stringify({ account: 'original-account', identityReads: 0,
    writer: null, pod: null, readOnly: true, reader: true, models: false, opened: false }));
  async function state() { return stateSchema.parse(JSON.parse(await readFile(kubeFile, 'utf8'))); }
  async function change(changes: Partial<z.infer<typeof stateSchema>>) {
    await writeFile(kubeFile, JSON.stringify({ ...await state(), ...changes }));
  }
  let beforeIdentity: (() => Promise<void>) | undefined;
  let beforeIsolation: (() => Promise<void>) | undefined;
  async function kube(args: string[]) {
    if (args[0] === 'scale' && args[1] === 'deployment/server') {
      const opened = args.includes('--replicas=1');
      await change({ opened, writer: opened ? 'server' : null });
      return '{}';
    }
    if (['patch', 'wait', 'rollout'].includes(args[0]!)) return '{}';
    if (args[0] !== 'get') throw new Error('Unexpected restore mutation');
    if (args[1] === 'serviceaccount') {
      await beforeIdentity?.();
      const saved = await state();
      await change({ identityReads: saved.identityReads + 1 });
      return JSON.stringify({ metadata: { name: 'package-restore', uid: saved.account } });
    }
    if (args[1] === 'pvc') {
      const items = [];
      for (const name of ['backups', 'pilot-restore', 'data-nats-0', 'data-postgres-0',
        'data-objects-0', 'personal-secrets', 'memory-secrets']) {
        items.push({ metadata: { name, uid: `uid-${name}` } });
      }
      return JSON.stringify({ items });
    }
    if (args[1] === 'deployments') {
      await beforeIsolation?.();
      const saved = await state();
      const items = [];
      for (const name of held) {
        const env = [{ name: 'PILOT_RESTORE_READ_ONLY', value: String(saved.readOnly) },
          { name: 'NATS_NKEY_SEED_FILE', value: saved.reader
            ? '/run/opencrane/files/projection.seed' : '/run/opencrane/files/command.seed' }];
        const containers = [{ name: 'server', env }];
        if (saved.models) containers.push({ name: 'models', env: [] });
        items.push({ metadata: { name, uid: `uid-${name}` }, spec: {
          replicas: saved.writer === name ? 1 : 0, template: { spec: { containers } } } });
      }
      return JSON.stringify({ items });
    }
    if (args[1] === 'pods') {
      const saved = await state();
      const items = saved.pod ? [{ metadata: { name: saved.pod, uid: 'writer-pod' } }] : [];
      return JSON.stringify({ items });
    }
    throw new Error('Unexpected Kubernetes read');
  }
  return { kube, state, change,
    onIdentity(action: () => Promise<void>) { beforeIdentity = action; },
    onIsolation(action: () => Promise<void>) { beforeIsolation = action; } };
}

async function objectFixture(directory: string) {
  const objectDirectory = join(directory, 'objects');
  await mkdir(objectDirectory);
  async function listObjectsV2() {
    const names = await readdir(objectDirectory);
    const objects = [];
    for (const name of names) objects.push({ name });
    return Readable.from(objects);
  }
  // Match MinIO's synchronous list stream and asynchronous byte reads at the service boundary.
  function listObjects() {
    async function* entries() {
      const stream = await listObjectsV2();
      yield* stream;
    }
    return Readable.from(entries());
  }
  function getObject(_bucket: string, key: string) {
    return Promise.resolve(createReadStream(join(objectDirectory, key)));
  }
  let corruptWrites = false;
  async function putObject(_bucket: string, key: string, bytes: Buffer) {
    const saved = Buffer.from(bytes);
    if (corruptWrites) saved[0] = saved[0]! ^ 1;
    await writeFile(join(objectDirectory, key), saved);
  }
  function storage() { return Promise.resolve({ listObjectsV2: listObjects, getObject, putObject }); }
  async function snapshot() {
    const objects: Record<string, string> = {};
    for (const name of await readdir(objectDirectory)) {
      const bytes = await readFile(join(objectDirectory, name));
      objects[name] = bytes.toString('base64');
    }
    return objects;
  }
  return { objectDirectory, storage, putObject, snapshot,
    corruptObjectWrites(this: void) { corruptWrites = true; } };
}

async function targetDatabaseFixture() {
  const content = await database('pg');
  const admin = new Pool({ connectionString: process.env['PG_TEST_URL'] });
  const coordination = await admin.connect();
  await lockPackageTestRoles(coordination);
  const inventory = await content.db.query<{ name: string }>('SELECT current_database() AS name');
  const contentUrl = new URL(process.env['PG_TEST_URL']!);
  contentUrl.pathname = `/${inventory.rows[0]!.name}`;
  const suffix = randomUUID().replaceAll('-', '');
  const role = `pilot_role_${suffix}`;
  const application = `pilot_application_${suffix}`;
  // Scope real catalogue queries to this fixture's databases and roles on shared PostgreSQL.
  // Represent its disposable administrative database as the empty target's postgres database.
  await content.db.query('CREATE SCHEMA restore_fixture');
  await content.db.query(`CREATE VIEW restore_fixture.pg_database AS
    SELECT 'postgres'::name AS datname, false AS datistemplate UNION ALL
    SELECT datname, datistemplate FROM pg_catalog.pg_database WHERE datname='${application}'`);
  await content.db.query(`CREATE VIEW restore_fixture.pg_roles AS
    SELECT * FROM pg_catalog.pg_roles WHERE rolname IN ('postgres', '${role}')`);
  await content.db.query(`CREATE VIEW restore_fixture.pg_tables AS
    SELECT * FROM pg_catalog.pg_tables WHERE schemaname='public'`);
  const adminUrl = new URL(contentUrl);
  adminUrl.searchParams.set('options', '-csearch_path=restore_fixture,pg_catalog,public');
  async function snapshot() {
    const tables = await content.db.query<{ tablename: string }>(
      "SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname='public' ORDER BY tablename");
    const rows: Record<string, unknown[]> = {};
    for (const { tablename } of tables.rows) {
      rows[tablename] = (await content.db.query(
        `SELECT * FROM "${tablename}" t ORDER BY to_jsonb(t)`)).rows;
    }
    const roles = await admin.query('SELECT rolname FROM pg_roles WHERE rolname=$1', [role]);
    const databases = await admin.query('SELECT datname FROM pg_database WHERE datname=$1',
      [application]);
    return { rows, roles: roles.rows, databases: databases.rows };
  }
  async function nonEmpty(kind: string) {
    if (kind === 'role') await admin.query(`CREATE ROLE ${role}`);
    if (kind === 'database') await admin.query(`CREATE DATABASE ${application}`);
    if (kind === 'table') {
      await content.db.query('CREATE TABLE retained_application (amount_cents INTEGER)');
      await content.db.query('INSERT INTO retained_application VALUES (1234)');
    }
  }
  async function close() {
    await admin.query(`DROP DATABASE IF EXISTS ${application} WITH (FORCE)`);
    await admin.query(`DROP ROLE IF EXISTS ${role}`);
    await content.close();
    await unlockPackageTestRoles(coordination);
    coordination.release();
    await admin.end();
  }
  return { content, adminUrl, contentUrl, snapshot, nonEmpty, close };
}

export async function restoreTargetFixture() {
  const directory = await mkdtemp('/tmp/pilot-target-');
  const nats = await natsFixture({ provision: false });
  const databases = await targetDatabaseFixture();
  const objects = await objectFixture(directory);
  const kubernetes = await kubernetesFixture(directory);
  async function snapshot() {
    const saved = await databases.snapshot();
    const files = await objects.snapshot();
    const info = await nats.connection.request('$JS.API.STREAM.INFO.EVENTS', '{}');
    const events = z.object({ state: z.unknown().optional(), error: z.unknown().optional() })
      .parse(info.json());
    const history = [];
    if (events.state) {
      for await (const row of nats.store.readStream('member-alice')) history.push(row);
    }
    return { ...saved, objects: files, events, history };
  }
  async function nonEmpty(kind: string) {
    if (kind === 'event stream') await nats.store.ensureStream({ replicas: 1 });
    if (kind === 'object') await objects.putObject('files', 'retained', Buffer.from('retained bytes'));
    await databases.nonEmpty(kind);
  }
  async function close() {
    await databases.close();
    await nats.close();
    await rm(directory, { recursive: true, force: true });
  }
  const environment = { ...nats.env(), POSTGRES_ADMIN_URL: databases.adminUrl.href,
    PROJECTION_DATABASE_URL: databases.contentUrl.href,
    HANDLER_DATABASE_URL: databases.contentUrl.href,
    MEMORY_PROJECTION_SCHEMA: 'opencrane_memory',
    SILO_ID: 'dev', RUNTIME_SECRET: 'runtime', KUBE_NAMESPACE: 'restore-test' };
  const options = await pilotBackupFixture();
  return { nats, content: databases.content, options, directory,
    objectDirectory: objects.objectDirectory, environment,
    ...kubernetes, storage: objects.storage, corruptObjectWrites: objects.corruptObjectWrites,
    snapshot, nonEmpty, close };
}
