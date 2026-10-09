import { readdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { authorityFence, history, readActiveMember } from '@opencrane/models';
import { memoryKeys, memoryIdentity } from '@opencrane/projections';
import { memoryTextSchema, memoryWrittenDataSchema, memoryWrittenEventSchema,
  } from '@opencrane/events';
import type { StoredEvent } from '@opencrane/event-store';
import { memoryAccessChecks, scopeAccess, MemoryRefused, type MemoryOptions,
  type Scope } from './access.ts';
import { MemoryConflict, memorySnapshot } from './reads.ts';
import { checkSources } from './sources.ts';
import { commandJournal } from './journal.ts';

const fields = memoryWrittenDataSchema.pick({ kind: true, pinned: true, expiresAt: true,
  sources: true, dependsOn: true });
const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/u);
const commandInput = fields.extend({ commandId: identifier, text: memoryTextSchema });
export const changeParams = z.strictObject({ scopeId: z.string().regex(/^[a-f0-9]{64}$/u),
  commandId: identifier });
type Input = z.infer<typeof commandInput>;

function commandReference(silo: string, scopeId: string, requester: string, commandId: string) {
  const hash = createHash('sha256');
  hash.update(JSON.stringify([silo, 'human', requester, scopeId, commandId]));
  return hash.digest('hex');
}
async function commandHistory(options: MemoryOptions, scopeId: string,
  requester: string, commandId: string) {
  const rows = await history(options.store, `scope-${scopeId}`, options.silo,
    performance.now() + 10_000);
  function matches(row: StoredEvent) {
    return row.event.commandId === commandId && row.event.principal?.kind === 'human' &&
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
  audience: { kind: string; ownerId: string }) {
  const receipt = savedReceipt(row, audience);
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
  const seen = new Set<string>();
  for (const dependency of input.dependsOn) {
    const reference = JSON.stringify(dependency);
    if (dependency.scopeId !== scope.scopeId || seen.has(reference)) {
      throw new MemoryConflict();
    }
    seen.add(reference);
    let latest: ReturnType<typeof memoryWrittenEventSchema.parse> | undefined;
    for (const row of rows) {
      const saved = memoryWrittenEventSchema.parse(row.event);
      if (saved.data.memoryId === dependency.memoryId) latest = saved;
    }
    if (!latest || !('schemaVersion' in latest.data) ||
        latest.data.revision !== dependency.revision) throw new MemoryConflict();
    const identity = { silo, ...scope, memoryId: dependency.memoryId, revision: dependency.revision };
    if (keys.decrypt(identity, latest.data) === null ||
        (latest.data.expiresAt !== null && Date.parse(latest.data.expiresAt) <= Date.now())) {
      throw new MemoryConflict();
    }
  }
}

export async function remember(options: MemoryOptions, requester: string, scope: Scope, raw: unknown) {
  const parsed = commandInput.parse(raw);
  if (Buffer.byteLength(JSON.stringify(raw)) > 16384 ||
      (parsed.kind === 'preference' && scope.scopeKind !== 'person')) {
    throw new z.ZodError([]);
  }
  const input = { ...parsed, sources: statementSources(parsed, requester) };
  if (!options.keyDirectory || !options.db.lock) {
    throw new Error('Memory custody unavailable');
  }
  const reference = commandReference(options.silo, scope.scopeId, requester, input.commandId);
  async function execute() {
    return rememberLocked(options, requester, scope, input, reference);
  }
  // Serialise one command across server processes before preparing or deleting its key.
  return options.db.lock(`memory-command:${reference}`, execute);
}
async function rememberLocked(options: MemoryOptions, requester: string, scope: Scope,
  input: Input, reference: string) {
  const keys = memoryKeys(options.keyDirectory!);
  const identity = { silo: options.silo, ...scope, memoryId: reference, revision: 1 };
  const journal = commandJournal(options.keyDirectory!, reference);
  const state = await commandHistory(options, scope.scopeId, requester, input.commandId);
  if (!state.original) {
    if (input.expiresAt !== null && Date.parse(input.expiresAt) <= Date.now()) {
      throw new z.ZodError([]);
    }
    await checkSources(options, requester, scope, input.sources, input.commandId);
    checkDependencies(state.rows, scope, input, keys, options.silo);
  }
  // Read content first. Watch only streams that decide permission during the two-second check.
  const fresh = await authorityFence(options.store, performance.now(), [`member-${requester}`]);
  const checks = memoryAccessChecks(options, requester, fresh);
  await readActiveMember(options.store, options.binding, requester, 'member', checks.applied);
  const access = await scopeAccess(options, requester, scope, false, checks, true);
  if (!access.canWrite) {
    throw new MemoryRefused();
  }
  if (state.original) {
    return originalReceipt(state.original, keys, input, access.audience);
  }
  const inputDigest = digest(input);
  const pending = journal.read();
  if (pending && pending.inputDigest !== inputDigest) {
    throw new MemoryConflict();
  }
  if (pending?.stage === 'unknown') {
    return { outcome: 'unknown', memoryId: reference };
  }
  if (pending) {
    keys.delete(identity);
    return { outcome: 'failed', memoryId: reference };
  }
  const entry = { identity, requester, commandId: input.commandId, inputDigest,
    stage: 'prepared' as const };
  return appendPrepared(options, input, entry, state.rows, fresh, access.audience);
}
async function appendPrepared(options: MemoryOptions, input: Input,
  entry: NonNullable<ReturnType<ReturnType<typeof commandJournal>['read']>>,
  rows: StoredEvent[], fresh: Awaited<ReturnType<typeof authorityFence>>,
  audience: { kind: string; ownerId: string }) {
  const { identity, requester } = entry;
  const reference = identity.memoryId;
  const scope = { scopeId: identity.scopeId, scopeKind: identity.scopeKind, ownerId: identity.ownerId };
  const keys = memoryKeys(options.keyDirectory!);
  const journal = commandJournal(options.keyDirectory!, reference);
  journal.save(entry);
  try {
    keys.provision(identity);
    const encrypted = keys.encrypt(identity, input.text);
    const data = { schemaVersion: 1, ...scope, memoryId: reference, revision: 1,
      kind: input.kind, pinned: input.pinned, expiresAt: input.expiresAt,
      sources: input.sources, dependsOn: input.dependsOn, ...encrypted };
    const event = memoryWrittenEventSchema.parse({ id: reference, commandId: input.commandId,
      silo: options.silo, subject: `scope-${scope.scopeId}`, type: 'memory.written',
      source: 'opencrane-server', time: new Date().toISOString(),
      principal: { kind: 'human', id: requester }, correlation: {}, data });
    await fresh();
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
      return savedReceipt({ event, sequence: result.sequence }, audience);
    }
    // Check the original command again before destroying any key after a definite refusal.
    const reconciled = await commandHistory(options, scope.scopeId, requester, input.commandId);
    if (reconciled.original) {
      return originalReceipt(reconciled.original, keys, input, audience);
    }
    journal.save({ ...entry, stage: 'failed' });
    keys.delete(identity);
    return { outcome: 'conflict', memoryId: reference };
  } catch (error) {
    if (journal.read()?.stage === 'prepared') {
      journal.save({ ...entry, stage: 'failed' });
      keys.delete(identity);
    }
    throw error;
  }
}
export async function readCommand(options: MemoryOptions, requester: string, scope: Scope,
  commandId: string, audience: { kind: string; ownerId: string }) {
  await memorySnapshot(options, scope);
  const state = await commandHistory(options, scope.scopeId, requester, commandId);
  if (!state.original) {
    return { outcome: 'unknown' };
  }
  if (!options.keyDirectory) {
    throw new Error('Memory custody unavailable');
  }
  const keys = memoryKeys(options.keyDirectory);
  const memoryId = commandReference(options.silo, scope.scopeId, requester, commandId);
  if (originalInput(state.original, keys) === null) {
    return { outcome: 'unavailable', memoryId };
  }
  return savedReceipt(state.original, audience);
}

