import { EventEmitter, once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it, vi } from 'vitest';
import { gatewayUsage, startGateway } from '../src/gateway.ts';

function keepsProviderJwtFailure() {
  const line = 'route=default/provider-openai-test http.status=401';
  expect(gatewayUsage(line)).toMatchObject({ outcome: 'error', reason: 'jwt_failed' });
}
it('keeps provider-route JWT refusals in the gateway audit', keepsProviderJwtFailure);

const STDERR_AFTER_EXIT_MS = 150;

const mockState = vi.hoisted(() => ({ exitBeforeStderrDrain: false, withContext: false }));

function mockGatewayChildProcess() {
  function spawnGateway() {
    const child = new EventEmitter();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    function killGateway() {
      stdout.end();
      stderr.end();
      child.emit('close', 0);
      return true;
    }
    const spawned = Object.assign(child, { stdout, stderr, exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null, kill: killGateway });
    function drainStartupStderr() {
      if (mockState.withContext) {
        stderr.write('Error: readiness server starts\n\nCaused by:\n');
        stderr.write('    Address already in use (os error 98)\n');
        stderr.write('fixture-credential-must-stay-private');
      } else {
        stderr.write('Error: Address already in use\n');
      }
      stdout.end();
      stderr.end();
      child.emit('close', 1, null);
    }
    function exitBeforeStderrDrain() {
      spawned.exitCode = 1;
      child.emit('exit', 1, null);
      // Wait longer than the startup loop's 50 ms poll to expose premature errors.
      setTimeout(drainStartupStderr, STDERR_AFTER_EXIT_MS);
    }
    if (mockState.exitBeforeStderrDrain) {
      setTimeout(exitBeforeStderrDrain, 0);
    }
    return spawned;
  }
  return { spawn: spawnGateway };
}
vi.mock('node:child_process', mockGatewayChildProcess);

async function keepsSafeBindDetailsAfterStderrDrain(withContext: boolean) {
  mockState.exitBeforeStderrDrain = true;
  mockState.withContext = withContext;
  const directory = await mkdtemp(`${tmpdir()}/gateway-start-stderr-`);
  const binary = resolve(`spikes/s0-1c-real-model-smoke/.tools/agentgateway-${
    process.platform === 'linux' ? 'linux-amd64' : 'darwin-arm64'
  }`);
  const options = {
    binary,
    configFile: `${directory}/config.json`,
    usageFile: `${directory}/usage.jsonl`,
    keyFile: `${directory}/key`,
    port: 1,
    readinessPort: 1,
    decisionUrl: 'http://127.0.0.1:1',
    issuer: 'https://test.invalid',
  };
  try {
    const pending = startGateway(options);
    await expect(pending).rejects.toThrow('Address already in use');
    await expect(pending).rejects.not.toThrow('fixture-credential-must-stay-private');
  } finally {
    mockState.exitBeforeStderrDrain = false;
    await rm(directory, { recursive: true, force: true });
  }
}
it.each([false, true])('drains stderr and keeps safe bind details (context: %s)',
  keepsSafeBindDetailsAfterStderrDrain);

it('waits for the request listener even when the readiness listener is already ready', async () => {
  let checks = 0, started = false;
  const readiness = createServer((_request, response) => { checks++; response.end(); });
  const traffic = createServer((_request, response) => { response.writeHead(404); response.end(); });
  readiness.listen(0, '127.0.0.1'); await once(readiness, 'listening');
  traffic.listen(0, '127.0.0.1'); await once(traffic, 'listening');
  const address = traffic.address(), readyAddress = readiness.address();
  if (!address || typeof address === 'string' || !readyAddress || typeof readyAddress === 'string') throw new Error('Missing listener');
  await new Promise<void>(resolve => traffic.close(() => resolve()));
  const directory = await mkdtemp(`${tmpdir()}/gateway-start-`);
  const pending = startGateway({
    binary: resolve(`spikes/s0-1c-real-model-smoke/.tools/agentgateway-${process.platform === 'linux' ? 'linux-amd64' : 'darwin-arm64'}`),
    configFile: `${directory}/config.json`, usageFile: `${directory}/usage.jsonl`, keyFile: `${directory}/key`,
    port: address.port, readinessPort: readyAddress.port, decisionUrl: 'http://127.0.0.1:1', issuer: 'https://test.invalid',
  }).then(gateway => { started = true; return gateway; });
  try {
    await vi.waitFor(() => expect(checks).toBeGreaterThan(0), { timeout: 5000 });
    await delay(75);
    expect(started).toBe(false);
    traffic.listen(address.port, '127.0.0.1'); await once(traffic, 'listening');
    expect((await pending).healthy()).toBe(true);
    expect((await fetch(`http://127.0.0.1:${address.port}/`)).status).toBe(404);
  } finally {
    // Release startup even when the early-return assertion fails.
    if (!traffic.listening) { traffic.listen(address.port, '127.0.0.1'); await once(traffic, 'listening'); }
    await (await pending).stop();
    await Promise.all([readiness, traffic].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    await rm(directory, { recursive: true, force: true });
  }
}, 10_000);
