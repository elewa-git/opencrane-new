import type { EventStore } from '@opencrane/event-store';
import { foldRoutine, handlerSubscriptions, legacyMemberRole, routineDefinitionSchema,
  routineRecordIdentitySchema, type EventEnvelope, type RoutineState } from '@opencrane/events';
import { objectId, TupleClient, type Binding, type Tuple } from './client.ts';

type RoutineRelation = 'read_metadata' | 'manage';
type History = Pick<EventStore, 'readStream'>;
const permissionEvents = ['routine.created', 'routine.reassigned', 'routine.retired'];

function field(event: EventEnvelope, name: string): unknown {
  if (typeof event.data !== 'object' || event.data === null) {
    throw new Error('Invalid routine access record');
  }
  return Reflect.get(event.data, name);
}

export async function applyRoutine(client: TupleClient, event: EventEnvelope, receipt: Tuple) {
  const identity = routineRecordIdentitySchema.parse(event.data);
  if (event.subject !== `routine-${identity.routineId}`) {
    throw new Error('Routine subject mismatch');
  }
  if (!identity.version) {
    await client.write([receipt], []);
    return;
  }
  const target = objectId('routine', event.silo, identity.routineId);
  const silo = objectId('silo', event.silo);
  const filter = { object: target };
  const current = await client.read(filter);
  let desired: Tuple[];
  if (event.type === 'routine.retired') {
    function retained(tuple: Tuple) {
      return tuple.relation !== 'active_silo';
    }
    desired = current.filter(retained);
  } else {
    const definition = routineDefinitionSchema.parse(field(event, 'definition'));
    desired = [
      { user: silo, object: target, relation: 'silo' },
      { user: silo, object: target, relation: 'active_silo' },
      { user: objectId('person', event.silo, definition.ownerId), object: target, relation: 'owner' },
    ];
  }
  function missing(tuple: Tuple) {
    function matches(existing: Tuple) {
      return existing.relation === tuple.relation && existing.user === tuple.user;
    }
    return !current.some(matches);
  }
  function unwanted(tuple: Tuple) {
    function matches(expected: Tuple) {
      return expected.relation === tuple.relation && expected.user === tuple.user;
    }
    return !desired.some(matches);
  }
  const writes = desired.filter(missing);
  writes.push(receipt);
  const deletes = current.filter(unwanted);
  await client.write(writes, deletes);
}

async function readRoutine(store: History, silo: string, routineId: string) {
  let state: RoutineState | undefined;
  let modernCreation = false;
  const receipts: string[] = [];
  const deadline = performance.now() + 10_000;
  for await (const row of store.readStream(`routine-${routineId}`, 1, deadline)) {
    if (row.event.silo !== silo) {
      throw new Error('Routine silo mismatch');
    }
    state = foldRoutine(state, row.event);
    const identity = routineRecordIdentitySchema.parse(row.event.data);
    if (row.event.type === 'routine.created' && identity.version === 1) {
      modernCreation = true;
    }
    if (permissionEvents.includes(row.event.type)) {
      receipts.push(row.event.id);
    }
  }
  return { state, modernCreation, receipts };
}

async function accessReceipts(store: History, silo: string, memberId: string) {
  const receipts: string[] = [];
  const subjects = [`member-${memberId}`, `ownership-${silo}`];
  const supported: readonly string[] = handlerSubscriptions['update-openfga'];
  const deadline = performance.now() + 10_000;
  let role = '';
  for (const subject of subjects) {
    for await (const row of store.readStream(subject, 1, deadline)) {
      const event = row.event;
      if (event.silo !== silo || event.subject !== subject) {
        throw new Error('Routine access history mismatch');
      }
      if (!supported.includes(event.type)) {
        continue;
      }
      if (event.type !== 'ownership.seeded' && field(event, 'memberId') !== memberId) {
        continue;
      }
      const memberRole = legacyMemberRole(event);
      if (memberRole !== undefined) {
        role = memberRole;
      }
      receipts.push(event.id);
    }
  }
  return { active: role !== '', receipts };
}

/** Check saved facts before permissions; this result never authorises execution. */
export async function checkRoutine(binding: Binding, client: TupleClient,
  store: History | undefined, memberId: string, routineId: string, relation: RoutineRelation) {
  const refused = { allowed: false, status: 'ok' as const };
  try {
    if (!store) {
      return refused;
    }
    // Load routine history before checking the small streams that decide access.
    const saved = await readRoutine(store, binding.silo, routineId);
    const state = saved.state;
    if (!saved.modernCreation || !state?.definition) {
      return refused;
    }
    const ownerId = state.definition.definition.ownerId;
    if (relation === 'manage' && (state.status === 'retired' || memberId !== ownerId)) {
      return refused;
    }
    const member = await accessReceipts(store, binding.silo, memberId);
    if (!member.active) {
      return refused;
    }
    const receipts = [...saved.receipts, ...member.receipts];
    const silo = objectId('silo', binding.silo);
    for (const eventId of receipts) {
      const receipt = { user: silo, relation: 'applied',
        object: objectId('projection_event', binding.silo, eventId) };
      const result = await client.check(receipt);
      if (!result.allowed) {
        return { allowed: false, status: result.status };
      }
    }
    const user = objectId('person', binding.silo, memberId);
    // Require the recorded owner or a current admin even if an old owner tuple survives.
    if (relation === 'read_metadata' && memberId !== ownerId) {
      const adminTuple = { user, object: silo, relation: 'admin' };
      const admin = await client.check(adminTuple);
      if (!admin.allowed) {
        return { allowed: false, status: admin.status };
      }
    }
    const tuple = { user, object: objectId('routine', binding.silo, routineId), relation };
    const result = await client.check(tuple);
    return { allowed: result.allowed, status: result.status };
  } catch {
    return { allowed: false, status: 'unavailable' as const };
  }
}
