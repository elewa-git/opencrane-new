import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { Binding } from '@opencrane/authz';
import { readEventAt, type EventStore, type StoredEvent } from '@opencrane/event-store';
import { connectionRevokedDataSchema } from '@opencrane/events';
import type { Db } from '@opencrane/projections';
import { envelope, history } from './actor.ts';
import { authorityFence } from './authority.ts';
import { connectionOperationId, foldConnection } from './bearer-connections.ts';
import { withConnectionStage } from './connection-stage-lock.ts';
import { activeMember, MemberAccessRefused } from './member-authority.ts';
import { refreshInput } from './oauth-refresh.ts';
import { currentMembership } from './ownership.ts';

type Input = z.infer<typeof refreshInput>;
const actorSchema = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/u);

/** Save local revocation only. Provider revocation and private retirement need a separate worker. */
export async function revokePersonalOAuth(store: EventStore, binding: Binding,
  actorId: string, raw: unknown, db: Pick<Db, 'lock'>) {
  try {
    const input = refreshInput.parse(raw);
    actorSchema.parse(actorId);
    if (actorId !== input.userId) {
      throw new MemberAccessRefused('OAuth revoke refused');
    }
    const profile = { ...input, siloId: binding.silo };
    async function revoke() {
      const subject = `connection-${input.userId}-${input.serverId}-${input.profileId}`;
      const prepared = await prepareRevoke(store, binding.silo, subject, input);
      const membership = await currentMembership(store, binding.silo, actorId,
        undefined, performance.now() + 10_000);
      const subjects = [...membership.positions.keys()];
      const fresh = await authorityFence(store, performance.now(), subjects);
      const options = { requiredRole: 'member' as const, membership, fresh };
      // Decide access once, even when loading the target failed. Keep any refusal final.
      await activeMember(store, binding, actorId, options);
      if (!prepared) {
        throw new Error('OAuth revoke unavailable');
      }
      if (prepared.original) {
        return revokeReceipt(prepared.original, input.expectedGeneration);
      }
      const command = { event: prepared.event, expectedSequence: prepared.sequence,
        historyChecked: true as const, deadline: fresh.deadline, checkAccess: fresh };
      await fresh();
      const result = await store.append(command);
      if (result.status !== 'appended') {
        throw new Error('OAuth revoke unavailable');
      }
      const saved = await readEventAt(store, subject, result.sequence, performance.now() + 10_000);
      if (!saved || !isDeepStrictEqual(saved.event, prepared.event)) {
        throw new Error('OAuth revoke unavailable');
      }
      return revokeReceipt(saved, input.expectedGeneration);
    }
    // Share the refresh lock so a waiting worker sees the revoke before it can send.
    return await withConnectionStage(db, profile, revoke);
  } catch (error) {
    if (error instanceof MemberAccessRefused) {
      throw new MemberAccessRefused('OAuth revoke refused');
    }
    // eslint-disable-next-line preserve-caught-error -- Keep private dependency values out of replies.
    throw new Error('OAuth revoke unavailable');
  }
}

async function prepareRevoke(store: EventStore, siloId: string, subject: string, input: Input) {
  try {
    const rows = await history(store, subject, siloId, performance.now() + 10_000);
    const last = rows.at(-1);
    const original = last?.event.type === 'connection.revoked' ? last : undefined;
    const preceding = original ? rows.slice(0, -1) : rows;
    const state = revokeGeneration(preceding, input);
    for (const row of rows) {
      if (row.event.commandId === input.changeRef && row !== original) {
        return undefined;
      }
    }
    const operationId = connectionOperationId(siloId, subject, `${state.operationId}-revoke`);
    const payload = { userId: input.userId,
      serverId: input.serverId, profile: input.profileId, revokedBy: input.userId,
      expectedSequence: state.sequence, reason: 'owner_requested' };
    const data = connectionRevokedDataSchema.parse(payload);
    const time = original ? new Date(original.event.time) : new Date();
    const event = { ...envelope(siloId, subject, 'connection.revoked', data, operationId, time),
      commandId: original?.event.commandId ?? input.changeRef, source: 'opencrane-server',
      principal: { kind: 'human' as const, id: input.userId } };
    if (original && (original.sequence <= state.sequence ||
        !isDeepStrictEqual(original.event, event))) {
      return undefined;
    }
    return { event, original, sequence: state.sequence };
  } catch {
    // Defer target and history failures until after the caller's current access decision.
    return undefined;
  }
}

function revokeGeneration(rows: StoredEvent[], input: Input) {
  const state = foldConnection(rows);
  const saved = state.data;
  const activation = saved?.activation;
  function isGeneration(row: StoredEvent) {
    return row.event.id === activation?.operationId;
  }
  const generation = rows.find(isGeneration);
  if (!saved || activation?.reason !== 'oauth_confirmed' ||
      saved.userId !== input.userId || saved.serverId !== input.serverId ||
      saved.profile !== input.profileId || activation.connectionId !== input.connectionId ||
      activation.generation !== input.expectedGeneration ||
      generation?.sequence !== input.expectedSequence) {
    throw new Error('OAuth revoke unavailable');
  }
  return { sequence: state.sequence, operationId: activation.operationId };
}

function revokeReceipt(row: StoredEvent, generation: number) {
  return { status: 'revoked' as const, sequence: row.sequence, generation,
    changeRef: row.event.commandId, callsAvailable: false as const };
}
