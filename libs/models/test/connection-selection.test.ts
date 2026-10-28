import { createServer, type Socket } from 'node:net';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { jetstreamManager } from '@nats-io/jetstream';
import { createEventStore, type AppendCommand, type StoredEvent } from '@opencrane/event-store';
import { connectionCreatedDataSchema, connectionSelectedDataSchema,
  mcpServerDiscoveredDataSchema } from '@opencrane/events';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createStore, grantStream, memberAuthorisation } from '@opencrane/authz';
import { databases, openfga } from '@opencrane/authz/testing';
import { natsFixture } from '@opencrane/event-store/testing';
import { catalogueDigest, toolReviewDigest } from '@opencrane/events/mcp-catalogue';
import { pgDb } from '@opencrane/projections';
import { envelope, history } from '../src/actor.ts';
import { saveBearerConnection, changePersonalConnection, foldConnection } from '../src/bearer-connections.ts';
import { changeConnectionSelection, foldConnectionSelection, readConnectionSelection }
  from '../src/connection-selection.ts';
import { toolPolicyFromRows } from '../src/tool-policy.ts';
import { confirmCredentialRelease } from '../src/credential-release.ts';
import { approvalActivity, requireActiveConversationTurn } from '../src/decision-activity.ts';
import { authorityFence } from '../src/authority.ts';
import { activeMember, MemberAccessRefused } from '../src/member-authority.ts';
import { data as eventData } from '../src/state.ts';

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
  const checkedAt = Date.now();
  const discovery = envelope('test', 'mcp-server', 'mcp.server_discovered', {
    serverId: 'server', connectionId: 'installed', accountMode: 'personal', tools: [],
    toolCount: 0, schemaDigest: catalogueDigest([]), checkedAt: new Date(checkedAt).toISOString(),
    expiresAt: new Date(checkedAt + 300_000).toISOString(),
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
  await nats.seed([review]);
  const rows = await history(nats.store, 'mcp-server', 'test');
  const policy = toolPolicyFromRows(rows);
  if (policy.driftHeld) {
    await confirmPublication(policy.sequence);
  } else {
    await nats.seed([publication]);
  }
}
async function confirmPublication(reviewRevision: number) {
  const changeRef = `publication-${reviewRevision}`;
  const fragmentDigest = 'a'.repeat(64);
  const publication = envelope('test', 'mcp-server', 'mcp.server_published', {
    serverId: 'server', publishedBy: 'admin', commandId: changeRef,
    expectedSequence: reviewRevision, reviewRevision, fragmentDigest,
  });
  await nats.seed([publication]);
  const sourceSequence = await nats.store.head('mcp-server');
  const observation = envelope('test', 'mcp-server', 'mcp.configuration_observed', {
    serverId: 'server', changeRef, reviewRevision, fragmentDigest, sourceSequence,
    generation: 1, recordDigest: 'b'.repeat(64), configDigest: 'c'.repeat(64),
    processRef: '00000000-0000-4000-8000-000000000001', observedAt: new Date().toISOString(),
  });
  await nats.seed([observation]);
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
  { ownerKind: 'validation' }, { connectionId: 'other' },
  { profileId: 'missing' }, { profileRevision: 1 }, { expectedSequence: 1 }])(
  'refuses forged or stale selection input %j', invalidInput);

async function invalidProfile(kind: string) {
  const test = await fixture();
  const rows = await history(nats.store, test.profileSubject, 'test');
  expect(foldConnection(rows).status).toBe('saved_unverified');
  const changed = structuredClone(rows);
  const row = changed[0]!;
  const saved = connectionCreatedDataSchema.parse(row.event.data);
  const activation = saved.activation!;
  if (kind === 'legacy') {
    row.event.data = { ...saved, activation: undefined };
  } else if (kind === 'incomplete') {
    row.event.data = { ...saved, activation: { ...activation, uid: undefined } };
  } else if (kind === 'company' || kind === 'validation') {
    row.event.data = { ...saved, activation: { ...activation, ownerKind: kind } };
  } else {
    if (kind === 'foreign') {
      saved.userId = 'another-person';
      activation.changedBy = saved.userId;
      row.event.principal = { kind: 'human', id: saved.userId };
    } else if (kind === 'server') {
      saved.serverId = 'another-server';
    } else if (kind === 'profile') {
      saved.profile = 'another-profile';
    } else if (kind === 'installation') {
      activation.connectionId = 'another-installation';
    } else if (kind === 'endpoint') {
      activation.endpointDigest = 'a'.repeat(64);
    }
    row.event.subject = `connection-${saved.userId}-${saved.serverId}-${saved.profile}`;
    row.event.data = saved;
    // Keep the supplied profile valid on its own so only the selection binding rejects it.
    expect(foldConnection(changed).status).toBe('saved_unverified');
  }
  const readStream = nats.store.readStream.bind(nats.store);
  async function* substituteProfile(subject: string, from?: number, deadline?: number) {
    if (subject === test.profileSubject) {
      yield* changed;
      return;
    }
    yield* readStream(subject, from, deadline);
  }
  const fault = vi.spyOn(nats.store, 'readStream');
  fault.mockImplementation(substituteProfile);
  try {
    await expect(test.select()).rejects.toThrow('Selection conflict');
  } finally {
    fault.mockRestore();
  }
  expect(await nats.store.head(test.subject)).toBe(0);
}
it.each(['foreign', 'legacy', 'incomplete', 'company', 'validation',
  'server', 'profile', 'installation', 'endpoint'])(
  'refuses a profile with only the %s fault', invalidProfile);

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
  if (action !== 'disable') {
    const replacement = { ...test.input, profileId: 'replacement', changeRef: 'replacement' };
    await test.save(replacement);
  }
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

async function staleReview() {
  const test = await fixture();
  const rows = await history(nats.store, 'mcp-server', 'test');
  const discovery = envelope('test', 'mcp-server', 'mcp.server_discovered',
    rows.at(-3)!.event.data);
  const publication = envelope('test', 'mcp-server', 'mcp.server_published',
    rows.at(-1)!.event.data);
  try {
    await nats.seed([discovery, publication]);
    await expect(test.select()).rejects.toThrow();
    expect(await nats.store.head(test.subject)).toBe(0);
  } finally {
    await publishServer();
  }
}
it('requires a review of the current catalogue after rediscovery and legacy publication', staleReview);

async function wrongClearConnection() {
  const test = await fixture();
  const clear = { action: 'clear', serverId: 'server', connectionId: 'other',
    expectedSequence: 0, changeRef: 'clear' };
  await expect(test.select(clear)).rejects.toThrow();
  expect(await nats.store.head(test.subject)).toBe(0);
}
it('refuses a clear naming a different installed connection', wrongClearConnection);

