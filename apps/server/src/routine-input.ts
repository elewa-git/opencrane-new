import { isDeepStrictEqual } from 'node:util';
import { readEventAt, type StoredEvent } from '@opencrane/event-store';
import { messagePostedDataSchema } from '@opencrane/events';
import { chatHistory } from './chat/commands.ts';
import { loadRoutinePreparation } from './routine-session.ts';

/** Save user instructions without admitting a turn or starting a computer. */
export async function prepareRoutineInput(...args: Parameters<typeof loadRoutinePreparation>) {
  try {
    return await saveRoutineInput(...args);
  } catch {
    // Keep private text, custody failures and access failures out of replies.
    throw new Error('Routine input refused');
  }
}

export async function loadRoutineInput(...args: Parameters<typeof loadRoutinePreparation>) {
  const [, keys, worker] = args;
  const preparation = await loadRoutinePreparation(...args);
  const run = preparation.run;
  const conversationId = run.conversationId;
  const reader = { readStream: preparation.readStream };
  const rows = await chatHistory(reader, worker.silo, conversationId);
  if (rows[0]?.event.type !== 'conversation.created' ||
      run.messageId !== `routine-input-${run.occurrenceId}`) {
    throw new Error('Routine input refused');
  }
  const instructions = keys.decrypt(worker.silo, `routine-${run.routineId}`,
    run.definition.instructions);
  const text = `Routine instructions (user data):\n\n${instructions}`;
  const metadata = { conversationId, authorId: run.definition.ownerId,
    authorKind: 'system' as const, contentType: 'text' as const };
  function checkCustody(value: unknown) {
    if (keys.decrypt(worker.silo, `routine-${run.routineId}`,
      run.definition.instructions) !== instructions ||
      keys.decrypt(worker.silo, conversationId, value) !== text) {
      throw new Error('Routine input refused');
    }
  }
  function verify(row: StoredEvent) {
    const event = row.event;
    const data = messagePostedDataSchema.parse(event.data);
    const { ciphertext: _ciphertext, keyId: _keyId, ...savedMetadata } = data;
    if (event.id !== run.messageId || event.commandId !== run.messageId ||
        event.type !== 'message.posted' || event.silo !== worker.silo ||
        event.subject !== `conversation-${conversationId}` ||
        event.source !== 'opencrane-server' || event.principal?.kind !== 'system' ||
        event.principal.id !== worker.workerId || row.sequence <= rows[0]!.sequence ||
        !isDeepStrictEqual(savedMetadata, metadata)) {
      throw new Error('Routine input refused');
    }
    checkCustody(data);
  }
  let previous: StoredEvent | undefined;
  for (const row of rows) {
    if (row.event.type === 'conversation.closed') throw new Error('Routine input refused');
    if (row.event.type === 'message.posted' || row.event.commandId === run.messageId) {
      verify(row);
      if (previous) throw new Error('Routine input refused');
      previous = row;
    }
  }
  function encrypt() {
    const encrypted = keys.encrypt(worker.silo, conversationId, text);
    const data = { ...metadata, ...encrypted };
    return messagePostedDataSchema.parse(data);
  }
  return { preparation, rows, previous, verify, checkCustody, encrypt };
}

async function saveRoutineInput(...args: Parameters<typeof loadRoutinePreparation>) {
  const [store, , worker] = args;
  const { preparation, rows, previous, verify, checkCustody, encrypt } =
    await loadRoutineInput(...args);
  const run = preparation.run;
  const conversationId = run.conversationId;
  let position: number;
  if (previous) {
    await preparation.checkAccess();
    verify(previous);
    position = previous.sequence;
  } else {
    const data = encrypt();
    const event = { id: run.messageId, commandId: run.messageId, type: 'message.posted',
      subject: `conversation-${conversationId}`, silo: worker.silo,
      source: 'opencrane-server', time: new Date().toISOString(),
      principal: { kind: 'system' as const, id: worker.workerId }, data };
    // Finish history and custody reads before starting the short publication check.
    const deadline = await preparation.checkAccess();
    async function checkAccess() {
      await preparation.checkCurrent();
      checkCustody(data);
    }
    const command = { event, expectedSequence: rows.at(-1)!.sequence, historyChecked: true as const,
      deadline, checkAccess };
    const result = await store.append(command);
    if (result.status !== 'appended') throw new Error('Routine input refused');
    const saved = await readEventAt(store, event.subject, result.sequence,
      performance.now() + 10_000);
    if (!saved) throw new Error('Routine input refused');
    await preparation.checkOwner();
    verify(saved);
    position = saved.sequence;
  }
  return { status: 'confirmed' as const, occurrenceId: run.occurrenceId,
    conversationId, eventId: run.messageId, position,
    startBy: run.startBy, executionAvailable: false as const };
}
