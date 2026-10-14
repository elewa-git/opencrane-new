import { readFile, rename, stat, writeFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { freePort, gatewayFixture } from './gateway-delivery-fixture.ts';

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
    policies: { authorization: { rules: ['source.address == "127.0.0.1"'] },
      directResponse: { status: 200, body: 'generation-2' } } }];
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
  const external = await fetch(`http://${externalAddress}:${controlPort}/generation-2`,
    { signal: AbortSignal.timeout(1000) });
  expect(external.status).toBe(403);
  expect(await external.text()).not.toBe('generation-2');
}
it('keeps the control listener unreachable through a non-loopback address', isolatedControlListener);