async function clearAfterRegistration() {
  const test = await fixture();
  const selected = await test.select();
  const registration = envelope('test', 'mcp-server', 'mcp.server_registered', {
    serverId: 'server', kind: 'remote', locator: 'https://replacement.example.test/mcp',
    registeredBy: 'admin',
  });
  try {
    await nats.seed([registration]);
    expect(await test.read()).toEqual({ status: 'unavailable', sequence: selected.sequence });
    const clear = { action: 'clear', serverId: 'server', connectionId: 'installed',
      expectedSequence: selected.sequence, changeRef: 'clear-after-registration' };
    await expect(test.select({ ...clear, connectionId: 'other' }))
      .rejects.toThrow('Selection conflict');
    const cleared = await test.select(clear);
    expect(cleared.status).toBe('cleared');
    expect(await test.read()).toEqual({ status: 'unavailable', sequence: cleared.sequence });
    expect(await test.select(clear)).toEqual(cleared);
    expect(test.custody.stage).not.toHaveBeenCalled();
  } finally {
    await publishServer();
  }
}
it('clears the saved binding after re-registration before discovery succeeds',
  clearAfterRegistration);

async function blockedLegacyReview() {
  const test = await fixture();
  const definition = '{"inputSchema":{"type":"object"},"name":"read"}';
  const hash = createHash('sha256');
  hash.update(definition);
  const revision = hash.digest('hex');
  const tool = { name: 'read', revision, reviewed: false, definition, costCents: 0 };
  const tools = [tool];
  const schemaDigest = catalogueDigest(tools);
  const now = Date.now();
  const discovery = envelope('test', 'mcp-server', 'mcp.server_discovered', {
    serverId: 'server', connectionId: 'installed', accountMode: 'personal',
    tools, toolCount: 1, schemaDigest, checkedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 300_000).toISOString(),
  });
  try {
    await nats.seed([discovery]);
    const policyRevision = await nats.store.head('mcp-server');
    const choice = { name: 'read', revision, reviewDigest: toolReviewDigest(tool), mode: 'allow' };
    const review = envelope('test', 'mcp-server', 'mcp.server_reviewed', {
      serverId: 'server', connectionId: 'installed', accountMode: 'personal',
      catalogueDigest: schemaDigest, policyRevision, reviewedBy: 'admin', tools: [choice],
    });
    review.principal = { kind: 'human', id: 'admin' };
    const publication = envelope('test', 'mcp-server', 'mcp.server_published', {
      serverId: 'server', publishedBy: 'admin',
    });
    await nats.seed([review, publication]);
    await expect(test.select()).rejects.toThrow('Selection conflict');
    const input = { ...test.input, profileId: 'new-profile', changeRef: 'new-profile' };
    await expect(test.save(input)).rejects.toThrow('Connection server unavailable');
    expect(test.custody.stage).not.toHaveBeenCalled();
    expect(await nats.store.head(test.subject)).toBe(0);
  } finally {
    await publishServer();
  }
}
it('refuses selection and bearer staging after a blocked legacy review and publication',
  blockedLegacyReview);

async function invalidIdentifiers(patch: Record<string, unknown>) {
  const test = await fixture();
  await expect(test.select({ ...test.command, ...patch })).rejects.toThrow('Selection input invalid');
  expect(await nats.store.head(test.subject)).toBe(0);
}
it.each([{ serverId: '' }, { serverId: '*' }, { connectionId: 'a'.repeat(201) },
  { profileId: '../private' }, { changeRef: '' }, { expectedSequence: -1 },
  { expectedSequence: 0.5 }, { expectedSequence: Number.MAX_SAFE_INTEGER + 1 },
  { profileRevision: 0 }, { profileRevision: -1 }, { profileRevision: 0.5 }])(
  'rejects invalid ids and ranges before reading facts: %j', invalidIdentifiers);

async function invalidCaller() {
  const test = await fixture();
  await expect(changeConnectionSelection(nats.store, binding, '*', test.command))
    .rejects.toThrow('Selection input invalid');
  await expect(readConnectionSelection(nats.store, binding, '*', 'server'))
    .rejects.toThrow('Selection input invalid');
  await expect(readConnectionSelection(nats.store, binding, test.userId, '*'))
    .rejects.toThrow('Selection input invalid');
}
it('validates the authenticated caller and read server ids', invalidCaller);

async function corruptReceipt(field: string) {
  const test = await fixture();
  const selected = await test.select();
  const rows = await history(nats.store, test.subject, 'test');
  const changed = structuredClone(rows);
  const event = changed[0]!.event;
  if (field === 'id') {
    event.id = 'a'.repeat(64);
  } else if (field === 'subject') {
    event.subject = 'connection-selection-other-server';
  } else if (field === 'commandId') {
    event.commandId = 'other';
  } else if (field === 'type') {
    event.type = 'connection.created';
  } else if (field === 'source') {
    event.source = 'untrusted';
  } else if (field === 'principal kind') {
    event.principal = { kind: 'system', id: test.userId };
  } else if (field === 'principal id') {
    event.principal = { kind: 'human', id: 'other' };
  } else if (field === 'silo') {
    event.silo = 'other';
  }
  const readStream = nats.store.readStream.bind(nats.store);
  async function* substituteReceipt(subject: string, from?: number, deadline?: number) {
    if (subject === test.subject) {
      yield* changed;
      return;
    }
    yield* readStream(subject, from, deadline);
  }
  const fault = vi.spyOn(nats.store, 'readStream');
  fault.mockImplementation(substituteReceipt);
  try {
    const message = field === 'silo' ? 'Wrong silo' : 'Selection conflict';
    await expect(test.select()).rejects.toThrow(message);
  } finally {
    fault.mockRestore();
  }
  expect(await nats.store.head(test.subject)).toBe(selected.sequence);
}
it.each(['id', 'subject', 'commandId', 'type', 'source', 'principal kind', 'principal id', 'silo'])(
  'refuses recovery when the saved receipt has a different %s', corruptReceipt);

async function missingSavedReceipt() {
  const test = await fixture();
  const append = nats.store.append.bind(nats.store);
  const readStream = nats.store.readStream.bind(nats.store);
  let appended = false;
  async function appendThenHide(command: AppendCommand) {
    const result = await append(command);
    appended = true;
    return result;
  }
  async function* hideReceipt(subject: string, from?: number, deadline?: number) {
    if (appended && subject === test.subject) {
      return;
    }
    yield* readStream(subject, from, deadline);
  }
  const appendFault = vi.spyOn(nats.store, 'append');
  const readFault = vi.spyOn(nats.store, 'readStream');
  appendFault.mockImplementation(appendThenHide);
  readFault.mockImplementation(hideReceipt);
  try {
    await expect(test.select()).rejects.toThrow('Selection conflict');
  } finally {
    appendFault.mockRestore();
    readFault.mockRestore();
  }
  expect(appended).toBe(true);
  expect(await history(nats.store, test.subject, 'test')).toHaveLength(1);
}
it('never reports success without reading the saved receipt', missingSavedReceipt);

