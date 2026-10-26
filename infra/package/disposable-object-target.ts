import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { AssumeRoleProvider } from 'minio/dist/esm/AssumeRoleProvider.mjs';
import { storageClient } from '../../apps/server/src/files/storage.ts';

const execute = promisify(execFile);
const image = 'mirror.gcr.io/alpine/minio:RELEASE.2025-10-15T17-29-55Z@sha256:' +
  'cf23643a6cf9ce159c57643ceb88279e431262282428c9e0bf3a7ef1a97e84b4';
type Storage = ReturnType<typeof storageClient>;
interface Target {
  silo: string;
  name: string;
  marker: Buffer;
  claimed: boolean;
  closed: boolean;
}
// Accept only instances created here, with fresh credentials unavailable to product processes.
const targets = new WeakMap<Storage, Target>();

async function docker(args: string[], signal?: AbortSignal) {
  const result = await execute('docker', args, { timeout: 30_000, maxBuffer: 64 * 1024, signal });
  return result.stdout.trim();
}

async function issueLease(endpoint: string, accessKey: string, secretKey: string) {
  const provider = new AssumeRoleProvider({ stsEndpoint: endpoint, accessKey, secretKey,
    durationSeconds: 900 });
  const configuration = provider.getRequestConfig.bind(provider);
  function boundedConfiguration() {
    const request = configuration();
    request.requestOptions.signal = AbortSignal.timeout(1_000);
    return request;
  }
  provider.getRequestConfig = boundedConfiguration;
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      return await provider.getCredentials();
    } catch {
      if (Date.now() >= deadline) throw new Error('Disposable storage did not start');
      await delay(100);
    }
  }
}

/** Create storage for one local recovery attempt, without mounting or starting a product stack. */
export async function provisionDisposableObjectTarget(silo: string) {
  if (!silo || silo.length > 256) throw new Error('Invalid disposable storage owner');
  const directory = await mkdtemp(`${tmpdir()}/object-target-`);
  const name = `restore-minio-${randomUUID()}`;
  const marker = Buffer.from(JSON.stringify({ silo, instance: randomUUID() }));
  const state: Target = { silo, name, marker, claimed: false, closed: false };
  let created = false;
  async function close() {
    if (state.closed) return;
    state.closed = true;
    try {
      if (created) await docker(['rm', '-f', '-v', name]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  try {
    const accessKey = randomBytes(24).toString('hex');
    const secretKey = randomBytes(32).toString('hex');
    const environment = `MINIO_ROOT_USER=${accessKey}\nMINIO_ROOT_PASSWORD=${secretKey}\n`;
    const environmentFile = `${directory}/environment`;
    await writeFile(environmentFile, environment, { mode: 0o600 });
    await docker(['run', '-d', '--user', '0:0', '--name', name, '-p', '127.0.0.1::9000',
      '--env-file', environmentFile, image, 'server', '/data']);
    created = true;
    await rm(environmentFile);
    const address = await docker(['port', name, '9000/tcp']);
    if (!/^127\.0\.0\.1:\d+$/.test(address)) throw new Error('Invalid disposable storage port');
    const endpoint = `http://${address}`;
    const lease = await issueLease(endpoint, accessKey, secretKey);
    const leaseFile = `${directory}/lease`;
    await writeFile(leaseFile, JSON.stringify({ ...lease, expiresAt: Date.now() + 840_000 }),
      { mode: 0o600 });
    const client = storageClient(endpoint, leaseFile);
    await client.makeBucket('opencrane-restore');
    await client.putObject('opencrane-restore', 'owner', marker);
    targets.set(client, state);
    return { client, close, name };
  } catch {
    await close();
    throw new Error('Disposable storage provisioning refused');
  }
}

/** Reserve this instance once and verify its destination before any restored bytes are sent. */
export function claimDisposableObjectTarget(client: Storage, silo: string, signal: AbortSignal) {
  const state = targets.get(client);
  if (!state || state.silo !== silo || state.closed || state.claimed) {
    throw new Error('Disposable storage claim refused');
  }
  state.claimed = true;
  const target = state;
  async function check() {
    signal.throwIfAborted();
    if (target.closed) throw new Error('Disposable storage closed');
    // Check the real container, not a caller's assertion that product processes are stopped.
    const processes = await docker(['top', target.name, '-eo', 'pid,comm'], signal);
    const rows = processes.split('\n');
    if (rows.length !== 2 || !/^\d+\s+minio$/.test(rows[1]?.trim() ?? '')) {
      throw new Error('Disposable storage has another running process');
    }
    const address = await docker(['port', target.name, '9000/tcp'], signal);
    if (`http://${address}` !== client.endpoint) throw new Error('Disposable storage moved');
    const response = await client.getObject('opencrane-restore', 'owner');
    const chunks: Buffer[] = [];
    let count = 0;
    try {
      for await (const chunk of response) {
        if (!Buffer.isBuffer(chunk)) throw new Error('Invalid disposable storage marker');
        count += chunk.length;
        if (count > target.marker.length) throw new Error('Invalid disposable storage marker');
        chunks.push(chunk);
      }
      if (!Buffer.concat(chunks).equals(target.marker)) {
        throw new Error('Disposable storage owner changed');
      }
    } finally {
      response.destroy();
    }
  }
  return check;
}
