import { createHash } from 'node:crypto';
import type { EventStore } from '@opencrane/event-store';
import type { EventEnvelope } from '@opencrane/events';
import { grantStream } from '@opencrane/authz';
import { readEvents } from '@opencrane/projections';
import { registerHandler } from '@opencrane/handlers';
import { envelope, history } from './actor.ts';
import { data, models } from './state.ts';

/** One command, one conditional append; existing grants and revocations win. */
async function seedGrant(store: EventStore, trigger: EventEnvelope, model: string) {
  const member = trigger.type === 'member.joined';
  const granteeId = data(trigger)[member ? 'memberId' : 'assistantId'];
  if (typeof granteeId !== 'string') throw new Error('Missing model grantee');
  const subject = grantStream('model', model);
  const rows = await history(store, subject, trigger.silo);
  if (rows.some(row => data(row.event)['granteeId'] === granteeId)) return;
  const id = `initial-model-grant-${createHash('sha256').update(JSON.stringify([trigger.silo, member, granteeId, model])).digest('hex')}`;
  const event = envelope(trigger.silo, subject, 'grant.given', {
    resourceType: 'model', resourceId: model, granteeId,
    granteeKind: member ? 'member' : 'assistant', grantedBy: 'installation',
  }, id);
  const result = await store.append({ event, expectedSequence: rows.at(-1)?.sequence ?? 0 });
  if (result.status !== 'appended') throw new Error('Initial model grant append failed; retry the reaction');
}

export function modelGrantHandler(store: EventStore) {
  return registerHandler('seed-model-grants', async event => {
    for (const model of models.filter(row => !row.retired)) await seedGrant(store, event, model.id);
  });
}

/** Run once during upgrade, with writers stopped; safe to resume after failure. */
export async function migrateModelGrants(store: EventStore, silo: string) {
  const head = await store.head();
  const entities = new Map<string, EventEnvelope>();
  if (!head) return;
  for await (const { event } of readEvents(store, 1, head)) {
    if (event.silo !== silo) throw new Error('Model grant migration silo mismatch');
    if (event.type === 'member.joined' || event.type === 'assistant.created') entities.set(event.subject, event);
    if (event.type === 'member.removed') entities.delete(event.subject);
  }
  const handler = modelGrantHandler(store);
  const noSql = { query: () => Promise.reject(new Error('Model grants cannot write SQL')) };
  for (const event of entities.values()) await handler.handle(event, noSql);
}
