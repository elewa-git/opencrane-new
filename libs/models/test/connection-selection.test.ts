import { setTimeout as delay } from 'node:timers/promises';
import { jetstreamManager } from '@nats-io/jetstream';
import type { AppendCommand } from '@opencrane/event-store';
import { connectionCreatedDataSchema, connectionSelectedDataSchema } from '@opencrane/events';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createStore, grantStream, memberAuthorisation } from '@opencrane/authz';
import { databases, openfga } from '@opencrane/authz/testing';
import { natsFixture } from '@opencrane/event-store/testing';
import { catalogueDigest } from '@opencrane/events/mcp-catalogue';
import { pgDb } from '@opencrane/projections';
import { envelope, history } from '../src/actor.ts';
import { saveBearerConnection, changePersonalConnection } from '../src/bearer-connections.ts';
import { changeConnectionSelection, foldConnectionSelection, readConnectionSelection }
  from '../src/connection-selection.ts';

let nats: Awaited<ReturnType<typeof natsFixture>>;
let fga: Awaited<ReturnType<typeof openfga>>;
let storage: Awaited<ReturnType<typeof databases>>;
let binding: Awaited<ReturnType<typeof createStore>>;
let counter = 0;
async function initialise() {
  nats = await natsFixture();
  fga = await openfga();
  storage = await databases();
  binding = await createStore(fga.apiUrl, 'test');
  await publishServer();
}
async function publishServer(locator = 'https://example.test/mcp') {
  const registration = envelope('test', 'mcp-server', 'mcp.server_registered', {
    serverId: 'server', kind: 'remote', locator, registeredBy: 'admin',
  });
  const discovery = envelope('test', 'mcp-server', 'mcp.server_discovered', {
    serverId: 'server', connectionId: 'installed', accountMode: 'personal', tools: [],
    toolCount: 0, schemaDigest: catalogueDigest([]), checkedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
  });
  await nats.seed([registration, discovery]);
  const policyRevision = await nats.store.head('mcp-server');
  const review = envelope('test', 'mcp-server', 'mcp.server_reviewed', {
    serverId: 'server', connectionId: 'installed', accountMode: 'personal', tools: [],
    catalogueDigest: catalogueDigest([]), policyRevision, reviewedBy: 'admin',
  });
  review.principal = { kind: 'human', id: 'admin' };
  const publication = envelope('test', 'mcp-server', 'mcp.server_published', {
    serverId: 'server', publishedBy: 'admin',
  });
  await nats.seed([review, publication]);
}
async function close() {
  await storage?.close();
  await fga?.close();
  await nats?.close();
}
beforeAll(initialise, 120_000);
afterAll(close);
async function fixture() {
  counter += 1;
  const userId = `person${counter}`;
  const auth = memberAuthorisation(binding);
  const joined = envelope('test', `member-${userId}`, 'member.joined', {
    memberId: userId, role: 'admin', email: `${userId}@example.test`, displayName: userId,
  });
  const grant = envelope('test', grantStream('mcp_server', 'server'), 'grant.given', {
    resourceType: 'mcp_server', resourceId: 'server', granteeKind: 'member',
    granteeId: userId, grantedBy: userId,
  });
  await nats.seed([joined, grant]);
  await auth.handler.handle(joined, pgDb(storage.queue));
  await auth.handler.handle(grant, pgDb(storage.queue));
  const input = { action: 'create' as const, serverId: 'server', connectionId: 'installed',
    profileId: 'personal', changeRef: 'create', expectedSequence: 0, expectedGeneration: 0,
    appendUntil: Date.now() + 60_000 };
  function stage() {
    const identity = { reference: 'synthetic', uid: 'uid', resourceVersion: '1' };
    return Promise.resolve({ status: 'staged' as const, identity });
  }
  const custody = { stage: vi.fn(stage) };
  async function save(raw: unknown = input) {
    return saveBearerConnection(nats.store, binding, userId, custody, raw,
      'synthetic-material', pgDb(storage.queue));
  }
  const created = await save();
  custody.stage.mockClear();
  const command = { action: 'select' as const, serverId: 'server', connectionId: 'installed',
    profileId: 'personal', profileRevision: created.sequence, changeRef: 'selection',
    expectedSequence: 0 };
  async function select(raw: unknown = command) {
    return changeConnectionSelection(nats.store, binding, userId, raw);
  }
  async function read() {
    return readConnectionSelection(nats.store, binding, userId, 'server');
  }
  return { userId, input, created, command, custody, save, select, read,
    subject: `connection-selection-${userId}-server`,
    profileSubject: `connection-${userId}-server-personal` };
}
async function explicitSelection() {
  const test = await fixture();
  expect(await test.read()).toEqual({ status: 'unavailable', sequence: 0 });
  const selected = await test.select();
  expect(await test.read()).toEqual({ status: 'saved_unverified', sequence: selected.sequence,
    profileId: 'personal', profileRevision: test.created.sequence });
  const clear = { action: 'clear', serverId: 'server', connectionId: 'installed',
    expectedSequence: selected.sequence, changeRef: 'clear' };
  const cleared = await test.select(clear);
  expect(await test.read()).toEqual({ status: 'unavailable', sequence: cleared.sequence });
  const rows = await history(nats.store, test.subject, 'test');
  expect(rows).toHaveLength(2);
  expect(foldConnectionSelection(rows)).toEqual({ sequence: cleared.sequence, selected: null });
  expect(test.custody.stage).not.toHaveBeenCalled();
}
it('requires an explicit selection and an explicit clear, without verifying the account',
  explicitSelection);

