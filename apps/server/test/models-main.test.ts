import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { appendFile, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID, generateKeyPairSync } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { losslessJson } from '@opencrane/events/lossless-json';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { natsFixture } from '@opencrane/event-store/testing';
import { databases } from '@opencrane/authz/testing';
import { BudgetActor, envelope, history } from '@opencrane/models';
import { chatCommand } from '../src/chat/commands.ts';
import { conversationKeys } from '../src/chat/keys.ts';
import { turnCommand } from '../src/chat/turns.ts';
import { tokenIssuer } from '@opencrane/auth';

const modelsMain = resolve('apps/server/src/models-main.ts');
const agentgateway = resolve('spikes/s0-1c-real-model-smoke/.tools/agentgateway-linux-amd64');

it('keeps running through a slow NATS reply and ingests later usage', async () => {
  const nats = await natsFixture();
  const dbs = await databases();
  const fixture = await runningModelsFixture(nats, await dbs.postgres());
  expect((await stat(`${fixture.directory}/egress`)).mode & 0o777).toBe(0o700);
  const laterUsageId = randomUUID();
  try {
    await waitForUsageEvent(nats.store, fixture.initialUsageId);
    nats.pauseResponses(true);
    await delay(600);
    expect(fixture.child.exitCode).toBeNull();
    const readiness = await fetch(`http://127.0.0.1:${fixture.readinessPort}/healthz/ready`);
    expect(readiness.status).toBe(200);
    nats.pauseResponses(false);
    await appendUsage(fixture.usageFile, { id: laterUsageId, outcome: 'error' });
    await waitForUsageEvent(nats.store, laterUsageId);
    expect(fixture.child.exitCode).toBeNull();
    expect((await fetch(`http://127.0.0.1:${fixture.readinessPort}/healthz/ready`)).status).toBe(200);
  } finally {
    nats.pauseResponses(false);
    await stopModelsFixture(fixture);
    await nats.close();
    await dbs.close();
  }
}, 60_000);

it('stops with a non-zero exit when a usage line is malformed', async () => {
  const nats = await natsFixture();
  const dbs = await databases();
  const fixture = await runningModelsFixture(nats, await dbs.postgres());
  try {
    await waitForUsageEvent(nats.store, fixture.initialUsageId);
    await appendFile(fixture.usageFile, '{malformed usage line}\n');
    await waitForProcessExit(fixture.child);
    expect(fixture.child.exitCode).toBe(1);
  } finally {
    await stopModelsFixture(fixture);
    await nats.close();
    await dbs.close();
  }
}, 60_000);

it('exits when NATS stays unavailable beyond the reconnect window', async () => {
  const nats = await natsFixture();
  const dbs = await databases();
  const fixture = await runningModelsFixture(nats, await dbs.postgres());
  try {
    await waitForUsageEvent(nats.store, fixture.initialUsageId);
    await nats.stop();
    await waitForProcessExit(fixture.child, 20_000);
    expect(fixture.child.exitCode).toBe(1);
  } finally {
    await stopModelsFixture(fixture);
    await nats.close();
    await dbs.close();
  }
}, 60_000);