function replaceStream(subjectToReplace: string, rows: StoredEvent[]) {
  const readStream = nats.store.readStream.bind(nats.store);
  async function* substitute(subject: string, from?: number, deadline?: number) {
    if (subject === subjectToReplace) {
      yield* rows;
      return;
    }
    yield* readStream(subject, from, deadline);
  }
  const fault = vi.spyOn(nats.store, 'readStream');
  fault.mockImplementation(substitute);
  return fault;
}

async function unavailableServer(kind: string) {
  const test = await fixture();
  const allRows = await history(nats.store, 'mcp-server', 'test');
  const rows = structuredClone(allRows.slice(-4));
  expect(toolPolicyFromRows(rows).published).toBe(true);
  if (kind === 'missing') {
    rows.length = 0;
  } else if (kind === 'hosted') {
    rows[0]!.event.data = { serverId: 'server', kind: 'hosted', registeredBy: 'admin',
      locator: `registry.example.test/tool@sha256:${'a'.repeat(64)}` };
  } else if (kind === 'company') {
    for (const row of rows.slice(1, 3)) {
      row.event.data = { ...eventData(row.event), accountMode: 'company' };
    }
  } else if (kind === 'unpublished') {
    const event = envelope('test', 'mcp-server', 'mcp.server_unpublished', {
      serverId: 'server', unpublishedBy: 'admin',
    });
    rows.push({ sequence: rows.at(-1)!.sequence + 1, event });
  } else if (kind === 'expired') {
    // Use one timestamp so a clock tick cannot exceed the five-minute catalogue lifetime.
    const timestamp = Date.now();
    const checkedAt = new Date(timestamp - 400_000).toISOString();
    const expiresAt = new Date(timestamp - 100_000).toISOString();
    rows[1]!.event.data = { ...eventData(rows[1]!.event), checkedAt, expiresAt };
    rows[2]!.event.time = checkedAt;
    expect(mcpServerDiscoveredDataSchema.safeParse(rows[1]!.event.data).success).toBe(true);
  }
  const fault = replaceStream('mcp-server', rows);
  try {
    await expect(test.select()).rejects.toThrow('Selection conflict');
  } finally {
    fault.mockRestore();
  }
  expect(await nats.store.head(test.subject)).toBe(0);
}
it.each(['missing', 'hosted', 'company', 'unpublished', 'expired'])(
  'refuses %s server facts while the person still has tool rights and a valid profile',
  unavailableServer);

async function expiredServerAcrossClockTick() {
  let timestamp = Date.now();
  function advancingClock() {
    timestamp += 1;
    return timestamp;
  }
  const clock = vi.spyOn(Date, 'now');
  clock.mockImplementation(advancingClock);
  try {
    await unavailableServer('expired');
  } finally {
    clock.mockRestore();
  }
}
it('refuses expired server facts with valid catalogue dates when the clock ticks between reads',
  expiredServerAcrossClockTick);

async function catalogueEvent(kind: string) {
  const rows = await history(nats.store, 'mcp-server', 'test');
  const policy = toolPolicyFromRows(rows);
  if (kind === 'registered') {
    return envelope('test', 'mcp-server', 'mcp.server_registered', {
      serverId: 'server', kind: 'remote', locator: 'https://replacement.example.test/mcp',
      registeredBy: 'admin',
    });
  }
  if (kind === 'changed') {
    return envelope('test', 'mcp-server', 'mcp.tools_changed', {
      serverId: 'server', previousSchemaDigest: policy.catalogue!.schemaDigest,
      newSchemaDigest: policy.catalogue!.schemaDigest, catalogue: policy.catalogue,
    });
  }
  const now = Date.now();
  return envelope('test', 'mcp-server', 'mcp.catalogue_checked', {
    serverId: 'server', outcome: 'unchanged', schemaDigest: policy.catalogue!.schemaDigest,
    checkedAt: new Date(now).toISOString(), expiresAt: new Date(now + 300_000).toISOString(),
  });
}

async function catalogueBeforeAppend(kind: string) {
  const test = await fixture();
  const event = await catalogueEvent(kind);
  const append = nats.store.append.bind(nats.store);
  async function changeThenAppend(command: AppendCommand) {
    fault.mockRestore();
    await nats.seed([event]);
    await expect(command.checkAccess!()).rejects.toThrow('Selection conflict');
    return append(command);
  }
  const fault = vi.spyOn(nats.store, 'append');
  fault.mockImplementationOnce(changeThenAppend);
  try {
    await expect(test.select()).rejects.toThrow('Selection append unconfirmed');
    expect(await nats.store.head(test.subject)).toBe(0);
  } finally {
    fault.mockRestore();
    await publishServer();
  }
}
it.each(['registered', 'changed', 'unchanged'])(
  'refuses a %s catalogue event between loading facts and appending', catalogueBeforeAppend);

async function catalogueAvailability(kind: string) {
  const test = await fixture();
  const selected = await test.select();
  const event = await catalogueEvent(kind);
  try {
    await nats.seed([event]);
    if (kind === 'unchanged') {
      expect(await test.read()).toMatchObject({ status: 'saved_unverified' });
      const input = { ...test.command, expectedSequence: selected.sequence, changeRef: 'again' };
      expect((await test.select(input)).status).toBe('selected');
    } else {
      expect(await test.read()).toEqual({ status: 'unavailable', sequence: selected.sequence });
      const input = { ...test.command, expectedSequence: selected.sequence, changeRef: 'again' };
      await expect(test.select(input)).rejects.toThrow('Selection conflict');
    }
  } finally {
    await publishServer();
  }
}
it.each(['unchanged', 'changed'])(
  'uses current catalogue availability after an %s check', catalogueAvailability);

async function expiryDuringAppend() {
  const test = await fixture();
  const rows = await history(nats.store, 'mcp-server', 'test');
  const expiresAt = Date.parse(toolPolicyFromRows(rows).expiresAt!);
  const append = nats.store.append.bind(nats.store);
  async function expireThenAppend(command: AppendCommand) {
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(expiresAt);
    try {
      await expect(command.checkAccess!()).rejects.toThrow('Selection unavailable');
      return await append(command);
    } finally {
      now.mockRestore();
    }
  }
  const fault = vi.spyOn(nats.store, 'append');
  fault.mockImplementationOnce(expireThenAppend);
  try {
    await expect(test.select()).rejects.toThrow('Selection append unconfirmed');
  } finally {
    fault.mockRestore();
  }
  expect(await nats.store.head(test.subject)).toBe(0);
}
it('rechecks catalogue expiry inside the append', expiryDuringAppend);

