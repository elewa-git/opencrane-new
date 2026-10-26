import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
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
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(silo)) {
    throw new Error('Recovery owner refused');
  }
  let directory: string | undefined;
  let child: ChildProcess | undefined;
  let exited: Promise<unknown> | undefined;
  let connection: NatsConnection | undefined;
  let closed = false;

  function running() {
    if (closed || !child) {
      return false;
    }
    return child.exitCode === null && child.signalCode === null;
  }

  async function close() {
    if (closed) {
      return;
    }
    closed = true;
    try {
      try {
        await connection?.close();
      } finally {
        try {
          child?.kill('SIGKILL');
          await exited?.catch(ignoreFailure);
        } finally {
          if (directory) {
            await rm(directory, { recursive: true, force: true });
          }
        }
      }
    } catch {
      throw new Error('Recovery event target cleanup refused');
    }
  }

  try {
    directory = await mkdtemp(join(tmpdir(), 'recovery-events-'));
    const token = randomBytes(32).toString('hex');
    const configuration = {
      host: '127.0.0.1',
      port: -1,
      authorization: { token },
      jetstream: { store_dir: directory },
    };
    const configPath = join(directory, 'server.conf');
    await writeFile(configPath, JSON.stringify(configuration), { mode: 0o600 });
    // Keep the private directory out of process arguments, which local observers can read.
    const spawnOptions: SpawnOptions = {
      cwd: directory,
      stdio: ['ignore', 'ignore', 'pipe'],
    };
    child = spawn(resolve('.tools/nats-server'), ['-c', 'server.conf'], spawnOptions);
    exited = once(child, 'close');
    void exited.catch(ignoreFailure);
    const port = await waitForPort(child);
    await rm(configPath);
    const connectionOptions = {
      servers: `127.0.0.1:${port}`,
      token,
      reconnect: false,
      timeout: 2_000,
    };
    connection = await connect(connectionOptions);
    const serverId = connection.info?.server_id;
    if (!serverId || !running()) {
      throw new Error('Recovery event target unavailable');
    }
    const target = { silo, serverId, claimed: false, running };
    targets.set(connection, target);
    return { connection, close };
  } catch {
    // Attempt every cleanup step without replacing the original fixed refusal.
    await close().catch(ignoreFailure);
    throw new Error('Recovery event target refused');
  }
}

async function waitForPort(child: ChildProcess) {
  const stderr = child.stderr;
  if (!stderr) {
    throw new Error('Recovery event target unavailable');
  }
  const ready = Promise.withResolvers<number>();
  function failed() {
    ready.reject(new Error('Recovery event target unavailable'));
  }
  let output = '';
  function received(bytes: Buffer) {
    output += bytes.toString();
    if (output.length > 64 * 1024) {
      return failed();
    }
    const port = /Listening for client connections on 127\.0\.0\.1:(\d+)/.exec(output)?.[1];
    if (port && output.includes('Server is ready')) {
      ready.resolve(Number(port));
    }
  }
  stderr.on('data', received);
  child.once('error', failed);
  child.once('exit', failed);
  const timer = setTimeout(failed, 10_000);
  try {
    return await ready.promise;
  } finally {
    clearTimeout(timer);
    stderr.removeListener('data', received);
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
