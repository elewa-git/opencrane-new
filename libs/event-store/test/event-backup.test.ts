import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { AckPolicy, jetstream, jetstreamManager } from '@nats-io/jetstream';
import { headers, type Msg, type Subscription, type SubscriptionOptions }
  from '@nats-io/transport-node';
import { collectEventBackup, descriptorSchema } from '../../../infra/package/event-backup.ts';
import { event, natsFixture } from './testing.ts';

const execute = promisify(execFile);
const canary = 'synthetic-sensitive-value-never-print';

async function fixture() {
  const source = await natsFixture();
  const directory = await mkdtemp(join(tmpdir(), 'event-backup-'));
  const destination = join(directory, 'capture');
  const options = { silo: 'test', attempt: 'attempt-1', destination };
  const original = event('saved-command');
  const command = { ...original, data: { ...original.data, displayName: canary } };
  await source.store.append({ event: command, expectedSequence: 0 });
  async function close() {
    await source.close();
    await rm(directory, { recursive: true, force: true });
  }
  return { source, directory, destination, options, command, close };
}

async function restoresNativeBytes() {
  const setup = await fixture();
  const target = await natsFixture();
  try {
    await setup.source.store.append({ event: event('second', 'member-bob'), expectedSequence: 0 });
    await setup.source.store.append({ event: event('third'), expectedSequence: 1 });
    const sourceManager = await jetstreamManager(setup.source.connection);
    await sourceManager.consumers.add('EVENTS',
      { durable_name: 'backup-probe', ack_policy: AckPolicy.Explicit });
    const before = await Array.fromAsync(setup.source.store.readStream('member-alice'));
    await collectEventBackup(setup.source.connection, setup.options);
    const descriptorText = await readFile(join(setup.destination, 'descriptor.json'), 'utf8');
    const descriptor = descriptorSchema.parse(JSON.parse(descriptorText));
    const archive = await readFile(join(setup.destination, 'events.snapshot'));
    expect(descriptor).toMatchObject({
      kind: 'event-bytes-only', silo: 'test', attempt: 'attempt-1',
      firstSequence: 1, lastSequence: 3, eventCount: 3,
      subjectPositions: { 'ev.member.alice': 3, 'ev.member.bob': 2 }, byteCount: archive.length,
    });
    expect(descriptor.identityDigest)
      .toBe('89ca95e09c6fca864827df93595a175aaedd7ec939ae8829112625fbcc9cb26a');
    expect(descriptor.sha256).toBe(createHash('sha256').update(archive).digest('hex'));
    expect(descriptorText).not.toContain(canary);
    expect(descriptorSchema.safeParse({ ...descriptor, completeBackup: true }).success).toBe(false);
    for (const name of ['', 'descriptor.json', 'events.snapshot']) {
      const metadata = await stat(join(setup.destination, name));
      expect(metadata.mode & 0o777).toBe(name ? 0o600 : 0o700);
    }
    expect(await readdir(setup.destination)).toEqual(['descriptor.json', 'events.snapshot']);
    const manager = await jetstreamManager(target.connection);
    await manager.streams.delete('EVENTS');
    const info = await sourceManager.streams.info('EVENTS');
    const reply = await target.connection.request('$JS.API.STREAM.RESTORE.EVENTS',
      JSON.stringify({ config: info.config, state: info.state }));
    const delivery = reply.json<{ deliver_subject: string }>().deliver_subject;
    await target.connection.request(delivery, archive);
    const finished = await target.connection.request(delivery, new Uint8Array());
    expect(finished.json<{ error?: unknown }>().error).toBeUndefined();
    const restoredInfo = await manager.streams.info('EVENTS');
    expect(restoredInfo.state.consumer_count).toBe(0);
    expect(await Array.fromAsync(target.store.readStream('member-alice'))).toEqual(before);
    const probe = await jetstream(target.connection).publish('ev.member.probe', '{}',
      { msgID: setup.command.id });
    expect(probe.duplicate).toBe(false);
    const repeated = { ...setup.command, id: 'another-id' };
    expect(await target.store.append({ event: repeated, expectedSequence: 3 }))
      .toMatchObject({ status: 'appended', sequence: 1 });
    expect(await Array.fromAsync(target.store.readStream('member-alice'))).toEqual(before);
  } finally {
    await target.close();
    await setup.close();
  }
}

