import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Db } from '@opencrane/projections';
import { withConnectionStage } from './connection-stage-lock.ts';
import type { Binding } from '@opencrane/authz';
import { readEventAt, type EventStore, type StoredEvent } from '@opencrane/event-store';
import { connectionCreatedDataSchema, connectionOperationClosedDataSchema,
  type EventEnvelope } from '@opencrane/events';
import type { connectionCustody, ConnectionStage } from './connection-custody.ts';
import { envelope, history } from './actor.ts';
import { authorityFence } from './authority.ts';
import { activeMember, readActiveMember } from './member-authority.ts';
import { connectionServer } from './connection-server.ts';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/u);
const commandSchema = z.strictObject({ action: z.enum(['create', 'rotate']),
  serverId: id, connectionId: id, profileId: id, changeRef: id,
  expectedSequence: z.int().nonnegative(), expectedGeneration: z.int().nonnegative(),
  appendUntil: z.int().positive() });
const savedSchema = connectionCreatedDataSchema.required({ activation: true });
const controlSchema = z.strictObject({
  action: z.enum(['revoke', 'disable']), userId: id, serverId: id, profileId: id,
  changeRef: id, expectedSequence: z.int().nonnegative(),
});
type Saved = z.infer<typeof savedSchema>;
type Command = z.infer<typeof commandSchema>;
type Custody = Pick<ReturnType<typeof connectionCustody>, 'stage'>;
interface State {
  status: 'unavailable' | 'saved_unverified';
  sequence: number;
  data?: Saved;
  lastGeneration: number;
  closedOperations: string[];
}

/** Rebuild references only. Saving material does not prove the upstream account's identity. */
export function foldConnection(rows: StoredEvent[]): State {
  let state: State = { status: 'unavailable', sequence: 0, lastGeneration: 0,
    closedOperations: [] };
  for (const row of rows) {
    const parsed = savedSchema.safeParse(row.event.data);
    const previous = state;
    state = { status: 'unavailable', sequence: row.sequence, lastGeneration: 0,
      closedOperations: [] };
    if (row.event.type === 'connection.operation_closed') {
      state = applyClosure(previous, row, rows[0]?.event.silo) ?? state;
      continue;
    }
    if (!parsed.success) {
      continue;
    }
    const data = parsed.data;
    const activation = data.activation;
    if (!validIdentity(row, data, previous.sequence)) {
      continue;
    }
    const first = previous.sequence === 0 && activation.generation === 1 &&
      row.event.type === 'connection.created' && activation.reason === 'bearer_create';
    const replacement = replacesSaved(previous, row, data, rows[0]?.event.silo);
    if (first || replacement) {
      state = { status: 'saved_unverified', sequence: row.sequence, data,
        lastGeneration: activation.generation, closedOperations: previous.closedOperations };
    }
  }
  return state;
}
function applyClosure(previous: State, row: StoredEvent, silo?: string): State | undefined {
  const parsed = connectionOperationClosedDataSchema.safeParse(row.event.data);
  if (!parsed.success) {
    return undefined;
  }
  const data = parsed.data;
  const subject = `connection-${data.userId}-${data.serverId}-${data.profile}`;
  if (row.event.subject !== subject || row.event.silo !== silo ||
      row.event.principal?.kind !== 'system' || row.event.principal.id !== 'models' ||
      data.expectedSequence !== previous.sequence || row.sequence <= previous.sequence ||
      Date.parse(row.event.time) <= data.appendUntil ||
      data.generation !== previous.lastGeneration + 1) {
    return undefined;
  }
  if (previous.sequence !== 0 && previous.status !== 'saved_unverified') {
    return undefined;
  }
  if (!closureMatchesProfile(data, previous.data)) {
    return undefined;
  }
  if (previous.closedOperations.includes(data.operationId)) {
    return undefined;
  }
  // Reserve the name permanently: the private journal pins each generation's original UID.
  return { ...previous, sequence: row.sequence, lastGeneration: data.generation,
    closedOperations: [...previous.closedOperations, data.operationId] };
}
function closureMatchesProfile(data: z.infer<typeof connectionOperationClosedDataSchema>,
  previous?: Saved) {
  if (!previous) {
    return true;
  }
  return previous.userId === data.userId && previous.serverId === data.serverId &&
    previous.profile === data.profile && previous.activation.operationId !== data.operationId;
}
function validIdentity(row: StoredEvent, data: Saved, expectedSequence: number) {
  const subject = `connection-${data.userId}-${data.serverId}-${data.profile}`;
  return row.event.subject === subject && row.event.principal?.kind === 'human' &&
    row.event.principal.id === data.userId && data.activation.changedBy === data.userId &&
    data.activation.operationId === row.event.id &&
    data.activation.expectedSequence === expectedSequence;
}
function replacesSaved(previous: State, row: StoredEvent, data: Saved, silo?: string) {
  if (previous.status !== 'saved_unverified' || !previous.data) {
    return false;
  }
  return row.event.type === 'connection.refreshed' &&
    data.activation.reason === 'bearer_rotation' &&
    data.activation.generation === previous.lastGeneration + 1 &&
    !previous.closedOperations.includes(data.activation.operationId) &&
    sameBindings(previous.data, data) && row.event.silo === silo;
}
function sameBindings(first: Saved, second: Saved) {
  return first.userId === second.userId && first.serverId === second.serverId &&
    first.profile === second.profile &&
    first.activation.connectionId === second.activation.connectionId &&
    first.activation.endpointDigest === second.activation.endpointDigest;
}
function digest(value: unknown) {
  const hash = createHash('sha256');
  hash.update(JSON.stringify(value));
  return hash.digest('hex');
}
export function connectionOperationId(silo: string, subject: string, changeRef: string) {
  return digest([silo, subject, changeRef]);
}
function receipt(row: StoredEvent) {
  const data = savedSchema.parse(row.event.data);
  return { status: 'saved_unverified' as const, sequence: row.sequence,
    generation: data.activation.generation, changeRef: row.event.commandId };
}
function requireSameEvent(saved: StoredEvent, attempted: EventEnvelope) {
  const event = saved.event;
  if (event.id !== attempted.id || event.silo !== attempted.silo ||
      event.subject !== attempted.subject || event.type !== attempted.type ||
      event.commandId !== attempted.commandId || event.principal?.kind !== 'human' ||
      event.principal.id !== attempted.principal?.id ||
      digest(event.data) !== digest(attempted.data)) {
    throw new Error('Connection conflict');
  }
}
async function eligibleServer(store: EventStore, silo: string, input: Command) {
  const rows = await history(store, `mcp-${input.serverId}`, silo, performance.now() + 10_000);
  const server = connectionServer(rows, input.connectionId);
  if (!server.available || server.endpointDigest === undefined) {
    throw new Error('Connection server unavailable');
  }
  return { sequence: server.sequence, endpointDigest: server.endpointDigest,
    expiresAt: server.expiresAt };
}