async function runningModelsFixture(nats: Awaited<ReturnType<typeof natsFixture>>, databaseUrl: string,
  extraEnv: NodeJS.ProcessEnv = {}) {
  const directory = await mkdtemp(`${tmpdir()}/oc-models-retry-`);
  const key = generateKeyPairSync('ec', { namedCurve: 'P-256', privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  await writeFile(`${directory}/key.pem`, key.privateKey, { mode: 0o600 });
  const issuer = await tokenIssuer({ privateKeyPath: `${directory}/key.pem`, issuer: 'https://lifecycle.test/' });
  await writeFile(`${directory}/jwks.json`, JSON.stringify(issuer.jwks));
  const usageFile = `${directory}/usage.jsonl`;
  const initialUsageId = randomUUID();
  await appendUsage(usageFile, { id: initialUsageId, outcome: 'error' });
  const decisionPort = await freePort();
  const gatewayPort = await freePort();
  const readinessPort = await freePort();
  const controlPort = await freePort();
  const child = spawn(process.execPath, ['--experimental-strip-types', modelsMain], {
    cwd: resolve('.'),
    env: {
      ...process.env,
      ...nats.env('command'),
      DATABASE_URL: databaseUrl,
      SILO_ID: 'test',
      TOKEN_ISSUER: 'https://lifecycle.test/',
      MODEL_STATE_DIR: directory,
      MODEL_JWKS_FILE: `${directory}/jwks.json`,
      MODEL_DECISION_PORT: String(decisionPort),
      MODEL_GATEWAY_PORT: String(gatewayPort),
      MODEL_READINESS_PORT: String(readinessPort),
      MODEL_GATEWAY_CONTROL_PORT: String(controlPort),
      AGENTGATEWAY_BINARY: agentgateway,
      MODEL_KEY_FILE: `${directory}/key.pem`,
      MODEL_UPSTREAM: '127.0.0.1:9',
      OPENFGA_API_URL: 'http://127.0.0.1:9',
      OPENFGA_STORE_ID: 'test',
      OPENFGA_MODEL_ID: 'test',
      ...extraEnv,
    },
    stdio: 'ignore',
  });
  await waitForReadiness(child, readinessPort);
  return { child, directory, usageFile, readinessPort, gatewayPort, controlPort, initialUsageId };
}

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No free port');
  const port = address.port;
  server.close();
  await once(server, 'close');
  return port;
}

async function waitForReadiness(child: ChildProcess, port: number) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`models process exited before readiness: ${child.exitCode}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz/ready`);
      if (response.status === 200) return;
    } catch { /* The gateway is still starting. */ }
    await delay(100);
  }
  throw new Error('models readiness timed out');
}

async function appendUsage(file: string, usage: { id: string; outcome: 'error' }) {
  await appendFile(file, `${JSON.stringify(usage)}\n`);
}

async function waitForUsageEvent(store: Awaited<ReturnType<typeof natsFixture>>['store'], id: string) {
  const subject = `security-${id}`;
  for (let attempt = 0; attempt < 100; attempt++) {
    const rows = await history(store, subject, 'test');
    if (rows.some(row => row.event.type === 'security.alert_raised')) return;
    await delay(100);
  }
  throw new Error('Later usage line was not ingested');
}

async function waitForProcessExit(child: ChildProcess, timeoutMs = 5000) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([once(child, 'exit'), delay(timeoutMs)]);
}

async function stopModelsFixture(fixture: { child: ChildProcess; directory: string }) {
  if (fixture.child.exitCode === null && fixture.child.signalCode === null) {
    fixture.child.kill('SIGTERM');
    await Promise.race([once(fixture.child, 'exit'), delay(5000)]);
  }
  await rm(fixture.directory, { recursive: true, force: true });
}

