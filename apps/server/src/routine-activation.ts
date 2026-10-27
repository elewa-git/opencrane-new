import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { StoredEvent } from '@opencrane/event-store';
import { budgetRootAllowanceSetDataSchema, budgetRootStoppedDataSchema,
  routineActivationSchema } from '@opencrane/events';
import { history } from '@opencrane/models';
import { verifySaved } from './chat/child-requests.ts';
import { loadRoutineRootPreparation } from './routine-root.ts';

type Arguments = Parameters<typeof loadRoutineRootPreparation>;

// Record only the admission. A saved receipt never grants a caller permission to send.
export async function admitRoutineActivation(store: Arguments[0], keys: Arguments[1],
  worker: Arguments[2], raw: unknown, selection: Arguments[4], senderAttemptId: string) {
  try {
    return await admit(store, keys, worker, raw, selection, senderAttemptId);
  } catch {
    throw new Error('Routine activation refused');
  }
}

async function admit(store: Arguments[0], keys: Arguments[1], worker: Arguments[2],
  raw: unknown, selection: Arguments[4], senderAttemptId: string) {
  z.string().regex(/^[\w-]{1,200}$/u).parse(senderAttemptId);
  // Read growing budget history before preparation starts its access deadline.
  const budgetSubject = `budget-${worker.silo}`;
  const budgetRows = await history(store, budgetSubject, worker.silo, performance.now() + 10_000);
  const checked = await loadRoutineRootPreparation(store, keys, worker, raw, selection, true);
  const { run, binding, deadline, preparation } = checked;
  const hash = createHash('sha256');
  hash.update(JSON.stringify([worker.silo, run.conversationId, run.turnId]));
  const rootId = hash.digest('hex');
  let allocation: StoredEvent | undefined;
  function checkBudget(row: StoredEvent) {
    if (row.event.silo !== worker.silo || row.event.subject !== budgetSubject) {
      throw new Error('Routine activation refused');
    }
    if (row.event.type === 'budget.root_stopped') {
      const stopped = budgetRootStoppedDataSchema.parse(row.event.data);
      if (stopped.rootId === rootId) throw new Error('Routine activation refused');
    }
    if (row.event.type !== 'budget.root_allowance_set') return;
    const saved = budgetRootAllowanceSetDataSchema.parse(row.event.data);
    if (saved.rootId !== rootId && saved.conversationId !== run.conversationId) return;
    const expected = { ...binding, allowanceCents: saved.allowanceCents, rootId };
    if (allocation || !isDeepStrictEqual(saved, expected) ||
        row.event.source !== 'models' || row.event.principal?.kind !== 'system' ||
        row.event.principal.id !== 'models') {
      throw new Error('Routine activation refused');
    }
    allocation = row;
  }
  for (const row of budgetRows) checkBudget(row);
  if (!allocation) throw new Error('Routine activation refused');
  let budgetPosition = budgetRows.at(-1)!.sequence;
  const data = routineActivationSchema.parse({ version: 1, routineId: run.routineId,
    definitionRevision: run.definitionRevision, scheduleRevision: run.scheduleRevision,
    controlRevision: run.controlRevision, occurrenceId: run.occurrenceId, rootId: run.rootId,
    conversationId: run.conversationId, messageId: run.messageId, turnId: run.turnId,
    senderAttemptId, admission: { eventId: allocation.event.id, position: allocation.sequence } });
  const id = `routine-activation-${run.occurrenceId}`;
  const subject = `routine-${run.routineId}`;
  const event = { id, commandId: id, silo: worker.silo, subject, data,
    type: 'routine.run_activation_admitted', source: 'opencrane-server',
    principal: { kind: 'system' as const, id: 'opencrane-server' },
    time: new Date().toISOString(), correlation: {} };
  let saved: StoredEvent | undefined;
  let position = 0;
  function checkRoutine(row: StoredEvent) {
    position = row.sequence;
    if (row.event.id !== id) {
      if (row.event.type !== event.type) return;
      const previous = routineActivationSchema.parse(row.event.data);
      if (previous.occurrenceId !== run.occurrenceId) return;
    }
    if (saved) throw new Error('Routine activation refused');
    verifySaved(row, event);
    saved = row;
  }
  for (const row of preparation.routineRows) checkRoutine(row);
  async function readChanges() {
    for await (const row of store.readStream(budgetSubject, budgetPosition + 1, deadline)) {
      checkBudget(row);
      budgetPosition = row.sequence;
    }
    for await (const row of store.readStream(subject, position + 1, deadline)) checkRoutine(row);
  }
  async function confirm() {
    let before: Awaited<ReturnType<typeof checked.receiptState>>;
    let after: typeof before;
    do {
      before = await checked.receiptState();
      await checked.confirmPreparation();
      await readChanges();
      after = await checked.receiptState();
    } while (!isDeepStrictEqual(before, after));
    preparation.checkTime();
    if (performance.now() >= deadline) throw new Error('Routine activation refused');
    return after;
  }
  let confirmed = await confirm();
  while (!saved) {
    const before = confirmed;
    async function checkAccess() {
      if (!await worker.checkCurrent()) throw new Error('Routine activation refused');
      await readChanges();
      const after = await checked.receiptState();
      preparation.checkTime();
      if (!isDeepStrictEqual(before, after)) throw new Error('Routine activation refused');
    }
    // Let storage order the final small checks against publication. Unrelated conflicts retry
    // within this same deadline; no second sender or renewed access window is created.
    const command = { event, expectedSequence: position, historyChecked: true as const,
      deadline, checkAccess };
    const result = await store.append(command);
    confirmed = await confirm();
    if (!saved && result.status !== 'appended' && result.status !== 'conflict') {
      throw new Error('Routine activation refused');
    }
  }
  return { status: 'confirmed' as const, occurrenceId: run.occurrenceId,
    conversationId: run.conversationId, eventId: saved.event.id, position: saved.sequence,
    startBy: run.startBy, executionAvailable: false as const };
}
