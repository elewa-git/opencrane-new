import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { networkInterfaces, tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { exportJWK, generateKeyPair } from 'jose';
import { expect, it, onTestFinished } from 'vitest';
import { z } from 'zod';
import { startGateway } from '../src/gateway.ts';

async function freePort() {
  const server = createServer();
  server.listen(0, '::');
  await once(server, 'listening');
  const address = server.address();
  const closed = once(server, 'close');
  server.close();
  await closed;
  if (!address || typeof address === 'string') {
    throw new Error('No fixture port');
  }
  return address.port;
}

async function gatewayFixture() {
  const directory = await mkdtemp(`${tmpdir()}/gateway-reload-`);
  const pair = await generateKeyPair('ES256', { extractable: true });
  const jwk = await exportJWK(pair.publicKey);
  const jwks = JSON.stringify({ keys: [{ ...jwk, kid: 'fixture', alg: 'ES256' }] });
  function serveKeys(_request: IncomingMessage, response: ServerResponse) {
    response.setHeader('content-type', 'application/json');
    response.end(jwks);
  }
  const decision = createServer(serveKeys);
  decision.listen(0, '127.0.0.1');
  await once(decision, 'listening');
  const address = decision.address();
  if (!address || typeof address === 'string') {
    throw new Error('No fixture listener');
  }
  let child: ChildProcess | undefined;
  let stop: ((signal?: NodeJS.Signals) => Promise<void>) | undefined;
  const logs: string[] = [];
  function record(chunk: Buffer) {
    logs.push(chunk.toString('utf8'));
  }
  function spawned(process: ChildProcess, stopProcess: NonNullable<typeof stop>) {
    child = process;
    stop = stopProcess;
    process.stdout?.on('data', record);
    process.stderr?.on('data', record);
  }
  async function close() {
    await stop?.('SIGKILL');
    const closed = once(decision, 'close');
    decision.close();
    decision.closeAllConnections();
    await closed;
    await rm(directory, { recursive: true, force: true });
  }
  onTestFinished(close);
  const options = {
    binary: resolve('spikes/s0-1c-real-model-smoke/.tools/agentgateway-linux-amd64'),
    configFile: `${directory}/gateway.json`, usageFile: `${directory}/usage.jsonl`,
    keyFile: `${directory}/provider`, port: await freePort(), readinessPort: await freePort(),
    decisionUrl: `http://127.0.0.1:${address.port}`, issuer: 'reload-fixture',
    onChildSpawn: spawned,
  };
  await writeFile(options.keyFile, 'fixture-provider', { mode: 0o600 });
  const gateway = await startGateway(options);
  return { options, gateway, child: child!, logs };
}

async function atomicReload() {
  const setup = await gatewayFixture();
  const pid = setup.child.pid;
  const base = `http://127.0.0.1:${setup.options.port}`;
  const request = { method: 'POST', signal: AbortSignal.timeout(2000) };
  const old = await fetch(`${base}/v1/responses`, request);
  expect(old.status).toBe(401);
  await old.arrayBuffer();
  const bytes = await readFile(setup.options.configFile, 'utf8');
  const parsed: unknown = JSON.parse(bytes);
  const config = z.record(z.string(), z.unknown()).parse(parsed);
  config['routes'] = [{ name: 'replacement', gateways: 'default',
    matches: [{ path: { exact: '/generation-2' } }],
    policies: { directResponse: { status: 200, body: 'generation-2' } } }];
  const sibling = `${setup.options.configFile}.next`;
  await writeFile(sibling, JSON.stringify(config), { mode: 0o600, flag: 'wx' });
  expect((await stat(sibling)).mode & 0o777).toBe(0o600);
  await rename(sibling, setup.options.configFile);
  async function replacementServes() {
    const response = await fetch(`${base}/generation-2`, { signal: AbortSignal.timeout(1000) });
    expect(await response.text()).toBe('generation-2');
    expect(response.status).toBe(200);
  }
  await expect.poll(replacementServes, { timeout: 5000 }).toBeUndefined();
  const gone = await fetch(`${base}/v1/responses`, request);
  expect(gone.status).toBe(404);
  await gone.arrayBuffer();
  expect(setup.child.pid).toBe(pid);
  expect(setup.gateway.healthy()).toBe(true);
}
it('reloads a renamed 0600 sibling file without restarting and removes the old route', atomicReload);

function nonLoopbackAddress() {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) {
        return address.address;
      }
    }
  }
  throw new Error('Loopback isolation qualification needs a non-loopback interface');
}

async function isolatedControlListener() {
  const externalAddress = nonLoopbackAddress();
  const setup = await gatewayFixture();
  const controlPort = await freePort();
  const bytes = await readFile(setup.options.configFile, 'utf8');
  const parsed: unknown = JSON.parse(bytes);
  const config = z.record(z.string(), z.unknown()).parse(parsed);
  config['gateways'] = { default: { port: setup.options.port }, control: { port: controlPort } };
  config['routes'] = [{ name: 'witness', gateways: 'control',
    matches: [{ path: { exact: '/generation-2' } }],
    policies: { directResponse: { status: 200, body: 'generation-2' } } }];
  const sibling = `${setup.options.configFile}.next`;
  await writeFile(sibling, JSON.stringify(config), { mode: 0o600, flag: 'wx' });
  await rename(sibling, setup.options.configFile);
  async function loopbackServes() {
    const response = await fetch(`http://127.0.0.1:${controlPort}/generation-2`,
      { signal: AbortSignal.timeout(1000) });
    expect(await response.text()).toBe('generation-2');
    expect(response.status).toBe(200);
  }
  await expect.poll(loopbackServes, { timeout: 5000 }).toBeUndefined();
  const external = fetch(`http://${externalAddress}:${controlPort}/generation-2`,
    { signal: AbortSignal.timeout(1000) });
  await expect(external).rejects.toThrow();
}
it('keeps the control listener unreachable through a non-loopback address', isolatedControlListener);
