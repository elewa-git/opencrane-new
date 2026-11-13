import { ports, secondary } from '../identity.ts';
import assert from 'node:assert/strict';
import { Server } from 'node:net';

const configuredPorts = Object.values(ports);
const secondaryPorts = new Set(configuredPorts.map(Number));

function listenInFixture(target, server, args) {
  const options = args[0];
  assert(options && typeof options === 'object');
  const port = Number(options.port);
  assert(secondary && secondaryPorts.has(port), 'Claim fixtures may probe only secondary stack ports');

  // Keep the real port check while giving each fixture its own sockets.
  // Map the deliberately occupied model port to the test's real listener.
  let fixturePort = 0;
  const busyStackPort = Number(process.env.CLAIM_TEST_BUSY_STACK_PORT ?? 25110);
  if (port === busyStackPort && options.host === '127.0.0.1') {
    fixturePort = Number(process.env.CLAIM_TEST_BUSY_PORT);
    assert(Number.isInteger(fixturePort) && fixturePort >= 0 && fixturePort <= 65535);
  }
  const fixtureOptions = { ...options, port: fixturePort };
  return Reflect.apply(target, server, [fixtureOptions, ...args.slice(1)]);
}

const handler = { apply: listenInFixture };
Server.prototype.listen = new Proxy(Server.prototype.listen, handler);