export async function reconcileCommands(options: MemoryOptions) {
  if (!options.keyDirectory || !options.db.lock) return;
  const directory = options.keyDirectory;
  const keys = memoryKeys(directory);
  for (const name of readdirSync(directory)) {
    const match = /^command-([a-f0-9]{64})\.json(?:-pending)?$/u.exec(name);
    if (!match) {
      continue;
    }
    const reference = match[1]!;
    async function reconcile() {
      const journal = commandJournal(directory, reference);
      const entry = journal.read();
      if (!entry) {
        // Remove an interrupted journal write. Key provision starts only after its rename.
        rmSync(`${directory}/${name}`, { force: true });
        return;
      }
      if (entry.identity.silo !== options.silo || entry.stage === 'unknown') return;
      const expected = commandReference(options.silo, entry.identity.scopeId,
        entry.requester, entry.commandId);
      if (reference !== expected || entry.identity.memoryId !== reference) {
        throw new Error('Invalid memory command record');
      }
      const state = await commandHistory(options, entry.identity.scopeId,
        entry.requester, entry.commandId);
      if (state.original) return;
      journal.save({ ...entry, stage: 'failed' });
      keys.delete(entry.identity);
    }
    await options.db.lock(`memory-command:${reference}`, reconcile);
  }
}
