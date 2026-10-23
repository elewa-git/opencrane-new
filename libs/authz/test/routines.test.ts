import { expect, it } from 'vitest';
import { event, natsFixture } from '@opencrane/event-store/testing';
import { getEventDefinition, routineDefinitionSchema,
  type EventEnvelope } from '@opencrane/events';
import { createStore, memberAuthorisation, rebuildMembers } from '../src/index.ts';
import { openfga } from './services.ts';

function noSql(): never {
  throw new Error('Permission replay cannot write SQL');
}
const db = { query: noSql };

function routine(type: string, ownerId = 'alice', id = type): EventEnvelope {
  const saved = getEventDefinition('routine.created')?.example;
  if (typeof saved !== 'object' || !saved) throw new Error('Missing routine example');
  const original = routineDefinitionSchema.parse(Reflect.get(saved, 'definition'));
  const definition = { ...original, ownerId, ownerAdmissionId: `joined-${ownerId}` };
  let data: unknown = { ...saved, definition, actorId: ownerId };
  let actorId = ownerId;
  if (type !== 'routine.created') {
    actorId = 'admin';
    const control = { version: 1, routineId: 'orders', definitionRevision: 2,
      scheduleRevision: 1, controlRevision: 2, actorId, source: 'admin',
      reason: 'admin_requested', affectedRun: null, next: null };
    data = control;
    if (type === 'routine.reassigned') {
      data = { ...control, definition };
    }
  }
  return { ...event(id, 'routine-orders', type), source: 'opencrane-server',
    commandId: id, principal: { kind: 'human', id: actorId }, data };
}

async function routinePermissions() {
  const nats = await natsFixture();
  const fga = await openfga();
  try {
    const binding = await createStore(fga.apiUrl, 'test');
    const auth = memberAuthorisation(binding, nats.store);
    const alice = event('joined-alice', 'member-alice');
    const admin = event('joined-admin', 'member-admin');
    admin.data = { ...admin.data, role: 'admin' };
    const bob = event('joined-bob', 'member-bob');
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
    const foreign = memberAuthorisation({ ...binding, silo: 'foreign' }, nats.store);
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
