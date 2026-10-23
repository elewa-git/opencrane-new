import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { event, natsFixture } from '@opencrane/event-store/testing';
import type { EventEnvelope } from '@opencrane/events';
import { routine, joinedMember } from './routine-fixture.ts';
import { createStore, memberAuthorisation, rebuildMembers } from '../src/index.ts';
import { objectId, TupleClient, type Binding } from '../src/client.ts';
import { openfga } from './services.ts';

function noSql(): never {
  throw new Error('Permission replay cannot write SQL');
}
const db = { query: noSql };
const exec = promisify(execFile);

async function routinePermissions() {
  const nats = await natsFixture();
  const fga = await openfga();
  try {
    const binding = await createStore(fga.apiUrl, 'test');
    const auth = memberAuthorisation(binding, nats.store);
    const alice = joinedMember('alice');
    const admin = joinedMember('admin');
    const bob = joinedMember('bob');
    const created = routine('routine.created');
    await nats.seed([alice, admin, bob, created]);
    for (const saved of [alice, admin, bob, created]) {
      await auth.handler.handle(saved, db);
    }
    expect((await auth.routine('alice', 'orders', 'read_metadata')).allowed).toBe(true);
    expect((await auth.routine('alice', 'orders', 'manage')).allowed).toBe(true);
    expect((await auth.routine('admin', 'orders', 'read_metadata')).allowed).toBe(true);
    expect((await auth.routine('admin', 'orders', 'manage')).allowed).toBe(false);
    expect((await auth.routine('bob', 'orders', 'read_metadata')).allowed).toBe(false);
    expect((await auth.routine('outsider', 'orders', 'manage')).allowed).toBe(false);
    const foreignBinding = { ...binding, silo: 'foreign' };
    const foreign = memberAuthorisation(foreignBinding, nats.store);
    expect((await foreign.routine('alice', 'orders', 'read_metadata')).allowed).toBe(false);
    expect(await auth.applied(created.id)).toBe(true);
    const options = { verifyAgainst: binding };
    const rebuilt = await rebuildMembers(fga.apiUrl, 'test', nats.reader, options);
    expect(rebuilt.verified).toBe(true);
  } finally {
    await fga.close();
    await nats.close();
  }
}
it('gives the owner management and current silo admins metadata only', routinePermissions, 30_000);

async function guardedReplay(nats: Awaited<ReturnType<typeof natsFixture>>, binding: Binding) {
  const env = { ...process.env, ...nats.env('projection'), LOG_LEVEL: 'silent',
    SILO_ID: binding.silo,
    OPENFGA_API_URL: binding.apiUrl, OPENFGA_STORE_ID: binding.storeId,
    OPENFGA_MODEL_ID: binding.authorizationModelId };
  const args = ['--experimental-strip-types', '--experimental-test-module-mocks',
    '--import', './apps/ops/test/support/routine-effects.ts',
    'apps/ops/src/replay.ts', 'openfga', '--verify', '--confirm-openfga-stopped'];
  const options = { env };
  const result = await exec(process.execPath, args, options);
  expect(result.stdout).toContain('PASS: openfga rebuilt');
  const output = result.stdout + result.stderr;
  expect(output).not.toContain('Forbidden routine replay effect');
  expect(output).not.toContain('ZmFrZS1jaXBoZXJ0ZXh0');
  expect(output).not.toContain('key:1');
}