async function appendDeadline(remaining: number, expectedDeadline: number) {
  const test = await fixture();
  const rows = await history(nats.store, 'mcp-server', 'test');
  const expiresAt = Date.parse(toolPolicyFromRows(rows).expiresAt!);
  const wallClock = vi.spyOn(Date, 'now');
  const monotonicClock = vi.spyOn(performance, 'now');
  wallClock.mockReturnValue(expiresAt - remaining);
  monotonicClock.mockReturnValue(1000);
  const append = nats.store.append.bind(nats.store);
  async function checkDeadline(command: AppendCommand) {
    expect(command.deadline).toBe(expectedDeadline);
    return append(command);
  }
  const fault = vi.spyOn(nats.store, 'append');
  fault.mockImplementationOnce(checkDeadline);
  try {
    expect((await test.select()).status).toBe('selected');
    expect(fault).toHaveBeenCalledTimes(1);
  } finally {
    fault.mockRestore();
    wallClock.mockRestore();
    monotonicClock.mockRestore();
  }
}
it.each([[500, 1500], [5000, 3000]])(
  'caps the append deadline with %i milliseconds left at %i', appendDeadline);

async function applyAccessEvent(event: StoredEvent['event']) {
  await nats.seed([event]);
  const auth = memberAuthorisation(binding);
  await auth.handler.handle(event, pgDb(storage.queue));
}

function revokeDirect(userId: string, typed = true) {
  const fields = { resourceType: 'mcp_server', resourceId: 'server',
    granteeId: userId, revokedBy: userId };
  let data: unknown = fields;
  if (typed) {
    data = { ...fields, granteeKind: 'member' };
  }
  return envelope('test', grantStream('mcp_server', 'server'), 'grant.revoked', data);
}

async function teamAccess(test: Awaited<ReturnType<typeof fixture>>) {
  const teamId = `group-${test.userId}`;
  const subject = `team-${teamId}`;
  const created = envelope('test', subject, 'team.created', {
    teamId, name: 'Test group', createdBy: test.userId,
  });
  const added = envelope('test', subject, 'team.member_added', {
    teamId, memberId: test.userId, addedBy: test.userId,
  });
  const grant = envelope('test', grantStream('mcp_server', 'server'), 'grant.given', {
    resourceType: 'mcp_server', resourceId: 'server', granteeKind: 'team',
    granteeId: teamId, grantedBy: test.userId,
  });
  await applyAccessEvent(created);
  await applyAccessEvent(added);
  await applyAccessEvent(grant);
  await applyAccessEvent(revokeDirect(test.userId));
  return { teamId, subject };
}

async function delayedRevocation(kind: string) {
  const test = await fixture();
  let event = revokeDirect(test.userId, false);
  if (kind !== 'untyped direct') {
    const team = await teamAccess(test);
    if (kind === 'team removal') {
      event = envelope('test', team.subject, 'team.member_removed', {
        teamId: team.teamId, memberId: test.userId, removedBy: test.userId,
      });
    } else {
      const fields = { resourceType: 'mcp_server', resourceId: 'server',
        granteeId: team.teamId, revokedBy: test.userId };
      let data: unknown = fields;
      if (kind === 'team grant') {
        data = { ...fields, granteeKind: 'team' };
      }
      event = envelope('test', grantStream('mcp_server', 'server'), 'grant.revoked', data);
    }
  }
  const selected = await test.select();
  expect(await test.read()).toMatchObject({ status: 'saved_unverified' });
  await nats.seed([event]);
  const command = { ...test.command, expectedSequence: selected.sequence, changeRef: 'again' };
  const auth = memberAuthorisation(binding);
  try {
    expect((await auth.use('person', test.userId, 'mcp_server', 'server')).allowed).toBe(true);
    await expect(test.select(command)).rejects.toThrow('Selection access unavailable');
    await expect(test.read()).rejects.toThrow('Selection access unavailable');
  } finally {
    await auth.handler.handle(event, pgDb(storage.queue));
  }
  await expect(test.select(command)).rejects.toThrow('Selection access unavailable');
  await expect(test.read()).rejects.toThrow('Selection access unavailable');
  expect(await nats.store.head(test.subject)).toBe(selected.sequence);
}
it.each(['untyped direct', 'team grant', 'untyped team', 'team removal'])(
  'refuses a saved %s revocation before and after IAM applies it', delayedRevocation);

async function accessPositionRace(kind: string, timing: string) {
  const test = await fixture();
  let subject = grantStream('mcp_server', 'server');
  let event = revokeDirect(test.userId);
  if (kind === 'team') {
    const team = await teamAccess(test);
    subject = team.subject;
    event = envelope('test', subject, 'team.member_removed', {
      teamId: team.teamId, memberId: test.userId, removedBy: test.userId,
    });
  }
  const readStream = nats.store.readStream.bind(nats.store);
  const head = nats.store.head.bind(nats.store);
  const append = nats.store.append.bind(nats.store);
  let changed = false;
  async function change() {
    if (!changed) {
      changed = true;
      await nats.seed([event]);
    }
  }
  async function* changeAfterHistory(stream: string, from?: number, deadline?: number) {
    yield* readStream(stream, from, deadline);
    if (stream === subject && timing === 'before') {
      await change();
    }
  }
  async function changeDuringAccess(stream?: string, deadline?: number) {
    if (stream === `member-${test.userId}` && timing === 'during') {
      await change();
    }
    return head(stream, deadline);
  }
  async function changeAtAppend(command: AppendCommand) {
    appendFault.mockRestore();
    if (timing === 'append') {
      await change();
    }
    return append(command);
  }
  const readFault = vi.spyOn(nats.store, 'readStream');
  const headFault = vi.spyOn(nats.store, 'head');
  const appendFault = vi.spyOn(nats.store, 'append');
  readFault.mockImplementation(changeAfterHistory);
  headFault.mockImplementation(changeDuringAccess);
  appendFault.mockImplementationOnce(changeAtAppend);
  try {
    let message = 'Authority changed';
    if (timing === 'before') {
      message = 'Selection conflict';
    } else if (timing === 'append') {
      message = 'Selection append unconfirmed';
    }
    await expect(test.select()).rejects.toThrow(message);
    expect(changed).toBe(true);
  } finally {
    readFault.mockRestore();
    headFault.mockRestore();
    appendFault.mockRestore();
    if (changed) {
      const auth = memberAuthorisation(binding);
      await auth.handler.handle(event, pgDb(storage.queue));
    }
  }
  expect(await nats.store.head(test.subject)).toBe(0);
}
const accessRaces = [
  ['grant', 'before'], ['grant', 'during'], ['grant', 'append'],
  ['team', 'before'], ['team', 'during'], ['team', 'append'],
];
it.each(accessRaces)('refuses a %s change %s the write access check', accessPositionRace);

