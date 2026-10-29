import { createHash } from 'node:crypto';
import { z } from 'zod';
import { authorityFence, memoryReferences, readActiveMember } from '@opencrane/models';
import { memoryKeys, memoryIdentity } from '@opencrane/projections';
import { memoryCorrectedEventSchema, memoryValueEventSchema, memoryTextSchema,
  memoryWrittenDataSchema } from '@opencrane/events';
import type { StoredEvent } from '@opencrane/event-store';
import { memoryAccessChecks, resolveScope, scopeAccess, MemoryRefused,
  type MemoryOptions, type Scope } from './access.ts';
import { MemoryConflict } from './reads.ts';
import { commandJournal } from './journal.ts';
import { commandReference, commandHistory } from './command-history.ts';
import { acquireMemoryWrite, MemoryBusy } from './admission.ts';
import { changeReceipt } from './forget.ts';
import { confirmChange, changeRefused, type AgentChange, type WriteAuthority }
  from './change-authority.ts';

const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/u);
const targetParams = z.strictObject({ scopeId: z.string(), memoryId: identifier });
const fields = memoryWrittenDataSchema.pick({ kind: true, pinned: true, expiresAt: true });
const inputSchema = fields.extend({ commandId: identifier, expectedRevision: z.int().positive(),
  text: memoryTextSchema });
type Input = z.infer<typeof inputSchema>;
type State = Awaited<ReturnType<typeof commandHistory>>;
const agentInputSchema = inputSchema.extend({ dependsOn: memoryWrittenDataSchema.shape.dependsOn });

