import { once } from 'node:events';
import { connect, createServer, Socket } from 'node:net';
import { connect as connectTls } from 'node:tls';
import { expect, it, onTestFinished } from 'vitest';
import { clientHello } from './egress-hello-fixture.ts';
import { connectEgressDestination } from '../src/egress-guard.ts';

const destination = { host: 'registry.npmjs.org', port: 8443 };
const publicAnswers = [{ address: '1.1.1.1', family: 4 },
  { address: '2606:4700:4700::1111', family: 6 }];

async function fixture(answers = publicAnswers, stalled = false) {
  const sockets = new Set<Socket>();
  let connections = 0;
  function record(socket: Socket) {
    connections++;
    sockets.add(socket);
  }
  const upstream = createServer(record);
  const listener = createServer();
  onTestFinished(close);
  upstream.listen(0, '127.0.0.1');
  listener.listen(0, '127.0.0.1');
  await Promise.all([once(upstream, 'listening'), once(listener, 'listening')]);
  const upstreamAddress = upstream.address();
  const relayAddress = listener.address();
  if (!upstreamAddress || typeof upstreamAddress === 'string' ||
      !relayAddress || typeof relayAddress === 'string') throw new Error('No fixture ports');
  const upstreamPort = upstreamAddress.port;
  const accepted = once(listener, 'connection');
  const client = connect(relayAddress.port, '127.0.0.1');
  sockets.add(client);
  const acceptedValues: unknown[] = await accepted;
  const incoming = acceptedValues[0];
  if (!(incoming instanceof Socket)) throw new Error('No socket');
  const socket = incoming;
  sockets.add(socket);
  const requests: { address: string; port: number }[] = [];
  const lookups: string[] = [];
  function resolve(host: string) {
    lookups.push(host);
    if (stalled) return new Promise<typeof answers>(neverResolve);
    return Promise.resolve(answers);
  }
  function neverResolve() {
    // Model a resolver that never replies; the guard owns the deadline.
  }
  function connector(address: string, port: number) {
    requests.push({ address, port });
    const outgoing = connect(upstreamPort, '127.0.0.1');
    sockets.add(outgoing);
    return outgoing;
  }
  function begin(target = destination) {
    const transport = { resolve, connect: connector };
    return connectEgressDestination(socket, target, transport);
  }
  async function close() {
    for (const active of sockets) active.destroy();
    const closed = [once(listener, 'close'), once(upstream, 'close')];
    listener.close();
    upstream.close();
    await Promise.all(closed);
  }
  return { client, incoming: socket, begin, requests, lookups, connections: () => connections };
}

async function acceptsFragmentedHello() {
  const setup = await fixture();
  const pending = setup.begin();
  const bytes = clientHello();
  const firstFragment = once(setup.incoming, 'data');
  setup.client.write(bytes.subarray(0, 2));
  await firstFragment;
  expect(setup.requests).toHaveLength(0);
  setup.client.write(bytes.subarray(2, 17));
  setup.client.write(bytes.subarray(17));
  const result = await pending;
  expect(result.initialData).toEqual(bytes);
  expect(result.address).toBe('1.1.1.1');
  expect(setup.requests).toEqual([{ address: '1.1.1.1', port: 8443 }]);
  expect(setup.lookups).toEqual(['registry.npmjs.org']);
}
it('checks the complete ClientHello and pins a public IP with the approved port',
  acceptsFragmentedHello);

async function acceptsNodeTls() {
  const setup = await fixture();
  const pending = setup.begin();
  const options = { socket: setup.client, servername: destination.host };
  const tls = connectTls(options);
  function ignoreShutdown() {
    // Stop before TLS negotiation; this test checks the real outgoing ClientHello.
  }
  tls.on('error', ignoreShutdown);
  function stopTls() {
    tls.destroy();
  }
  onTestFinished(stopTls);
  const result = await pending;
  expect(result.initialData[0]).toBe(22);
  expect(setup.requests).toHaveLength(1);
}
it('accepts a real node:tls ClientHello without terminating TLS', acceptsNodeTls);

