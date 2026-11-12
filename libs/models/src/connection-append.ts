import { isDeepStrictEqual } from 'node:util';
import type { Binding } from '@opencrane/authz';
import { readEventAt, type EventStore, type StoredEvent } from '@opencrane/event-store';
import { connectionCreatedDataSchema, type EventEnvelope } from '@opencrane/events';
import { authorityFence } from './authority.ts';
import { activeMember } from './member-authority.ts';
import { connectionAccount } from './connection-account.ts';

export type ConnectionAccessCheck = () => Promise<Awaited<ReturnType<typeof authorityFence>>>;
export interface ConnectionAppend {
  input: { serverId: string; appendUntil: number; expectedSequence: number };
  event: EventEnvelope;
  server: { expiresAt: number; sequence: number };
  original?: StoredEvent | undefined;
  confirmAccess?: ConnectionAccessCheck | undefined;
}

export async function appendConnection(store: EventStore, binding: Binding, memberId: string,
  append: ConnectionAppend) {
  const { input, event, server, original } = append;
  // Finish remote calls and custody before starting the short access check.
  const controlSubject = `connection-control-${memberId}-${input.serverId}`;
  const subjects = [`member-${memberId}`, controlSubject];
  let fresh: Awaited<ReturnType<typeof authorityFence>>;
  if (append.confirmAccess) fresh = await append.confirmAccess();
  else fresh = await authorityFence(store, performance.now(), subjects);
  fresh.include(...subjects);
  const connectionSequence = await store.head('connection-*', fresh.deadline);
  const options = { requiredRole: 'member' as const, fresh };
  await activeMember(store, binding, memberId, options);
  await requireConnectionEnabled(store, memberId, input.serverId, fresh.deadline);
  if (original) {
    requireSameConnectionEvent(original, event);
    return connectionReceipt(original);
  }
  const appendUntil = Math.min(input.appendUntil, server.expiresAt);
  async function requireCurrentServer() {
    if (Date.now() >= appendUntil ||
        await store.head(`mcp-${input.serverId}`, fresh.deadline) !== server.sequence) {
      throw new Error('Connection conflict');
    }
  }
  async function checkAccess() {
    await fresh();
    await requireCurrentServer();
  }
  await requireCurrentServer();
  if (await store.head(event.subject, fresh.deadline) !== input.expectedSequence) {
    throw new Error('Connection append unconfirmed');
  }
  await fresh();
  const deadline = Math.min(fresh.deadline, performance.now() + appendUntil - Date.now());
  const command = { event, expectedSequence: connectionSequence,
    ...(append.confirmAccess ? { checkAccess } : {}),
    expectedSubject: 'connection-*', historyChecked: true as const, deadline };
  const result = await store.append(command);
  if (result.status !== 'appended') throw new Error('Connection append unconfirmed');
  const saved = await readEventAt(store, event.subject, result.sequence, performance.now() + 10_000);
  if (!saved) throw new Error('Connection append unconfirmed');
  requireSameConnectionEvent(saved, event);
  return connectionReceipt(saved);
}

export async function requireConnectionEnabled(store: EventStore, memberId: string,
  serverId: string, deadline: number) {
  // Keep an admin block across new profile ids until an explicit admin enable exists.
  const sequence = await store.head(`connection-control-${memberId}-${serverId}`, deadline);
  if (sequence !== 0) throw new Error('Connection disabled');
}

export function connectionReceipt(row: StoredEvent) {
  const schema = connectionCreatedDataSchema.required({ activation: true });
  const data = schema.parse(row.event.data);
  const status = connectionAccount(data.activation) ? 'verified' as const : 'saved_unverified' as const;
  return { status, sequence: row.sequence,
    generation: data.activation.generation, changeRef: row.event.commandId };
}

export function requireSameConnectionEvent(saved: StoredEvent, attempted: EventEnvelope) {
  const event = saved.event;
  if (event.id !== attempted.id || event.silo !== attempted.silo ||
      event.subject !== attempted.subject || event.type !== attempted.type ||
      event.commandId !== attempted.commandId || event.principal?.kind !== 'human' ||
      event.principal.id !== attempted.principal?.id ||
      !isDeepStrictEqual(event.data, attempted.data)) throw new Error('Connection conflict');
}