async function readMembershipDenial(state: string) {
  const test = await fixture();
  if (state !== 'absent') {
    const selected = await test.select();
    if (state === 'cleared') {
      const clear = { action: 'clear', serverId: 'server', connectionId: 'installed',
        expectedSequence: selected.sequence, changeRef: 'clear' };
      await test.select(clear);
    }
  }
  await changeProfile(test, 'remove');
  await expect(test.read()).rejects.toThrow('Active silo membership required');
}
it.each(['saved', 'absent', 'cleared'])(
  'refuses reading a %s selection after membership ends', readMembershipDenial);

async function wrongReadIdentity(field: 'userId' | 'serverId') {
  const test = await fixture();
  const selected = await test.select();
  const rows = await history(nats.store, test.subject, 'test');
  const row = rows[0]!;
  const data = connectionSelectedDataSchema.parse(row.event.data);
  data[field] = 'another';
  row.event.data = data;
  row.event.subject = `connection-selection-${data.userId}-${data.serverId}`;
  row.event.principal = { kind: 'human', id: data.userId };
  const hash = createHash('sha256');
  hash.update(JSON.stringify([row.event.silo, row.event.subject, row.event.commandId]));
  row.event.id = hash.digest('hex');
  expect(foldConnectionSelection(rows).selected).toEqual(data);
  const profiles = await history(nats.store, test.profileSubject, 'test');
  const profile = connectionCreatedDataSchema.parse(profiles[0]!.event.data);
  profile.userId = data.userId;
  profile.serverId = data.serverId;
  profile.activation!.changedBy = data.userId;
  const profileSubject = `connection-${data.userId}-${data.serverId}-personal`;
  profiles[0]!.event.subject = profileSubject;
  profiles[0]!.event.principal = { kind: 'human', id: data.userId };
  profiles[0]!.event.data = profile;
  expect(foldConnection(profiles).status).toBe('saved_unverified');
  const serverRows = await history(nats.store, 'mcp-server', 'test');
  const server = structuredClone(serverRows);
  for (const record of server) {
    const fields = eventData(record.event);
    if (record.event.type === 'mcp.tools_changed' && fields['catalogue']) {
      const catalogue = mcpServerDiscoveredDataSchema.parse(fields['catalogue']);
      fields['catalogue'] = { ...catalogue, serverId: data.serverId };
    }
    record.event.subject = `mcp-${data.serverId}`;
    record.event.data = { ...fields, serverId: data.serverId };
  }
  expect(toolPolicyFromRows(server).published).toBe(true);
  const readStream = nats.store.readStream.bind(nats.store);
  async function* substituteIdentity(subject: string, from?: number, deadline?: number) {
    if (subject === test.subject) {
      yield* rows;
    } else if (subject === profileSubject) {
      yield* profiles;
    } else if (subject === `mcp-${data.serverId}`) {
      yield* server;
    } else {
      yield* readStream(subject, from, deadline);
    }
  }
  const fault = vi.spyOn(nats.store, 'readStream');
  fault.mockImplementation(substituteIdentity);
  try {
    expect(await test.read()).toEqual({ status: 'unavailable', sequence: selected.sequence });
  } finally {
    fault.mockRestore();
  }
}
it.each(['userId', 'serverId'] as const)(
  'never exposes a valid saved choice for a different %s', wrongReadIdentity);

async function readWithoutWriteDeadline() {
  const test = await fixture();
  const selected = await test.select();
  const readStream = nats.store.readStream.bind(nats.store);
  const head = vi.spyOn(nats.store, 'head');
  const clock = vi.spyOn(performance, 'now');
  let now = 1000;
  clock.mockImplementation(currentTime);
  function currentTime() {
    return now;
  }
  async function* slowHistory(subject: string, from?: number, deadline?: number) {
    expect(subject.startsWith('conversation-')).toBe(false);
    yield* readStream(subject, from, deadline);
    if (subject === test.profileSubject || subject === `member-${test.userId}`) {
      now += 2500;
    }
  }
  const read = vi.spyOn(nats.store, 'readStream');
  read.mockImplementation(slowHistory);
  try {
    expect(await test.read()).toMatchObject({ status: 'saved_unverified',
      sequence: selected.sequence });
    for (const call of head.mock.calls) {
      expect(call[0]).toBe(`connection-control-${test.userId}-server`);
    }
    const subjects = read.mock.calls.map(readSubject);
    expect(subjects).toEqual([test.subject, 'mcp-server', test.profileSubject,
      grantStream('mcp_server', 'server'), ...teamSubjects(subjects),
      `member-${test.userId}`, 'ownership-test']);
  } finally {
    read.mockRestore();
    head.mockRestore();
    clock.mockRestore();
  }
}
function readSubject(call: [string, ...unknown[]]) {
  return call[0];
}
function teamSubjects(subjects: string[]) {
  function isTeam(subject: string) {
    return subject.startsWith('team-');
  }
  return subjects.filter(isTeam);
}
it('checks read access once without starting a two-second write deadline', readWithoutWriteDeadline);

async function independentChoices() {
  const first = await fixture();
  const second = await fixture();
  const firstChoice = await first.select();
  const secondChoice = await second.select();
  const clear = { action: 'clear', serverId: 'server', connectionId: 'installed',
    expectedSequence: firstChoice.sequence, changeRef: 'clear' };
  await first.select(clear);
  expect(await first.read()).toMatchObject({ status: 'unavailable' });
  expect(await second.read()).toEqual({ status: 'saved_unverified', sequence: secondChoice.sequence,
    profileId: 'personal', profileRevision: second.created.sequence });
  expect(await nats.store.head(`connection-control-${first.userId}-server`)).toBe(0);
  expect(await nats.store.head(first.profileSubject)).toBe(first.created.sequence);
  expect(await nats.store.head(second.profileSubject)).toBe(second.created.sequence);
}
it('keeps choices, profiles and control streams separate for two people using the same reference',
  independentChoices);

async function historyBeforeWriteAccess() {
  const test = await fixture();
  const readStream = nats.store.readStream.bind(nats.store);
  const clock = vi.spyOn(performance, 'now');
  let now = 1000;
  function currentTime() {
    return now;
  }
  clock.mockImplementation(currentTime);
  async function* slowFacts(subject: string, from?: number, deadline?: number) {
    expect(subject.startsWith('conversation-')).toBe(false);
    yield* readStream(subject, from, deadline);
    if (subject === test.profileSubject) {
      now += 2500;
    }
  }
  const read = vi.spyOn(nats.store, 'readStream');
  read.mockImplementation(slowFacts);
  try {
    expect((await test.select()).status).toBe('selected');
  } finally {
    read.mockRestore();
    clock.mockRestore();
  }
}
it('finishes profile history before starting the two-second write access check',
  historyBeforeWriteAccess);


