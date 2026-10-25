import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { jetstream, jetstreamManager } from '@nats-io/jetstream';
import { createEventStore } from '../src/index.ts';
import { collectEventBackup, descriptorSchema } from '../../../infra/package/event-backup.ts';
import { restoreEventBackup } from '../../../infra/package/event-restore.ts';
import { event, natsFixture } from './testing.ts';

const execute = promisify(execFile);
const canary = 'private-restore-canary-never-print';
const refused = new Error('Event restore refused; keep target isolated');

async function fixture() {
  const source = await natsFixture();
  const target = await natsFixture({ provision: false });
  const directory = await mkdtemp(join(tmpdir(), 'event-restore-'));
  const destination = join(directory, 'backup');
  const original = event('original');
  original.data['displayName'] = canary;
  await source.store.append({ event: original, expectedSequence: 0 });
  await source.store.append({ event: event('other', 'member-bob'), expectedSequence: 0 });
  await source.store.append({ event: event('later'), expectedSequence: 1 });
  await collectEventBackup(source.connection, { silo: 'test', attempt: 'copy', destination });
  const options = { directory: destination, silo: 'test', disposable: true as const };
  async function close() {
    vi.restoreAllMocks();
    const results = await Promise.allSettled([source.close(), target.close(),
      rm(directory, { recursive: true, force: true })]);
    for (const result of results) expect(result.status).toBe('fulfilled');
  }
  return { source, target, destination, options, original, close };
}

async function restoresEvents() {
  const setup = await fixture();
  try {
    const before = await Array.fromAsync(setup.source.store.readStream('member-alice'));
    await restoreEventBackup(setup.source.connection, setup.target.connection, setup.options);
    const manager = await jetstreamManager(setup.target.connection);
    const info = await manager.streams.info('EVENTS');
    expect(info.state).toMatchObject({ first_seq: 1, last_seq: 3, messages: 3, consumer_count: 0 });
    // Discard client summaries before checking durable history and command retries.
    await setup.target.connection.close();
    const connection = await setup.target.client('command');
    const store = await createEventStore(connection);
    expect(await Array.fromAsync(store.readStream('member-alice'))).toEqual(before);
    expect(await store.append({ event: event('stale'), expectedSequence: 1 }))
      .toMatchObject({ status: 'conflict' });
    const probe = await jetstream(connection).publish('ev.member.probe', '{}',
      { msgID: setup.original.id });
    expect(probe.duplicate).toBe(false);
    const retry = { ...setup.original, id: 'replacement-id' };
    expect(await store.append({ event: retry, expectedSequence: 3 }))
      .toMatchObject({ status: 'appended', sequence: 1 });
    expect(await Array.fromAsync(store.readStream('member-alice'))).toEqual(before);
  } finally {
    await setup.close();
  }
}

const inputFaults = ['truncated', 'corrupt', 'hash', 'identity', 'foreign-config',
  'same-server', 'empty-existing', 'populated-existing', 'not-disposable'] as const;
async function refusesBeforeMutation(fault: typeof inputFaults[number]) {
  const setup = await fixture();
  const connection = setup.target.connection;
  const request = vi.spyOn(connection, 'request');
  const manager = await jetstreamManager(connection);
  const descriptorPath = join(setup.destination, 'descriptor.json');
  const archivePath = join(setup.destination, 'events.snapshot');
  try {
    const descriptor = descriptorSchema.parse(JSON.parse(await readFile(descriptorPath, 'utf8')));
    if (fault === 'truncated' || fault === 'corrupt') {
      const archive = await readFile(archivePath);
      if (fault === 'truncated') await writeFile(archivePath, archive.subarray(0, -1));
      else {
        archive[0] = (archive[0] ?? 0) ^ 1;
        await writeFile(archivePath, archive);
      }
    }
    if (fault === 'hash') descriptor.sha256 = '0'.repeat(64);
    if (fault === 'identity') descriptor.created = '2000-01-01T00:00:00Z';
    if (fault === 'foreign-config') descriptor.config['subjects'] = ['foreign.>'];
    await writeFile(descriptorPath, JSON.stringify(descriptor));
    if (fault === 'empty-existing' || fault === 'populated-existing') {
      await setup.target.store.ensureStream({ replicas: 1 });
      if (fault === 'populated-existing') {
        await setup.target.store.append({ event: event('keep-me'), expectedSequence: 0 });
      }
    }
    const before = await manager.streams.list().next();
    const source = fault === 'same-server' ? connection : setup.source.connection;
    const options = { ...setup.options, disposable: fault !== 'not-disposable' };
    await expect(restoreEventBackup(source, connection, options)).rejects.toEqual(refused);
    expect(await manager.streams.list().next()).toEqual(before);
    for (const call of request.mock.calls) {
      expect(call[0]).not.toMatch(/STREAM\.(RESTORE|DELETE|PURGE)/);
    }
  } finally {
    await setup.close();
  }
}

