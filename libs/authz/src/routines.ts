import type { EventStore, StoredEvent } from '@opencrane/event-store';
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

async function retiredOwner(store: History | undefined, event: EventEnvelope, routineId: string) {
  if (!store) {
    throw new Error('Routine retirement requires saved history');
  }
  const saved = await readRoutine(store, event.silo, routineId, event.id);
  if (!saved.modernCreation || !saved.state?.definition || saved.state.status !== 'retired') {
    throw new Error('Routine retirement requires a saved modern creation and retirement');
  }
  return saved.state.definition.definition.ownerId;
}

export async function applyRoutine(client: TupleClient, event: EventEnvelope, receipt: Tuple,
  store?: History) {
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
  let ownerId: string;
  if (event.type === 'routine.retired') {
    // Reconstruct the owner at retirement even if earlier permission jobs have not run.
    ownerId = await retiredOwner(store, event, identity.routineId);
  } else {
    const definition = routineDefinitionSchema.parse(field(event, 'definition'));
    ownerId = definition.ownerId;
  }
  const desired: Tuple[] = [
    { user: silo, object: target, relation: 'silo' },
    { user: objectId('person', event.silo, ownerId), object: target, relation: 'owner' },
  ];
  if (event.type !== 'routine.retired') {
    desired.push({ user: silo, object: target, relation: 'active_silo' });
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

async function readRoutine(store: History, silo: string, routineId: string,
  throughEventId?: string) {
  let state: RoutineState | undefined;
  let modernCreation = false;
  const receipts: string[] = [];
  const rows: StoredEvent[] = [];
  const deadline = performance.now() + 10_000;
  for await (const row of store.readStream(`routine-${routineId}`, 1, deadline)) {
    if (row.event.silo !== silo) {
      throw new Error('Routine silo mismatch');
    }
    state = foldRoutine(state, row.event);
    rows.push(row);
    const identity = routineRecordIdentitySchema.parse(row.event.data);
    if (row.event.type === 'routine.created' && identity.version === 1) {
      modernCreation = true;
    }
    if (permissionEvents.includes(row.event.type)) {
      receipts.push(row.event.id);
    }
    if (row.event.id === throughEventId) {
      return { state, modernCreation, receipts, rows };
    }
  }
  if (throughEventId !== undefined) {
    throw new Error('Routine retirement was not found in saved history');
  }
  return { state, modernCreation, receipts, rows };
}

async function accessReceipts(store: History, silo: string, memberId: string) {
  const receipts: string[] = [];
  const subjects = [`member-${memberId}`, `ownership-${silo}`];
  const positions = new Map<string, number>();
  const supported: readonly string[] = handlerSubscriptions['update-openfga'];
  const deadline = performance.now() + 10_000;
  let role = '';
  for (const subject of subjects) {
    positions.set(subject, 0);
    for await (const row of store.readStream(subject, 1, deadline)) {
      positions.set(subject, row.sequence);
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
  return { active: role !== '', receipts, positions };
}

/** Load saved facts before a caller starts its short write check. */
export async function loadRoutineAccess(binding: Binding, client: TupleClient,
  store: History | undefined, memberId: string, routineId: string) {
  if (!store) {
    throw new Error('Routine history unavailable');
  }
  const saved = await readRoutine(store, binding.silo, routineId);
  const member = await accessReceipts(store, binding.silo, memberId);
  async function check(relation: RoutineRelation) {
    try {
      return await checkSavedRoutine(binding, client, memberId, routineId, relation, saved, member);
    } catch {
      return { allowed: false, status: 'unavailable' as const };
    }
  }
  return { state: saved.state, rows: saved.rows, positions: member.positions, check };
}

/** Check saved facts before permissions; this result never authorises execution. */
export async function checkRoutine(binding: Binding, client: TupleClient,
  store: History | undefined, memberId: string, routineId: string, relation: RoutineRelation) {
  if (!store) {
    return { allowed: false, status: 'ok' as const };
  }
  try {
    const saved = await loadRoutineAccess(binding, client, store, memberId, routineId);
    return await saved.check(relation);
  } catch {
    return { allowed: false, status: 'unavailable' as const };
  }
}

async function checkSavedRoutine(binding: Binding, client: TupleClient, memberId: string,
  routineId: string, relation: RoutineRelation, saved: Awaited<ReturnType<typeof readRoutine>>,
  member: Awaited<ReturnType<typeof accessReceipts>>) {
  const refused = { allowed: false, status: 'ok' as const };
  const state = saved.state;
  if (!saved.modernCreation || !state?.definition || !member.active) {
    return refused;
  }
  const ownerId = state.definition.definition.ownerId;
  if (relation === 'manage' && (state.status === 'retired' || memberId !== ownerId)) {
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
}
