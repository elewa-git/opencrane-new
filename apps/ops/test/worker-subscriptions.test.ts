import { fork, type ForkOptions } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { expect, it } from 'vitest';
import { natsFixture } from '@opencrane/event-store/testing';
import { until } from '@opencrane/authz/testing';

async function workerWaitsBeforeStartingReactions() {
  const url = new URL(process.env['PG_TEST_URL']!);
  const admin = new Pool({ connectionString: url.href });
  const name = `worker_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: url.href });
  const nats = await natsFixture();
  const directory = await mkdtemp(`${tmpdir()}/worker-subscriptions-`);
  const keyOptions = { namedCurve: 'P-256', publicKeyEncoding: {
    type: 'spki', format: 'pem' }, privateKeyEncoding: {
    type: 'pkcs8', format: 'pem' } } as const;
  const key = generateKeyPairSync('ec', keyOptions);
  await writeFile(`${directory}/key.pem`, key.privateKey);
  await writeFile(`${directory}/kubectl`, `#!/bin/sh\necho called >> '${directory}/calls'\nexit 1\n`,
    { mode: 0o700 });
  await pool.query(`CREATE TABLE handler_dispatcher (
    id INTEGER PRIMARY KEY, silo TEXT, manifest TEXT, sequence BIGINT)`);
  await pool.query("INSERT INTO handler_dispatcher VALUES (1, 'test', '[]', 0)");
  const commandSettings = nats.env();
  const commandEnv: Record<string, string> = {};
  for (const [setting, value] of Object.entries(commandSettings)) {
    commandEnv[`COMMAND_${setting}`] = value;
  }
  const env = { ...process.env, ...nats.env('dispatcher'), ...commandEnv,
    DATABASE_URL: url.href, SILO_ID: 'test', OPENFGA_API_URL: 'http://unused',
    OPENFGA_STORE_ID: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    OPENFGA_MODEL_ID: '01ARZ3NDEKTSV4RRFFQ69G5FAV', KUBECONFIG: '/unused',
    KUBE_NAMESPACE: 'test', TOKEN_SIGNING_KEY_FILE: `${directory}/key.pem`,
    TOKEN_ISSUER: 'https://test.example', LOG_LEVEL: 'info',
    PATH: `${directory}:${process.env['PATH'] ?? ''}` };
  const filename = new URL('../src/worker.ts', import.meta.url);
  const options: ForkOptions = { env, execArgv: ['--experimental-strip-types'],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'] };
  const child = fork(filename, ['dispatcher'], options);
  let output = '';
  function collect(chunk: Buffer) {
    output += chunk.toString();
  }
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);
  try {
    function waiting() {
      if (child.exitCode !== null) {
        throw new Error(output);
      }
      return output.includes('--dry-run');
    }
    await until(waiting);
    expect(output).toContain('drain');
    expect((await pool.query('SELECT * FROM pgboss.job')).rows).toEqual([]);
    expect((await pool.query('SELECT * FROM handler_receipts')).rows).toEqual([]);
    await expect(readFile(`${directory}/calls`)).rejects.toThrow('ENOENT');
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await exited;
    }
    await pool.end();
    await nats.close();
    await rm(directory, { recursive: true, force: true });
    await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await admin.end();
  }
}
it.skipIf(!process.env['PG_TEST_URL'])(
  'worker waits on changed subscriptions before starting workers or the computer watcher',
  workerWaitsBeforeStartingReactions);
