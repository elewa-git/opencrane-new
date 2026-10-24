import { childActivatedDataSchema } from '@opencrane/events';
import { childStartState } from './child-failure.ts';
import { checkedChildInput, ChildRequestChanged, ChildRequestClosed,
  save, stageId, verifySaved } from './child-requests.ts';

type Options = Parameters<typeof checkedChildInput>[0];
export async function checkedChildActivation(options: Options, memberId: string,
  value: unknown, attempt: number) {
  const checked = await checkedChildInput(options, memberId, value);
  const { loaded, intent, rows, creation, previous, subject, fresh } = checked;
  const current = childStartState(loaded.rows, intent.row.event.id);
  if (!previous || current.failure || current.attempt !== attempt ||
      loaded.input.requestId !== intent.data.requestId) {
    throw new ChildRequestChanged('Child activation unavailable');
  }
  const data = childActivatedDataSchema.parse({ conversationId: intent.data.childConversationId,
    parentConversationId: intent.data.conversationId, requestId: intent.data.requestId,
    intentEventId: intent.row.event.id, intentPosition: intent.row.sequence,
    creationEventId: creation.event.id, creationPosition: creation.sequence,
    firstInputId: previous.event.id, firstInputPosition: previous.sequence,
    requestedBy: memberId, assistantId: intent.data.assistantId,
    payingGroupId: intent.data.payingGroupId, attempt });
  const id = stageId(options, loaded.input, 'child-activated');
  let sequence = 0;
  let activated: typeof previous | undefined;
  for (const row of rows) {
    if (row.event.subject === subject) sequence = row.sequence;
    if (row.event.type === 'conversation.child_activated' || row.event.id === id) activated = row;
  }
  async function confirmAccess() {
    // Read only new records. Keep full histories outside the original write deadline.
    await fresh();
    const parentSubject = `conversation-${intent.data.conversationId}`;
    const updated = [...loaded.rows];
    for await (const row of options.store.readStream(parentSubject, loaded.sequence + 1,
      fresh.deadline)) {
      if (row.event.silo !== options.silo) throw new ChildRequestChanged('Child activation unavailable');
      if (row.event.type === 'conversation.closed') throw new ChildRequestClosed('Conversation closed');
      updated.push(row);
    }
    const latest = childStartState(updated, intent.row.event.id);
    if (latest.failure || latest.attempt !== attempt) {
      throw new ChildRequestChanged('Child activation unavailable');
    }
    await fresh();
    for await (const row of options.store.readStream(subject, sequence + 1, fresh.deadline)) {
      if (row.event.silo !== options.silo) throw new ChildRequestChanged('Child activation unavailable');
      if (row.event.type === 'conversation.closed') throw new ChildRequestClosed('Conversation closed');
    }
    await fresh();
  }
  await confirmAccess();
  if (activated) {
    const expected = { ...activated.event, id, commandId: id, silo: options.silo, subject,
      source: 'opencrane-server', type: 'conversation.child_activated', data,
      principal: { kind: 'human' as const, id: memberId } };
    verifySaved(activated, expected);
  }
  return { ...checked, activated, data, id, sequence, confirmAccess };
}
export async function activateRequestedChild(options: Options, memberId: string,
  value: unknown, attempt: number) {
  const checked = await checkedChildActivation(options, memberId, value, attempt);
  const { activated, id, subject, data, sequence, fresh } = checked;
  if (activated) return activated;
  return save(options, memberId, id, subject, 'conversation.child_activated', data, sequence, fresh);
}