async function transfersAndRetirement() {
  const nats = await natsFixture();
  const fga = await openfga();
  try {
    const binding = await createStore(fga.apiUrl, 'test');
    const auth = memberAuthorisation(binding, nats.store);
    const client = new TupleClient(binding);
    const created = routine('routine.created');
    const transfer = routine('routine.reassigned', 'bob', 'transfer-bob');
    const second = routine('routine.reassigned', 'carol', 'transfer-carol');
    const retired = routine('routine.retired');
    const members = ['alice', 'bob', 'carol', 'admin'];
    for (const memberId of members) {
      const joined = joinedMember(memberId);
      await nats.seed([joined]);
      await auth.handler.handle(joined, db);
    }
    await nats.seed([created]);
    await auth.handler.handle(created, db);
    const ownerTuple = { user: objectId('person', 'test', 'alice'),
      object: objectId('routine', 'test', 'orders'), relation: 'manage' };
    const creationReceipt = { user: objectId('silo', 'test'), relation: 'applied',
      object: objectId('projection_event', 'test', created.id) };
    await client.write([], [creationReceipt]);
    expect((await client.check(ownerTuple)).allowed).toBe(true);
    expect((await auth.routine('alice', 'orders', 'manage')).allowed).toBe(false);
    await auth.handler.handle(created, db);
    await fga.pause();
    expect((await auth.routine('alice', 'orders', 'manage')).allowed).toBe(false);
    await fga.resume();
    expect((await auth.routine('alice', 'orders', 'manage')).allowed).toBe(true);

    await nats.seed([transfer]);
    expect((await client.check(ownerTuple)).allowed).toBe(true);
    expect((await auth.routine('alice', 'orders', 'manage')).allowed).toBe(false);
    expect((await auth.routine('alice', 'orders', 'read_metadata')).allowed).toBe(false);
    expect((await auth.routine('bob', 'orders', 'manage')).allowed).toBe(false);
    await auth.handler.handle(transfer, db);
    expect((await auth.routine('bob', 'orders', 'manage')).allowed).toBe(true);
    await nats.seed([second]);
    await auth.handler.handle(second, db);
    // Remove old receipts to exercise delayed jobs, rather than duplicate delivery alone.
    const transferReceipt = { ...creationReceipt,
      object: objectId('projection_event', 'test', transfer.id) };
    await client.write([], [creationReceipt, transferReceipt]);
    await auth.handler.handle(transfer, db);
    await auth.handler.handle(created, db);
    expect((await auth.routine('alice', 'orders', 'manage')).allowed).toBe(false);
    expect((await auth.routine('bob', 'orders', 'manage')).allowed).toBe(false);
    expect((await auth.routine('carol', 'orders', 'manage')).allowed).toBe(true);
    const staleOwner = { ...ownerTuple, relation: 'owner' };
    const staleMetadata = { ...ownerTuple, relation: 'read_metadata' };
    await client.write([staleOwner], []);
    expect((await client.check(staleMetadata)).allowed).toBe(true);
    expect((await auth.routine('alice', 'orders', 'read_metadata')).allowed).toBe(false);
    expect((await auth.routine('alice', 'orders', 'manage')).allowed).toBe(false);
    await client.write([], [staleOwner]);
    const options = { verifyAgainst: binding };
    expect((await rebuildMembers(fga.apiUrl, 'test', nats.reader, options)).verified).toBe(true);

    await nats.seed([retired]);
    expect((await auth.routine('carol', 'orders', 'manage')).allowed).toBe(false);
    expect((await auth.routine('admin', 'orders', 'read_metadata')).allowed).toBe(false);
    await auth.handler.handle(retired, db);
    expect((await auth.routine('carol', 'orders', 'read_metadata')).allowed).toBe(true);
    expect((await auth.routine('admin', 'orders', 'read_metadata')).allowed).toBe(true);
    const successorTuple = { ...ownerTuple, user: objectId('person', 'test', 'carol') };
    expect((await client.check(successorTuple)).allowed).toBe(false);
    await client.write([], [transferReceipt]);
    await auth.handler.handle(transfer, db);
    expect((await client.check(successorTuple)).allowed).toBe(false);
    const before = await nats.reader.head();
    await guardedReplay(nats, binding);
    const rebuilt = await rebuildMembers(fga.apiUrl, 'test', nats.reader, options);
    expect(rebuilt.verified).toBe(true);
    expect(await nats.reader.head()).toBe(before);
    const replayed = memberAuthorisation(rebuilt.binding, nats.store);
    expect((await replayed.routine('carol', 'orders', 'read_metadata')).allowed).toBe(true);
    expect((await replayed.routine('carol', 'orders', 'manage')).allowed).toBe(false);

    await revokedReaders(nats, auth);
  } finally {
    await fga.close();
    await nats.close();
  }
}
it('requires exact receipts and keeps transfers and retirement through delayed jobs and replay',
  transfersAndRetirement, 45_000);

