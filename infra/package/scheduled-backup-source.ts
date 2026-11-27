import { pilotDatabaseDetailsSchema } from './pilot-backup-contract.ts';
import { execFile } from 'node:child_process';
import { copyFile, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { Client, Pool } from 'pg';
import { connectNats } from '@opencrane/event-store';
import { memoryProjectionSchema } from '@opencrane/projections';
import { pilotProjectionNames } from './pilot-projections.ts';
import { hashBackupBytes } from './backup-bytes.ts';
import { z } from 'zod';
import { collectEventBackup, descriptorSchema, infoSchema } from './event-backup.ts';
import { pilotStorage } from './pilot-storage.ts';
import {
  captureMemberKeys, pilotBackupKeyFile, pilotKeyDirectories, type MemberKeyDirectories,
} from './pilot-member-keys.ts';
import {
  checkPilotFileInventory, maximumPilotObjects, readPilotFileReferences,
} from './pilot-file-inventory.ts';
import type { BackupPoint, BackupSource, ScheduledBackupOptions } from './scheduled-backup.ts';

const execute = promisify(execFile);
const deploymentSchema = z.object({ spec: z.object({ replicas: z.literal(1) }) });
const podsSchema = z.object({ items: z.array(z.unknown()) });
const admission = ['server', 'worker-dispatcher'];
const readers = ['worker-members', 'worker-mcp-catalogue', 'worker-computers',
  'worker-conversations', 'worker-files', 'worker-budgets', 'worker-audit', 'openfga'];

function databaseConnection(variable: string) {
  return { connectionString: process.env[variable],
    connectionTimeoutMillis: 2000, query_timeout: 5000 };
}

type BackupKeyStorage = { file: string; directories: MemberKeyDirectories };
const installedBackupKeys = { file: pilotBackupKeyFile, directories: pilotKeyDirectories };

export async function packageBackupSource(options: ScheduledBackupOptions,
  keyStorage: BackupKeyStorage = installedBackupKeys) {
  const connection = await connectNats();
  const source = new PilotBackupSource(options, connection, keyStorage);
  async function close() {
    await source.close();
  }
  return { source, close };
}

class PilotBackupSource implements BackupSource {
  private readonly db = new Pool(databaseConnection('POSTGRES_ADMIN_URL'));
  private readonly saved = new Map<string, number>();
  private readonly deadline = Date.now() + 240_000;
  private point!: BackupPoint;
  private info!: ReturnType<typeof infoSchema.parse>;


  private readonly options: ScheduledBackupOptions;
  private readonly connection: Awaited<ReturnType<typeof connectNats>>;
  private readonly keyStorage: BackupKeyStorage;

  constructor(options: ScheduledBackupOptions,
    connection: Awaited<ReturnType<typeof connectNats>>, keyStorage: BackupKeyStorage) {
    this.options = options;
    this.connection = connection;
    this.keyStorage = keyStorage;
  }

  readonly parts = {
    events: this.events.bind(this), database: this.database.bind(this), files: this.files.bind(this),
    'member-keys': this.memberKeys.bind(this),
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
    const projection = new Client(databaseConnection('PROJECTION_DATABASE_URL'));
    const handler = new Client(databaseConnection('HANDLER_DATABASE_URL'));
    try {
      await projection.connect();
      const rows = await projection.query<{ name: string; sequence: string }>(
        'SELECT name, sequence::text FROM public.projection_checkpoints UNION ALL ' +
        `SELECT name, sequence::text FROM ${memoryProjectionSchema}.projection_checkpoints`);
      const result: Record<string, number> = {};
      for (const row of rows.rows) {
        result[row.name] = Number(row.sequence);
      }
      await handler.connect();
      const dispatch = await handler.query<{ sequence: string }>(
        'SELECT sequence::text FROM handler_dispatcher WHERE id=1');
      result['dispatcher'] = Number(dispatch.rows[0]?.sequence);
      return result;
    } finally {
      // Wait for both clients to disconnect before verification counts other connections.
      await Promise.all([projection.end(), handler.end()]);
    }
  }
  async pause() {
    await this.stop(admission);
    this.info = await this.eventInfo();
    let positions = await this.checkpoints();
    const sequence = this.info.state.last_seq;
    const projectionNames = [...pilotProjectionNames(this.options.providerMode), 'memory'];
    const readerNames = [...readers];
    if (this.options.providerMode) {
      readerNames.push('worker-routines');
    }
    function caughtUp(name: string) {
      return positions[name] === sequence;
    }
    while (!projectionNames.every(caughtUp)) {
      await delay(500);
      this.remaining();
      positions = await this.checkpoints();
    }
    await this.stop(readerNames);
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
    const failed = new Set<string>();
    for (const [name, replicas] of this.saved) {
      try {
        await execute('kubectl', ['scale', `deployment/${name}`, `--replicas=${replicas}`],
          { timeout: 5000 });
      } catch {
        failed.add(name);
      }
    }
    // Start all replacements before waiting, so dependent services can become ready together.
    const names = [...this.saved.keys()];
    const waitReady = this.waitReady.bind(this);
    const readiness = names.map(waitReady);
    const results = await Promise.allSettled(readiness);
    for (const [index, result] of results.entries()) {
      const name = names[index]!;
      if (result.status === 'rejected') failed.add(name);
      if (!failed.has(name)) this.saved.delete(name);
    }
    if (failed.size > 0) {
      const cause = { kind: 'backup_resume', deployments: [...failed] };
      throw new Error('Backup replicas remain stopped', { cause });
    }
  }
  private async waitReady(name: string) {
    // Bound recovery separately from capture, including when its deadline has expired.
    await execute('kubectl', ['rollout', 'status', `deployment/${name}`, '--timeout=60s'],
      { timeout: 65_000 });
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
    const access = { storeId: process.env['OPENFGA_STORE_ID'],
      modelId: process.env['OPENFGA_MODEL_ID'] };
    return pilotDatabaseDetailsSchema.parse({ databases: names, lsn: this.point.lsn, access });
  }
  private async memberKeys(destination: string) {
    this.remaining();
    const identity = { id: this.options.id, silo: this.options.silo, sequence: this.point.sequence };
    return captureMemberKeys(destination, identity, this.keyStorage.file, this.keyStorage.directories);
  }
  private async fileReferences() {
    // Read the event-backed table after its worker has caught up and all writers have stopped.
    const projection = new Client(databaseConnection('PROJECTION_DATABASE_URL'));
    try {
      await projection.connect();
      return await readPilotFileReferences(projection, this.options.silo);
    } finally {
      await projection.end();
    }
  }

  async files(destination: string) {
    const expected = await this.fileReferences();
    const client = await pilotStorage(this.deadline);
    const objects: { key: string; byteCount: number; sha256: string }[] = [];
    const lines: string[] = [];
    let total = 0;
    for await (const object of client.listObjectsV2('files', '', true)) {
      this.remaining();
      if (objects.length === maximumPilotObjects) throw new Error('Too many stored objects');
      const entrySchema = z.object({ name: z.string().min(1) });
      const objectEntry = entrySchema.parse(object);
      if (!expected.has(objectEntry.name)) throw new Error('Stored object has no event');
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
      const archivedObject = { ...entry, data: bytes.toString('base64') };
      const serialisedObject = JSON.stringify(archivedObject);
      lines.push(serialisedObject);
    }
    checkPilotFileInventory(expected, objects);
    await writeFile(destination, lines.join('\n'), { mode: 0o600, flag: 'wx', flush: true });
    return { bucket: 'files', objects };
  }
  async close() {
    await this.db.end();
    await this.connection.close();
  }

}
