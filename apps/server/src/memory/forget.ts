import { createHash } from 'node:crypto';
import { z } from 'zod';
import { authorityFence, readActiveMember, memoryReferences } from '@opencrane/models';
import { memoryErasureHistory, memoryIdentity, memoryKeys } from '@opencrane/projections';
import { memoryForgottenEventSchema, memoryCleanupRecordedEventSchema,
  memoryValueEventSchema, memoryCorrectedEventSchema } from '@opencrane/events';
import type { StoredEvent } from '@opencrane/event-store';
import { memoryAccessChecks, resolveScope, scopeAccess, requireForgetAccess, MemoryRefused,
  type MemoryOptions, type Scope } from './access.ts';
import { MemoryConflict } from './reads.ts';
import { commandJournal } from './journal.ts';
import { commandReference, commandHistory } from './command-history.ts';
import { acquireMemoryWrite } from './admission.ts';

const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/u);
const targetParams = z.strictObject({ scopeId: z.string(), memoryId: identifier });
const forgetInput = z.strictObject({ commandId: identifier, expectedRevision: z.int().positive() });
type Input = z.infer<typeof forgetInput>;
function changeEvent(row: StoredEvent) {
  const saved = row.event.type === 'memory.corrected'
    ? memoryCorrectedEventSchema.parse(row.event) : memoryForgottenEventSchema.parse(row.event);
  if (!('schemaVersion' in saved.data)) {
    throw new MemoryConflict();
  }
  return { ...saved, data: saved.data };
}
function cleanupReceipt(saved: ReturnType<typeof changeEvent>, rows: StoredEvent[], sequence: number) {
  const data = saved.data;
  let cleanupStatus = 'pending';
  let forgottenAt: string | undefined;
  for (const record of rows) {
    if (record.sequence <= sequence || record.event.type !== 'memory.cleanup_recorded') {
      continue;
    }
    const cleanup = memoryCleanupRecordedEventSchema.parse(record.event);
    const details = cleanup.data;
    if (cleanup.silo !== saved.silo || cleanup.subject !== saved.subject ||
      details.changeId !== saved.id || details.scopeId !== data.scopeId ||
      details.scopeKind !== data.scopeKind || details.ownerId !== data.ownerId || forgottenAt) {
      continue;
    }
    cleanupStatus = 'unavailable';
    if (details.outcome === 'completed') {
      cleanupStatus = 'forgotten';
      forgottenAt = cleanup.time;
    }
  }
  return { cleanupStatus, forgottenAt };
}
function correctionStatus(saved: ReturnType<typeof changeEvent>, rows: StoredEvent[], directory?: string) {
  const references = memoryReferences(rows, saved.silo, saved.data.scopeId, 'event-only');
  const status = references.current(saved.data);
  if (status !== 'current') {
    return status;
  }
  if (!directory) {
    return 'unavailable';
  }
  const keys = memoryKeys(directory);
  const available = memoryReferences(rows, saved.silo, saved.data.scopeId, keys);
  if (available.current(saved.data) !== 'current') {
    return 'unavailable';
  }
  return 'current';
}
export function changeReceipt(row: StoredEvent, rows: StoredEvent[],
  audience: { kind: string; ownerId: string }, directory?: string) {
  const saved = changeEvent(row);
  const data = saved.data;
  const { cleanupStatus, forgottenAt } = cleanupReceipt(saved, rows, row.sequence);
  if (saved.type === 'memory.corrected') {
    const contentStatus = correctionStatus(saved, rows, directory);
    return { operation: 'correct', outcome: 'accepted', changeId: saved.id, memoryId: data.memoryId,
      revision: data.revision, scopeId: data.scopeId, audience, acceptedAt: saved.time,
      contentStatus, cleanupStatus: forgottenAt ? 'completed' : cleanupStatus,
      ...(forgottenAt ? { completedAt: forgottenAt } : {}) };
  }
  return { operation: 'forget', outcome: 'accepted', changeId: saved.id, memoryId: data.memoryId,
    revision: data.revision, scopeId: data.scopeId, audience, acceptedAt: saved.time,
    hidden: true, cleanupStatus, ...(forgottenAt ? { forgottenAt } : {}) };
}
function originalForget(row: StoredEvent, rows: StoredEvent[], input: Input, memoryId: string,
  audience: { kind: string; ownerId: string }) {
  if (row.event.type !== 'memory.forgotten') {
    throw new MemoryConflict();
  }
  const saved = memoryForgottenEventSchema.parse(row.event);
  if (!('schemaVersion' in saved.data) || saved.data.memoryId !== memoryId ||
    saved.data.expectedRevision !== input.expectedRevision) {
    throw new MemoryConflict();
  }
  return changeReceipt(row, rows, audience);
}
function requireForgetSources(scope: Scope, saved: ReturnType<typeof memoryValueEventSchema.parse>) {
  if (scope.scopeKind === 'person' || !('schemaVersion' in saved.data)) return;
  for (const source of saved.data.sources) {
    // Keep chat sources out of shared mutations, as for shared remember commands.
    if ('conversationId' in source) throw new MemoryRefused();
  }
}
async function requireTarget(rows: StoredEvent[], options: MemoryOptions, scope: Scope,
  memoryId: string, expectedRevision: number) {
  const erasure = await memoryErasureHistory(rows);
  if (erasure.hidden(options.silo, scope.scopeId).has(memoryId)) {
    throw new MemoryConflict();
  }
  let revision = 0;
  for (const row of rows) {
    if (row.event.type !== 'memory.written' && row.event.type !== 'memory.corrected') {
      continue;
    }
    const saved = memoryValueEventSchema.parse(row.event);
    if (saved.type === 'memory.corrected' && saved.data.memoryId === memoryId &&
      !('schemaVersion' in saved.data)) {
      throw new MemoryConflict();
    }
    const identity = memoryIdentity(saved);
    if (identity?.memoryId === memoryId && identity.scopeId === scope.scopeId &&
      identity.ownerId === scope.ownerId && identity.scopeKind === scope.scopeKind) {
      requireForgetSources(scope, saved);
      revision = Math.max(revision, identity.revision);
    }
  }
  if (revision === 0) {
    throw new MemoryRefused();
  }
  if (revision !== expectedRevision) {
    throw new MemoryConflict();
  }
}
export async function forget(options: MemoryOptions, requester: string, params: unknown, raw: unknown) {
  const target = targetParams.safeParse(params);
  if (!target.success) {
    throw new MemoryRefused();
  }
  const scope = await resolveScope(options, requester, target.data.scopeId);
  const initialAccess = await scopeAccess(options, requester, scope, true);
  requireForgetAccess(initialAccess);
  const { memoryId } = target.data;
  const input = forgetInput.parse(raw);
  // Refuse unknown ids before reading private history. The events still decide the revision.
  const known = await options.db.query(`SELECT memory_id FROM memory_facts
    WHERE silo=$1 AND scope_id=$2 AND memory_id=$3`, [options.silo, scope.scopeId, memoryId]);
  if (known.rows.length === 0) {
    throw new MemoryRefused();
  }
  const state = await commandHistory(options, scope.scopeId, requester, input.commandId);
  if (!state.original) {
    await requireTarget(state.rows, options, scope, memoryId, input.expectedRevision);
  }
  const fresh = await authorityFence(options.store, performance.now(), [`member-${requester}`]);
  const checks = memoryAccessChecks(options, requester, fresh);
  await readActiveMember(options.store, options.binding, requester, 'member', checks.applied);
  const access = await scopeAccess(options, requester, scope, true, checks);
  requireForgetAccess(access);
  await fresh();
  if (!options.keyDirectory || !options.db.lock) {
    throw new Error('Memory command records unavailable');
  }
  const reference = commandReference(options.silo, scope.scopeId, requester, input.commandId);
  async function execute() {
    return forgetLocked(options, requester, scope, memoryId, input, state, fresh, reference,
      access.audience);
  }
  function lockOptions() {
    // Allow slow database replies while keeping the original two-second access limit.
    const remainingMs = Math.max(0, fresh.deadline - performance.now());
    return { timeoutMs: Math.min(1000, remainingMs) };
  }
  async function lockFact() {
    return options.db.lock!(`memory-fact:${options.silo}:${scope.scopeId}:${memoryId}`,
      execute, lockOptions());
  }
  const release = await acquireMemoryWrite(options.silo, requester, scope.scopeId);
  try {
    await fresh();
    return await options.db.lock(`memory-command:${reference}`, lockFact, lockOptions());
  } finally {
    release();
  }
}
async function forgetLocked(options: MemoryOptions, requester: string, scope: Scope,
  memoryId: string, input: Input, state: Awaited<ReturnType<typeof commandHistory>>,
  fresh: Awaited<ReturnType<typeof authorityFence>>, reference: string,
  audience: { kind: string; ownerId: string }) {
  const journal = commandJournal(options.keyDirectory!, reference);
  const factReference = commandReference(options.silo, scope.scopeId, requester, memoryId);
  const reservation = commandJournal(options.keyDirectory!, `fact-${factReference}`);
  const fingerprint = createHash('sha256');
  const metadata = { operation: 'forget', memoryId, ...input };
  fingerprint.update(JSON.stringify(metadata));
  const inputDigest = fingerprint.digest('hex');
  function recoveredReceipt(row: StoredEvent, rows: StoredEvent[]) {
    const receipt = originalForget(row, rows, input, memoryId, audience);
    journal.remove();
    // Remove the reservation only after history proves the fact is permanently forgotten.
    reservation.remove();
    return receipt;
  }
  async function reconcile() {
    const reconciled = await commandHistory(options, scope.scopeId, requester, input.commandId,
      performance.now() + 100, state.rows);
    if (reconciled.original) {
      return recoveredReceipt(reconciled.original, reconciled.rows);
    }
    throw new MemoryConflict();
  }
  const current = await commandHistory(options, scope.scopeId, requester, input.commandId,
    performance.now() + 100, state.rows);
  await fresh();
  if (current.original) {
    return recoveredReceipt(current.original, current.rows);
  }
  const pending = journal.read();
  if (pending) {
    if (pending.operation !== 'forget' || pending.inputDigest !== inputDigest ||
      pending.stage === 'failed') {
      throw new MemoryConflict();
    }
    return { outcome: 'unknown' };
  }
  const expectedSequence = state.rows.at(-1)?.sequence ?? 0;
  const data = { schemaVersion: 1, ...scope, memoryId,
    expectedRevision: input.expectedRevision, revision: input.expectedRevision + 1 };
  const proposed = { id: reference, commandId: input.commandId,
    silo: options.silo, subject: `scope-${scope.scopeId}`, type: 'memory.forgotten',
    source: 'opencrane-server', time: new Date().toISOString(),
    principal: { kind: 'human', id: requester }, correlation: {}, data };
  const event = memoryForgottenEventSchema.parse(proposed);
  const identity = { silo: options.silo, ...scope, memoryId, revision: input.expectedRevision };
  const position = await options.store.head(`scope-${scope.scopeId}`, fresh.deadline);
  await fresh();
  if (position !== expectedSequence) {
    return reconcile();
  }
  // Keep uncertain attempts across restart. This record never authorises key recovery or a resend.
  const entry = { operation: 'forget' as const, identity, requester, principalKind: 'human' as const,
    commandId: input.commandId, inputDigest, expectedSequence, stage: 'unknown' as const };
  journal.save(entry);
  let result;
  try {
    const command = { event, expectedSequence, historyChecked: true as const, deadline: fresh.deadline };
    result = await options.store.append(command);
  } catch {
    return { outcome: 'unknown' };
  }
  if (result.status === 'unavailable') {
    return { outcome: 'unknown' };
  }
  if (result.status === 'appended') {
    journal.remove();
    reservation.remove();
    const saved = { event, sequence: result.sequence };
    return changeReceipt(saved, [], audience);
  }
  const failed = { ...entry, stage: 'failed' as const };
  journal.save(failed);
  return reconcile();
}
