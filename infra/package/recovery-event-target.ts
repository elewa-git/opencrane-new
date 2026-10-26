import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { connect, type NatsConnection } from '@nats-io/transport-node';

interface Target {
  silo: string;
  serverId: string;
  claimed: boolean;
  running: () => boolean;
}
const targets = new WeakMap<NatsConnection, Target>();

/** Start one empty local event store with a private token unavailable to product processes. */
export async function provisionRecoveryEventTarget(silo: string) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(silo)) throw new Error('Recovery owner refused');
  const directory = await mkdtemp(join(tmpdir(), 'recovery-events-'));
  const token = randomBytes(32).toString('hex');
  const configuration = { host: '127.0.0.1', port: -1, authorization: { token },
    jetstream: { store_dir: directory } };
  const configPath = join(directory, 'server.conf');
  await writeFile(configPath, JSON.stringify(configuration), { mode: 0o600 });
  const child = spawn(resolve('.tools/nats-server'), ['-c', configPath],
    { stdio: ['ignore', 'ignore', 'pipe'] });
  const exited = once(child, 'close');
  void exited.catch(ignoreFailure);
  let connection: NatsConnection | undefined;
  let closed = false;
  function running() {
    return !closed && child.exitCode === null && child.signalCode === null;
  }
  async function close() {
    if (closed) return;
    closed = true;
    try {
      await connection?.close();
    } finally {
      child.kill('SIGKILL');
      await exited.catch(ignoreFailure);
      await rm(directory, { recursive: true, force: true });
    }
  }
  try {
    const ready = Promise.withResolvers<number>();
    function failed() {
      ready.reject(new Error('Recovery event target unavailable'));
    }
    let output = '';
    function received(bytes: Buffer) {
      output += bytes.toString();
      if (output.length > 64 * 1024) return failed();
      const port = /Listening for client connections on 127\.0\.0\.1:(\d+)/.exec(output)?.[1];
      if (port && output.includes('Server is ready')) ready.resolve(Number(port));
    }
    child.stderr.on('data', received);
    child.once('error', failed);
    child.once('exit', failed);
    const timer = setTimeout(failed, 10_000);
    let port: number;
    try {
      port = await ready.promise;
      await rm(configPath);
    } finally {
      clearTimeout(timer);
      child.stderr.removeListener('data', received);
    }
    const connectionOptions = { servers: `127.0.0.1:${port}`, token,
      reconnect: false, timeout: 2_000 };
    connection = await connect(connectionOptions);
    const serverId = connection.info?.server_id;
    if (!serverId || !running()) throw new Error('Recovery event target unavailable');
    const target = { silo, serverId, claimed: false, running };
    targets.set(connection, target);
    return { connection, close };
  } catch {
    await close();
    throw new Error('Recovery event target refused');
  }
}

/** Claim the actual private server once; declarations cannot authorise another connection. */
export function claimRecoveryEventTarget(connection: NatsConnection, silo: string) {
  const target = targets.get(connection);
  if (!target || target.silo !== silo || target.claimed) {
    throw new Error('Recovery event ownership refused');
  }
  target.claimed = true;
  const owned = target;
  function check() {
    if (!owned.running() || connection.isClosed() ||
        connection.info?.server_id !== owned.serverId) {
      throw new Error('Recovery event ownership lost');
    }
  }
  check();
  return check;
}
function ignoreFailure() {}