function factReservation(options: MemoryOptions, scopeId: string, requester: string, memoryId: string) {
  const reference = commandReference(options.silo, scopeId, requester, memoryId);
  return commandJournal(options.keyDirectory!, `fact-${reference}`);
}
function targetValue(rows: StoredEvent[], scope: Scope, memoryId: string) {
  let latest;
  for (const row of rows) {
    if (row.event.type !== 'memory.written' && row.event.type !== 'memory.corrected') {
      continue;
    }
    const saved = memoryValueEventSchema.parse(row.event);
    const data = saved.data;
    if ('schemaVersion' in data && data.memoryId === memoryId && data.scopeId === scope.scopeId &&
      data.ownerId === scope.ownerId && data.scopeKind === scope.scopeKind &&
      (!latest || data.revision > latest.revision)) {
      latest = data;
    }
  }
  if (!latest) {
    throw new MemoryRefused();
  }
  return latest;
}
function originalReceipt(row: StoredEvent, rows: StoredEvent[], input: Input, memoryId: string,
  directory: string, audience: { kind: string; ownerId: string },
  dependsOn?: z.infer<typeof agentInputSchema>['dependsOn']) {
  if (row.event.type !== 'memory.corrected') {
    throw new MemoryConflict();
  }
  const saved = memoryCorrectedEventSchema.parse(row.event);
  const data = saved.data;
  if (!('schemaVersion' in data) || data.memoryId !== memoryId ||
    data.expectedRevision !== input.expectedRevision) {
    throw new MemoryConflict();
  }
  const receipt = changeReceipt(row, rows, audience, directory);
  // Never open superseded or erased text to compare an already consumed command.
  if ('contentStatus' in receipt && receipt.contentStatus === 'current') {
    const keys = memoryKeys(directory);
    const identity = memoryIdentity(saved)!;
    if (keys.decrypt(identity, data) !== input.text || data.kind !== input.kind ||
      data.pinned !== input.pinned || data.expiresAt !== input.expiresAt ||
      (dependsOn && JSON.stringify(data.dependsOn) !== JSON.stringify(dependsOn))) {
      throw new MemoryConflict();
    }
  }
  return receipt;
}
async function correctionTarget(options: MemoryOptions, requester: string, params: unknown,
  agent?: AgentChange) {
  const target = targetParams.safeParse(params);
  if (!target.success) {
    throw new MemoryRefused();
  }
  const scope = await resolveScope(options, requester, target.data.scopeId);
  if (agent && (scope.scopeKind !== 'person' || scope.ownerId !== requester)) {
    throw new MemoryRefused();
  }
  const access = await scopeAccess(options, requester, scope, true);
  if (!access.canCorrect) {
    throw new MemoryRefused();
  }
  const { memoryId } = target.data;
  const known = await options.db.query(`SELECT memory_id FROM memory_facts
    WHERE silo=$1 AND scope_id=$2 AND memory_id=$3`, [options.silo, scope.scopeId, memoryId]);
  if (known.rows.length === 0) {
    throw new MemoryRefused();
  }
  return { scope, memoryId };
}
export async function correct(options: MemoryOptions, requester: string, params: unknown,
  raw: unknown, agent?: AgentChange) {
  const { scope, memoryId } = await correctionTarget(options, requester, params, agent);
  const input = agent ? agentInputSchema.parse(raw) : inputSchema.parse(raw);
  const principalKind: 'agent' | 'human' = agent ? 'agent' : 'human';
  if (!options.keyDirectory || !options.db.lock) {
    throw new Error('Memory custody unavailable');
  }
  const keys = memoryKeys(options.keyDirectory);
  const state = await commandHistory(options, scope.scopeId, requester, input.commandId,
    agent?.checkAccess.deadline, agent?.rows, principalKind);
  const previous = targetValue(state.rows, scope, memoryId);
  if (!state.original) {
    const references = memoryReferences(state.rows, options.silo, scope.scopeId, keys);
    if (previous.revision !== input.expectedRevision || references.current(previous) !== 'current') {
      throw new MemoryConflict();
    }
  }
  // Keep the signed access check and its original deadline for agent writes.
  const fresh = agent?.checkAccess ?? await humanAuthority(options, requester, scope);
  await fresh();
  const reference = commandReference(options.silo, scope.scopeId, requester, input.commandId,
    principalKind);
  async function execute() {
    return correctLocked(options, requester, scope, input, reference, state, previous, fresh, agent);
  }
  async function lockFact() {
    return options.db.lock!(`memory-fact:${options.silo}:${scope.scopeId}:${memoryId}`,
      execute, { timeoutMs: 100 });
  }
  let release;
  try {
    release = await acquireMemoryWrite(options.silo, requester, scope.scopeId);
  } catch (error) {
    if (error instanceof MemoryBusy) {
      throw new MemoryConflict();
    }
    throw error;
  }
  try {
    await fresh();
    return await options.db.lock(`memory-command:${reference}`, lockFact, { timeoutMs: 100 });
  } finally {
    release();
  }
}
async function humanAuthority(options: MemoryOptions, requester: string, scope: Scope) {
  const fresh = await authorityFence(options.store, performance.now(), [`member-${requester}`]);
  const checks = memoryAccessChecks(options, requester, fresh);
  await readActiveMember(options.store, options.binding, requester, 'member', checks.applied);
  const access = await scopeAccess(options, requester, scope, true, checks);
  if (!access.canCorrect) {
    throw new MemoryRefused();
  }
  return fresh;
}
function checkReservation(reservation: ReturnType<typeof factReservation>, position: number) {
  const reserved = reservation.read();
  if (reserved?.stage === 'unknown' &&
    (reserved.expectedSequence === undefined || position <= reserved.expectedSequence)) {
    // Keep an uncertain slot until saved history makes its delayed append impossible.
    throw new MemoryConflict();
  }
}
async function correctLocked(options: MemoryOptions, requester: string, scope: Scope, input: Input,
  reference: string, state: State, previous: ReturnType<typeof targetValue>,
  fresh: WriteAuthority, agent?: AgentChange) {
  const principalKind: 'agent' | 'human' = agent ? 'agent' : 'human';
  const dependencies = agent ? agentInputSchema.parse(input).dependsOn : previous.dependsOn;
  const journal = commandJournal(options.keyDirectory!, reference);
  const memoryId = previous.memoryId;
  const reservation = factReservation(options, scope.scopeId, requester, memoryId);
  const audience = { kind: 'person', ownerId: requester };
  const current = await commandHistory(options, scope.scopeId, requester, input.commandId,
    Math.min(fresh.deadline, performance.now() + 100), state.rows, principalKind);
  await fresh();
  if (current.original) {
    const receipt = originalReceipt(current.original, current.rows, input, memoryId,
      options.keyDirectory!, audience, dependencies);
    journal.remove();
    return receipt;
  }
  const { text: _text, ...metadata } = input;
  const hash = createHash('sha256');
  hash.update(JSON.stringify({ memoryId, ...metadata }));
  const inputDigest = hash.digest('hex');
  const pending = journal.read();
  if (pending) {
    // Recover uncertain agent commands through status, without accepting another replacement.
    if (agent || pending.operation !== 'correct' || pending.inputDigest !== inputDigest ||
      pending.stage === 'failed') {
      throw new MemoryConflict();
    }
    return { outcome: 'unknown' };
  }
  const expectedSequence = state.rows.at(-1)?.sequence ?? 0;
  const position = current.rows.at(-1)?.sequence ?? 0;
  if (position !== expectedSequence) {
    throw new MemoryConflict();
  }
  checkReservation(reservation, position);
  const identity = { silo: options.silo, ...scope, memoryId, revision: input.expectedRevision + 1 };
  const entry = { operation: 'correct' as const, identity, requester, principalKind,
    commandId: input.commandId, inputDigest, expectedSequence, stage: 'prepared' as const,
    appendUntil: Date.now() + Math.max(0, fresh.deadline - performance.now()) };
  const replacement = { ...previous, dependsOn: dependencies };
  return appendCorrection(options, input, entry, replacement, fresh, current.rows, agent);
}
function correctionEvent(options: MemoryOptions, input: Input,
  entry: NonNullable<ReturnType<ReturnType<typeof commandJournal>['read']>>,
  previous: ReturnType<typeof targetValue>, agent?: AgentChange) {
  const { identity, requester } = entry;
  const { scopeId, memoryId } = identity;
  const reference = commandReference(options.silo, scopeId, requester, input.commandId,
    entry.principalKind);
  const encryptedSize = Buffer.byteLength(input.text) + 28;
  const encryptedBytes = Buffer.alloc(encryptedSize);
  const placeholder = { ciphertext: encryptedBytes.toString('base64'),
    keyId: `key:${'0'.repeat(64)}` };
  const data = { ...previous, revision: identity.revision,
    expectedRevision: input.expectedRevision, supersedes: { memoryId, revision: input.expectedRevision },
    reason: agent ? 'contradiction' : 'human', kind: input.kind, pinned: input.pinned,
    expiresAt: input.expiresAt, ...placeholder };
  let correlation = {};
  if (agent) {
    correlation = { conversation: agent.conversation, turn: agent.turn, request: agent.requestId };
  }
  const proposed = { id: reference, commandId: input.commandId, silo: options.silo,
    subject: `scope-${scopeId}`, type: 'memory.corrected', source: 'opencrane-server',
    time: new Date().toISOString(), principal: { kind: entry.principalKind, id: requester },
    correlation, data };
  return memoryCorrectedEventSchema.parse(proposed);
}
async function appendCorrection(options: MemoryOptions, input: Input,
  entry: NonNullable<ReturnType<ReturnType<typeof commandJournal>['read']>>,
  previous: ReturnType<typeof targetValue>, fresh: WriteAuthority,
  rows: StoredEvent[], agent?: AgentChange) {
  const { identity, requester, expectedSequence } = entry;
  const { scopeId, memoryId } = identity;
  const event = correctionEvent(options, input, entry, previous, agent);
  const journal = commandJournal(options.keyDirectory!, event.id);
  const reservation = factReservation(options, scopeId, requester, memoryId);
  const keys = memoryKeys(options.keyDirectory!);
  const audience = { kind: 'person', ownerId: requester };
  journal.save(entry);
  reservation.save(entry);
  // Keep this candidate after a refused attempt. Deleting it would also destroy a concurrent save.
  keys.discardUnpublished(identity);
  keys.provision(identity);
  const encrypted = keys.encrypt(identity, input.text);
  event.data = { ...event.data, ...encrypted };
  await confirmChange(options, requester, fresh, agent);
  async function checkAccess() {
    // Check expiry and custody again after the store prepares publication.
    await confirmChange(options, requester, fresh, agent);
    const references = memoryReferences(rows, options.silo, scopeId, keys);
    const loaded = [...previous.dependsOn, previous];
    for (const reference of loaded) {
      if (references.current(reference) !== 'current') {
        throw new MemoryRefused();
      }
    }
    // Refuse replacements that would invalidate their own loaded dependencies.
    const proposed = { event, sequence: expectedSequence! + 1 };
    const nextReferences = memoryReferences([...rows, proposed], options.silo, scopeId, keys);
    if (nextReferences.current(identity) !== 'current') {
      throw new MemoryRefused();
    }
  }
  const uncertain = { ...entry, stage: 'unknown' as const };
  reservation.save(uncertain);
  journal.save(uncertain);
  const command = { event, expectedSequence: expectedSequence!,
    historyChecked: true as const, deadline: fresh.deadline,
    ...(agent ? { checkAccess } : {}) };
  let result;
  try {
    result = await options.store.append(command);
  } catch (error) {
    if (agent && changeRefused(error)) {
      throw error;
    }
    return { outcome: 'unknown' };
  }
  if (result.status === 'unavailable') {
    if (agent && changeRefused(result.cause)) {
      throw result.cause;
    }
    return { outcome: 'unknown' };
  }
  if (result.status === 'appended') {
    journal.remove();
    reservation.remove();
    const saved = { event, sequence: result.sequence };
    return changeReceipt(saved, [...rows, saved], audience, options.keyDirectory);
  }
  const reconciled = await commandHistory(options, scopeId, requester, input.commandId,
    Math.min(fresh.deadline, performance.now() + 100), rows, entry.principalKind);
  if (reconciled.original) {
    return originalReceipt(reconciled.original, reconciled.rows, input, memoryId,
      options.keyDirectory!, audience, previous.dependsOn);
  }
  const failed = { ...entry, stage: 'failed' as const };
  journal.save(failed);
  reservation.save(failed);
  throw new MemoryConflict();
}