const transferFaults = ['creator-race', 'timeout', 'partial', 'lost-final', 'error-final',
  'oversize-reply', 'wrong-order', 'wrong-position', 'wrong-range'] as const;
async function refusesUncertainTransfer(fault: typeof transferFaults[number]) {
  const setup = await fixture();
  const connection = setup.target.connection;
  const request = connection.request.bind(connection);
  const manager = await jetstreamManager(connection);
  let delivery = '';
  let restoreRequests = 0;
  let chunks = 0;
  async function intercept(...args: Parameters<typeof request>) {
    const [subject, bytes] = args;
    expect(subject).not.toMatch(/STREAM\.(DELETE|PURGE)/);
    if (subject === '$JS.API.STREAM.RESTORE.EVENTS') {
      restoreRequests++;
      if (fault === 'creator-race') {
        await setup.target.store.ensureStream({ replicas: 1 });
        await setup.target.store.append({ event: event('racer'), expectedSequence: 0 });
      }
    }
    if (subject === delivery && bytes?.length) {
      chunks++;
      if (fault === 'partial') {
        await request(subject, bytes.slice(0, 10));
        throw new Error(canary);
      }
    }
    const reply = await request(...args);
    if (subject === '$JS.API.STREAM.RESTORE.EVENTS') {
      delivery = reply.json<{ deliver_subject?: string }>().deliver_subject ?? '';
    }
    if (subject === delivery && !bytes?.length) {
      if (fault === 'lost-final') throw new Error(canary);
      if (fault === 'error-final') reply.data = Buffer.from(JSON.stringify({ error: canary }));
      if (fault === 'oversize-reply') reply.data = Buffer.alloc(1024 * 1024 + 1);
    }
    return reply;
  }
  vi.spyOn(connection, 'request').mockImplementation(intercept);
  try {
    const path = join(setup.destination, 'descriptor.json');
    const descriptor = descriptorSchema.parse(JSON.parse(await readFile(path, 'utf8')));
    if (fault === 'wrong-order') descriptor.identityDigest = '0'.repeat(64);
    if (fault === 'wrong-position') descriptor.subjectPositions['ev.member.alice'] = 2;
    if (fault === 'wrong-range') descriptor.lastSequence = 4;
    await writeFile(path, JSON.stringify(descriptor));
    if (fault === 'timeout') setup.target.pauseResponses(true);
    const options = { ...setup.options, timeoutMs: 500 };
    await expect(restoreEventBackup(setup.source.connection, connection, options))
      .rejects.toEqual(refused);
    setup.target.pauseResponses(false);
    expect(restoreRequests).toBeLessThanOrEqual(1);
    if (fault === 'partial') expect(chunks).toBe(1);
    if (fault === 'creator-race') {
      expect(await Array.fromAsync(setup.target.store.readStream('member-alice')))
        .toMatchObject([{ event: { id: 'racer' } }]);
    }
    if (['lost-final', 'error-final', 'oversize-reply'].includes(fault)) {
      expect((await manager.streams.info('EVENTS')).state.messages).toBe(3);
      await expect(restoreEventBackup(setup.source.connection, connection, setup.options))
        .rejects.toEqual(refused);
      expect(restoreRequests).toBe(1);
    }
  } finally {
    await setup.close();
  }
}

async function checksExecutable(role: string) {
  const setup = await fixture();
  try {
    const env = { ...process.env, ...setup.target.env(role), NODE_NO_WARNINGS: '1' };
    const sourceEnv = setup.source.env();
    for (const [name, value] of Object.entries(sourceEnv)) env[`SOURCE_${name}`] = value;
    const args = ['--experimental-strip-types', 'infra/package/event-restore-run.ts',
      'test', setup.destination, '--disposable'];
    const operation = execute(process.execPath, args, { env, timeout: 10_000 });
    if (role === 'command') {
      const output = await operation;
      expect(output.stdout + output.stderr).toBe('');
    } else {
      await expect(operation).rejects.toMatchObject({ stdout: '', stderr: `${refused.message}\n` });
    }
  } finally {
    await setup.close();
  }
}

it('restores an absent stream and preserves command history after client restart', restoresEvents);
it.each(inputFaults)('refuses %s before sending restore bytes', refusesBeforeMutation);
it.each(transferFaults)('refuses %s without erasing or retrying the target', refusesUncertainTransfer);
it.each(['command', 'projection'])('restore executable uses %s permissions', checksExecutable);