async function invalidInput(patch: Record<string, unknown>) {
  const test = await fixture();
  await expect(test.select({ ...test.command, ...patch })).rejects.toThrow();
  expect(await nats.store.head(test.subject)).toBe(0);
  expect(test.custody.stage).not.toHaveBeenCalled();
}
it.each([{ userId: 'other' }, { ownerId: 'other' }, { ownerKind: 'company' },
  { ownerKind: 'validation' }, { serverId: 'other' }, { connectionId: 'other' },
  { profileId: 'missing' }, { profileRevision: 1 }, { expectedSequence: 1 }])(
  'refuses forged or stale selection input %j', invalidInput);

async function invalidProfile(kind: string) {
  const owner = await fixture();
  const test = await fixture();
  const rows = await history(nats.store, owner.profileSubject, 'test');
  const original = rows[0]!.event;
  const saved = connectionCreatedDataSchema.parse(original.data);
  let replacement: unknown = saved;
  if (kind === 'legacy') replacement = { ...saved, activation: undefined };
  if (kind === 'incomplete') {
    replacement = { ...saved, activation: { ...saved.activation, uid: undefined } };
  }
  if (kind === 'company' || kind === 'validation') {
    replacement = { ...saved, activation: { ...saved.activation, ownerKind: kind } };
  }
  const event = { ...original, id: `invalid-${test.userId}`, subject: test.profileSubject,
    data: replacement };
  await nats.seed([event]);
  const revision = await nats.store.head(test.profileSubject);
  await expect(test.select({ ...test.command, profileRevision: revision })).rejects.toThrow();
  expect(await nats.store.head(test.subject)).toBe(0);
}
it.each(['foreign', 'legacy', 'incomplete', 'company', 'validation'])(
  'refuses a %s profile without saving a choice', invalidProfile);

async function changeProfile(test: Awaited<ReturnType<typeof fixture>>, action: string) {
  if (action === 'rotate') {
    const rotation = { ...test.input, action, changeRef: action,
      expectedSequence: test.created.sequence, expectedGeneration: 1 };
    await test.save(rotation);
  } else if (action === 'remove') {
    const event = envelope('test', `member-${test.userId}`, 'member.removed', {
      memberId: test.userId, removedBy: test.userId,
    });
    await nats.seed([event]);
  } else {
    const expectedSequence = action === 'disable' ? 0 : test.created.sequence;
    const input = { action, userId: test.userId, serverId: 'server', profileId: 'personal',
      changeRef: action, expectedSequence };
    await changePersonalConnection(nats.store, binding, test.userId, input);
  }
}
async function staleSelection(action: string) {
  const test = await fixture();
  const selected = await test.select();
  await changeProfile(test, action);
  expect(await test.read()).toEqual({ status: 'unavailable', sequence: selected.sequence });
  const command = { ...test.command, expectedSequence: selected.sequence, changeRef: 'again' };
  await expect(test.select(command)).rejects.toThrow();
  expect(await nats.store.head(test.subject)).toBe(selected.sequence);
}
it.each(['rotate', 'revoke', 'disable'])(
  'makes a selection unavailable after %s without choosing another profile', staleSelection);

async function preAppendChange(action: string) {
  const test = await fixture();
  const append = nats.store.append.bind(nats.store);
  async function changeThenAppend(command: AppendCommand) {
    fault.mockRestore();
    await changeProfile(test, action);
    return append(command);
  }
  const fault = vi.spyOn(nats.store, 'append');
  fault.mockImplementationOnce(changeThenAppend);
  try {
    await expect(test.select()).rejects.toThrow();
  } finally {
    fault.mockRestore();
  }
  expect(await nats.store.head(test.subject)).toBe(0);
}
it.each(['rotate', 'revoke', 'disable', 'remove'])(
  'refuses %s saved at the pre-append barrier', preAppendChange);

