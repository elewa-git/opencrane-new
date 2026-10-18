import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { expect, it, onTestFinished } from 'vitest';
import { databases } from '@opencrane/authz/testing';
import { history } from '@opencrane/models';
import { losslessJson } from '@opencrane/events/lossless-json';
import { managedFixture, credential } from '../../../libs/models/test/managed-fixture.ts';

type Setup = Awaited<ReturnType<typeof managedFixture>>;

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No free port');
  const closed = once(server, 'close');
  server.close();
  await closed;
  return address.port;
}

async function startModels(setup: Setup, patch: NodeJS.ProcessEnv = {}) {
  await setup.stopDispatch();
  const dbs = await databases();
  const directory = await mkdtemp(`${tmpdir()}/oc-managed-start-`);
  const jwksFile = `${directory}/jwks.json`;
  await writeFile(jwksFile, JSON.stringify(setup.identity.jwks));
  const gatewayPort = await freePort();
  const readinessPort = await freePort();
  const env = { ...process.env, ...setup.nats.env('command'),
    DATABASE_URL: await dbs.postgres(), SILO_ID: 'test',
    TOKEN_ISSUER: setup.identity.issuer, MODEL_STATE_DIR: directory,
    MODEL_JWKS_FILE: jwksFile, MODEL_DECISION_PORT: String(await freePort()),
    MODEL_GATEWAY_PORT: String(gatewayPort), MODEL_READINESS_PORT: String(readinessPort),
    MODEL_GATEWAY_CONTROL_PORT: String(await freePort()),
    AGENTGATEWAY_BINARY: setup.options.binary, MODEL_KEY_FILE: undefined,
    PROVIDER_SECRETS_DIR: `${dirname(setup.options.keyFile)}/custody`,
    MODEL_UPSTREAM: setup.options.upstream,
    OPENFGA_API_URL: setup.binding.apiUrl, OPENFGA_STORE_ID: setup.binding.storeId,
    OPENFGA_MODEL_ID: setup.binding.authorizationModelId, ...patch };
  const child = spawn(process.execPath,
    ['--experimental-strip-types', resolve('apps/server/src/models-main.ts')],
    { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let diagnostics = '';
  function capture(chunk: Buffer) {
    diagnostics += chunk.toString();
  }
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  async function close() {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await exited(child);
    }
    await dbs.close();
    await rm(directory, { recursive: true, force: true });
  }
  onTestFinished(close);
  async function ready() {
    expect(child.exitCode).toBeNull();
    const response = await fetch(`http://127.0.0.1:${readinessPort}/healthz/ready`);
    expect(response.status).toBe(200);
  }
  async function call() {
    const headers = { ...setup.headers, 'x-provider-key': 'caller-supplied-canary' };
    const body = { model: 'gpt-6-luna', input: 'Say OK.'.repeat(150),
      max_output_tokens: 128, stream: true, store: false };
    const request = { method: 'POST', headers, body: JSON.stringify(body) };
    return fetch(`http://127.0.0.1:${gatewayPort}/v1/responses`, request);
  }
  async function config() {
    return readFile(`${directory}/gateway.json`, 'utf8');
  }
  return { child, ready, call, config, diagnostics: () => diagnostics, directory };
}

async function exited(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const options = { signal: AbortSignal.timeout(15_000) };
  await once(child, 'exit', options);
}

async function startsManaged() {
  const setup = await managedFixture();
  const process = await startModels(setup);
  await expect.poll(process.ready, { timeout: 15_000 }).toBeUndefined();
  async function assertManaged() {
    const config = await process.config();
    expect(config).toContain('/authorize/models/managed');
    expect(config).not.toContain('backendAuth');
    expect(config).not.toContain('.keys');
    expect(config).not.toContain(setup.options.keyFile);
  }
  await assertManaged();
  // Replace the configuration through the running worker before making the checked call.
  const saved = { changeRef: 'managed-reload', generation: 1, rendererVersion: '1', members: [] };
  const data = { ...saved, recordDigest: losslessJson(JSON.stringify(saved)).digest };
  await setup.append('gateway-config-test', 'gateway.configuration_requested', data);
  async function delivered() {
    const rows = await history(setup.nats.store, 'gateway-config-test', 'test');
    expect(rows.at(-1)?.event.data).toMatchObject({ outcome: 'loaded' });
  }
  await expect.poll(delivered, { timeout: 15_000 }).toBeUndefined();
  await assertManaged();
  const response = await process.call();
  expect(response.status).toBe(200);
  expect(await response.text()).not.toContain(credential);
  const expected = createHash('sha256').update(`Bearer ${credential}`).digest('hex');
  expect(setup.providerAuthHash()).toBe(expected);
  expect(setup.providerHeaders()).not.toContain('x-provider-key');
  expect(setup.received()).toBe(1);
  expect(process.diagnostics()).not.toContain(credential);
  expect(process.diagnostics()).not.toContain(setup.options.keyFile);
  const rows = await history(setup.nats.store, 'budget-test', 'test');
  function reservation(row: typeof rows[number]) {
    return row.event.type === 'budget.reserved';
  }
  expect(rows.filter(reservation)).toHaveLength(1);
}
it('starts managed without a static key and keeps it through a worker reload', startsManaged, 60_000);

async function refusesConfiguration(problem: string) {
  const setup = await managedFixture();
  const patch = problem === 'fallback'
    ? { MODEL_KEY_FILE: setup.options.keyFile } : { PROVIDER_SECRETS_DIR: undefined };
  const process = await startModels(setup, patch);
  await exited(process.child);
  expect(process.child.exitCode).toBe(1);
  const reason = problem === 'fallback' ? 'A fallback key file is still configured after switch-on'
    : 'Provider custody is required after switch-on';
  expect(process.diagnostics()).toContain(reason);
  expect(process.diagnostics()).not.toContain(setup.options.keyFile);
  await expect(process.config()).rejects.toMatchObject({ code: 'ENOENT' });
  expect(setup.received()).toBe(0);
}
it.each(['fallback', 'custody'])('refuses startup with %s configuration',
  refusesConfiguration, 60_000);

async function replaysWithoutCustody() {
  const setup = await managedFixture();
  const missing = `${dirname(setup.options.keyFile)}/missing-custody`;
  const process = await startModels(setup, { PROVIDER_SECRETS_DIR: missing });
  await expect.poll(process.ready, { timeout: 15_000 }).toBeUndefined();
  const rows = await history(setup.nats.store, 'budget-test', 'test');
  function reservation(row: typeof rows[number]) {
    return row.event.type === 'budget.reserved';
  }
  expect(rows.filter(reservation)).toHaveLength(0);
  expect(await history(setup.nats.store, 'decision-*', 'test')).toHaveLength(0);
  expect(setup.received()).toBe(0);
  await expect(readFile(missing)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(process.diagnostics()).not.toContain(missing);
}
it('restarts ready with absent custody and creates no call or hold', replaysWithoutCustody, 60_000);

async function stopsLegacy() {
  const setup = await managedFixture('marker');
  setup.headers['x-turn-token'] = await setup.sign(setup.t, 'decision-service');
  const process = await startModels(setup, { MODEL_KEY_FILE: setup.options.keyFile });
  await expect.poll(process.ready, { timeout: 15_000 }).toBeUndefined();
  expect(await process.config()).toContain('backendAuth');
  const enabled = { providerId: 'primary', revision: 3, changedBy: 'alice',
    expectedProviderSequence: 0 };
  await setup.append('budget-test', 'provider.managed_calls_enabled', enabled);
  const started = performance.now();
  await exited(process.child);
  expect(performance.now() - started).toBeLessThan(3000);
  expect(process.child.exitCode).toBe(1);

  const managedProcess = await startModels(setup);
  async function managedModeReady() {
    await managedProcess.ready();
    const config = await managedProcess.config();
    expect(config).toContain('/authorize/models/managed');
  }
  // Wait for the new process to serve managed calls. The old gateway returns 503 while it drains.
  await expect.poll(managedModeReady, { timeout: 15_000 }).toBeUndefined();
  const response = await managedProcess.call();
  expect(response.status).toBe(403);
  await response.text();
  expect(setup.received()).toBe(0);
}
it('stops a legacy process after switch-on and refuses its legacy call', stopsLegacy, 60_000);

async function refusesUnreadableMode() {
  const setup = await managedFixture();
  const directory = dirname(setup.options.keyFile);
  const fifo = `${directory}/startup-barrier`;
  execFileSync('mkfifo', [fifo]);
  const process = await startModels(setup, { TOKEN_SIGNING_KEY_FILE: fifo });
  // Wait for budget replay to finish and signing-file loading to begin.
  const writer = await open(fifo, 'w');
  setup.nats.pauseResponses(true);
  try {
    await writer.writeFile(await readFile(`${directory}/issuer.pem`));
    await writer.close();
    await exited(process.child);
    expect(process.child.exitCode).toBe(1);
    await expect(process.config()).rejects.toMatchObject({ code: 'ENOENT' });
    expect(setup.received()).toBe(0);
  } finally {
    setup.nats.pauseResponses(false);
  }
}
it('refuses startup when the recorded mode cannot be read', refusesUnreadableMode, 60_000);
