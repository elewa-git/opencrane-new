import { grantStream } from '@opencrane/authz';
import { losslessJson } from '@opencrane/events/lossless-json';
import { rememberTool } from '../src/memory/mcp.ts';
import { readAgentChange } from '../src/memory/forget.ts';
import { memoryWrittenEventSchema } from '@opencrane/events';
import { history } from '@opencrane/models';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { recallBackend, scopeId, threadId } from './support/recall-backend.ts';

function createMockOptions() {
  return { spy: true };
}
const mockOptions = vi.hoisted(createMockOptions);
vi.mock('node:net', mockOptions);
async function filesystem() {
  const original = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...original };
}
vi.mock('node:fs', filesystem);
async function processes() {
  const original = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...original };
}
vi.mock('node:child_process', processes);

const text = 'My walking destination is the summer garden.';
const content = z.object({ recallProof: z.string() });
const result = z.object({ structuredContent: content });
const recalled = z.object({ result });
async function rememberInput(test: Awaited<ReturnType<typeof recallBackend>>, thread = threadId) {
  const query = { scopeId, query: 'garden' };
  const response = await test.native.recall(thread, query);
  const recallProof = recalled.parse(response).result.structuredContent.recallProof;
  const reference = { scopeId, memoryId: 'garden', revision: 1 };
  return { scopeId, commandId: 'native-remember', text, kind: 'fact', pinned: false,
    expiresAt: null, sources: [], dependsOn: [reference], recallProof };
}

async function savesRememberReceipt() {
  const test = await recallBackend(true);
  await test.start();
  expect(test.wire.paths).toEqual([]);
  const args = await rememberInput(test);
  const response = await test.native.call(threadId, 'remember', args);
  const rows = await history(test.setup.nats.store, `scope-${scopeId}`, 'test');
  function matches(row: typeof rows[number]) {
    return row.event.commandId === args.commandId;
  }
  const writes = rows.filter(matches);
  expect(writes).toHaveLength(1);
  const saved = memoryWrittenEventSchema.parse(writes[0]!.event);
  expect(saved.principal).toEqual({ kind: 'agent', id: 'alice' });
  const receipt = { outcome: 'saved', changeId: saved.id, memoryId: saved.data.memoryId,
    revision: 1, scopeId, audience: { kind: 'person', ownerId: 'alice' }, savedAt: saved.time };
  expect(response).toEqual({ jsonrpc: '2.0', id: 1,
    result: { content: [], structuredContent: receipt } });
  expect(saved.data).toMatchObject({ dependsOn: args.dependsOn, ownerId: 'alice' });
  await test.setup.runner.run(test.projection);
  const query = { scopeId, query: 'summer' };
  const found = await test.native.recall(threadId, query);
  expect(JSON.stringify(found)).toContain(text);
  expect(JSON.stringify(rows)).not.toContain(text);
}
it('saves one own-person revision and returns the real Remember receipt on its native thread',
  savesRememberReceipt, 120_000);

async function lostRememberReply() {
  const test = await recallBackend(true);
  await test.start();
  const args = await rememberInput(test);
  const append = test.setup.nats.store.append.bind(test.setup.nats.store);
  let attempts = 0;
  async function loseReply(command: Parameters<typeof append>[0]) {
    const saved = await append(command);
    if (memoryWrittenEventSchema.safeParse(command.event).success) {
      attempts += 1;
      expect(saved.status).toBe('appended');
      return { status: 'unavailable' as const, cause: new Error('Reply lost') };
    }
    return saved;
  }
  vi.spyOn(test.setup.nats.store, 'append').mockImplementation(loseReply);
  const response = await test.native.call(threadId, 'remember', args);
  expect(response).toMatchObject({ result: { structuredContent: { outcome: 'unknown' } } });
  const scope = { scopeId, scopeKind: 'person' as const, ownerId: 'alice' };
  const status = await readAgentChange(test.memory, 'alice', scope, args.commandId);
  expect(status).toMatchObject({ outcome: 'saved', revision: 1, scopeId });
  expect(await readAgentChange(test.memory, 'alice', scope, args.commandId)).toEqual(status);
  expect(attempts).toBe(1);
  expect(JSON.stringify(status)).not.toContain(text);
}
it('reads original Remember status after an uncertain append without resubmitting',
  lostRememberReply, 120_000);

const refusals = ['qualification', 'ask', 'block', 'removal', 'grant', 'scope',
  'ended', 'lineage', 'replacement'] as const;