const failures = ['write', 'identity', 'malformed', 'missing-final', 'size', 'timeout',
  'cancel', 'disconnect', 'wrong-silo', 'snapshot-size', 'api-error'] as const;
async function refusesCaptureFault(fault: typeof failures[number]) {
  const setup = await fixture();
  const connection = setup.source.connection;
  const request = connection.request.bind(connection);
  const subscribe = connection.subscribe.bind(connection);
  const controller = new AbortController();
  let infoReads = 0;
  let captureSubscription: Subscription | undefined;
  async function faultyRequest(...args: Parameters<typeof request>) {
    const reply = await request(...args);
    if (args[0] === '$JS.API.STREAM.INFO.EVENTS') {
      infoReads += 1;
      if (fault === 'identity' && infoReads === 2) {
        const data = reply.json<Record<string, unknown>>();
        data['created'] = '2026-01-01T00:00:00Z';
        reply.data = Buffer.from(JSON.stringify(data));
      }
    }
    if (args[0] === '$JS.API.STREAM.SNAPSHOT.EVENTS') {
      if (fault === 'write') {
        await setup.source.store.append({ event: event('racing-write'), expectedSequence: 1 });
      }
      if (fault === 'malformed') reply.data = Buffer.from(canary);
      if (fault === 'api-error') {
        const data = reply.json<Record<string, unknown>>();
        data['error'] = { description: canary };
        reply.data = Buffer.from(JSON.stringify(data));
      }
      if (fault === 'disconnect') await setup.source.stop();
      if (fault === 'cancel') controller.abort(new Error(canary));
    }
    return reply;
  }
  function faultySubscribe(subject: string, options?: SubscriptionOptions) {
    const callback = options?.callback;
    function deliver(error: Error | null, message: Msg) {
      expect(statSync(join(setup.destination, 'events.partial')).mode & 0o777).toBe(0o600);
      expect(statSync(setup.destination).mode & 0o777).toBe(0o700);
      if (fault === 'snapshot-size' && message.data.length > 0) {
        message.data = new Uint8Array(2048);
      }
      if (fault === 'missing-final' && message.data.length === 0) return;
      return callback?.(error, message);
    }
    captureSubscription = subscribe(subject, { ...options, callback: deliver });
    return captureSubscription;
  }
  vi.spyOn(connection, 'request').mockImplementation(faultyRequest);
  vi.spyOn(connection, 'subscribe').mockImplementation(faultySubscribe);
  try {
    if (fault === 'timeout') setup.source.pauseResponses(true);
    let maxBytes = 64 * 1024 * 1024;
    if (fault === 'size') maxBytes = 1;
    if (fault === 'snapshot-size') maxBytes = 1024;
    const options = { ...setup.options, signal: controller.signal, timeoutMs: 300,
      maxBytes,
      silo: fault === 'wrong-silo' ? 'foreign' : 'test' };
    await expect(collectEventBackup(connection, options)).rejects.toEqual(new Error('Event backup refused'));
    expect(await readdir(setup.directory)).toEqual([]);
    if (fault === 'identity') expect(infoReads).toBe(2);
    if (captureSubscription) expect(captureSubscription.isClosed()).toBe(true);
  } finally {
    vi.restoreAllMocks();
    await setup.close();
  }
}

async function refusesExistingDestination(kind: 'existing' | 'symlink') {
  const setup = await fixture();
  try {
    if (kind === 'existing') {
      await collectEventBackup(setup.source.connection, setup.options);
    } else {
      await symlink(setup.directory, setup.destination);
    }
    await expect(collectEventBackup(setup.source.connection, setup.options))
      .rejects.toEqual(new Error('Event backup refused'));
    if (kind === 'existing') {
      expect(await readdir(setup.destination)).toEqual(['descriptor.json', 'events.snapshot']);
    }
  } finally {
    await setup.close();
  }
}

