import { createHash } from 'node:crypto';
import { z } from 'zod';
import { authorityFence, readActiveMember } from '@opencrane/models';
import { memoryErasureHistory, memoryIdentity } from '@opencrane/projections';
import { memoryForgottenEventSchema, memoryCleanupRecordedEventSchema,
  memoryWrittenEventSchema } from '@opencrane/events';
import type { StoredEvent } from '@opencrane/event-store';
import { memoryAccessChecks, scopeFor, MemoryRefused, type MemoryOptions,
  type Scope } from './access.ts';
import { MemoryConflict } from './reads.ts';
import { commandJournal } from './journal.ts';
import { commandReference, commandHistory } from './command-history.ts';
import { acquireMemoryWrite } from './admission.ts';

const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/u);
const targetParams = z.strictObject({ scopeId: z.string(), memoryId: identifier });
const changedIdentity = z.object({ memoryId: identifier });
const forgetInput = z.strictObject({ commandId: identifier, expectedRevision: z.int().positive() });
type Input = z.infer<typeof forgetInput>;
export function forgottenReceipt(row: StoredEvent, rows: StoredEvent[],
  audience: { kind: string; ownerId: string }) {
  const saved = memoryForgottenEventSchema.parse(row.event);
  const data = saved.data;
  if (!('schemaVersion' in data)) {
    throw new MemoryConflict();
  }
  let cleanupStatus = 'pending';
  let forgottenAt: string | undefined;
  for (const record of rows) {
    if (record.sequence <= row.sequence || record.event.type !== 'memory.cleanup_recorded') {
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
  return { operation: 'forget', outcome: 'accepted', changeId: saved.id, memoryId: data.memoryId,
    revision: data.revision, scopeId: data.scopeId, audience, acceptedAt: saved.time,
    hidden: true, cleanupStatus, ...(forgottenAt ? { forgottenAt } : {}) };
}
function originalForget(row: StoredEvent, rows: StoredEvent[], input: Input, memoryId: string,
  scope: Scope) {
  if (row.event.type !== 'memory.forgotten') {
    throw new MemoryConflict();
  }
  const saved = memoryForgottenEventSchema.parse(row.event);
  if (!('schemaVersion' in saved.data) || saved.data.memoryId !== memoryId ||
    saved.data.expectedRevision !== input.expectedRevision) {
    throw new MemoryConflict();
  }
  const audience = { kind: 'person', ownerId: scope.ownerId };
  return forgottenReceipt(row, rows, audience);
}
async function requireTarget(rows: StoredEvent[], options: MemoryOptions, scope: Scope,
  memoryId: string, expectedRevision: number) {
  const erasure = await memoryErasureHistory(rows);
  if (erasure.hidden(options.silo, scope.scopeId).has(memoryId)) {
    throw new MemoryConflict();
  }
  let revision = 0;
  for (const row of rows) {
    if (row.event.type === 'memory.corrected') {
      const changed = changedIdentity.parse(row.event.data);
      if (changed.memoryId === memoryId) {
        throw new MemoryConflict();
      }
    }
    if (row.event.type !== 'memory.written') {
      continue;
    }
    const saved = memoryWrittenEventSchema.parse(row.event);
    const identity = memoryIdentity(saved);
    if (identity?.memoryId === memoryId && identity.scopeId === scope.scopeId &&
      identity.ownerId === scope.ownerId && identity.scopeKind === 'person') {
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
  const scope = scopeFor(options.silo, 'person', requester);
  if (!target.success || target.data.scopeId !== scope.scopeId) {
    throw new MemoryRefused();
  }
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
  await fresh();
  if (!options.keyDirectory || !options.db.lock) {
    throw new Error('Memory command records unavailable');
  }
  const reference = commandReference(options.silo, scope.scopeId, requester, input.commandId);
  async function execute() {
    return forgetLocked(options, requester, scope, memoryId, input, state, fresh, reference);
  }
  const release = await acquireMemoryWrite(options.silo, requester, scope.scopeId);
  try {
    await fresh();
    return await options.db.lock(`memory-command:${reference}`, execute, { timeoutMs: 100 });
  } finally {
    release();
  }
}
async function forgetLocked(options: MemoryOptions, requester: string, scope: Scope,
  memoryId: string, input: Input, state: Awaited<ReturnType<typeof commandHistory>>,
  fresh: Awaited<ReturnType<typeof authorityFence>>, reference: string) {
  const journal = commandJournal(options.keyDirectory!, reference);
  const fingerprint = createHash('sha256');
  const metadata = { operation: 'forget', memoryId, ...input };
  fingerprint.update(JSON.stringify(metadata));
  const inputDigest = fingerprint.digest('hex');
  function recoveredReceipt(row: StoredEvent, rows: StoredEvent[]) {
    const receipt = originalForget(row, rows, input, memoryId, scope);
    journal.remove();
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
  await fresh();
  if (await options.store.head(`scope-${scope.scopeId}`, fresh.deadline) !== expectedSequence) {
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
    const saved = { event, sequence: result.sequence };
    const audience = { kind: 'person', ownerId: requester };
    return forgottenReceipt(saved, [], audience);
  }
  const failed = { ...entry, stage: 'failed' as const };
  journal.save(failed);
  return reconcile();
}