async function releaseFixture() {
  const test = await fixture();
  const selection = await test.select();
  const issuedAt = Date.now();
  const release = { requestId: `release-${test.userId}`, permitId: `permit-${test.userId}`,
    leaseId: `lease-${test.userId}`, purpose: 'tool_call' as const,
    userId: test.userId, ownerId: test.userId, ownerKind: 'personal' as const,
    assistantId: test.userId, computerId: 'computer', computerGeneration: 1,
    conversationId: test.userId, turnId: test.userId, threadId: 'thread',
    serverId: 'server', toolName: 'read', connectionId: 'installed', profileId: 'personal',
    generation: 1, profileRevision: test.created.sequence, selectionRevision: selection.sequence,
    policyRevision: await nats.store.head('mcp-server'),
    argumentsDigest: 'a'.repeat(64), scopeDigest: releaseDigest([]), accountDigest: releaseDigest(null),
    issuedAt, expiresAt: issuedAt + 30_000 };
  const decision = envelope('test', `decision-${release.requestId}`, 'decision.recorded', {
    requestId: release.requestId, requesterId: test.userId, assistantId: release.assistantId,
    conversationId: release.conversationId, turnId: release.turnId, permitId: release.permitId,
    serverId: release.serverId, toolName: release.toolName, route: 'mcp', outcome: 'allow',
    reason: 'policy_allow', contextDigest: 'd'.repeat(64), release,
  });
  decision.correlation.approval = 'approval';
  await nats.seed([decision]);
  const turn = envelope('test', `computer-${test.userId}`, 'computer.turn_started', {
    assistantId: test.userId, computerId: 'computer', conversationId: test.userId,
    turnId: test.userId, threadId: 'thread', requesterId: test.userId, task: 'chat_turn',
  });
  turn.source = 'opencrane-server';
  await nats.seed([turn]);
  async function prepareAccess() {
    const activity = await approvalActivity(nats.store, 'test', release.assistantId,
      release.conversationId, release.turnId, performance.now() + 10_000);
    requireActiveConversationTurn(activity.conversation, release.turnId);
    if (activity.computer.firstClose) throw new Error('Stopped');
    const fresh = await authorityFence(nats.store, performance.now());
    await activeMember(nats.store, binding, test.userId, { requiredRole: 'member', fresh });
    async function checkAccess() {
      await activity.confirm(fresh.deadline, true);
      await fresh();
    }
    return { deadline: fresh.deadline, checkAccess };
  }
  async function confirm(raw: unknown = release, action: 'append' | 'recover' = 'append') {
    return confirmCredentialRelease(nats.store, 'test', test.userId, decision.id, raw,
      prepareAccess, action);
  }
  return { ...test, release, decision, confirm, prepareAccess,
    releaseSubject: `credential-${release.requestId}` };
}

async function confirmsReleaseOnce() {
  const test = await releaseFixture();
  const budgetBefore = await nats.store.head('budget-test');
  const first = await test.confirm();
  expect(first.status).toBe('confirmed');
  expect(first.eventId).toBe(`${test.decision.id}:release`);
  expect(first.sequence).toBeGreaterThan(0);
  expect(await test.confirm()).toEqual(first);
  const rows = await history(nats.store, test.releaseSubject, 'test');
  expect(rows).toHaveLength(1);
  expect(rows[0]!.event.data).toEqual(test.release);
  expect(rows[0]!.event.correlation).toMatchObject({ request: test.decision.id,
    approval: 'approval', permit: test.release.permitId });
  expect(await nats.store.head('budget-test')).toBe(budgetBefore);
  expect(test.custody.stage).not.toHaveBeenCalled();
}
it('confirms one exact release audit without custody, forwarding or another budget',
  confirmsReleaseOnce);

async function changedRelease(patch: Record<string, unknown>) {
  const test = await releaseFixture();
  await expect(test.confirm({ ...test.release, ...patch })).rejects.toThrow('Release unavailable');
  expect(await nats.store.head(test.releaseSubject)).toBe(0);
}
it.each([{ requestId: 'other' }, { purpose: 'discovery' }, { generation: 2 },
  { ownerId: 'other' }, { userId: 'other' }, { threadId: 'other' }, { turnId: 'other' },
  { permitId: 'other' }, { expiresAt: 1 }, { scopeDigest: 'e'.repeat(64) },
  { accountDigest: 'e'.repeat(64) }, { argumentsDigest: 'e'.repeat(64) },
  { computerGeneration: 2 }, { selectionRevision: 1 }, { policyRevision: 1 }])(
  'refuses changed release binding %j', changedRelease);

async function releaseAppendFailure(saved: boolean | 'unknown') {
  const test = await releaseFixture();
  const append = nats.store.append.bind(nats.store);
  async function loseReply(command: AppendCommand) {
    if (saved === 'unknown') return { status: 'unavailable' as const, cause: 'private-canary' };
    if (saved) await append(command);
    throw new Error('private-secret-canary');
  }
  const failure = vi.spyOn(nats.store, 'append').mockImplementationOnce(loseReply);
  await expect(test.confirm()).rejects.toThrow(/^Release unavailable$/u);
  failure.mockRestore();
  const rows = await history(nats.store, test.releaseSubject, 'test');
  expect(rows).toHaveLength(saved === true ? 1 : 0);
  const spy = vi.spyOn(nats.store, 'append');
  if (saved === true) {
    expect(await test.confirm(test.release, 'recover')).toMatchObject({
      status: 'confirmed', sequence: rows[0]!.sequence });
  } else {
    await expect(test.confirm(test.release, 'recover')).rejects.toThrow('Release unavailable');
  }
  expect(spy).not.toHaveBeenCalled();
  spy.mockRestore();
}
it.each([false, true, 'unknown'] as const)('returns no receipt on an outage or lost append reply: saved=%s',
  releaseAppendFailure);

async function racingRelease() {
  const test = await releaseFixture();
  const outcomes = await Promise.allSettled([test.confirm(), test.confirm()]);
  expect(outcomes.some(isFulfilled)).toBe(true);
  const rows = await history(nats.store, test.releaseSubject, 'test');
  expect(rows).toHaveLength(1);
  expect(await test.confirm()).toMatchObject({ sequence: rows[0]!.sequence });
}
function isFulfilled(result: PromiseSettledResult<unknown>) {
  return result.status === 'fulfilled';
}
it('racing audit confirmations retain one saved identity', racingRelease);

