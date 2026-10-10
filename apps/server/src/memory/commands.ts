import { rmSync } from 'node:fs';
import { opendir } from 'node:fs/promises';
import { setImmediate } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { authorityFence, MemoryPersonScopeOnly, memoryReferences,
  readActiveMember } from '@opencrane/models';
import { memoryKeys, memoryIdentity } from '@opencrane/projections';
import { memoryTextSchema, memoryWrittenDataSchema, memoryWrittenEventSchema,
  } from '@opencrane/events';
import type { StoredEvent } from '@opencrane/event-store';
import { memoryAccessChecks, scopeAccess, MemoryRefused, type MemoryOptions,
  type Scope } from './access.ts';
import { bindingReceipt } from './maintenance.ts';
import { MemoryConflict, memorySnapshot } from './reads.ts';
import { checkSources } from './sources.ts';
import { commandJournal } from './journal.ts';
import { acquireMemoryWrite } from './admission.ts';

const fields = memoryWrittenDataSchema.pick({ kind: true, pinned: true, expiresAt: true,
  sources: true, dependsOn: true });
const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/u);
const commandInput = fields.extend({ commandId: identifier, text: memoryTextSchema });
export const changeParams = z.strictObject({ scopeId: z.string().regex(/^[a-f0-9]{64}$/u),
  commandId: identifier });
type Input = z.infer<typeof commandInput>;
type PrincipalKind = 'human' | 'agent';
type AgentWrite = { deadline: number; conversation: string; turn: string; requestId: string;
  confirm: () => Promise<unknown> };

function commandReference(silo: string, scopeId: string, requester: string, commandId: string,
  principalKind: PrincipalKind = 'human') {
  const hash = createHash('sha256');
  hash.update(JSON.stringify([silo, principalKind, requester, scopeId, commandId]));
  return hash.digest('hex');
}
async function commandHistory(options: MemoryOptions, scopeId: string,
  requester: string, commandId: string, deadline = performance.now() + 10_000,
  knownRows: StoredEvent[] = [], principalKind: PrincipalKind = 'human') {
  const rows = [...knownRows];
  const fromSequence = (rows.at(-1)?.sequence ?? 0) + 1;
  for await (const row of options.store.readStream(`scope-${scopeId}`, fromSequence, deadline)) {
    if (row.event.silo !== options.silo) {
      throw new Error('Wrong silo');
    }
    rows.push(row);
  }
  function matches(row: StoredEvent) {
    return row.event.commandId === commandId && row.event.principal?.kind === principalKind &&
      row.event.principal.id === requester;
  }
  return { rows, original: rows.find(matches) };
}
function savedReceipt(row: StoredEvent, audience: { kind: string; ownerId: string }) {
  const saved = memoryWrittenEventSchema.parse(row.event);
  if (!('schemaVersion' in saved.data)) {
    throw new MemoryRefused();
  }
  return { outcome: 'saved', changeId: saved.id, memoryId: saved.data.memoryId,
    revision: saved.data.revision, scopeId: saved.data.scopeId, audience, savedAt: saved.time };
}
function originalInput(row: StoredEvent, keys: ReturnType<typeof memoryKeys>) {
  const saved = memoryWrittenEventSchema.parse(row.event);
  if (!('schemaVersion' in saved.data)) {
    throw new MemoryConflict();
  }
  const identity = memoryIdentity(saved);
  if (identity === null) {
    return null;
  }
  const text = keys.decrypt(identity, saved.data);
  if (text === null) {
    return null;
  }
  return { commandId: saved.commandId, text, kind: saved.data.kind, pinned: saved.data.pinned,
    expiresAt: saved.data.expiresAt, sources: saved.data.sources, dependsOn: saved.data.dependsOn };
}
function originalReceipt(row: StoredEvent, keys: ReturnType<typeof memoryKeys>, input: Input,
  rows: StoredEvent[], audience: { kind: string; ownerId: string }) {
  if (row.event.type !== 'memory.written') {
    throw new MemoryConflict();
  }
  const receipt = savedReceipt(row, audience);
  const references = memoryReferences(rows, row.event.silo, receipt.scopeId, keys);
  const contentStatus = references.current(receipt);
  if (contentStatus !== 'current') {
    return { ...receipt, contentStatus };
  }
  const original = originalInput(row, keys);
  if (original === null) {
    return { outcome: 'unavailable', memoryId: receipt.memoryId };
  }
  if (digest(commandInput.parse(original)) !== digest(input)) {
    throw new MemoryConflict();
  }
  return receipt;
}
function digest(input: Input) {
  const hash = createHash('sha256');
  hash.update(JSON.stringify(input));
  return hash.digest('hex');
}
function statementSources(input: Input, requester: string) {
  if (input.sources.length > 0) {
    return input.sources;
  }
  return [{ memberId: requester, commandId: input.commandId }];
}
function checkDependencies(rows: StoredEvent[], scope: Scope, input: Input,
  keys: ReturnType<typeof memoryKeys>, silo: string) {
  if (input.dependsOn.length === 0) {
    return;
  }
  const references = memoryReferences(rows, silo, scope.scopeId, keys);
  const seen = new Set<string>();
  for (const dependency of input.dependsOn) {
    const reference = JSON.stringify(dependency);
    if (seen.has(reference) || references.current(dependency) !== 'current') {
      throw new MemoryConflict();
    }
    seen.add(reference);
  }
}