async function retries() {
  const test = await fixture();
  const manager = await jetstreamManager(nats.connection);
  await manager.streams.update('EVENTS', { duplicate_window: 1_000_000_000 });
  const append = nats.store.append.bind(nats.store);
  async function loseReply(command: AppendCommand) {
    await append(command);
    return { status: 'unavailable' as const, cause: new Error('synthetic-material') };
  }
  const fault = vi.spyOn(nats.store, 'append');
  fault.mockImplementationOnce(loseReply);
  try {
    await expect(test.select()).rejects.toThrow('Selection append unconfirmed');
  } finally {
    fault.mockRestore();
  }
  const recovered = await test.select();
  await delay(1100);
  expect(await test.select()).toEqual(recovered);
  const changed = { ...test.command, profileId: 'different' };
  await expect(test.select(changed)).rejects.toThrow('Selection conflict');
  const clear = { action: 'clear', serverId: 'server', connectionId: 'installed',
    expectedSequence: 0, changeRef: test.command.changeRef };
  await expect(test.select(clear)).rejects.toThrow('Selection conflict');
  expect(await history(nats.store, test.subject, 'test')).toHaveLength(1);
}
it('recovers the original receipt after a lost reply and dedupe expiry; changed reuse conflicts',
  retries);
async function concurrentSelection() {
  const test = await fixture();
  const before = await nats.store.head();
  const grantPosition = await nats.store.head(grantStream('mcp_server', 'server'));
  const results = await Promise.all([test.select(), test.select()]);
  expect(results[0]).toEqual(results[1]);
  expect(await nats.store.head()).toBe(before + 1);
  expect(await nats.store.head(grantStream('mcp_server', 'server'))).toBe(grantPosition);
  const rows = await history(nats.reader, test.subject, 'test');
  expect(foldConnectionSelection(rows).selected).toMatchObject({ userId: test.userId,
    profileId: 'personal', profileRevision: test.created.sequence });
  expect(test.custody.stage).not.toHaveBeenCalled();
  expect(JSON.stringify(results)).not.toContain('personal');
  expect(JSON.stringify(results)).not.toContain('synthetic-material');
}
it('converges concurrent identical commands, replays the choice and leaves grants unchanged',
  concurrentSelection);
async function rotationDoesNotSelect() {
  const test = await fixture();
  await changeProfile(test, 'rotate');
  expect(await test.read()).toEqual({ status: 'unavailable', sequence: 0 });
  expect(await nats.store.head(test.subject)).toBe(0);
  const clear = { action: 'clear', serverId: 'server', connectionId: 'installed',
    expectedSequence: 0, changeRef: 'clear' };
  const receipt = await test.select(clear);
  expect(await test.select(clear)).toEqual(receipt);
  expect(await test.read()).toEqual({ status: 'unavailable', sequence: receipt.sequence });
}
it('never selects when a profile is created or rotated, and can explicitly clear absence',
  rotationDoesNotSelect);
async function missingToolRights() {
  const test = await fixture();
  const event = envelope('test', grantStream('mcp_server', 'server'), 'grant.revoked', {
    resourceType: 'mcp_server', resourceId: 'server', granteeId: test.userId,
    granteeKind: 'member', revokedBy: test.userId,
  });
  await nats.seed([event]);
  await expect(test.select()).rejects.toThrow();
  const auth = memberAuthorisation(binding);
  await auth.handler.handle(event, pgDb(storage.queue));
  await expect(test.select()).rejects.toThrow();
  expect(await nats.store.head(test.subject)).toBe(0);
}
it('requires current tool rights even while OpenFGA still allows a revoked grant', missingToolRights);
function strictEvent() {
  const clear = { action: 'clear', userId: 'person', serverId: 'server',
    connectionId: 'installed', expectedSequence: 0 };
  expect(connectionSelectedDataSchema.safeParse(clear).success).toBe(true);
  expect(connectionSelectedDataSchema.safeParse({ ...clear, profileId: 'personal' }).success)
    .toBe(false);
  expect(connectionSelectedDataSchema.safeParse({ ...clear, action: 'select' }).success).toBe(false);
}
it('requires a checked profile revision for selection and no profile on clear', strictEvent);

async function serverReplacement() {
  const test = await fixture();
  const selected = await test.select();
  try {
    await publishServer('https://replacement.example.test/mcp');
    expect(await test.read()).toEqual({ status: 'unavailable', sequence: selected.sequence });
    const input = { ...test.command, expectedSequence: selected.sequence, changeRef: 'replacement' };
    await expect(test.select(input)).rejects.toThrow();
    expect(await nats.store.head(test.subject)).toBe(selected.sequence);
  } finally {
    await publishServer();
  }
}
it('refuses an old profile after the installed endpoint is replaced and reviewed again',
  serverReplacement);
