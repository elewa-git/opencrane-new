import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { jetstreamManager } from '@nats-io/jetstream';
import { egressObservationSchema } from '@opencrane/events';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { expect, it, onTestFinished } from 'vitest';
import { databases } from '@opencrane/authz/testing';
import { auditTrail, pgDb, ProjectionRunner, readAudit } from '@opencrane/projections';
import { createLogger } from '@opencrane/observability';
import { history } from '../src/event-history.ts';
import { egressFixture } from './egress-fixture.ts';
import { clientHello } from './egress-hello-fixture.ts';

async function normalClose() {
  const setup = await egressFixture(true, true);
  const observationId = setup.receipt.observationId;
  await setup.tunnel(await setup.token(), 'registry.npmjs.org:443', clientHello());
  function closed() { return setup.closeRecords.length; }
  await expect.poll(closed).toBe(1);
  expect(setup.receipt.capture(setup.closeRecords[0])).toBe(true);
  expect(await setup.receipt.retry()).toBe('saved');
  const rows = await history(setup.store, `egress-${setup.permit}`, 'test');
  expect(rows).toHaveLength(1);
  expect(rows[0]?.event).toMatchObject({ id: observationId, type: 'egress.observed',
    data: { outcome: 'unknown', relay: { reason: 'finished', address: '1.1.1.1',
      host: 'registry.npmjs.org', port: 443, bytesSent: clientHello().length,
      bytesReceived: clientHello().length } } });
  expect(JSON.stringify(rows)).not.toContain('secret-canary');
}
it('saves one durable close receipt from the pinned gateway', normalClose);

async function competingClosers(expire: boolean) {
  const setup = await egressFixture(true, true);
  async function closeTogether(socket: import('node:net').Socket) {
    const closed = once(socket, 'close');
    if (expire) await closed;
    const permitClose = Promise.resolve().then(closePermit);
    const allClose = Promise.resolve().then(closeAll);
    await Promise.all([permitClose, allClose]);
    await closed;
  }
  function closePermit() { setup.registry.closePermit(setup.permit); }
  function closeAll() { setup.registry.closeAll(); }
  await setup.tunnel(await setup.token(), 'registry.npmjs.org:443', clientHello(), closeTogether);
  expect(setup.closeRecords).toHaveLength(1);
  expect(setup.receipt.capture(setup.closeRecords[0])).toBe(true);
  expect(setup.receipt.capture(setup.closeRecords[0])).toBe(true);
  expect(await setup.receipt.retry()).toBe('saved');
  const restarted = await setup.restartReceipt();
  expect(await restarted.retry()).toBe('saved');
  const rows = await history(setup.store, `egress-${setup.permit}`, 'test');
  expect(rows).toHaveLength(1);
  expect(setup.connected()).toBe(1);
}
it.each([false, true])('deduplicates competing closures and redelivery (expiry: %s)',
  competingClosers);

async function unavailableAppend(accepted: boolean) {
  const setup = await egressFixture(true, true);
  const manager = await jetstreamManager(setup.connection);
  await manager.streams.update('EVENTS', { duplicate_window: 100_000_000 });
  const append = setup.store.append.bind(setup.store);
  const readStream = setup.store.readStream.bind(setup.store);
  let readsUnavailable = false;
  async function* unavailableRead(...args: Parameters<typeof readStream>) {
    if (readsUnavailable) throw new Error('private-read-canary');
    yield* readStream(...args);
  }
  setup.store.readStream = unavailableRead;
  let attempted = 0;
  async function unavailable(command: import('@opencrane/event-store').AppendCommand)
    : Promise<import('@opencrane/event-store').AppendResult> {
    attempted++;
    const cause = new Error('private-outage-canary');
    if (!accepted) return { status: 'unavailable', cause };
    await append(command);
    readsUnavailable = true;
    throw cause;
  }
  async function afterEcho(socket: import('node:net').Socket) {
    setup.store.append = unavailable;
    const started = Date.now();
    const closed = once(socket, 'close');
    setup.registry.closeAll('unavailable');
    await closed;
    await expect.poll(setup.activeConnections).toBe(0);
    expect(Date.now() - started).toBeLessThan(2000);
  }
  await setup.tunnel(await setup.token(), 'registry.npmjs.org:443', clientHello(), afterEcho);
  expect(await setup.receipt.retry()).toBe('pending');
  expect(attempted).toBeLessThanOrEqual(2);
  const originalId = setup.receipt.observationId;
  setup.store.readStream = readStream;
  const originalRows = await history(setup.store, `egress-${setup.permit}`, 'test');
  expect(originalRows).toHaveLength(accepted ? 1 : 0);
  const evidence = await readFile(`${setup.directory}/${originalId}.jsonl`, 'utf8');
  expect(evidence).not.toContain('private-outage-canary');
  expect(evidence).not.toContain('secret-canary');
  expect(evidence).not.toContain(clientHello().toString('base64'));
  expect(evidence).not.toContain('success');
  setup.store.append = append;
  await delay(150);
  await setup.restartStore();
  const restarted = await setup.restartReceipt();
  expect(restarted.observationId).toBe(originalId);
  const concurrent = await Promise.all([restarted.retry(), setup.receipt.retry()]);
  expect(concurrent).toEqual(['saved', 'saved']);
  expect(await restarted.retry()).toBe('saved');
  const rows = await history(setup.store, `egress-${setup.permit}`, 'test');
  expect(rows).toHaveLength(1);
  expect(setup.connected()).toBe(1);
  expect(rows[0]?.event.data).toMatchObject({ outcome: 'unknown',
    relay: { reason: 'unavailable' } });
}
it.each([false, true])('retains outage evidence and recovers after restart (append saved: %s)',
  unavailableAppend);