async function refusesRemember(reason: typeof refusals[number]) {
  const test = await recallBackend(true);
  await test.start();
  const args = await rememberInput(test);
  if (reason === 'qualification') {
    test.deployment.remove();
  }
  if (reason === 'ended') {
    test.native.callers.remove(test.turnId);
  }
  if (reason === 'scope') {
    args.scopeId = 'f'.repeat(64);
  }
  if (reason === 'lineage') {
    args.dependsOn = [];
  }
  if (reason === 'removal') {
    const data = { memberId: 'alice', removedBy: 'alice' };
    await test.setup.append('member-alice', 'member.removed', data);
  }
  if (reason === 'grant') {
    const data = { resourceType: 'memory_write', resourceId: scopeId,
      granteeKind: 'assistant', granteeId: 'assistant', revokedBy: 'alice' };
    await test.setup.append(grantStream('memory_write', scopeId), 'grant.revoked', data);
  }
  if (reason === 'replacement') {
    const data = { assistantId: 'assistant', computerId: 'computer',
      generation: 2, podUid: 'replacement' };
    await test.setup.append('computer-assistant', 'computer.ready', data);
  }
  if (reason === 'ask' || reason === 'block') {
    const definition = JSON.stringify(rememberTool);
    const data = { serverId: 'memory', connectionId: 'server', toolName: 'remember',
      toolRevision: losslessJson(definition).digest, mode: reason, setBy: 'alice' };
    await test.setup.append('mcp-memory', 'mcp.tool_mode_set', data);
  }
  const response = await test.native.call(threadId, 'remember', args);
  expect(response).not.toHaveProperty('result.structuredContent');
  const rows = await history(test.setup.nats.store, `scope-${scopeId}`, 'test');
  expect(rows).toHaveLength(1);
  expect(JSON.stringify(response)).not.toContain(text);
}
it.each(refusals)('releases no Remember result after %s', refusesRemember, 120_000);

async function withdrawsBeforeRelease(reason: 'qualification' | 'reference') {
  const test = await recallBackend(true);
  await test.start();
  const args = await rememberInput(test);
  const append = test.setup.nats.store.append.bind(test.setup.nats.store);
  async function withdraw(command: Parameters<typeof append>[0]) {
    const saved = await append(command);
    if (memoryWrittenEventSchema.safeParse(command.event).success) {
      if (reason === 'qualification') {
        test.deployment.remove();
      } else {
        const data = { schemaVersion: 1, scopeId, scopeKind: 'person', ownerId: 'alice',
          memoryId: 'garden', expectedRevision: 1, revision: 2 };
        await test.setup.append(`scope-${scopeId}`, 'memory.forgotten', data);
      }
    }
    return saved;
  }
  vi.spyOn(test.setup.nats.store, 'append').mockImplementation(withdraw);
  const response = await test.native.call(threadId, 'remember', args);
  expect(response).not.toHaveProperty('result.structuredContent');
  const scope = { scopeId, scopeKind: 'person' as const, ownerId: 'alice' };
  const status = await readAgentChange(test.memory, 'alice', scope, args.commandId);
  expect(status).toMatchObject({ outcome: 'saved' });
}
it.each(['qualification', 'reference'] as const)(
  'withholds the Remember receipt if %s changes while saving', withdrawsBeforeRelease, 120_000);

async function isolatesRememberSessions() {
  const test = await recallBackend(true);
  await test.start();
  const first = await rememberInput(test);
  const otherThread = 'returned-native-2';
  const other = await test.admit('other-chat', otherThread);
  await other.start();
  expect(test.native.mcp.size).toBe(2);
  const second = await rememberInput(test, otherThread);
  test.native.callers.remove(test.turnId);
  expect(test.native.mcp.size).toBe(1);
  const ended = await test.native.call(threadId, 'remember', first);
  expect(ended).not.toHaveProperty('result.structuredContent');
  const foreignProof = await test.native.call(otherThread, 'remember', first);
  expect(foreignProof).not.toHaveProperty('result.structuredContent');
  const saved = await test.native.call(otherThread, 'remember', second);
  expect(saved).toMatchObject({ result: { structuredContent: { outcome: 'saved', revision: 1 } } });
}
it('keeps Remember catalogues and proofs separate in two sessions for the same person',
  isolatesRememberSessions, 120_000);

async function refusesUnqualifiedStart() {
  const test = await recallBackend(true);
  test.deployment.remove();
  await expect(test.start()).rejects.toThrow();
  expect(test.native.received).not.toContain('turn/start');
  expect(test.native.mcp.size).toBe(0);
  expect(test.wire.paths).toEqual([]);
}
it('releases no initial input or write call without deployment qualification',
  refusesUnqualifiedStart, 120_000);
