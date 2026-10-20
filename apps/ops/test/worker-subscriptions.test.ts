import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { provisionDispatcher } from '@opencrane/handlers';
import { fork, type ForkOptions } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { generateKeyPairSync } from 'node:crypto';
import { expect, it } from 'vitest';
import { natsFixture } from '@opencrane/event-store/testing';
import { until, databases } from '@opencrane/authz/testing';

async function workerWaitsBeforeStartingReactions(scenario: string) {
  const changed = scenario.includes('changed');
  const configured = !scenario.includes('missing');
  const held = Promise.withResolvers<void>();
  let lists = 0;
  let listClosed = false;
  function closed() {
    listClosed = true;
  }
  async function respond(request: IncomingMessage, response: ServerResponse) {
    expect(request.method).toBe('GET');
    expect(request.url).toContain('/secrets?');
    lists += 1;
    response.once('close', closed);
    if (scenario === 'hanging') {
      await held.promise;
    }
    response.end(JSON.stringify({ items: [], metadata: {} }));
  }
  function listener(request: IncomingMessage, response: ServerResponse) {
    void respond(request, response);
  }
  const server = createServer(listener);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture unavailable');
  const storage = await databases();
  const pool = storage.queue;
  const connectionString = pool.options.connectionString;
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

  const commandSettings = nats.env();
  const commandEnv: Record<string, string> = {};
  for (const [setting, value] of Object.entries(commandSettings)) {
    commandEnv[`COMMAND_${setting}`] = value;
  }
  const env = { ...process.env, ...nats.env('dispatcher'), ...commandEnv,
    DATABASE_URL: connectionString, SILO_ID: 'test', OPENFGA_API_URL: 'http://unused',
    OPENFGA_STORE_ID: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    OPENFGA_MODEL_ID: '01ARZ3NDEKTSV4RRFFQ69G5FAV', KUBECONFIG: '/unused',
    KUBE_NAMESPACE: 'test', TOKEN_SIGNING_KEY_FILE: `${directory}/key.pem`,
    TOKEN_ISSUER: 'https://test.example', LOG_LEVEL: 'info',
    CONNECTION_CUSTODY_FILE: `${directory}/custody.json`,
    PATH: `${directory}:${process.env['PATH'] ?? ''}` };
  if (configured) {
    const config = { apiUrl: `http://127.0.0.1:${address.port}`, namespace: 'custody',
      journalDirectory: `${directory}/journal`, currentKeyId: 'fixture',
      keys: { fixture: Buffer.alloc(32, 7).toString('base64') } };
    await writeFile(env.CONNECTION_CUSTODY_FILE, JSON.stringify(config));
  }
  if (changed) {
    await pool.query("INSERT INTO handler_dispatcher VALUES (1, 'test', '[]', 0)");
  }
  await provisionDispatcher(nats.connection);
  const event = { id: 'scan-startup', type: 'connection.operation_closed', source: 'fixture',
    silo: 'test', subject: 'connection-member-server-profile', time: new Date().toISOString(),
    correlation: {}, data: { userId: 'member', serverId: 'server', profile: 'profile',
      operationId: 'abandoned', generation: 1, expectedSequence: 0, appendUntil: 1,
      reason: 'append_deadline_passed' } };
  await nats.seed([event]);
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
    async function started() {
      if (child.exitCode !== null) {
        throw new Error(output);
      }
      if (changed) {
        return output.includes('--dry-run');
      }
      const checkpoint = await pool.query<{ sequence: string }>(
        'SELECT sequence FROM handler_dispatcher');
      return Number(checkpoint.rows[0]?.sequence) === 1;
    }
    await until(started);
    if (!configured) {
      expect(output).toContain('Connection cleanup disabled: custody file is missing');
      expect(output).not.toContain('cleanup-connection');
    }
    expect(output).not.toContain(env.CONNECTION_CUSTODY_FILE);
    if (changed) {
      expect(output).toContain('prepare-gateway-configuration');
      expect(output).toContain('drain');
      expect((await pool.query('SELECT * FROM pgboss.job')).rows).toEqual([]);
      expect((await pool.query('SELECT * FROM handler_receipts')).rows).toEqual([]);
      await expect(readFile(`${directory}/calls`)).rejects.toThrow('ENOENT');
    }
    if (configured && !changed) {
      function listed() {
        return lists === 1;
      }
      await until(listed);
      if (scenario === 'hanging') {
        expect(listClosed).toBe(false);
      }
    } else {
      await delay(100);
      expect(lists).toBe(0);
    }
  } finally {
    held.resolve();
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await exited;
    }
    server.closeAllConnections();
    server.close();
    await once(server, 'close');
    await nats.close();
    await rm(directory, { recursive: true, force: true });
    await storage.close();
  }
}
it.skipIf(!process.env['PG_TEST_URL']).each([
  'missing changed', 'configured changed', 'missing ready', 'configured ready', 'hanging',
])('worker starts custody scanning only after subscriptions agree: %s',
  workerWaitsBeforeStartingReactions);
