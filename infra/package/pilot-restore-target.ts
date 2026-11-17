import { Pool, type PoolClient } from 'pg';
import type { Client } from 'minio';
import { z } from 'zod';
import { connectNats, createEventStore } from '@opencrane/event-store';
import { rebuildMembers, deleteStoreById, type Binding } from '@opencrane/authz';
import { connectProjectionDb } from '@opencrane/projections';
import { fileUploadedDataSchema } from '@opencrane/events';
import { hashBackupBytes } from './backup-bytes.ts';
import { captureBounds, infoSchema, eventBackupMaximumBytes } from './event-backup.ts';
import { checkHistory, restoreOfflineEventBackup } from './event-restore.ts';
import { pilotDatabaseDetailsSchema, type CheckedPilotBackup } from './pilot-backup-contract.ts';
import { checkPilotCheckpoints, replayPilotDatabase } from './pilot-restore-database.ts';
import { restoreKube } from './pilot-restore-kube.ts';
import { packageDatabaseRoles } from './package-database.ts';
import { pilotStorage } from './pilot-storage.ts';
import { PilotRestoreRefused, type PilotRestoreOptions,
  type PilotRestoreTarget } from './pilot-restore.ts';

const environment = z.object({ POSTGRES_ADMIN_URL: z.url(), PROJECTION_DATABASE_URL: z.url(),
  HANDLER_DATABASE_URL: z.url(), SILO_ID: z.string().min(1),
  RUNTIME_SECRET: z.string().regex(/^[a-z0-9-]+$/u),
  KUBE_NAMESPACE: z.string().regex(/^[a-z0-9-]+$/u) });
const metadata = z.object({ name: z.string(), uid: z.string().min(1) });
const resource = z.object({ metadata });
const inventory = z.object({ items: z.array(resource) });
const held = ['server', 'worker-dispatcher', 'worker-members', 'worker-mcp-catalogue',
  'worker-computers', 'worker-conversations', 'worker-files', 'worker-budgets',
  'worker-audit', 'backup-catalogue'];
const claimNames = ['backups', 'pilot-restore', 'data-nats-0', 'data-postgres-0', 'data-objects-0'];

export async function packageRestoreTarget(options: PilotRestoreOptions) {
  const connection = await connectNats();
  try {
    const store = await createEventStore(connection);
    const target = new PackageRestoreTarget(options, connection, store);
    async function close() { await target.close(); }
    return { target, close };
  } catch (cause) {
    await connection.close();
    throw new Error('Restore target unavailable', { cause });
  }
}

class PackageRestoreTarget implements PilotRestoreTarget {
  private readonly options: PilotRestoreOptions;
  private readonly connection: Awaited<ReturnType<typeof connectNats>>;
  private readonly store: Awaited<ReturnType<typeof createEventStore>>;
  private readonly env = environment.parse(process.env);
  private readonly admin = new Pool({ connectionString: this.env.POSTGRES_ADMIN_URL,
    connectionTimeoutMillis: 2000, query_timeout: 5000 });
  private readonly deadline = Date.now() + 480_000;
  private objects: Client | undefined;
  private failure: Error | undefined;

  constructor(options: PilotRestoreOptions, connection: Awaited<ReturnType<typeof connectNats>>,
    store: Awaited<ReturnType<typeof createEventStore>>) {
    this.options = options;
    this.connection = connection;
    this.store = store;
    if (options.silo !== this.env.SILO_ID) throw new Error('Restore silo differs');
    this.admin.on('error', this.disconnected.bind(this));
  }
  private disconnected(cause: Error) {
    this.failure = new Error('Restore database connection lost', { cause });
  }
  private check() {
    if (this.failure) throw this.failure;
    if (Date.now() >= this.deadline) throw new Error('Restore deadline exceeded');
  }
  private kube(args: string[], input?: Buffer) {
    this.check();
    return restoreKube(args, this.deadline, input);
  }
  private async storage() {
    this.check();
    if (!this.objects) this.objects = await pilotStorage(this.deadline);
    return this.objects;
  }
  async acquire() {
    const client = await this.admin.connect();
    client.on('error', this.disconnected.bind(this));
    try {
      const result = await client.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock(hashtext('pilot_restore')) AS locked");
      if (!result.rows[0]?.locked) throw new PilotRestoreRefused('concurrent', 'lock');
      return releaseRestoreLock.bind(null, client);
    } catch (cause) {
      client.release();
      throw cause;
    }
  }