function requireAgentPersonScope(scope: Scope, requester: string) {
  if (scope.scopeKind !== 'person' || scope.ownerId !== requester) {
    throw new MemoryPersonScopeOnly();
  }
}

export async function remember(options: MemoryOptions, requester: string, scope: Scope,
  raw: unknown, agent?: AgentWrite) {
  let principalKind: PrincipalKind = 'human';
  if (agent) {
    requireAgentPersonScope(scope, requester);
    principalKind = 'agent';
  }
  // Check write permission before inspecting private content or reserving a database client.
  const initialAccess = await scopeAccess(options, requester, scope, false, undefined, true);
  if (!initialAccess.canWrite) {
    throw new MemoryRefused();
  }
  const parsed = commandInput.parse(raw);
  if (Buffer.byteLength(JSON.stringify(raw)) > 16384 ||
      (parsed.kind === 'preference' && scope.scopeKind !== 'person')) {
    throw new z.ZodError([]);
  }
  let sources = parsed.sources;
  if (!agent) sources = statementSources(parsed, requester);
  const input = { ...parsed, sources };
  if (!options.keyDirectory || !options.db.lock) {
    throw new Error('Memory custody unavailable');
  }
  const reference = commandReference(options.silo, scope.scopeId, requester, input.commandId,
    principalKind);
  const state = await commandHistory(options, scope.scopeId, requester, input.commandId,
    performance.now() + 10_000, [], principalKind);
  if (!state.original) {
    if (input.expiresAt !== null && Date.parse(input.expiresAt) <= Date.now()) {
      throw new z.ZodError([]);
    }
    await checkSources(options, requester, scope, input.sources, input.commandId);
    const keys = memoryKeys(options.keyDirectory);
    checkDependencies(state.rows, scope, input, keys, options.silo);
  }
  // Finish permission history and OpenFGA checks before taking a database connection.
  const fresh = await authorityFence(options.store, performance.now(), [`member-${requester}`],
    agent?.deadline);
  const checks = memoryAccessChecks(options, requester, fresh);
  await readActiveMember(options.store, options.binding, requester, 'member', checks.applied);
  const access = await scopeAccess(options, requester, scope, false, checks, true);
  if (!access.canWrite) {
    throw new MemoryRefused();
  }
  await fresh();
  async function execute() {
    return rememberLocked(options, requester, scope, input, reference, state.rows,
      fresh, access.audience, principalKind, agent);
  }
  // Finish permission checks before waiting for a write slot or taking a database client.
  const release = await acquireMemoryWrite(options.silo, requester, scope.scopeId);
  try {
    await fresh();
    return await options.db.lock(`memory-command:${reference}`, execute, { timeoutMs: 100 });
  } finally {
    release();
  }
}
async function rememberLocked(options: MemoryOptions, requester: string, scope: Scope,
  input: Input, reference: string, rows: StoredEvent[],
  fresh: Awaited<ReturnType<typeof authorityFence>>, audience: { kind: string; ownerId: string },
  principalKind: PrincipalKind, agent?: AgentWrite) {
  const keys = memoryKeys(options.keyDirectory!);
  const identity = { silo: options.silo, ...scope, memoryId: reference, revision: 1 };
  const journal = commandJournal(options.keyDirectory!, reference);
  // Read only changes since the earlier history, and release the database client promptly
  // if NATS is slow. Full scope replay must not occupy the shared connection pool.
  const state = await commandHistory(options, scope.scopeId, requester, input.commandId,
    performance.now() + 100, rows, principalKind);
  if (state.original) {
    journal.remove();
    return originalReceipt(state.original, keys, input, state.rows, audience);
  }
  const { text: _text, ...metadata } = input;
  const hash = createHash('sha256');
  // Leave text out so a forgotten fact cannot be guessed from a saved fingerprint.
  hash.update(JSON.stringify(metadata));
  const inputDigest = hash.digest('hex');
  const pending = journal.read();
  if (pending && pending.inputDigest !== inputDigest) {
    throw new MemoryConflict();
  }
  if (pending) {
    if (!definiteFailure(pending, state.rows)) {
      return { outcome: 'unknown', memoryId: reference };
    }
    keys.delete(identity);
    journal.remove();
    return { outcome: 'failed', memoryId: reference };
  }
  if (keys.status(identity) === 'destroyed') {
    return { outcome: 'failed', memoryId: reference };
  }
  const entry = { identity, requester, principalKind, commandId: input.commandId, inputDigest,
    appendUntil: Date.now() + Math.max(0, fresh.deadline - performance.now()),
    expectedSequence: rows.at(-1)?.sequence ?? 0,
    stage: 'prepared' as const };
  return appendPrepared(options, input, entry, rows, fresh, audience, agent);
}
async function appendPrepared(options: MemoryOptions, input: Input,
  entry: NonNullable<ReturnType<ReturnType<typeof commandJournal>['read']>>,
  rows: StoredEvent[], fresh: Awaited<ReturnType<typeof authorityFence>>,
  audience: { kind: string; ownerId: string }, agent?: AgentWrite) {
  const { identity, requester, principalKind } = entry;
  const reference = identity.memoryId;
  const scope = { scopeId: identity.scopeId, scopeKind: identity.scopeKind, ownerId: identity.ownerId };
  const keys = memoryKeys(options.keyDirectory!);
  const journal = commandJournal(options.keyDirectory!, reference);
  const encryptedSize = Buffer.byteLength(input.text) + 28;
  const placeholder = { ciphertext: Buffer.alloc(encryptedSize).toString('base64'),
    keyId: `key:${'0'.repeat(64)}` };
  // Check the full event with an encrypted value of the same size before creating a key.
  const data = { schemaVersion: 1, ...scope, memoryId: reference, revision: 1,
    kind: input.kind, pinned: input.pinned, expiresAt: input.expiresAt,
    sources: input.sources, dependsOn: input.dependsOn, ...placeholder };
  let correlation = {};
  if (agent) {
    correlation = { conversation: agent.conversation, turn: agent.turn, request: agent.requestId };
  }
  const event = memoryWrittenEventSchema.parse({ id: reference, commandId: input.commandId,
      silo: options.silo, subject: `scope-${scope.scopeId}`, type: 'memory.written',
      source: 'opencrane-server', time: new Date().toISOString(),
      principal: { kind: principalKind, id: requester }, correlation, data });
  journal.save(entry);
  try {
    keys.provision(identity);
    const encrypted = keys.encrypt(identity, input.text);
    event.data = { ...data, ...encrypted };
    checkDependencies(rows, scope, input, keys, options.silo);
    await fresh();
    // Recheck the original deadline, live turn and watched grants just before saving.
    if (agent) await agent.confirm();
    journal.save({ ...entry, stage: 'unknown' });
    const command = { event, expectedSequence: rows.at(-1)?.sequence ?? 0,
      historyChecked: true as const, deadline: fresh.deadline };
    let result;
    try {
      result = await options.store.append(command);
    } catch {
      return { outcome: 'unknown', memoryId: reference };
    }
    if (result.status === 'unavailable') {
      return { outcome: 'unknown', memoryId: reference };
    }
    if (result.status === 'appended') {
      journal.remove();
      return savedReceipt({ event, sequence: result.sequence }, audience);
    }
    // Check the original command again before destroying any key after a definite refusal.
    const readDeadline = Math.min(fresh.deadline, performance.now() + 100);
    const reconciled = await commandHistory(options, scope.scopeId, requester, input.commandId,
      readDeadline, rows, principalKind);
    if (reconciled.original) {
      journal.remove();
      return originalReceipt(reconciled.original, keys, input, reconciled.rows, audience);
    }
    keys.delete(identity);
    journal.remove();
    return { outcome: 'conflict', memoryId: reference };
  } catch (error) {
    if (journal.read()?.stage === 'prepared') {
      keys.delete(identity);
      journal.remove();
    }
    throw error;
  }
}
export async function readCommand(options: MemoryOptions, requester: string, scope: Scope,
  commandId: string, audience: { kind: string; ownerId: string }) {
  await memorySnapshot(options, scope);
  const state = await commandHistory(options, scope.scopeId, requester, commandId);
  if (state.original?.event.type === 'memory.maintenance_bound') {
    return bindingReceipt(state.original);
  }
  if (!options.keyDirectory) {
    throw new Error('Memory custody unavailable');
  }
  const keys = memoryKeys(options.keyDirectory);
  const memoryId = commandReference(options.silo, scope.scopeId, requester, commandId);
  const identity = { silo: options.silo, ...scope, memoryId, revision: 1 };
  const journal = commandJournal(options.keyDirectory, memoryId);
  if (!state.original) {
    const entry = journal.read();
    if (entry && (entry.stage !== 'unknown' || Date.now() > entry.appendUntil) && options.db.lock) {
      await reconcileCommand(options, memoryId);
    }
    if (keys.status(identity) === 'destroyed') {
      return { outcome: 'failed', memoryId };
    }
    return { outcome: 'unknown' };
  }
  journal.remove();
  const receipt = savedReceipt(state.original, audience);
  const references = memoryReferences(state.rows, options.silo, scope.scopeId, keys);
  const contentStatus = references.current(receipt);
  if (contentStatus !== 'current') {
    return { ...receipt, contentStatus };
  }
  return receipt;
}