const badHellos = [
  ['missing name', clientHello([])], ['other host', clientHello(['example.com'])],
  ['several names', clientHello([destination.host, destination.host])],
  ['ECH', clientHello(undefined, Buffer.from([0xfe, 0x0d, 0, 0]))],
  ['duplicate SNI', clientHello(undefined, Buffer.from([0, 0, 0, 0]))],
  ['HTTP', Buffer.from('GET https://registry.npmjs.org/ HTTP/1.1\r\n\r\n')],
  ['SOCKS', Buffer.from([5, 1, 0, 0, 0])], ['unknown protocol', Buffer.alloc(5)],
  ['oversized record', Buffer.from([22, 3, 1, 0xff, 0xff])],
  ['oversized input', Buffer.alloc(65537)],
] as const;
async function refusesHello(_name: string, bytes: Buffer) {
  const setup = await fixture();
  const refused = expect(setup.begin()).rejects.toThrow('egress_tls_refused');
  setup.client.write(bytes);
  await refused;
  expect(setup.lookups).toHaveLength(0);
  expect(setup.requests).toHaveLength(0);
  expect(setup.connections()).toBe(0);
}
it.each(badHellos)('refuses %s before DNS or an upstream connection', refusesHello);

async function refusesIncompleteHello() {
  const setup = await fixture();
  const started = performance.now();
  const refused = expect(setup.begin()).rejects.toThrow('egress_tls_refused');
  setup.client.write(clientHello().subarray(0, 10));
  await refused;
  expect(performance.now() - started).toBeLessThan(2000);
  expect(setup.requests).toHaveLength(0);
}
it('bounds the wait for an incomplete ClientHello', refusesIncompleteHello);

const forbiddenAddresses = ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1',
  '169.254.169.254', '100.64.0.1', '224.0.0.1', '240.0.0.1', '0.0.0.0',
  '192.0.0.1', '198.18.0.1', '203.0.113.1', '::', '::1', 'fe80::1', 'fc00::1',
  'ff02::1', '::ffff:1.1.1.1', '64:ff9b::101:101', '2002:0101:0101::1',
  '2001:0:4136:e378::1', '2001:db8::1', '3fff::1', 'not-an-address'];
async function refusesDns(address: string) {
  let family = 4;
  if (address.includes(':')) family = 6;
  const answers = [...publicAnswers, { address, family }];
  const setup = await fixture(answers);
  const refused = expect(setup.begin()).rejects.toThrow('egress_dns_refused');
  setup.client.write(clientHello());
  await refused;
  expect(setup.requests).toHaveLength(0);
  expect(setup.connections()).toBe(0);
}
it.each(forbiddenAddresses)('refuses mixed answers containing %s', refusesDns);

async function refusesEmptyOrSlowDns(stalled: boolean) {
  const setup = await fixture([], stalled);
  const started = performance.now();
  const refused = expect(setup.begin()).rejects.toThrow('egress_dns_refused');
  setup.client.write(clientHello());
  await refused;
  expect(performance.now() - started).toBeLessThan(2000);
  expect(setup.requests).toHaveLength(0);
}
it.each([false, true])('refuses empty or timed-out DNS (stalled: %s)', refusesEmptyOrSlowDns);

async function refusesInvalidDestination(host: string, port: number) {
  const setup = await fixture();
  const target = { host, port };
  await expect(setup.begin(target)).rejects.toThrow('egress_destination_refused');
  expect(setup.lookups).toHaveLength(0);
  expect(setup.requests).toHaveLength(0);
}
it.each([['127.0.0.1', 443], ['localhost', 443], ['https://example.com', 443],
  ['example.com', 0], ['example.com', 65536], ['example.com', 1.5]])(
  'validates destination %s:%s before reading or connecting', refusesInvalidDestination);

async function rechecksDns() {
  const answers = [...publicAnswers];
  const first = await fixture(answers);
  const connected = first.begin();
  first.client.write(clientHello());
  await connected;
  answers.splice(0, answers.length, { address: '127.0.0.1', family: 4 });
  const second = await fixture(answers);
  const refused = expect(second.begin()).rejects.toThrow('egress_dns_refused');
  second.client.write(clientHello());
  await refused;
  expect(second.lookups).toEqual(['registry.npmjs.org']);
  expect(second.requests).toHaveLength(0);
}
it('resolves a new connection again and refuses a rebound private answer', rechecksDns);

async function refusesMalformedHello(offset: number, value: number) {
  const bytes = clientHello();
  bytes[offset] = value;
  await refusesHello('malformed ClientHello', bytes);
}
it.each([[0, 23], [5, 2], [8, 1], [9, 2], [43, 33], [45, 1], [50, 255],
  [53, 23], [58, 1], [60, 255]])(
  'refuses malformed TLS fields at byte %s', refusesMalformedHello);