  async identity() {
    const account = resource.parse(JSON.parse(
      await this.kube(['get', 'serviceaccount', 'package-restore', '-o', 'json'])));
    const claims = inventory.parse(JSON.parse(
      await this.kube(['get', 'pvc', ...claimNames, '-o', 'json'])));
    const result: Record<string, string> = { namespace: this.env.KUBE_NAMESPACE,
      account: account.metadata.uid };
    for (const claim of claims.items) result[claim.metadata.name] = claim.metadata.uid;
    if (claims.items.length !== claimNames.length) throw new Error('Restore claims differ');
    return result;
  }
  async requireIsolated() { await this.heldDeployments(false); }
  async hold() {
    await this.heldDeployments(true);
    await this.kube(['scale', 'deployment/server', '--replicas=0']);
    await this.kube(['wait', '--for=delete', 'pod', '-l', 'app=server', '--timeout=60s']);
    await this.requireIsolated();
  }

  private async heldDeployments(allowServer: boolean) {
    const container = z.object({ name: z.string(),
      env: z.array(z.object({ name: z.string(), value: z.string().optional() })).optional() });
    const deployment = z.object({ metadata, spec: z.object({ replicas: z.number().int(),
      template: z.object({ spec: z.object({ containers: z.array(container) }) }) }) });
    const list = z.object({ items: z.array(deployment) }).parse(JSON.parse(
      await this.kube(['get', 'deployments', ...held, '-o', 'json'])));
    for (const item of list.items) {
      const allowed = allowServer && item.metadata.name === 'server' ? 1 : 0;
      if (item.spec.replicas > allowed) throw new Error('Restore admission is active');
      if (item.metadata.name !== 'server') continue;
      let readOnly = false;
      for (const entry of item.spec.template.spec.containers) {
        if (entry.name === 'models') throw new Error('Restore effects are active');
        if (entry.name !== 'server') continue;
        for (const setting of entry.env ?? []) {
          if (setting.name === 'PILOT_RESTORE_READ_ONLY' && setting.value === 'true') readOnly = true;
        }
      }
      if (!readOnly) throw new Error('Restore read-only admission is absent');
    }
    const stopped = allowServer ? held.slice(1) : held;
    const selector = `app in (${stopped.join(',')})`;
    const pods = inventory.parse(JSON.parse(
      await this.kube(['get', 'pods', '-l', selector, '-o', 'json'])));
    if (pods.items.length) throw new Error('Restore writers remain');
  }
  async empty() {
    const reply = await this.connection.request('$JS.API.STREAM.INFO.EVENTS', '{}', { timeout: 2000 });
    const absent = z.object({ error: z.object({ code: z.literal(404), err_code: z.literal(10059) }) });
    if (!absent.safeParse(reply.json()).success) return false;
    const databases = await this.admin.query<{ datname: string }>(
      'SELECT datname FROM pg_database WHERE NOT datistemplate');
    if (databases.rows.length !== 1 || databases.rows[0]?.datname !== 'postgres') return false;
    const roles = await this.admin.query(
      "SELECT 1 FROM pg_roles WHERE rolname !~ '^pg_' AND rolname <> 'postgres'");
    const tables = await this.admin.query(
      "SELECT 1 FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema')");
    if (roles.rows.length || tables.rows.length) return false;
    const objects = await this.storage();
    for await (const _object of objects.listObjectsV2('files', '', true)) return false;
    return true;
  }
  async events(backup: CheckedPilotBackup) {
    const options = { directory: '', silo: this.options.silo, disposable: true, resume: true };
    await restoreOfflineEventBackup(this.connection, backup.events, backup.bytes.events, options);
  }
  async database(backup: CheckedPilotBackup) {
    await this.kube(['scale', 'deployment/openfga', '--replicas=0']);
    await this.kube(['wait', '--for=delete', 'pod', '-l', 'app=openfga', '--timeout=60s']);
    // Reset only named resources in this journal's isolated, originally empty installation.
    for (const name of ['projections', 'handlers', 'openfga', 'pilot_replay', 'pilot_dump']) {
      await this.admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    }
    for (const role of packageDatabaseRoles()) {
      await this.admin.query(`DROP ROLE IF EXISTS ${role.name}`);
    }
    const dump = backup.bytes.database.toString('utf8');
    // PostgreSQL supplies this administrative role before any application data is loaded.
    const sql = dump.replace(/^CREATE ROLE postgres;\r?\n/gmu, '');
    await this.kube(['exec', '-i', 'postgres-0', '--', 'psql', '-U', 'postgres',
      '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '--no-password'], Buffer.from(sql));
    for (const role of packageDatabaseRoles()) {
      await this.admin.query(`ALTER ROLE ${role.name} PASSWORD '${role.password}'`);
    }
    await replayPilotDatabase(this.admin, this.env.PROJECTION_DATABASE_URL,
      this.store, backup.manifest.point.sequence, true);
    await this.kube(['scale', 'deployment/openfga', '--replicas=1']);
    await this.kube(['rollout', 'status', 'deployment/openfga', '--timeout=60s']);
    const original: Binding = { silo: this.options.silo, apiUrl: 'http://openfga:8080',
      storeId: backup.database.access.storeId, authorizationModelId: backup.database.access.modelId };
    const replayed = await rebuildMembers(original.apiUrl, original.silo, this.store,
      { verifyAgainst: original });
    await this.patchRuntime({ OPENFGA_STORE_ID: replayed.binding.storeId,
      OPENFGA_MODEL_ID: replayed.binding.authorizationModelId });
  }
  private async patchRuntime(stringData: Record<string, string>) {
    const patch = Buffer.from(JSON.stringify({ stringData }));
    await this.kube(['patch', 'secret', this.env.RUNTIME_SECRET, '--type=merge',
      '--patch-file=/dev/stdin'], patch);
  }
  private async binding(): Promise<Binding> {
    const secret = z.object({ data: z.record(z.string(), z.string()) }).parse(JSON.parse(
      await this.kube(['get', 'secret', this.env.RUNTIME_SECRET, '-o', 'json'])));
    const store = secret.data['OPENFGA_STORE_ID'];
    const model = secret.data['OPENFGA_MODEL_ID'];
    if (!store || !model) throw new Error('Restored access binding absent');
    const access = pilotDatabaseDetailsSchema.shape.access.parse({
      storeId: Buffer.from(store, 'base64').toString('utf8'),
      modelId: Buffer.from(model, 'base64').toString('utf8') });
    return { silo: this.options.silo, apiUrl: 'http://openfga:8080',
      storeId: access.storeId, authorizationModelId: access.modelId };
  }
  async files(backup: CheckedPilotBackup) {
    const present = await this.checkedFiles(backup);
    const objects = await this.storage();
    for (const entry of backup.files.objects) {
      if (present.has(entry.key)) continue;
      const bytes = backup.objects.get(entry.key);
      if (!bytes) throw new Error('Checked file absent');
      await objects.putObject('files', entry.key, bytes, bytes.length);
      await checkStoredObject(objects, entry);
    }
  }
  private async checkedFiles(backup: CheckedPilotBackup) {
    const content = connectProjectionDb(this.env.PROJECTION_DATABASE_URL, this.disconnected.bind(this));
    try {
      const references = await content.db.query<{ data: unknown }>(
        'SELECT data FROM conversation_files WHERE silo=$1', [this.options.silo]);
      const expected = new Map<string, CheckedPilotBackup['files']['objects'][number]>();
      for (const { data } of references.rows) {
        const file = fileUploadedDataSchema.parse(data);
        const previous = expected.get(file.objectKey);
        if (previous && (previous.byteCount !== file.size || previous.sha256 !== file.sha256)) {
          throw new Error('Conflicting event file references');
        }
        expected.set(file.objectKey, { key: file.objectKey, byteCount: file.size, sha256: file.sha256 });
      }
      if (expected.size !== backup.objects.size) throw new Error('Event file inventory differs');
      const present = new Set<string>();
      const objects = await this.storage();
      for await (const object of objects.listObjectsV2('files', '', true)) {
        const key = z.string().min(1).parse(object.name);
        const entry = expected.get(key);
        if (!entry || present.has(key)) throw new Error('Foreign file in restore target');
        await checkStoredObject(objects, entry);
        present.add(key);
      }
      for (const entry of backup.files.objects) {
        const event = expected.get(entry.key);
        if (!event || event.byteCount !== entry.byteCount || event.sha256 !== entry.sha256) {
          throw new Error('File differs from events');
        }
      }
      return present;
    } finally {
      await content.close();
    }
  }
  async verify(backup: CheckedPilotBackup) {
    this.check();
    const bounds = captureBounds(this.connection, {});
    try {
      const info = infoSchema.parse(await bounds.request('$JS.API.STREAM.INFO.EVENTS', {}));
      await checkHistory(bounds, { ...backup.events, created: info.created }, eventBackupMaximumBytes);
    } finally {
      bounds.dispose();
    }
    await replayPilotDatabase(this.admin, this.env.PROJECTION_DATABASE_URL,
      this.store, backup.manifest.point.sequence, false);
    const content = connectProjectionDb(this.env.PROJECTION_DATABASE_URL, this.disconnected.bind(this));
    const handlers = new Pool({ connectionString: this.env.HANDLER_DATABASE_URL,
      connectionTimeoutMillis: 2000, query_timeout: 5000 });
    try {
      await checkPilotCheckpoints(content.db, backup.manifest.point.sequence);
      const dispatcher = await handlers.query<{ sequence: string }>(
        'SELECT sequence::text FROM handler_dispatcher WHERE id=1');
      if (Number(dispatcher.rows[0]?.sequence) !== backup.manifest.point.checkpoints['dispatcher']) {
        throw new Error('Delivery checkpoint differs');
      }
    } finally {
      await Promise.all([content.close(), handlers.end()]);
    }
    const binding = await this.binding();
    const replayed = await rebuildMembers(binding.apiUrl, binding.silo, this.store,
      { verifyAgainst: binding });
    await deleteStoreById(binding.apiUrl, replayed.binding.storeId);
    if ((await this.checkedFiles(backup)).size !== backup.objects.size ||
        await this.store.head() !== backup.manifest.point.sequence) throw new Error('Restore changed');
    this.check();
  }
  async open(_backup: CheckedPilotBackup) {
    await this.heldDeployments(true);
    await this.patchRuntime({ OWNER_BOOTSTRAP_READY: 'ready' });
    await this.kube(['scale', 'deployment/server', '--replicas=1']);
    await this.kube(['rollout', 'status', 'deployment/server', '--timeout=60s']);
    this.check();
  }
  async close() {
    await Promise.all([this.admin.end(), this.connection.close()]);
  }
}

async function releaseRestoreLock(client: PoolClient) {
  try {
    await client.query("SELECT pg_advisory_unlock(hashtext('pilot_restore'))");
  } finally {
    client.release();
  }
}

async function checkStoredObject(client: Client,
  expected: CheckedPilotBackup['files']['objects'][number]) {
  const stream = await client.getObject('files', expected.key);
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of stream) {
    if (!Buffer.isBuffer(chunk)) throw new Error('Stored object bytes refused');
    length += chunk.length;
    if (length > expected.byteCount) {
      stream.destroy();
      throw new Error('Stored object length differs');
    }
    chunks.push(chunk);
  }
  if (length !== expected.byteCount || hashBackupBytes(Buffer.concat(chunks)) !== expected.sha256) {
    throw new Error('Stored object checksum differs');
  }
}