async function checksFinalSnapshotStatus(status: number) {
  const setup = await fixture();
  const connection = setup.source.connection;
  const subscribe = connection.subscribe.bind(connection);
  let captureSubscription: Subscription | undefined;
  let receivedBytes = 0;
  let finalReceived = false;
  function subscribeWithFinalStatus(subject: string, options?: SubscriptionOptions) {
    const callback = options?.callback;
    function deliver(error: Error | null, message: Msg) {
      if (message.data.length > 0) {
        receivedBytes += message.data.length;
      } else {
        expect(error).toBeNull();
        expect(receivedBytes).toBeGreaterThan(0);
        expect(statSync(join(setup.destination, 'events.partial')).size).toBe(receivedBytes);
        finalReceived = true;
        if (status !== 0) {
          const failureHeaders = headers(status, canary);
          vi.spyOn(message, 'headers', 'get').mockReturnValue(failureHeaders);
        } else {
          expect(message.headers).toBeUndefined();
        }
      }
      return callback?.(error, message);
    }
    const subscriptionOptions = { ...options, callback: deliver };
    captureSubscription = subscribe(subject, subscriptionOptions);
    return captureSubscription;
  }
  vi.spyOn(connection, 'subscribe').mockImplementation(subscribeWithFinalStatus);
  try {
    const capture = collectEventBackup(connection, setup.options);
    if (status === 0) {
      await capture;
      const descriptorText = await readFile(join(setup.destination, 'descriptor.json'), 'utf8');
      const descriptor = descriptorSchema.parse(JSON.parse(descriptorText));
      const archive = await readFile(join(setup.destination, 'events.snapshot'));
      const archiveHash = createHash('sha256');
      archiveHash.update(archive);
      expect(descriptor.byteCount).toBe(receivedBytes);
      expect(archive.length).toBe(receivedBytes);
      expect(descriptor.sha256).toBe(archiveHash.digest('hex'));
      expect(await readdir(setup.destination)).toEqual(['descriptor.json', 'events.snapshot']);
    } else {
      await expect(capture).rejects.toEqual(new Error('Event backup refused'));
      expect(await readdir(setup.directory)).toEqual([]);
    }
    expect(finalReceived).toBe(true);
    expect(captureSubscription?.isClosed()).toBe(true);
  } finally {
    vi.restoreAllMocks();
    await setup.close();
  }
}

async function refusesOrdinaryIdentity(role: string) {
  const setup = await fixture();
  try {
    const connection = await setup.source.client(role);
    await expect(collectEventBackup(connection, { ...setup.options, timeoutMs: 300 }))
      .rejects.toEqual(new Error('Event backup refused'));
    expect(await readdir(setup.directory)).toEqual([]);
  } finally {
    await setup.close();
  }
}

const entry = 'infra/package/event-backup-run.ts';
async function checksExecutablePermissions(role: string) {
  const setup = await fixture();
  try {
    const env = { ...process.env, ...setup.source.env(role), NODE_NO_WARNINGS: '1' };
    const args = ['--experimental-strip-types', entry, 'test', 'attempt-1', setup.destination];
    const operation = execute(process.execPath, args, { env, timeout: 10_000 });
    if (role === 'command') {
      const result = await operation;
      expect(result.stdout + result.stderr).toBe('');
      expect(await readdir(setup.destination)).toEqual(['descriptor.json', 'events.snapshot']);
    } else {
      await expect(operation).rejects.toMatchObject({ stdout: '', stderr: 'Event backup refused\n' });
      expect(await readdir(setup.directory)).toEqual([]);
    }
  } finally {
    await setup.close();
  }
}

it('exports native bytes, restores identities and preserves command idempotency', restoresNativeBytes);
it.each(failures)('refuses %s and removes partial files', refusesCaptureFault);
it.each([500, 408])('refuses final snapshot status %s after data and removes the backup',
  checksFinalSnapshotStatus);
it('publishes the backup after a clean final snapshot message', checksCleanFinalSnapshot);
it.each(['existing', 'symlink'] as const)('refuses an %s destination', refusesExistingDestination);
it.each(['projection', 'dispatcher', 'computer', 'gateway'])('refuses %s', refusesOrdinaryIdentity);
it.each(['command', 'projection'])('operator executable uses %s permissions', checksExecutablePermissions);

async function checksCleanFinalSnapshot() {
  await checksFinalSnapshotStatus(0);
}