async function invalidatesRelease(kind: string) {
  const test = await releaseFixture();
  let changed = false;
  async function changedAccess() {
    if (kind === 'expiry') {
      vi.spyOn(Date, 'now').mockReturnValue(test.release.expiresAt);
    } else if (kind === 'policy') {
      await publishServer();
    } else if (kind === 'selection') {
      const clear = { action: 'clear', serverId: 'server', connectionId: 'installed',
        expectedSequence: test.release.selectionRevision, changeRef: 'clear-release' };
      await test.select(clear);
    } else if (kind === 'stop') {
      const stop = envelope('test', `conversation-${test.userId}`, 'agent.turn_stop_requested', {
        conversationId: test.userId, turnId: test.userId, requestedBy: test.userId,
      });
      await nats.seed([stop]);
    } else if (kind === 'disable') {
      const disabled = envelope('test', `connection-control-${test.userId}-server`,
        'connection.disabled', { userId: test.userId, serverId: 'server', profile: 'personal',
          disabledBy: 'admin', expectedSequence: 0, reason: 'admin_disabled' });
      await nats.seed([disabled]);
    } else {
      const event = envelope('test', test.profileSubject, 'connection.revoked', {
        userId: test.userId, serverId: 'server', profile: 'personal', revokedBy: test.userId,
      });
      await nats.seed([event]);
    }
    changed = true;
    return test.prepareAccess();
  }
  try {
    await expect(confirmCredentialRelease(nats.store, 'test', test.userId, test.decision.id,
      test.release, changedAccess)).rejects.toThrow('Release unavailable');
    expect(changed).toBe(true);
    expect(await nats.store.head(test.releaseSubject)).toBe(0);
  } finally {
    vi.restoreAllMocks();
  }
}
it.each(['expiry', 'policy', 'selection', 'revoke', 'disable', 'stop'])(
  'refuses %s changed while checking access', invalidatesRelease);

async function forgedRelease(legacy: boolean) {
  const test = await releaseFixture();
  const { requestId, permitId, connectionId, profileId, leaseId, generation } = test.release;
  const old = { requestId, permitId, connectionId, profileId, leaseId, generation };
  const event = envelope('test', test.releaseSubject, 'credential.released',
    legacy ? old : test.release, `${test.decision.id}:release`);
  event.source = 'untrusted';
  await nats.seed([event]);
  await expect(test.confirm()).rejects.toThrow('Release unavailable');
  expect(await history(nats.store, test.releaseSubject, 'test')).toHaveLength(1);
}
it.each([true, false])('legacy or forged saved audit cannot confirm: legacy=%s', forgedRelease);

function releaseDigest(value: unknown) {
  const hash = createHash('sha256');
  hash.update(JSON.stringify(value));
  return hash.digest('hex');
}

async function delayedReleaseHistory() {
  const test = await releaseFixture();
  const readStream = nats.store.readStream.bind(nats.store);
  let accessStarted = false;
  let delayed = false;
  async function* read(subject: string, ...rest: Parameters<typeof readStream> extends
    [string, ...infer Rest] ? Rest : never) {
    if (subject === `decision-${test.release.requestId}` && !delayed) {
      expect(accessStarted).toBe(false);
      delayed = true;
      await delay(2100);
    }
    yield* readStream(subject, ...rest);
  }
  async function access() {
    accessStarted = true;
    return test.prepareAccess();
  }
  const spy = vi.spyOn(nats.store, 'readStream').mockImplementation(read);
  try {
    const result = await confirmCredentialRelease(nats.store, 'test', test.userId,
      test.decision.id, test.release, access);
    expect(result.status).toBe('confirmed');
  } finally {
    spy.mockRestore();
  }
}
it('loads delayed release history before starting the short access check', delayedReleaseHistory);

async function refusedInsideReleaseAppend() {
  const test = await releaseFixture();
  const append = nats.store.append.bind(nats.store);
  async function stopped(command: AppendCommand) {
    const stop = envelope('test', `conversation-${test.userId}`, 'agent.turn_stop_requested', {
      conversationId: test.userId, turnId: test.userId, requestedBy: test.userId,
    });
    await nats.seed([stop]);
    return append(command);
  }
  const spy = vi.spyOn(nats.store, 'append').mockImplementationOnce(stopped);
  try {
    await expect(test.confirm()).rejects.toThrow('Release unavailable');
    expect(await nats.store.head(test.releaseSubject)).toBe(0);
  } finally {
    spy.mockRestore();
  }
}
it('checks a saved Stop inside the conditional release append', refusedInsideReleaseAppend);

async function releasePreparationRefusal(change: string, failedHistory: string) {
  const test = await releaseFixture();
  let event;
  if (change === 'removed') {
    event = envelope('test', `member-${test.userId}`, 'member.removed', {
      memberId: test.userId, removedBy: 'owner',
    });
  } else {
    event = envelope('test', `member-${test.userId}`, 'member.role_changed', {
      memberId: test.userId, previousRole: 'admin', newRole: 'member', changedBy: 'owner',
    });
  }
  await nats.seed([event]);
  const readStream = nats.store.readStream.bind(nats.store);
  async function* read(subject: string, from?: number, deadline?: number) {
    const failedSubject = failedHistory === 'decision' ? test.decision.subject : test.profileSubject;
    if (failedHistory !== 'none' && subject === failedSubject) {
      throw new Error('private-history-canary');
    }
    yield* readStream(subject, from, deadline);
  }
  let refusal: unknown;
  async function prepareAccess(): Promise<never> {
    try {
      await activeMember(nats.store, binding, test.userId, { requiredRole: 'admin' });
    } catch (error) {
      refusal = error;
      throw error;
    }
    throw new Error('Expected access refusal');
  }
  const permission = vi.fn(prepareAccess);
  const reads = vi.spyOn(nats.store, 'readStream');
  reads.mockImplementation(read);
  const writes = vi.spyOn(nats.store, 'append');
  try {
    const pending = confirmCredentialRelease(nats.store, 'test', test.userId,
      test.decision.id, test.release, permission);
    await expect(pending).rejects.toBeInstanceOf(MemberAccessRefused);
    await expect(pending).rejects.toBe(refusal);
    expect(permission).toHaveBeenCalledTimes(1);
    expect(writes).not.toHaveBeenCalled();
    expect(await nats.store.head(test.releaseSubject)).toBe(0);
    expect(test.custody.stage).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
  }
}
it.each([
  ['removed', 'none'], ['removed', 'decision'], ['removed', 'profile'],
  ['demoted', 'none'], ['demoted', 'decision'], ['demoted', 'profile'],
])('preserves release refusal for %s access with failed %s history', releasePreparationRefusal);

