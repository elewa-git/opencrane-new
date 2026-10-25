import { setTimeout as delay } from 'node:timers/promises';
import { jetstreamManager } from '@nats-io/jetstream';
import type { AppendCommand } from '@opencrane/event-store';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createStore, memberAuthorisation } from '@opencrane/authz';
import { databases, openfga } from '@opencrane/authz/testing';
import { natsFixture } from '@opencrane/event-store/testing';
import { companyOptInSetDataSchema } from '@opencrane/events';
import { catalogueDigest } from '@opencrane/events/mcp-catalogue';
import { pgDb } from '@opencrane/projections';
import { MemberAccessRefused } from '../src/member-authority.ts';
import { connectionServer } from '../src/connection-server.ts';
import { changeConnectionSelection, readConnectionSelection } from '../src/connection-selection.ts';
import { mcpPolicy, parseMcpCall } from '../src/mcp.ts';
import { envelope, history } from '../src/actor.ts';
import { changeCompanyOptIn, foldCompanyOptIn } from '../src/company-opt-in.ts';

let nats: Awaited<ReturnType<typeof natsFixture>>;
let fga: Awaited<ReturnType<typeof openfga>>;
let storage: Awaited<ReturnType<typeof databases>>;
let binding: Awaited<ReturnType<typeof createStore>>;
let counter = 0;
const canary = 'company-material-canary';
async function initialise() {
  nats = await natsFixture();
  fga = await openfga();
  storage = await databases();
  binding = await createStore(fga.apiUrl, 'test');
}
async function close() {
  await storage?.close();
  await fga?.close();
  await nats?.close();
}
beforeAll(initialise, 120_000);
afterAll(close);
async function fixture(role = 'admin') {
  counter += 1;
  const userId = `person${counter}`;
  const serverId = `server${counter}`;
  const subject = `connection-company-${serverId}`;
  const joined = envelope('test', `member-${userId}`, 'member.joined', {
    memberId: userId, role, email: `${userId}@example.test`, displayName: canary,
  });
  await nats.seed([joined]);
  const auth = memberAuthorisation(binding);
  await auth.handler.handle(joined, pgDb(storage.queue));
  const registration = envelope('test', `mcp-${serverId}`, 'mcp.server_registered', {
    serverId, kind: 'remote', locator: 'https://example.test/mcp', registeredBy: userId,
  });
  await nats.seed([registration]);
  const registrationRevision = await nats.store.head(`mcp-${serverId}`);
  const checkedAt = Date.now();
  const discovery = envelope('test', `mcp-${serverId}`, 'mcp.server_discovered', {
    serverId, connectionId: 'installed', accountMode: 'company', tools: [], toolCount: 0,
    schemaDigest: catalogueDigest([]), checkedAt: new Date(checkedAt).toISOString(),
    expiresAt: new Date(checkedAt + 300_000).toISOString(),
  });
  await nats.seed([discovery]);
  const installation = { silo: 'test', serverId, connectionId: 'installed', registrationRevision };
  const input = { serverId, connectionId: 'installed', registrationRevision,
    enabled: true, expectedSequence: 0, changeRef: 'enable' };
  async function change(raw: unknown = input) {
    return changeCompanyOptIn(nats.store, binding, userId, raw);
  }
  async function rows() {
    return history(nats.store, subject, 'test');
  }
  return { userId, subject, input, installation, registration, discovery, change, rows };
}
async function explicitOptIn() {
  const test = await fixture();
  expect(foldCompanyOptIn([], test.installation)).toEqual({ enabled: false, sequence: 0 });
  const before = await nats.store.head();
  const saved = await test.change();
  expect(saved).toEqual({ enabled: true, sequence: before + 1, changeRef: 'enable' });
  expect(foldCompanyOptIn(await test.rows(), test.installation)).toEqual({
    enabled: true, sequence: saved.sequence,
  });
  const disabled = await test.change({ ...test.input, enabled: false,
    expectedSequence: saved.sequence, changeRef: 'disable' });
  expect(foldCompanyOptIn(await test.rows(), test.installation)).toEqual({
    enabled: false, sequence: disabled.sequence,
  });
  expect(await nats.store.head()).toBe(before + 2);
}
it('records explicit admin opt-in and removal, granting nothing', explicitOptIn);

async function refusedInput(patch: Record<string, unknown>) {
  const test = await fixture();
  await expect(test.change({ ...test.input, ...patch })).rejects.toThrow();
  expect(await test.rows()).toHaveLength(0);
}
it.each([{ changedBy: 'admin' }, { actorId: 'admin' }, { silo: 'foreign' },
  { secret: canary }, { serverId: '*' }, { serverId: 'missing' }, { connectionId: 'missing' },
  { registrationRevision: 1 }, { expectedSequence: 1 }, { enabled: 'true' },
  { expectedSequence: 0.5 }, { expectedSequence: Number.MAX_SAFE_INTEGER + 1 }])(
  'refuses spoofed, malformed or stale input %j', refusedInput);