async function refusesForeignEvidence() {
  const setup = await egressFixture(true, true);
  await setup.tunnel(await setup.token(), 'registry.npmjs.org:443', clientHello());
  function closed() { return setup.closeRecords.length; }
  await expect.poll(closed).toBe(1);
  expect(await setup.receipt.retry()).toBe('saved');
  const record = setup.closeRecords[0]!;
  const patches = [{ permitId: 'foreign' }, { host: 'foreign.org' }, { port: 8443 },
    { address: '127.0.0.1' }, { reason: 'private-path-canary' }, { bytesSent: -1 },
    { closedAt: 0 }, { header: 'private-bytes-canary' }];
  for (const patch of patches) {
    expect(setup.receipt.capture({ ...record, ...patch })).toBe(false);
  }
  const rows = await history(setup.store, `egress-${setup.permit}`, 'test');
  const event = rows[0]!.event;
  const data = egressObservationSchema.parse(event.data);
  const forgeries = [{ data: { ...data, outcome: 'success' } }, { silo: 'foreign' }, { source: 'computer' },
    { principal: { kind: 'human', id: 'models' } }, { subject: 'egress-foreign' }];
  for (const patch of forgeries) {
    const forged = { ...event, ...patch };
    expect(await setup.store.append({ event: forged, expectedSequence: 0 }))
      .toMatchObject({ status: 'rejected' });
    const file = `${setup.directory}/${setup.receipt.observationId}.jsonl`;
    await writeFile(file, JSON.stringify(forged));
    await expect(setup.restartReceipt()).rejects.toThrow('egress_receipt_refused');
  }
  const oversized = ' '.repeat(4097);
  await writeFile(`${setup.directory}/${setup.receipt.observationId}.jsonl`, oversized);
  await expect(setup.restartReceipt()).rejects.toThrow('egress_receipt_refused');
}
it('refuses changed callbacks and forged or foreign saved evidence', refusesForeignEvidence);

async function rebuildsWithoutConnecting() {
  const setup = await egressFixture(true, true);
  const database = await databases();
  onTestFinished(database.close.bind(database));
  const db = pgDb(database.queue);
  const logger = createLogger('egress-replay-test', { level: 'silent' });
  const runner = new ProjectionRunner(db, setup.store, logger);
  await runner.initialise(auditTrail);
  await setup.tunnel(await setup.token(), 'registry.npmjs.org:443', clientHello());
  function closed() { return setup.closeRecords.length; }
  await expect.poll(closed).toBe(1);
  expect(await setup.receipt.retry()).toBe('saved');
  await runner.run(auditTrail);
  const filter = { requestId: setup.permit };
  const before = await readAudit(db, 'test', filter);
  expect(before.rows[0]?.outcome).toBe('unknown');
  expect(before.rows[0]?.records).toContainEqual(expect.objectContaining({
    eventId: setup.receipt.observationId, type: 'egress.observed', status: 'unknown' }));
  const position = await setup.store.head();
  const connections = setup.connected();
  await runner.rebuild(auditTrail);
  expect(await readAudit(db, 'test', filter)).toEqual(before);
  expect(await setup.store.head()).toBe(position);
  expect(setup.connected()).toBe(connections);
}
it('rebuilds the receipt in PostgreSQL without appending or opening relays',
  rebuildsWithoutConnecting);

async function failedEvidenceWrite() {
  const setup = await egressFixture(true, true);
  const file = `${setup.directory}/${setup.receipt.observationId}.jsonl`;
  await mkdir(file);
  await setup.tunnel(await setup.token(), 'registry.npmjs.org:443', clientHello());
  function closed() { return setup.closeRecords.length; }
  await expect.poll(closed).toBe(1);
  expect(await setup.receipt.retry()).toBe('pending');
  expect(await history(setup.store, `egress-${setup.permit}`, 'test'))
    .toHaveLength(0);
  await rm(file, { recursive: true });
  expect(await setup.receipt.retry()).toBe('saved');
  expect(setup.connected()).toBe(1);
}
it('keeps a pending record when the callback cannot write its evidence file', failedEvidenceWrite);
