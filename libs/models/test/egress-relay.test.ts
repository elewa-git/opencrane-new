import { once } from 'node:events';
import { connect, createServer, Socket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it, onTestFinished } from 'vitest';
import { EgressRelayRegistry, type EgressCloseRecord } from '../src/egress-relay.ts';
import { clientHello } from './egress-hello-fixture.ts';

const destination = { host: 'registry.npmjs.org', port: 443 };
async function fixture(stage = 'open', throwing = false) {
  const records: EgressCloseRecord[] = [];
  const sockets: Socket[] = [];
  let lookups = 0;
  let connections = 0;
  let received = 0;
  const answers = [{ address: '1.1.1.1', family: 4 }];
  const dns = Promise.withResolvers<typeof answers>();
  function record(socket: Socket) {
    sockets.push(socket);
    function echo(chunk: Buffer) {
      received += chunk.length;
      socket.write(chunk);
    }
    socket.on('data', echo);
  }
  const upstream = createServer(record);
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const address = upstream.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture port');
  const upstreamPort = address.port;
  function resolve() {
    lookups++;
    if (stage === 'dns') return dns.promise;
    return Promise.resolve(answers);
  }
  function connector() {
    connections++;
    if (stage === 'failed') throw new Error('Connect failed');
    let socket = new Socket();
    if (stage !== 'connect' && stage !== 'late-connect') {
      socket = connect(upstreamPort, '127.0.0.1');
    }
    if (stage === 'late-connect') registry.closePermit('permit');
    sockets.push(socket);
    return socket;
  }
  function closed(record: EgressCloseRecord) {
    records.push(record);
    if (throwing) throw new Error('Callback failed');
  }
  const transport = { resolve, connect: connector };
  const registry = new EgressRelayRegistry(closed, transport);
  async function register(permitId = 'permit', expiresAt = Date.now() + 400) {
    return registry.register({ ...destination, permitId, expiresAt });
  }
  async function dial(target: string, hello = true) {
    const port = Number(target.split(':')[1]);
    const socket = connect(port, '127.0.0.1');
    socket.on('error', ignoreError);
    sockets.push(socket);
    await once(socket, 'connect');
    if (hello) socket.write(clientHello());
    return socket;
  }
  async function cleanup() {
    registry.closeAll();
    for (const socket of sockets) socket.destroy();
    const finished = once(upstream, 'close');
    upstream.close();
    await finished;
  }
  onTestFinished(cleanup);
  function counts() {
    return { lookups, connections, received };
  }
  function recordCount() {
    return records.length;
  }
  function lookupCount() {
    return lookups;
  }
  function connectionCount() {
    return connections;
  }
  function socketsClosed() {
    return sockets.every(isClosed);
  }
  return { registry, register, dial, records, sockets, counts, dns, answers, recordCount, lookupCount, connectionCount, socketsClosed };
}
function ignoreError() {
  // Accept connection resets when a relay refuses a socket.
}

async function invalidRegistration(host: string, port: number, lifetime: number) {
  const setup = await fixture();
  const request = { host, port, permitId: 'permit', expiresAt: Date.now() + lifetime };
  await expect(setup.registry.register(request)).rejects.toThrow();
  expect(setup.records).toHaveLength(0);
  expect(setup.counts().connections).toBe(0);
  expect(await setup.register()).toMatch(/^127\.0\.0\.1:\d+$/u);
}
it.each([['localhost', 443, 400], ['127.0.0.1', 443, 400],
  ['example.com', 0, 400], ['example.com', 65536, 400], ['example.com', 1.5, 400],
  ['example.com', 443, -1], ['example.com', 443, 61000], ['example.com', 443, NaN]])(
  'refuses invalid registration %s:%s lasting %s', invalidRegistration);

async function singleUse(concurrent: boolean) {
  const setup = await fixture();
  const target = await setup.register();
  await expect(setup.register()).rejects.toThrow();
  const other = await setup.register('other');
  expect(other).not.toBe(target);
  const client = await setup.dial(target);
  await once(client, 'data');
  if (!concurrent) {
    client.destroy();
    await expect.poll(setup.recordCount).toBe(1);
  }
  const extra = await setup.dial(target);
  await once(extra, 'close');
  expect(setup.counts()).toEqual({ lookups: 1, connections: 1, received: clientHello().length });
  setup.registry.closePermit('permit');
  const afterClose = await setup.dial(target);
  await once(afterClose, 'close');
  await expect(setup.register()).rejects.toThrow();
}
it.each([false, true])('keeps a used port bound and refuses extras (concurrent: %s)', singleUse);