async function deniedMember(kind: string) {
  let role = 'admin';
  if (kind === 'ordinary') {
    role = 'member';
  }
  const test = await fixture(role);
  let currentBinding = binding;
  if (kind === 'foreign') {
    currentBinding = { ...binding, silo: 'foreign' };
  }
  await expect(changeCompanyOptIn(nats.store, currentBinding, test.userId, test.input))
    .rejects.toThrow();
  expect(await test.rows()).toHaveLength(0);
}
it.each(['ordinary', 'foreign'])('refuses a %s member without appending', deniedMember);

async function replacedInstallation() {
  const test = await fixture();
  const saved = await test.change();
  await nats.seed([{ ...test.registration, id: 'replacement-registration' }]);
  const revision = await nats.store.head(`mcp-${test.input.serverId}`);
  const next = { ...test.input, changeRef: 'next', expectedSequence: saved.sequence };
  await expect(test.change(next)).rejects.toThrow('Company opt-in conflict');
  await nats.seed([{ ...test.discovery, id: 'replacement-discovery' }]);
  await expect(test.change(next)).rejects.toThrow('Company opt-in conflict');
  const installation = { ...test.installation, registrationRevision: revision };
  expect(foldCompanyOptIn(await test.rows(), installation).enabled).toBe(false);
  expect(await test.change()).toEqual(saved);
  const renewed = await test.change({ ...next, registrationRevision: revision });
  expect(foldCompanyOptIn(await test.rows(), installation)).toEqual({
    enabled: true, sequence: renewed.sequence,
  });
}
it('invalidates old opt-in on re-registration even when the connection id is reused',
  replacedInstallation);

async function replayAndRetries() {
  const test = await fixture();
  const manager = await jetstreamManager(nats.connection);
  await manager.streams.update('EVENTS', { duplicate_window: 1_000_000_000 });
  const append = nats.store.append.bind(nats.store);
  async function loseReply(command: AppendCommand) {
    await append(command);
    return { status: 'unavailable' as const, cause: new Error(canary) };
  }
  const fault = vi.spyOn(nats.store, 'append');
  fault.mockImplementationOnce(loseReply);
  await expect(test.change()).rejects.toThrow('Company opt-in unavailable');
  fault.mockRestore();
  const original = await test.change();
  await delay(1100);
  expect(await test.change()).toEqual(original);
  await expect(test.change({ ...test.input, enabled: false }))
    .rejects.toThrow('Company opt-in conflict');
  const second = await test.change({ ...test.input,
    expectedSequence: original.sequence, changeRef: 'again' });
  const removed = await test.change({ ...test.input, enabled: false,
    expectedSequence: second.sequence, changeRef: 'remove' });
  expect(await test.change()).toEqual(original);
  const rows = await test.rows();
  expect(rows).toHaveLength(3);
  const beforeReplay = await nats.store.head();
  const requests = vi.spyOn(globalThis, 'fetch');
  const writes = vi.spyOn(nats.store, 'append');
  const disorder = [...rows, rows[0]!, rows[1]!];
  expect(foldCompanyOptIn(disorder, test.installation)).toEqual({
    enabled: false, sequence: removed.sequence,
  });
  expect(requests).not.toHaveBeenCalled();
  expect(writes).not.toHaveBeenCalled();
  requests.mockRestore();
  writes.mockRestore();
  expect(await nats.store.head()).toBe(beforeReplay);
  expect(JSON.stringify({ rows, original, removed })).not.toContain(canary);
}
it('recovers original receipts beyond deduplication and never restores opt-in from old rows',
  replayAndRetries);

async function removeAdmin(test: Awaited<ReturnType<typeof fixture>>) {
  const removed = envelope('test', `member-${test.userId}`, 'member.removed', {
    memberId: test.userId, removedBy: 'admin',
  });
  await nats.seed([removed]);
}
async function preparationRemoval(failure: string) {
  const test = await fixture();
  let input = test.input;
  if (failure === 'conflicting retry') {
    await test.change();
    input = { ...input, enabled: false };
  }
  const before = await nats.store.head(test.subject);
  const read = nats.store.readStream.bind(nats.store);
  async function* removeDuringRead(subject: string, from?: number, deadline?: number) {
    if (subject === test.subject) {
      fault.mockRestore();
      await removeAdmin(test);
      if (failure === 'failed history') {
        throw new Error(canary);
      }
    }
    yield* read(subject, from, deadline);
  }
  const fault = vi.spyOn(nats.store, 'readStream');
  fault.mockImplementation(removeDuringRead);
  await expect(test.change(input)).rejects.toBeInstanceOf(MemberAccessRefused);
  fault.mockRestore();
  expect(await nats.store.head(test.subject)).toBe(before);
}
it.each(['successful history', 'failed history', 'conflicting retry'])(
  'checks removal during preparation before exposing %s', preparationRemoval);