async function bindingsAndLegacy() {
  const nats = await natsFixture();
  const fga = await openfga();
  try {
    const binding = await createStore(fga.apiUrl, 'test');
    const auth = memberAuthorisation(binding, nats.store);
    const joined = event('joined-alice', 'member-alice');
    await nats.seed([joined]);
    await auth.handler.handle(joined, db);
    const created = routine('routine.created');
    const invalid = [
      { ...created, subject: 'routine-other' },
      { ...created, silo: 'other' },
      { ...created, source: 'untrusted' },
      { ...created, principal: { kind: 'human' as const, id: 'bob' } },
      { ...created, principal: { kind: 'system' as const, id: 'alice' } },
    ];
    for (const record of invalid) {
      await expect(auth.handler.handle(record, db)).rejects.toThrow();
      expect(await auth.applied(record.id)).toBe(false);
    }
    const command = { event: created, expectedSequence: 0 };
    expect((await nats.store.append(command)).status).toBe('appended');
    expect((await auth.routine('alice', 'orders', 'manage')).allowed).toBe(false);
    expect(await auth.applied(created.id)).toBe(false);
    await auth.handler.handle(created, db);
    expect((await auth.routine('alice', 'orders', 'manage')).allowed).toBe(true);
    const legacy = { ...created, id: 'legacy', commandId: 'legacy', subject: 'routine-old',
      data: { routineId: 'old', assistantId: 'assistant', schedule: '* * * * *',
        createdBy: 'alice' } };
    const wrongLegacy = { ...legacy, subject: 'routine-wrong' };
    await expect(auth.handler.handle(wrongLegacy, db)).rejects.toThrow('subject mismatch');
    await nats.seed([legacy]);
    await auth.handler.handle(legacy, db);
    expect(await auth.applied(legacy.id)).toBe(true);
    expect((await auth.routine('alice', 'old', 'read_metadata')).allowed).toBe(false);
    expect((await auth.routine('alice', 'old', 'manage')).allowed).toBe(false);
    const options = { verifyAgainst: binding };
    expect((await rebuildMembers(fga.apiUrl, 'test', nats.reader, options)).verified).toBe(true);
    const removed = event('removed-alice', 'member-alice', 'member.removed');
    await nats.seed([removed]);
    expect((await auth.routine('alice', 'orders', 'manage')).allowed).toBe(false);
    await auth.handler.handle(removed, db);
    expect((await auth.routine('alice', 'orders', 'read_metadata')).allowed).toBe(false);
  } finally {
    await fga.close();
    await nats.close();
  }
}
it('validates bindings, leaves commands without tuple writes and keeps legacy records unavailable',
  bindingsAndLegacy, 30_000);

async function revokedReaders(nats: Awaited<ReturnType<typeof natsFixture>>,
  auth: ReturnType<typeof memberAuthorisation>) {
  const removed = event('removed-carol', 'member-carol', 'member.removed');
  await nats.seed([removed]);
  expect((await auth.routine('carol', 'orders', 'read_metadata')).allowed).toBe(false);
  await auth.handler.handle(removed, db);
  expect((await auth.routine('carol', 'orders', 'read_metadata')).allowed).toBe(false);
  const demoted: EventEnvelope = event('demoted-admin', 'member-admin', 'member.role_changed');
  demoted.data = { memberId: 'admin', previousRole: 'admin', newRole: 'member',
    changedBy: 'alice' };
  await nats.seed([demoted]);
  expect((await auth.routine('admin', 'orders', 'read_metadata')).allowed).toBe(false);
  await auth.handler.handle(demoted, db);
  expect((await auth.routine('admin', 'orders', 'read_metadata')).allowed).toBe(false);
}