it.each([undefined, { d: 'not-a-private-key' }, { alg: 'ES384' }, { crv: 'P-384' }, { kty: 'RSA' }, { use: 'enc' }])(
  'starts with actual issuer public JWKS and rejects invalid key patch %j', async patch => {
  const nats = await natsFixture(), dbs = await databases();
  const directory = await mkdtemp(`${tmpdir()}/oc-models-startup-`);
  try {
    const key = generateKeyPairSync('ec', { namedCurve: 'P-256', privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    await writeFile(`${directory}/key.pem`, key.privateKey, { mode: 0o600 });
    const issuer = await tokenIssuer({ privateKeyPath: `${directory}/key.pem`, issuer: 'https://lifecycle.test/' });
    const jwks = issuer.jwks;
    await writeFile(`${directory}/jwks.json`, JSON.stringify({ keys: jwks.keys.map(key => ({ ...key, ...patch })) }));
    // Stop at binary verification, before the gateway can load any provider credential.
    await writeFile(`${directory}/gateway`, 'deliberately untrusted test binary');
    const result = await promisify(execFile)(process.execPath, ['--experimental-strip-types', resolve('apps/server/src/models-main.ts')], {
      timeout: 20_000,
      env: { ...process.env, ...nats.env(), DATABASE_URL: await dbs.postgres(), SILO_ID: 'test',
        TOKEN_ISSUER: 'https://lifecycle.test/', MODEL_STATE_DIR: directory, MODEL_JWKS_FILE: `${directory}/jwks.json`, MODEL_DECISION_PORT: '0',
        MODEL_GATEWAY_CONTROL_PORT: '43004', MODEL_GATEWAY_PORT: '0', MODEL_READINESS_PORT: '0', AGENTGATEWAY_BINARY: `${directory}/gateway`,
        OPENFGA_API_URL: 'http://127.0.0.1:1', OPENFGA_STORE_ID: 'test', OPENFGA_MODEL_ID: 'test' },
    }).then(() => '', (error: unknown) => z.object({ stderr: z.string() }).parse(error).stderr);
    expect(result).toContain(patch ? 'ZodError' : 'Gateway digest mismatch');
    expect((await history(nats.store, 'budget-test', 'test')).map(r => r.event.type))
      .toEqual(patch ? [] : ['budget.ceiling_set', 'budget.period_started']);
    if (!patch) expect((await history(nats.store, 'budget-test', 'test'))[0]?.event.data).toMatchObject({ defaultPayingGroupId: 'installation-default' });
  } finally { await nats.close(); await dbs.close(); await rm(directory, { recursive: true, force: true }); }
}, 40_000);

it.each(['startup', 'migration'] as const)('upgrades an existing budget through %s without changing ceilings and admits personal chat', async mode => {
  const nats = await natsFixture(), dbs = await databases();
  const directory = await mkdtemp(`${tmpdir()}/oc-budget-upgrade-`);
  try {
    const legacy = new BudgetActor(nats.store, 'test');
    await legacy.start(3210, 45678);
    await legacy.configure({ scope: 'paying_group', scopeId: 'sales', ceilingCents: 1234, setBy: 'owner' });
    await legacy.configure({ scope: 'assistant', scopeId: 'personal', ceilingCents: 2345, setBy: 'owner' });
    const key = generateKeyPairSync('ec', { namedCurve: 'P-256', privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    await writeFile(`${directory}/key.pem`, key.privateKey, { mode: 0o600 });
    const issuer = await tokenIssuer({ privateKeyPath: `${directory}/key.pem`, issuer: 'https://lifecycle.test/' });
    await writeFile(`${directory}/jwks.json`, JSON.stringify(issuer.jwks));
    await writeFile(`${directory}/gateway`, 'deliberately untrusted test binary');
    const env = { ...process.env, ...nats.env(), DATABASE_URL: await dbs.postgres(), SILO_ID: 'test',
      TOKEN_ISSUER: 'https://lifecycle.test/', MODEL_STATE_DIR: directory, MODEL_JWKS_FILE: `${directory}/jwks.json`, MODEL_DECISION_PORT: '0',
      MODEL_GATEWAY_CONTROL_PORT: '43004', MODEL_GATEWAY_PORT: '0', MODEL_READINESS_PORT: '0', AGENTGATEWAY_BINARY: `${directory}/gateway`,
      DEFAULT_PAYING_GROUP_ID: 'installation-default',
      OPENFGA_API_URL: 'http://127.0.0.1:1', OPENFGA_STORE_ID: 'test', OPENFGA_MODEL_ID: 'test' };
    for (let restart = 0; restart < 2; restart++) {
      if (mode === 'startup') {
        const result = await promisify(execFile)(process.execPath, ['--experimental-strip-types', resolve('apps/server/src/models-main.ts')], { timeout: 20_000, env })
          .then(() => '', (error: unknown) => z.object({ stderr: z.string() }).parse(error).stderr);
        expect(result).toContain('Gateway digest mismatch');
      } else await promisify(execFile)(process.execPath, ['--experimental-strip-types', resolve('apps/ops/src/migrate-budget-default.ts')], { timeout: 20_000, env });
    }
    const recovered = new BudgetActor(nats.store, 'test');
    await recovered.start(2000, 20000, 'different-installation-default');
    expect(recovered.state).toMatchObject({ dailyCeilingCents: 3210, ceilingCents: 45678,
      defaultPayingGroupId: 'installation-default', ceilings: legacy.state.ceilings });
    const defaults = (await history(nats.store, 'budget-test', 'test')).filter(row =>
      row.event.type === 'budget.ceiling_set' && z.object({ defaultPayingGroupId: z.string().optional() }).parse(row.event.data).defaultPayingGroupId);
    expect(defaults).toHaveLength(1);
    const joined = envelope('test', 'member-alice', 'member.joined', {
      memberId: 'alice', email: 'alice@example.test', displayName: 'Alice',
      role: 'member', invitationId: 'invite-alice',
    });
    await nats.seed([joined]);
    await nats.store.append({ expectedSequence: 0, event: envelope('test', 'assistant-personal', 'assistant.created', { assistantId: 'personal', ownerId: 'alice', kind: 'personal' }) });
    await nats.store.append({ expectedSequence: 0, event: envelope('test', 'computer-personal', 'computer.ready', { assistantId: 'personal', computerId: 'personal', generation: 1 }) });
    const keys = conversationKeys(directory); keys.provision('test', 'chat');
    await chatCommand(nats.store, keys, { silo: 'test', memberId: 'alice' }, { id: 'create-chat', conversationId: 'chat', assistantId: 'personal' });
    await chatCommand(nats.store, keys, { silo: 'test', memberId: 'alice' }, { id: 'message', conversationId: 'chat', text: 'Hello' });
    expect(await turnCommand(nats.store, { silo: 'test', assistantId: 'personal', computerId: 'personal' },
      { conversationId: 'chat', turnId: 'message', threadId: 'thread', status: 'started' })).toMatchObject({ payingGroupId: 'installation-default' });
  } finally { await nats.close(); await dbs.close(); await rm(directory, { recursive: true, force: true }); }
}, 40_000);

async function restartsLatestWithoutStartupTools() {
  const nats = await natsFixture();
  const dbs = await databases();
  let requests = 0;
  function record(_request: import('node:http').IncomingMessage,
    response: import('node:http').ServerResponse) {
    requests += 1;
    response.end('{}');
  }
  const upstream = createHttpServer(record);
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const address = upstream.address();
  if (!address || typeof address === 'string') throw new Error('No upstream port');
  const canary = { serverId: 'canary', connectionId: 'installed',
    upstream: `127.0.0.1:${address.port}`, generation: 'canary',
    revisionHeader: 'x-opencrane-mcp-revision' };
  const env = { MODEL_MCP_ROUTES: JSON.stringify([canary]) };
  const databaseUrl = await dbs.postgres();
  const identities = new Set<string>();
  try {
    for (const generation of [1, 2]) {
      const saved = { changeRef: `change-${generation}`, generation,
        rendererVersion: '1', members: [] };
      const data = { ...saved, recordDigest: publicationDigest(saved) };
      await nats.seed([envelope('test', 'gateway-config-test',
        'gateway.configuration_requested', data)]);
    }
    for (let restart = 0; restart < 2; restart++) {
      const fixture = await runningModelsFixture(nats, databaseUrl, env);
      try {
        const response = await fetch(`http://127.0.0.1:${fixture.gatewayPort}/mcp/canary/installed`,
          { method: 'POST', signal: AbortSignal.timeout(2000) });
        expect(response.status).toBe(404);
        async function observed() {
          const rows = await history(nats.store, 'gateway-config-test', 'test');
          expect(rows).toHaveLength(3 + restart);
          const last = rows.at(-1)!;
          expect(last.event.data).toMatchObject({ generation: 2, outcome: 'loaded' });
          const data = z.object({ processRef: z.string() }).parse(last.event.data);
          identities.add(data.processRef);
        }
        await expect.poll(observed, { timeout: 10_000 }).toBeUndefined();
      } finally {
        await stopModelsFixture(fixture);
      }
    }
    expect(identities.size).toBe(2);
    expect(requests).toBe(0);
  } finally {
    upstream.close();
    upstream.closeAllConnections();
    await nats.close();
    await dbs.close();
  }
}
it('re-delivers only the latest saved generation after restart and ignores startup MCP routes',
  restartsLatestWithoutStartupTools, 40_000);

function publicationDigest(value: unknown) {
  const encoded = JSON.stringify(value);
  return losslessJson(encoded).digest;
}