async function releaseHistoryFailureAfterPermission(failedHistory: string) {
  const test = await releaseFixture();
  const readStream = nats.store.readStream.bind(nats.store);
  async function* read(subject: string, from?: number, deadline?: number) {
    const failedSubject = failedHistory === 'decision' ? test.decision.subject : test.profileSubject;
    if (subject === failedSubject) {
      throw new Error('private-history-canary');
    }
    yield* readStream(subject, from, deadline);
  }
  const reads = vi.spyOn(nats.store, 'readStream');
  reads.mockImplementation(read);
  const permission = vi.fn(test.prepareAccess);
  const writes = vi.spyOn(nats.store, 'append');
  try {
    const pending = confirmCredentialRelease(nats.store, 'test', test.userId,
      test.decision.id, test.release, permission);
    await expect(pending).rejects.toThrow(/^Release unavailable$/u);
    await expect(pending).rejects.not.toHaveProperty('cause');
    expect(permission).toHaveBeenCalledTimes(1);
    expect(writes).not.toHaveBeenCalled();
    expect(await nats.store.head(test.releaseSubject)).toBe(0);
  } finally {
    vi.restoreAllMocks();
  }
}
it.each(['decision', 'profile'])(
  'sanitises failed %s release history after one permission decision',
  releaseHistoryFailureAfterPermission);

const invalidReleaseBindings = [{ generation: 0 }, { ownerId: 'other' }, { userId: 'other' }];

async function releaseValidationRefusal(patch: Record<string, unknown>) {
  const messages = ['Active silo membership required', 'Owner or Admin required'];
  for (const message of messages) {
    const test = await releaseFixture();
    const refusal = new MemberAccessRefused(message);
    function prepareAccess(): Promise<never> {
      return Promise.reject(refusal);
    }
    const permission = vi.fn(prepareAccess);
    const writes = vi.spyOn(nats.store, 'append');
    const raw = { ...test.release, ...patch };
    try {
      const pending = confirmCredentialRelease(nats.store, 'test', test.userId,
        test.decision.id, raw, permission);
      await expect(pending).rejects.toBe(refusal);
      expect(permission).toHaveBeenCalledTimes(1);
      expect(writes).not.toHaveBeenCalled();
      expect(await nats.store.head(test.releaseSubject)).toBe(0);
      expect(test.custody.stage).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  }
}
it.each(invalidReleaseBindings)(
  'preserves removed and demoted release refusals with invalid binding %j',
  releaseValidationRefusal);

async function releaseValidationAfterPermission(patch: Record<string, unknown>) {
  const test = await releaseFixture();
  const permission = vi.fn(test.prepareAccess);
  const writes = vi.spyOn(nats.store, 'append');
  const raw = { ...test.release, ...patch };
  try {
    const pending = confirmCredentialRelease(nats.store, 'test', test.userId,
      test.decision.id, raw, permission);
    await expect(pending).rejects.toThrow(/^Release unavailable$/u);
    await expect(pending).rejects.not.toHaveProperty('cause');
    expect(permission).toHaveBeenCalledTimes(1);
    expect(writes).not.toHaveBeenCalled();
    expect(await nats.store.head(test.releaseSubject)).toBe(0);
    expect(test.custody.stage).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
  }
}
it.each(invalidReleaseBindings)(
  'sanitises invalid release binding %j after one permission decision',
  releaseValidationAfterPermission);

async function releaseAppendAccessRefusal(message: string, laterFailure: string) {
  const test = await releaseFixture();
  const refusal = new MemberAccessRefused(message);
  let appending = false;
  async function prepareAccess() {
    const access = await test.prepareAccess();
    async function checkAccess() {
      if (appending) {
        throw refusal;
      }
      await access.checkAccess();
    }
    return { deadline: access.deadline, checkAccess };
  }
  const permission = vi.fn(prepareAccess);
  const append = nats.store.append.bind(nats.store);
  async function appendFailure(command: AppendCommand) {
    appending = true;
    const result = await append(command);
    expect(result.status).toBe('unavailable');
    if (laterFailure === 'throw') {
      throw new Error('private-append-canary');
    }
    if (laterFailure === 'return') {
      return { status: 'unavailable' as const, cause: new Error('private-append-canary') };
    }
    return result;
  }
  const writes = vi.spyOn(nats.store, 'append');
  writes.mockImplementationOnce(appendFailure);
  try {
    const pending = confirmCredentialRelease(nats.store, 'test', test.userId,
      test.decision.id, test.release, permission);
    await expect(pending).rejects.toBe(refusal);
    expect(permission).toHaveBeenCalledTimes(1);
    expect(writes).toHaveBeenCalledTimes(1);
    expect(await nats.store.head(test.releaseSubject)).toBe(0);
    expect(test.custody.stage).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
  }
}
it.each([
  ['Active silo membership required', 'none'], ['Owner or Admin required', 'none'],
  ['Active silo membership required', 'throw'], ['Owner or Admin required', 'throw'],
  ['Active silo membership required', 'return'], ['Owner or Admin required', 'return'],
])('preserves release append refusal %s through a later %s failure', releaseAppendAccessRefusal);


async function releaseReplayAfterRestart() {
  let upstreamBytes = 0;
  function received(bytes: Buffer) {
    upstreamBytes += bytes.length;
  }
  function connected(socket: Socket) {
    socket.on('data', received);
  }
  const upstream = createServer(connected);
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const address = upstream.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  await publishServer(`https://127.0.0.1:${address.port}/mcp`);
  const test = await releaseFixture();
  // Custody uses fetch; access checks use the real OpenFGA adapter separately.
  const custodyReads = vi.spyOn(globalThis, 'fetch');
  try {
    const first = await test.confirm();
    await nats.stop();
    await nats.restart();
    const restarted = await createEventStore(await nats.client('command'));
    const rows = await history(restarted, test.releaseSubject, 'test');
    expect(rows).toHaveLength(1);
    const append = vi.spyOn(restarted, 'append');
    const receipt = await confirmCredentialRelease(restarted, 'test', test.userId,
      test.decision.id, test.release, test.prepareAccess);
    expect(receipt).toEqual(first);
    expect(Object.keys(receipt)).toEqual(['status', 'eventId', 'sequence']);
    expect(append).not.toHaveBeenCalled();
    expect(custodyReads).not.toHaveBeenCalled();
    expect(upstreamBytes).toBe(0);
    append.mockRestore();
  } finally {
    custodyReads.mockRestore();
    upstream.close();
    await once(upstream, 'close');
  }
}
// Run this case last because restarting closes the shared fixture's original store.
it('replay and a restarted store recover audit evidence without a sending capability',
  releaseReplayAfterRestart);