function requireCurrent(state: State, input: Command) {
  if (input.expectedSequence !== state.sequence) {
    throw new Error('Connection conflict');
  }
  if (input.action === 'create') {
    if (state.sequence !== 0 || input.expectedGeneration !== 0) {
      throw new Error('Connection conflict');
    }
  } else if (state.status !== 'saved_unverified' ||
      input.expectedGeneration !== state.data?.activation.generation) {
    throw new Error('Connection conflict');
  }
}
async function stageMaterial(custody: Custody, stage: ConnectionStage, material: string) {
  try {
    const result = await custody.stage(stage, material);
    if ((result.status === 'staged' || result.status === 'recovered') && result.identity) {
      return result.identity;
    }
  } catch {
    // Hide adapter errors because a transport error can contain the supplied material.
    throw new Error('Connection custody unavailable');
  }
  throw new Error('Connection custody unavailable');
}

/** Stage outside the append-only command, then check current access before saving a reference. */
export async function saveBearerConnection(store: EventStore, binding: Binding,
  memberId: string, custody: Custody, raw: unknown, material: string, db: Pick<Db, 'lock'>) {
  const parsed = commandSchema.safeParse(raw);
  if (!parsed.success || !id.safeParse(memberId).success || typeof material !== 'string' ||
      Buffer.byteLength(material) === 0 || Buffer.byteLength(material) > 8192) {
    throw new Error('Connection input invalid');
  }
  const input = parsed.data;
  const profile = { siloId: binding.silo, userId: memberId,
    serverId: input.serverId, profileId: input.profileId };
  async function save() {
    return saveLocked(store, binding, memberId, custody, input, material);
  }
  return withConnectionStage(db, profile, save);
}
async function saveLocked(store: EventStore, binding: Binding, memberId: string,
  custody: Custody, input: Command, material: string) {
  const subject = `connection-${memberId}-${input.serverId}-${input.profileId}`;
  const rows = await history(store, subject, binding.silo, performance.now() + 10_000);
  const state = foldConnection(rows);
  const operationId = connectionOperationId(binding.silo, subject, input.changeRef);
  function originalOperation(row: StoredEvent) {
    return row.event.id === operationId;
  }
  const original = rows.find(originalOperation);
  if (state.closedOperations.includes(operationId)) {
    throw new Error('Connection conflict');
  }
  let expectedState = state;
  if (original) {
    const originalIndex = rows.indexOf(original);
    const precedingRows = rows.slice(0, originalIndex);
    expectedState = foldConnection(precedingRows);
  }
  requireCurrent(expectedState, input);
  const server = await eligibleServer(store, binding.silo, input);
  await readActiveMember(store, binding, memberId);
  await requireConnectionEnabled(store, memberId, input.serverId, performance.now() + 10_000);
  const stage: ConnectionStage = { siloId: binding.silo, userId: memberId,
    serverId: input.serverId, connectionId: input.connectionId, profileId: input.profileId,
    purpose: 'personal', generation: expectedState.lastGeneration + 1, operationId,
    expectedSequence: input.expectedSequence, appendUntil: input.appendUntil,
    endpointDigest: server.endpointDigest };
  const identity = await stageMaterial(custody, stage, material);
  const reason = input.action === 'create' ? 'bearer_create' : 'bearer_rotation';
  const payload = { userId: memberId, serverId: input.serverId,
    profile: input.profileId, secretRef: `secret:${identity.reference}`,
    activation: { connectionId: input.connectionId, ownerKind: 'personal', purpose: 'personal',
      generation: stage.generation, uid: identity.uid, resourceVersion: identity.resourceVersion,
      endpointDigest: server.endpointDigest, operationId, changedBy: memberId,
      expectedSequence: input.expectedSequence, appendUntil: input.appendUntil, reason } };
  const checkedData = savedSchema.safeParse(payload);
  if (!checkedData.success) {
    throw new Error('Connection custody unavailable');
  }
  const data = checkedData.data;
  if (state.data && !sameBindings(state.data, data)) {
    throw new Error('Connection conflict');
  }
  const type = input.action === 'create' ? 'connection.created' : 'connection.refreshed';
  const event = { ...envelope(binding.silo, subject, type, data, operationId),
    commandId: input.changeRef, source: 'opencrane-server',
    principal: { kind: 'human' as const, id: memberId } };
  return appendConnection(store, binding, memberId, input, event, server, original);
}
async function appendConnection(store: EventStore, binding: Binding, memberId: string,
  input: Command, event: EventEnvelope,
  server: Awaited<ReturnType<typeof eligibleServer>>, original?: StoredEvent) {
  // Start the short membership check only after custody and profile history have finished.
  const controlSubject = `connection-control-${memberId}-${input.serverId}`;
  const subjects = [`member-${memberId}`, controlSubject];
  const fresh = await authorityFence(store, performance.now(), subjects);
  // Include profile writes and admin blocks in one native append condition.
  const connectionSequence = await store.head('connection-*', fresh.deadline);
  const options = { requiredRole: 'member' as const, fresh };
  await activeMember(store, binding, memberId, options);
  await requireConnectionEnabled(store, memberId, input.serverId, fresh.deadline);
  if (original) {
    requireSameEvent(original, event);
    return receipt(original);
  }
  const appendUntil = Math.min(input.appendUntil, server.expiresAt);
  if (Date.now() >= appendUntil ||
      await store.head(`mcp-${input.serverId}`, fresh.deadline) !== server.sequence) {
    throw new Error('Connection conflict');
  }
  // Check after capturing the category position so a later profile change also conflicts.
  if (await store.head(event.subject, fresh.deadline) !== input.expectedSequence) {
    throw new Error('Connection append unconfirmed');
  }
  await fresh();
  const deadline = Math.min(fresh.deadline, performance.now() + appendUntil - Date.now());
  const command = { event, expectedSequence: connectionSequence,
    expectedSubject: 'connection-*', historyChecked: true as const, deadline };
  const result = await store.append(command);
  if (result.status !== 'appended') {
    throw new Error('Connection append unconfirmed');
  }
  const saved = await readEventAt(store, event.subject, result.sequence, performance.now() + 10_000);
  if (!saved) {
    throw new Error('Connection append unconfirmed');
  }
  requireSameEvent(saved, event);
  return receipt(saved);
}