async function appendRace(kind: string) {
  const test = await fixture();
  const append = nats.store.append.bind(nats.store);
  async function changeInsideAppend(command: AppendCommand) {
    fault.mockRestore();
    const check = command.checkAccess;
    async function raceAfterCheck() {
      await check?.();
      if (kind === 'admin removal') {
        await removeAdmin(test);
      } else {
        await nats.seed([{ ...test.registration, id: `racing-${test.userId}` }]);
      }
    }
    return append({ ...command, checkAccess: raceAfterCheck });
  }
  const fault = vi.spyOn(nats.store, 'append');
  fault.mockImplementationOnce(changeInsideAppend);
  await expect(test.change()).rejects.toThrow();
  fault.mockRestore();
  expect(await test.rows()).toHaveLength(0);
}
it.each(['admin removal', 'installation replacement'])(
  'refuses %s inside the conditional append', appendRace);

async function historyTiming(stage: string) {
  const test = await fixture();
  const now = performance.now.bind(performance);
  let elapsed = 0;
  function clock() {
    return now() + elapsed;
  }
  const timer = vi.spyOn(performance, 'now');
  timer.mockImplementation(clock);
  const read = nats.store.readStream.bind(nats.store);
  async function* slowHistory(subject: string, from?: number, deadline?: number) {
    yield* read(subject, from, deadline);
    const preparing = stage === 'preparation' && subject === `mcp-${test.input.serverId}`;
    const checkingAccess = stage === 'access' && subject === `member-${test.userId}`;
    if (preparing || checkingAccess) {
      elapsed += 2100;
    }
  }
  const fault = vi.spyOn(nats.store, 'readStream');
  fault.mockImplementation(slowHistory);
  try {
    if (stage === 'preparation') {
      expect((await test.change()).enabled).toBe(true);
    } else {
      await expect(test.change()).rejects.toThrow('Company opt-in unavailable');
      expect(await test.rows()).toHaveLength(0);
    }
  } finally {
    fault.mockRestore();
    timer.mockRestore();
  }
}
it.each(['preparation', 'access'])('keeps the short write deadline separate from %s', historyTiming);

async function noAccountUse() {
  const test = await fixture();
  await test.change();
  const rows = await history(nats.store, `mcp-${test.input.serverId}`, 'test');
  expect(connectionServer(rows, 'installed').available).toBe(false);
  expect(await readConnectionSelection(nats.store, binding, test.userId, test.input.serverId))
    .toEqual({ status: 'unavailable', sequence: 0 });
  const selection = { action: 'select', serverId: test.input.serverId,
    connectionId: 'installed', profileId: 'company', profileRevision: 1,
    expectedSequence: 0, changeRef: 'select-company' };
  await expect(changeConnectionSelection(nats.store, binding, test.userId, selection))
    .rejects.toThrow();
  expect(await nats.store.head(`connection-selection-${test.userId}-${test.input.serverId}`))
    .toBe(0);
  const metadata = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientCapabilities': {}, threadId: 'thread', callId: 'call' };
  const request = { jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'example', arguments: {}, _meta: metadata } };
  const parsed = parseMcpCall(JSON.stringify(request));
  const headers = { 'mcp-protocol-version': '2026-07-28',
    'mcp-method': 'tools/call', 'mcp-name': 'example' };
  await expect(mcpPolicy(nats.store, 'test', test.input.serverId, 'installed', parsed, headers))
    .rejects.toThrow('MCP context unavailable');
}
it('keeps selection and dispatch unavailable after opt-in alone', noAccountUse);

async function invalidReplay(field: string) {
  const test = await fixture();
  await test.change();
  const rows = await test.rows();
  const row = rows[0]!;
  if (field === 'silo') {
    row.event.silo = 'foreign';
  } else if (field === 'actor') {
    row.event.principal = { kind: 'human', id: 'spoofed' };
  } else if (field === 'source') {
    row.event.source = 'untrusted';
  } else if (field === 'subject') {
    row.event.subject = 'connection-company-foreign';
  } else if (field === 'type') {
    row.event.type = 'connection.selected';
  } else if (field === 'id') {
    row.event.id = 'forged';
  } else {
    const saved = companyOptInSetDataSchema.parse(row.event.data);
    row.event.data = { ...saved, extra: canary };
  }
  expect(foldCompanyOptIn(rows, test.installation).enabled).toBe(false);
}
it.each(['silo', 'actor', 'source', 'subject', 'type', 'id', 'data'])(
  'refuses replay with an invalid %s', invalidReplay);

async function privateFailure() {
  const test = await fixture();
  const read = nats.store.readStream.bind(nats.store);
  async function* failedHistory(subject: string, from?: number, deadline?: number) {
    if (subject === test.subject) {
      throw new Error(canary);
    }
    yield* read(subject, from, deadline);
  }
  const fault = vi.spyOn(nats.store, 'readStream');
  fault.mockImplementation(failedHistory);
  try {
    await expect(test.change()).rejects.toEqual(new Error('Company opt-in unavailable'));
  } finally {
    fault.mockRestore();
  }
  expect(await test.rows()).toHaveLength(0);
}
it('keeps dependency canaries out of public errors', privateFailure);
