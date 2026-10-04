import { EventEmitter, once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it, vi } from 'vitest';
import { startGateway } from '../src/gateway.ts';

vi.mock('node:child_process', () => ({
  spawn: () => {
    const child = new EventEmitter(), stdout = new PassThrough(), stderr = new PassThrough();
    return Object.assign(child, { stdout, stderr, exitCode: null, signalCode: null,
      kill() { stdout.end(); stderr.end(); child.emit('close', 0); return true; },
    });
  },
}));

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
  const fetch = globalThis.fetch;
  vi.stubGlobal('fetch', (url: string) => url.endsWith('/api/config/effective')
    ? readFile(`${directory}/config.json`, 'utf8').then(body => new Response(body))
    : url.endsWith('/config_dump') ? Promise.resolve(new Response('{"binds":[],"backends":[]}')) : fetch(url));
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
    vi.unstubAllGlobals();
  }
}, 10_000);