type JournalEntry = NonNullable<ReturnType<ReturnType<typeof commandJournal>['read']>>;

function definiteFailure(entry: JournalEntry, rows: StoredEvent[]) {
  if (entry.stage !== 'unknown') {
    return true;
  }
  if (Date.now() <= entry.appendUntil || entry.expectedSequence === undefined) {
    return false;
  }
  // Keep the key until another scope event makes the delayed conditional append impossible.
  // Treat older records without an expected position as unknown, however long they wait.
  const latestSequence = rows.at(-1)?.sequence ?? 0;
  return latestSequence > entry.expectedSequence;
}

async function reconcileCommand(options: MemoryOptions, reference: string) {
  const journal = commandJournal(options.keyDirectory!, reference);
  const entry = journal.read();
  if (!entry) {
    function removeOrphan() {
      if (journal.read() === null) {
        rmSync(`${options.keyDirectory!}/command-${reference}.json-pending`, { force: true });
      }
      return Promise.resolve();
    }
    await options.db.lock!(`memory-command:${reference}`, removeOrphan, { timeoutMs: 100 });
    return;
  }
  if (entry.identity.silo !== options.silo) {
    return;
  }
  const expected = commandReference(options.silo, entry.identity.scopeId,
    entry.requester, entry.commandId, entry.principalKind);
  if (reference !== expected || entry.identity.memoryId !== reference) {
    throw new Error('Invalid memory command record');
  }
  if (entry.stage === 'unknown' && Date.now() <= entry.appendUntil) {
    return;
  }
  const state = await commandHistory(options, entry.identity.scopeId,
    entry.requester, entry.commandId, performance.now() + 1000, [], entry.principalKind);
  function finishRecovery() {
    const current = journal.read();
    // Ignore a read taken while another server was changing this command's record.
    if (current === null || JSON.stringify(current) !== JSON.stringify(entry)) {
      return Promise.resolve();
    }
    if (!state.original) {
      if (!definiteFailure(current, state.rows)) {
        return Promise.resolve();
      }
      memoryKeys(options.keyDirectory!).delete(current.identity);
    }
    journal.remove();
    return Promise.resolve();
  }
  await options.db.lock!(`memory-command:${reference}`, finishRecovery, { timeoutMs: 100 });
}

export async function reconcileCommands(options: MemoryOptions) {
  if (!options.keyDirectory || !options.db.lock) {
    return;
  }
  const directory = await opendir(options.keyDirectory);
  let processed = 0;
  for await (const file of directory) {
    const match = /^command-([a-f0-9]{64})\.json(?:-pending)?$/u.exec(file.name);
    if (!match) {
      continue;
    }
    const reference = match[1]!;
    try {
      await reconcileCommand(options, reference);
    } catch {
      // Keep the record for a later check. One damaged file or outage must not stop startup.
    }
    if (++processed % 16 === 0) {
      await setImmediate();
    }
  }
}
