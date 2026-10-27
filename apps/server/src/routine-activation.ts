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
    const checked = await admit(store, keys, worker, raw, selection, senderAttemptId, true);
    return checked.receipt;
  } catch {
    throw new Error('Routine activation refused');
  }
}

export async function readRoutineActivation(store: Arguments[0], keys: Arguments[1],
  worker: Arguments[2], raw: unknown, selection: Arguments[4], senderAttemptId: string) {
  return admit(store, keys, worker, raw, selection, senderAttemptId, false);
}

// Retain publication proof only in the live caller. Reading a receipt cannot recreate it.
export async function claimRoutineActivation(...args: Parameters<typeof readRoutineActivation>) {
  return admit(...args, true);
}

async function admit(store: Arguments[0], keys: Arguments[1], worker: Arguments[2],
  raw: unknown, selection: Arguments[4], senderAttemptId: string, recordAdmission: boolean) {
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
  // Never repair a missing admission while inspecting an existing sender attempt.
  if (!recordAdmission && !saved) throw new Error('Routine activation refused');
  async function readBudgetChanges() {
    for await (const row of store.readStream(budgetSubject, budgetPosition + 1, deadline)) {
      checkBudget(row);
      budgetPosition = row.sequence;
    }
  }
  async function readChanges() {
    await readBudgetChanges();
    for await (const row of store.readStream(subject, position + 1, deadline)) checkRoutine(row);
  }
  async function receiptState(started?: StoredEvent) {
    const state = await checked.receiptState(started);
    // Check this root's Stop after the awaited access and provider reads.
    // Read only new events; unrelated spending must not repeat confirmation.
    await readBudgetChanges();
    return state;
  }
  async function confirm(started?: StoredEvent) {
    let before: Awaited<ReturnType<typeof receiptState>>;
    let after: typeof before;
    do {
      before = await receiptState(started);
      await checked.confirmPreparation(started);
      await readChanges();
      after = await receiptState(started);
    } while (!isDeepStrictEqual(before, after));
    preparation.checkTime();
    if (performance.now() >= deadline) throw new Error('Routine activation refused');
    return after;
  }
  let published = false;
  let confirmed = await confirm();
  while (!saved) {
    const before = confirmed;
    async function checkAccess() {
      if (!await worker.checkCurrent(deadline)) {
        throw new Error('Routine activation refused');
      }
      await readChanges();
      const after = await receiptState();
      preparation.checkTime();
      if (!isDeepStrictEqual(before, after)) throw new Error('Routine activation refused');
    }
    // Let storage order the final small checks against publication. Unrelated conflicts retry
    // within this same deadline; no second sender or renewed access window is created.
    const command = { event, expectedSequence: position, historyChecked: true as const,
      deadline, checkAccess };
    const result = await store.append(command);
    published = result.outcome?.kind === 'appended';
    confirmed = await confirm();
    if (!saved && result.status !== 'appended' && result.status !== 'conflict') {
      throw new Error('Routine activation refused');
    }
  }
  const receipt = { status: 'confirmed' as const, occurrenceId: run.occurrenceId,
    conversationId: run.conversationId, eventId: saved.event.id, position: saved.sequence,
    startBy: run.startBy, executionAvailable: false as const };
  async function fresh() {
    await confirm();
  }
  async function confirmStarted(started: StoredEvent | undefined) {
    if (!started) throw new Error('Routine activation refused');
    await confirm(started);
  }
  return { receipt, messageId: run.messageId, turnId: run.turnId, rootId, senderAttemptId,
    published, run, fresh, confirmStarted, deadline, provider: checked.provider };
}
