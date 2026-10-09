import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { EventStore } from '@opencrane/event-store';
import { assistantCreatedDataSchema, type EventEnvelope } from '@opencrane/events';
import { grantStream } from '@opencrane/authz';
import { readEvents } from '@opencrane/projections';
import { registerHandler } from '@opencrane/handlers';
import { envelope, history } from './actor.ts';
import { data, models } from './state.ts';

function defaultGrantee(trigger: EventEnvelope) {
  const member = trigger.type === 'member.joined' || trigger.type === 'silo.owner_bootstrapped';
  const field = member ? 'memberId' : 'assistantId';
  const granteeId = z.string().parse(data(trigger)[field]);
  const granteeKind = member ? 'member' : 'assistant';
  return { resourceType: 'model', granteeId, granteeKind };
}

/** One command, one conditional append; existing grants and revocations win. */
async function seedGrant(store: EventStore, trigger: EventEnvelope, resourceId: string,
  explicit?: { resourceType: string; granteeId: string; granteeKind: string }) {
  const target = explicit ?? defaultGrantee(trigger);
  const { granteeId, resourceType, granteeKind } = target;
  if (typeof granteeId !== 'string') throw new Error('Missing model grantee');
  const subject = grantStream(resourceType, resourceId);
  const rows = await history(store, subject, trigger.silo);
  function matchesGrantee(row: typeof rows[number]) {
    const previous = data(row.event);
    if (previous['granteeId'] !== granteeId) return false;
    // Keep old revocations denying every matching id when reactions run again.
    if (row.event.type === 'grant.revoked' && previous['granteeKind'] === undefined) return true;
    return previous['granteeKind'] === granteeKind;
  }
  if (rows.some(matchesGrantee)) return;
  const identity = [trigger.silo, resourceType, granteeKind, granteeId, resourceId];
  const hash = createHash('sha256');
  hash.update(JSON.stringify(identity));
  const digest = hash.digest('hex');
  const id = `initial-model-grant-${digest}`;
  let grantedBy = 'installation';
  if (explicit && trigger.principal) grantedBy = trigger.principal.id;
  const event = envelope(trigger.silo, subject, 'grant.given', {
    resourceType, resourceId, granteeId, granteeKind,
    grantedBy,
  }, id);
  const result = await store.append({ event, expectedSequence: rows.at(-1)?.sequence ?? 0 });
  if (result.status !== 'appended') throw new Error('Initial model grant append failed; retry the reaction');
}

export function modelGrantHandler(store: EventStore) {
  async function seedSelection(event: EventEnvelope) {
    if (event.type === 'assistant.created' && data(event)['kind'] === 'team') {
      const shared = assistantCreatedDataSchema.parse(event.data);
      // Old team events with no explicit selection grant nothing; ownership is not tool authority.
      for (const grant of shared.grants ?? []) {
        const assistant = { resourceType: grant.resourceType,
          granteeId: shared.assistantId, granteeKind: 'assistant' };
        const group = { resourceType: grant.resourceType,
          granteeId: shared.ownerId, granteeKind: 'team' };
        await seedGrant(store, event, grant.resourceId, assistant);
        await seedGrant(store, event, grant.resourceId, group);
      }
      return;
    }
    function activeModel(model: typeof models[number]) {
      return !model.retired;
    }
    const activeModels = models.filter(activeModel);
    for (const model of activeModels) await seedGrant(store, event, model.id);
  }
  return registerHandler('seed-model-grants', seedSelection);
}

/** Run once during upgrade, with writers stopped; safe to resume after failure. */
export async function migrateModelGrants(store: EventStore, silo: string) {
  const head = await store.head();
  const entities = new Map<string, EventEnvelope>();
  if (!head) return;
  for await (const { event } of readEvents(store, 1, head)) {
    if (event.silo !== silo) throw new Error('Model grant migration silo mismatch');
    if ((event.type === 'member.joined' || event.type === 'silo.owner_bootstrapped') || event.type === 'assistant.created') entities.set(event.subject, event);
    if (event.type === 'member.removed') entities.delete(event.subject);
  }
  const handler = modelGrantHandler(store);
  const noSql = { query: () => Promise.reject(new Error('Model grants cannot write SQL')) };
  for (const event of entities.values()) await handler.handle(event, noSql);
}