async function requireConnectionEnabled(store: EventStore, memberId: string,
  serverId: string, deadline: number) {
  // Keep the admin block across new profile ids. Only a future explicit admin enable can lift it.
  const sequence = await store.head(`connection-control-${memberId}-${serverId}`, deadline);
  if (sequence !== 0) {
    throw new Error('Connection disabled');
  }
}

/** Record invalidation only. Retain stored material until cleanup can prove deletion is safe. */
export async function changePersonalConnection(store: EventStore, binding: Binding,
  actorId: string, raw: unknown) {
  const parsed = controlSchema.safeParse(raw);
  if (!parsed.success || !id.safeParse(actorId).success) {
    throw new Error('Connection input invalid');
  }
  const input = parsed.data;
  const isRevoke = input.action === 'revoke';
  if (isRevoke && input.userId !== actorId) {
    throw new Error('Connection owner required');
  }
  const requiredRole = isRevoke ? 'member' as const : 'admin' as const;
  await readActiveMember(store, binding, actorId, requiredRole);
  const profileSubject = `connection-${input.userId}-${input.serverId}-${input.profileId}`;
  const controlSubject = `connection-control-${input.userId}-${input.serverId}`;
  const subject = isRevoke ? profileSubject : controlSubject;
  const profileRows = await history(store, profileSubject, binding.silo, performance.now() + 10_000);
  let rows = profileRows;
  if (!isRevoke) {
    rows = await history(store, subject, binding.silo, performance.now() + 10_000);
  }
  const operationId = connectionOperationId(binding.silo, subject, input.changeRef);
  function originalOperation(row: StoredEvent) {
    return row.event.id === operationId;
  }
  const original = rows.find(originalOperation);
  if (!original) {
    requireControlTarget(profileRows, input);
    if ((rows.at(-1)?.sequence ?? 0) !== input.expectedSequence) {
      throw new Error('Connection conflict');
    }
  }
  const fields = { userId: input.userId, serverId: input.serverId,
    profile: input.profileId, expectedSequence: input.expectedSequence };
  const payload = isRevoke
    ? { ...fields, revokedBy: actorId, reason: 'owner_requested' }
    : { ...fields, disabledBy: actorId, reason: 'admin_disabled' };
  const type = isRevoke ? 'connection.revoked' : 'connection.disabled';
  const event = { ...envelope(binding.silo, subject, type, payload, operationId),
    commandId: input.changeRef, source: 'opencrane-server',
    principal: { kind: 'human' as const, id: actorId } };
  // Read profile history before starting the short actor membership check.
  const fresh = await authorityFence(store, performance.now(), [`member-${actorId}`]);
  const options = { requiredRole, fresh };
  await activeMember(store, binding, actorId, options);
  const sequence = await appendControl(store, event, input.expectedSequence, fresh, original);
  const status = isRevoke ? 'revoked' as const : 'disabled' as const;
  return { status, sequence, changeRef: input.changeRef };
}

function requireControlTarget(rows: StoredEvent[], input: z.infer<typeof controlSchema>) {
  const state = foldConnection(rows);
  if (state.status !== 'saved_unverified' || state.data?.userId !== input.userId ||
      state.data.serverId !== input.serverId || state.data.profile !== input.profileId) {
    throw new Error('Connection conflict');
  }
}

async function appendControl(store: EventStore, event: EventEnvelope, expectedSequence: number,
  fresh: Awaited<ReturnType<typeof authorityFence>>, original?: StoredEvent) {
  if (original) {
    requireSameEvent(original, event);
    return original.sequence;
  }
  await fresh();
  const command = { event, expectedSequence, historyChecked: true as const,
    deadline: fresh.deadline };
  const result = await store.append(command);
  if (result.status !== 'appended') {
    throw new Error('Connection append unconfirmed');
  }
  const saved = await readEventAt(store, event.subject, result.sequence, performance.now() + 10_000);
  if (!saved) {
    throw new Error('Connection append unconfirmed');
  }
  requireSameEvent(saved, event);
  return saved.sequence;
}
