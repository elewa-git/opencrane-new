import { execFile } from 'node:child_process';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { Pool } from 'pg';
import { Client } from 'minio';
import { connectNats } from '@opencrane/event-store';
import { budgets } from '@opencrane/models';
import { members, mcpCatalogue, computers, conversations, files, auditTrail,
  personalSettings, groups, providers, modelAccess, egressPolicy, connectionProfiles,
  childRequests } from '@opencrane/projections';
import { hashBackupBytes } from './scheduled-backup.ts';
import { readStorageLease } from '@opencrane/auth';
import { z } from 'zod';
import { collectEventBackup, descriptorSchema, infoSchema } from './event-backup.ts';
import { issueObjectLease, storageTransport } from './object-credentials.mjs';
import type { BackupPoint, BackupSource, ScheduledBackupOptions } from './scheduled-backup.ts';

const execute = promisify(execFile);
const deploymentSchema = z.object({ spec: z.object({ replicas: z.literal(1) }) });
const podsSchema = z.object({ items: z.array(z.unknown()) });
const projections = [members.name, mcpCatalogue.name, computers.name, conversations.name,
  files.name, budgets.name, auditTrail.name, personalSettings.name, groups.name, providers.name,
  modelAccess.name, egressPolicy.name, connectionProfiles.name, childRequests.name];
const admission = ['server', 'worker-dispatcher'];
const readers = ['worker-members', 'worker-mcp-catalogue', 'worker-computers',
  'worker-conversations', 'worker-files', 'worker-budgets', 'worker-audit', 'openfga'];

export async function packageBackupSource(options: ScheduledBackupOptions) {
  const connection = await connectNats();
  const source = new PilotBackupSource(options, connection);
  async function close() {
    await source.close();
  }
  return { source, close };
}

class PilotBackupSource implements BackupSource {
  private readonly db = new Pool({ connectionString: process.env['POSTGRES_ADMIN_URL'],
    connectionTimeoutMillis: 2000, query_timeout: 5000 });
  private readonly saved = new Map<string, number>();
  private readonly deadline = Date.now() + 240_000;
  private point!: BackupPoint;
  private info!: ReturnType<typeof infoSchema.parse>;


  private readonly options: ScheduledBackupOptions;
  private readonly connection: Awaited<ReturnType<typeof connectNats>>;

  constructor(options: ScheduledBackupOptions,
    connection: Awaited<ReturnType<typeof connectNats>>) {
    this.options = options;
    this.connection = connection;
  }

  readonly parts = {
    events: this.events.bind(this), database: this.database.bind(this), files: this.files.bind(this),
  };