async function closesTunnel(action: string) {
  const setup = await fixture('open', true);
  const registeredAt = Date.now();
  const target = await setup.register();
  const client = await setup.dial(target);
  await once(client, 'data');
  const sent = once(client, 'data');
  client.write(Buffer.from('more'));
  await sent;
  const started = Date.now();
  const ended = once(client, 'close');
  if (action === 'permit') setup.registry.closePermit('permit');
  if (action === 'destination') setup.registry.closeDestination(destination);
  if (action === 'all') setup.registry.closeAll();
  if (action === 'finished') client.end();
  await ended;
  await expect.poll(setup.socketsClosed).toBe(true);
  expect(Date.now() - started).toBeLessThan(2000);
  setup.registry.closeAll();
  await delay(450);
  expect(setup.records).toHaveLength(1);
  let reason = 'revoked';
  if (action === 'expiry') reason = 'expired';
  if (action === 'finished') reason = 'finished';
  const record = setup.records[0]!;
  expect(record).toEqual({ permitId: 'permit', ...destination,
    address: '1.1.1.1', reason, bytesSent: clientHello().length + 4,
    bytesReceived: clientHello().length + 4, registeredAt: record.registeredAt,
    connectedAt: record.connectedAt, closedAt: record.closedAt });
  expect(setup.records[0]!.registeredAt).toBeGreaterThanOrEqual(registeredAt);
  expect(setup.records[0]!.connectedAt).toBeGreaterThanOrEqual(setup.records[0]!.registeredAt);
  expect(setup.records[0]!.closedAt).toBeGreaterThanOrEqual(setup.records[0]!.connectedAt!);
}
function isClosed(socket: Socket) {
  return socket.destroyed;
}
it.each(['permit', 'destination', 'all', 'expiry', 'finished'])(
  'closes both sides once with exact counts on %s, despite a throwing callback', closesTunnel);

async function stopsPending(stage: string, expire: boolean) {
  const setup = await fixture(stage);
  const target = await setup.register();
  if (stage !== 'before') {
    await setup.dial(target, stage !== 'hello');
    if (stage === 'dns') await expect.poll(setup.lookupCount).toBe(1);
    if (stage === 'connect' || stage === 'late-connect') {
      await expect.poll(setup.connectionCount).toBe(1);
    }
  }
  const started = Date.now();
  if (!expire) setup.registry.closePermit('permit');
  await expect.poll(setup.recordCount).toBe(1);
  expect(Date.now() - started).toBeLessThan(2000);
  setup.dns.resolve(setup.answers);
  if (stage === 'connect') setup.sockets.at(-1)!.emit('connect');
  if (stage === 'before' && !expire) {
    const extra = await setup.dial(target);
    await once(extra, 'close');
  }
  await delay(20);
  expect(setup.counts().received).toBe(0);
  const connected = stage === 'connect' || stage === 'late-connect';
  expect(setup.counts().connections).toBe(connected ? 1 : 0);
  expect(setup.sockets.every(isClosed)).toBe(true);
  expect(setup.records).toHaveLength(1);
  expect(setup.records[0]).toMatchObject({ connectedAt: null, bytesSent: 0,
    bytesReceived: 0, reason: expire ? 'expired' : 'revoked' });
}
it.each([['before', false], ['hello', false], ['dns', false], ['connect', false],
  ['before', true], ['hello', true], ['dns', true], ['connect', true], ['late-connect', false]])(
  'stops %s work with no bytes (expiry: %s)', stopsPending);

async function recordsRefusal() {
  const setup = await fixture();
  const client = await setup.dial(await setup.register(), false);
  client.write(Buffer.alloc(5));
  await once(client, 'close');
  expect(setup.records).toHaveLength(1);
  expect(setup.records[0]).toMatchObject({ reason: 'refused', address: null,
    connectedAt: null, bytesSent: 0, bytesReceived: 0 });
}
it('records a guard refusal without storing tunnel data', recordsRefusal);

async function failedConnection() {
  const setup = await fixture('failed');
  const client = await setup.dial(await setup.register());
  await once(client, 'close');
  expect(setup.records).toHaveLength(1);
  expect(setup.records[0]).toMatchObject({ reason: 'failed', address: '1.1.1.1',
    connectedAt: null, bytesSent: 0, bytesReceived: 0 });
}
it('records a failed connection with its checked address', failedConnection);

async function matchesExactDestination() {
  const setup = await fixture();
  const first = await setup.register();
  const other = { ...destination, port: 8443, permitId: 'other', expiresAt: Date.now() + 400 };
  const second = await setup.registry.register(other);
  setup.registry.closeDestination({ host: 'REGISTRY.NPMJS.ORG', port: 443 });
  expect(setup.records).toHaveLength(1);
  expect(setup.records[0]).toMatchObject({ permitId: 'permit', address: null });
  const refused = await setup.dial(first);
  await once(refused, 'close');
  const allowed = await setup.dial(second);
  await once(allowed, 'data');
  expect(setup.counts().connections).toBe(1);
}
it('normalises the host and closes only the exact destination port', matchesExactDestination);
