import { once } from 'node:events';
import { createServer } from 'node:net';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse }
  from 'node:http';
import { expect, it } from 'vitest';
import { startGateway } from '../src/gateway.ts';
import { freePort, gatewayFixture } from './gateway-delivery-fixture.ts';

async function usesWorkerPorts() {
  const ports = new Set<number>();
  const worker = Number(process.env['VITEST_POOL_ID'] ?? 1);
  const first = 20_000 + worker * 200;
  for (let index = 0; index < 8; index++) {
    const port = await freePort();
    expect(port).toBeGreaterThanOrEqual(first);
    expect(port).toBeLessThan(first + 200);
    expect(port).toBeLessThan(32768);
    expect(ports.has(port)).toBe(false);
    ports.add(port);
  }
}
it('keeps test listeners out of the outgoing connection range in each worker', usesWorkerPorts);

async function skipsBusyPort() {
  const previous = await freePort();
  const occupied = createServer();
  occupied.listen(previous + 1, '127.0.0.1');
  await once(occupied, 'listening');
  try {
    expect(await freePort()).toBe(previous + 2);
  } finally {
    const closed = once(occupied, 'close');
    occupied.close();
    await closed;
  }
}
it('tries the next worker port when another listener already uses it', skipsBusyPort);

function unavailable(_request: IncomingMessage, response: ServerResponse) {
  response.writeHead(503);
  response.end();
}

async function keepsBindFailure() {
  const setup = await gatewayFixture();
  await setup.gateway.stop();
  const occupied = createHttpServer(unavailable);
  occupied.listen(setup.options.readinessPort, '127.0.0.1');
  await once(occupied, 'listening');
  try {
    await expect(startGateway(setup.options)).rejects.toThrow(/address (?:already )?in use/iu);
  } finally {
    const closed = once(occupied, 'close');
    occupied.close();
    occupied.closeAllConnections();
    await closed;
  }
}
it('keeps the bind cause after the gateway readiness error', keepsBindFailure);