  private remaining() {
    const milliseconds = this.deadline - Date.now();
    if (milliseconds <= 0) throw new Error('Backup deadline');
    return Math.min(milliseconds, 60_000);
  }
  async kube(args: string[]) {
    const result = await execute('kubectl', args, { timeout: this.remaining(), maxBuffer: 134217728 });
    return result.stdout;
  }
  async podsGone(names: string[]) {
    while (true) {
      const selector = `app in (${names.join(',')})`;
      const pods = podsSchema.parse(JSON.parse(await this.kube(['get', 'pods', '-l', selector, '-o', 'json'])));
      if (pods.items.length === 0) return;
      await delay(500);
      this.remaining();
    }
  }
  async stop(names: string[]) {
    for (const name of names) {
      const deployment = deploymentSchema.parse(
        JSON.parse(await this.kube(['get', 'deployment', name, '-o', 'json'])));
      // Record before scaling so handled failures also restore an interrupted scale request.
      this.saved.set(name, deployment.spec.replicas);
      await this.kube(['scale', `deployment/${name}`, '--replicas=0', '--current-replicas=1']);
    }
    await this.podsGone(names);
  }
  async eventInfo() {
    const reply = await this.connection.request('$JS.API.STREAM.INFO.EVENTS', '{}', { timeout: 2000 });
    return infoSchema.parse(reply.json());
  }
  async checkpoints() {
    const projection = new Pool({ connectionString: process.env['PROJECTION_DATABASE_URL'],
      connectionTimeoutMillis: 2000, query_timeout: 5000 });
    const handler = new Pool({ connectionString: process.env['HANDLER_DATABASE_URL'],
      connectionTimeoutMillis: 2000, query_timeout: 5000 });
    try {
      const rows = await projection.query<{ name: string; sequence: string }>(
        'SELECT name, sequence::text FROM projection_checkpoints');
      const result: Record<string, number> = {};
      for (const row of rows.rows) result[row.name] = Number(row.sequence);
      const dispatch = await handler.query<{ sequence: string }>(
        'SELECT sequence::text FROM handler_dispatcher WHERE id=1');
      result['dispatcher'] = Number(dispatch.rows[0]?.sequence);
      return result;
    } finally {
      await projection.end();
      await handler.end();
    }
  }
  async pause() {
    await this.stop(admission);
    this.info = await this.eventInfo();
    let positions = await this.checkpoints();
    const sequence = this.info.state.last_seq;
    function caughtUp(name: string) {
      return positions[name] === sequence;
    }
    while (!projections.every(caughtUp)) {
      await delay(500);
      this.remaining();
      positions = await this.checkpoints();
    }
    await this.stop(readers);
    const lsn = await this.db.query<{ lsn: string }>('SELECT pg_current_wal_lsn()::text AS lsn');
    this.point = { sequence: this.info.state.last_seq, lsn: lsn.rows[0]!.lsn,
      checkpoints: await this.checkpoints() };
    return this.point;
  }
  async verify() {
    for (const name of this.saved.keys()) {
      const replicas = await this.kube(['get', 'deployment', name, '-o', 'jsonpath={.spec.replicas}']);
      if (replicas !== '0') throw new Error('Writer restarted');
    }
    await this.podsGone([...this.saved.keys()]);
    const current = await this.eventInfo();
    if (current.created !== this.info.created || current.state.last_seq !== this.point.sequence ||
        current.state.first_seq !== this.info.state.first_seq ||
        current.state.messages !== this.info.state.messages) throw new Error('Event history changed');
    const positions = await this.checkpoints();
    const clients = await this.db.query<{ count: string }>(
      "SELECT count(*)::text FROM pg_stat_activity WHERE backend_type='client backend' " +
      'AND pid <> pg_backend_pid()');
    if (clients.rows[0]?.count !== '0') throw new Error('Database writer remains');
    return { ...this.point, checkpoints: positions };
  }
  async resume() {
    const failed: string[] = [];
    for (const [name, replicas] of this.saved) {
      try {
        await execute('kubectl', ['scale', `deployment/${name}`, `--replicas=${replicas}`],
          { timeout: 5000 });
        this.saved.delete(name);
      } catch {
        failed.push(name);
      }
    }
    if (failed.length > 0) {
      const cause = { kind: 'backup_resume', deployments: failed };
      throw new Error('Backup replicas remain stopped', { cause });
    }
  }
  async events(destination: string) {
    const capture = `${destination}-capture`;
    try {
      await collectEventBackup(this.connection, { silo: this.options.silo, attempt: this.options.id,
        destination: capture, timeoutMs: this.remaining() });
      const descriptor = descriptorSchema.parse(
        JSON.parse(await readFile(join(capture, 'descriptor.json'), 'utf8')));
      if (descriptor.lastSequence !== this.point.sequence) throw new Error('Event position differs');
      await copyFile(join(capture, 'events.snapshot'), destination);
      return z.record(z.string(), z.json()).parse(descriptor);
    } finally {
      await rm(capture, { recursive: true, force: true });
    }
  }
  async database(destination: string) {
    const dump = await this.kube(['exec', 'postgres-0', '--', 'pg_dumpall', '-U', 'postgres',
      '--no-role-passwords', '--no-password']);
    await writeFile(destination, dump, { mode: 0o600, flag: 'wx', flush: true });
    const databases = await this.db.query<{ datname: string }>(
      'SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname');
    const names: string[] = [];
    for (const row of databases.rows) names.push(row.datname);
    return { databases: names, lsn: this.point.lsn };
  }
  async files(destination: string) {
    await mkdir('/tmp/backup-storage', { recursive: true, mode: 0o700 });
    const accessKey = await readFile('/run/object-owner/MINIO_ROOT_USER', 'utf8');
    const secretKey = await readFile('/run/object-owner/MINIO_ROOT_PASSWORD', 'utf8');
    const leaseFile = '/tmp/backup-storage/lease.json';
    await issueObjectLease({ accessKey, secretKey }, leaseFile, 'http://objects:9000');
    const lease = await readStorageLease(leaseFile);
    const client = new Client({ endPoint: 'objects', port: 9000, useSSL: false,
      accessKey: lease.accessKey, secretKey: lease.secretKey, sessionToken: lease.sessionToken,
      transport: storageTransport('http:', AbortSignal.timeout(this.remaining())),
      retryOptions: { disableRetry: true } });
    const objects: { key: string; byteCount: number; sha256: string }[] = [];
    const lines: string[] = [];
    let total = 0;
    for await (const object of client.listObjectsV2('files', '', true)) {
      this.remaining();
      const entrySchema = z.object({ name: z.string().min(1) });
      const objectEntry = entrySchema.parse(object);
      const stream = await client.getObject('files', objectEntry.name);
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        if (!Buffer.isBuffer(chunk)) throw new Error('Object bytes refused');
        total += chunk.length;
        if (total > 64 * 1024 * 1024) {
          stream.destroy();
          throw new Error('File limit');
        }
        chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks);
      const entry = { key: objectEntry.name, byteCount: bytes.length, sha256: hashBackupBytes(bytes) };
      objects.push(entry);
      lines.push(JSON.stringify({ ...entry, data: bytes.toString('base64') }));
    }
    await writeFile(destination, lines.join('\n'), { mode: 0o600, flag: 'wx', flush: true });
    return { bucket: 'files', objects };
  }
  async close() {
    await this.db.end();
    await this.connection.close();
  }

}
