import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Binding } from '@opencrane/authz';
import { readEventAt, type EventStore, type StoredEvent } from '@opencrane/event-store';
import { connectionCreatedDataSchema, type EventEnvelope } from '@opencrane/events';
import type { connectionCustody, ConnectionStage } from './connection-custody.ts';
import { envelope, history } from './actor.ts';
import { authorityFence } from './authority.ts';
import { activeMember, readActiveMember } from './member-authority.ts';
import { toolPolicyFromRows } from './tool-policy.ts';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/u);
const commandSchema = z.strictObject({ action: z.enum(['create', 'rotate']),
  serverId: id, connectionId: id, profileId: id, changeRef: id,
  expectedSequence: z.int().nonnegative(), expectedGeneration: z.int().nonnegative(),
  appendUntil: z.int().positive() });
const savedSchema = connectionCreatedDataSchema.required({ activation: true });
type Saved = z.infer<typeof savedSchema>;
type Command = z.infer<typeof commandSchema>;
type Custody = Pick<ReturnType<typeof connectionCustody>, 'stage'>;
interface State {
  status: 'unavailable' | 'saved_unverified';
  sequence: number;
  data?: Saved;
}

/** Rebuild references only. Saving material does not prove the upstream account's identity. */
export function foldConnection(rows: StoredEvent[]): State {
  let state: State = { status: 'unavailable', sequence: 0 };
  for (const row of rows) {
    const parsed = savedSchema.safeParse(row.event.data);
    const previous = state;
    state = { status: 'unavailable', sequence: row.sequence };
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
      state = { status: 'saved_unverified', sequence: row.sequence, data };
    }
  }
  return state;
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
    data.activation.generation === previous.data.activation.generation + 1 &&
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
  const policy = toolPolicyFromRows(rows);
  function registered(row: StoredEvent) {
    return row.event.type === 'mcp.server_registered';
  }
  function reviewed(row: StoredEvent) {
    return row.event.type === 'mcp.server_reviewed';
  }
  function replacedCatalogue(row: StoredEvent) {
    const types = ['mcp.server_registered', 'mcp.server_discovered', 'mcp.tools_changed'];
    return types.includes(row.event.type);
  }
  const registration = rows.findLast(registered);
  const review = rows.findLast(reviewed);
  const catalogue = rows.findLast(replacedCatalogue);
  const registrationSchema = z.object({ kind: z.literal('remote'), locator: z.string() });
  const locator = registrationSchema.safeParse(registration?.event.data);
  if (!policy.published || policy.accountMode !== 'personal' ||
      policy.connectionId !== input.connectionId || !review ||
      review.sequence <= (catalogue?.sequence ?? 0) || !locator.success) {
    throw new Error('Connection server unavailable');
  }
  return { sequence: policy.sequence, endpointDigest: digest(locator.data.locator),
    expiresAt: Date.parse(policy.expiresAt!) };
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
  memberId: string, custody: Custody, raw: unknown, material: string) {
  const parsed = commandSchema.safeParse(raw);
  if (!parsed.success || !id.safeParse(memberId).success || typeof material !== 'string' ||
      Buffer.byteLength(material) === 0 || Buffer.byteLength(material) > 8192) {
    throw new Error('Connection input invalid');
  }
  const input = parsed.data;
  const subject = `connection-${memberId}-${input.serverId}-${input.profileId}`;
  const rows = await history(store, subject, binding.silo, performance.now() + 10_000);
  const state = foldConnection(rows);
  const operationId = digest([binding.silo, subject, input.changeRef]);
  function originalOperation(row: StoredEvent) {
    return row.event.id === operationId;
  }
  const original = rows.find(originalOperation);
  if (!original) {
    requireCurrent(state, input);
  }
  const server = await eligibleServer(store, binding.silo, input);
  await readActiveMember(store, binding, memberId);
  const stage: ConnectionStage = { siloId: binding.silo, userId: memberId,
    serverId: input.serverId, connectionId: input.connectionId, profileId: input.profileId,
    purpose: 'personal', generation: input.expectedGeneration + 1, operationId,
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
  const fresh = await authorityFence(store, performance.now(), [`member-${memberId}`]);
  const options = { requiredRole: 'member' as const, fresh };
  await activeMember(store, binding, memberId, options);
  if (original) {
    requireSameEvent(original, event);
    return receipt(original);
  }
  const appendUntil = Math.min(input.appendUntil, server.expiresAt);
  if (Date.now() >= appendUntil ||
      await store.head(`mcp-${input.serverId}`, fresh.deadline) !== server.sequence) {
    throw new Error('Connection conflict');
  }
  await fresh();
  const deadline = Math.min(fresh.deadline, performance.now() + appendUntil - Date.now());
  const command = { event, expectedSequence: input.expectedSequence,
    historyChecked: true as const, deadline };
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
