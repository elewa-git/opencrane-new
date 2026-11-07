import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { createStore, grantStream, memberAuthorisation } from '@opencrane/authz';
import { databases, openfga } from '@opencrane/authz/testing';
import { natsFixture } from '@opencrane/event-store/testing';
import { companyConnectionCreatedDataSchema } from '@opencrane/events';
import type { StoredEvent } from '@opencrane/event-store';
import { pgDb } from '@opencrane/projections';
import { data } from '../src/state.ts';
import { envelope, history } from '../src/actor.ts';
import { connectionOperationId } from '../src/bearer-connections.ts';
import { changeConnectionSelection, foldConnectionSelection, readConnectionSelection }
  from '../src/connection-selection.ts';
import { readOwnSelectionChange } from '../src/connection-selection-change-read.ts';
import { oauthConfigurationDigest } from '../src/oauth-attempt.ts';
import { oauthSelectionFixture } from './support/oauth-selection.ts';

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
}
async function close() {
  await storage?.close();
  await fga?.close();
  await nats?.close();
}
beforeAll(initialise, 120_000);
afterAll(close);
afterEach(vi.restoreAllMocks);

async function fixture() {
  counter += 1;
  const userId = `requester${counter}`;
  const serverId = `server${counter}`;
  const joined = envelope('test', `member-${userId}`, 'member.joined', {
    memberId: userId, role: 'member', email: `${userId}@example.test`, displayName: userId,
  });
  const grant = envelope('test', grantStream('mcp_server', serverId), 'grant.given', {
    resourceType: 'mcp_server', resourceId: serverId, granteeKind: 'member',
    granteeId: userId, grantedBy: 'admin',
  });
  await nats.seed([joined, grant]);
  const auth = memberAuthorisation(binding);
  await auth.handler.handle(joined, pgDb(storage.queue));
  await auth.handler.handle(grant, pgDb(storage.queue));
  const personal = await oauthSelectionFixture(nats, userId, serverId, 'shared');
  const serverRows = await history(nats.store, `mcp-${serverId}`, 'test');
  const registrationRevision = serverRows[0]!.sequence;
  const optInSubject = `connection-company-${serverId}`;
  const optIn = envelope('test', optInSubject, 'connection.company_opt_in_set', {
    serverId, connectionId: 'installed', registrationRevision, enabled: true,
    changedBy: 'admin', expectedSequence: 0,
  }, connectionOperationId('test', optInSubject, 'enable'));
  optIn.source = 'opencrane-server';
  optIn.commandId = 'enable';
  optIn.principal = { kind: 'human', id: 'admin' };
  await nats.seed([optIn]);
  const subject = `connection-company:${serverId}:shared`;
  const operationId = connectionOperationId('test', subject, 'save');
  const activation = { connectionId: 'installed', ownerKind: 'company', purpose: 'company',
    generation: 1, uid: 'uid', resourceVersion: '1',
    endpointDigest: personal.configuration.endpointDigest, operationId, changedBy: 'admin',
    expectedSequence: 0, appendUntil: Date.now() + 60_000, reason: 'bearer_create',
    registrationRevision, optInRevision: await nats.store.head(optInSubject) };
  const saved = envelope('test', subject, 'connection.created', {
    siloId: 'test', custodianId: 'admin', serverId, profile: 'shared',
    secretRef: 'secret:synthetic', activation,
  }, operationId);
  saved.source = 'opencrane-server';
  saved.commandId = 'save';
  saved.principal = { kind: 'human', id: 'admin' };
  await nats.seed([saved]);
  const revision = await nats.store.head(subject);
  // Supply synthetic verification separately. Saved bearer records alone remain unverified.
  const evidence = { status: 'verified', siloId: 'test', serverId, profileId: 'shared',
    ownerKind: 'company', connectionId: 'installed', profileRevision: revision, generation: 1,
    accountDigest: 'a'.repeat(64), configurationDigest: oauthConfigurationDigest(personal.configuration),
    scopes: ['openid', 'read', 'write'], expiresAt: Date.now() + 120_000 };
  function verifiedProfile(rows: StoredEvent[]) {
    expect(rows.at(-1)?.sequence).toBeGreaterThanOrEqual(revision);
    return evidence;
  }
  const command = { ...personal.command, ownerKind: 'company', profileRevision: revision };
  async function select(input: unknown = command) {
    return changeConnectionSelection(nats.store, binding, userId, input,
      personal.loadConfiguration, verifiedProfile);
  }
  const selectionSubject = `connection-selection-${userId}-${serverId}`;
  async function rows() {
    return history(nats.store, selectionSubject, 'test');
  }
  return { userId, serverId, personal, subject, optInSubject, evidence, command, select, rows, verifiedProfile };
}

async function explicitChoice() {
  const test = await fixture();
  expect(foldConnectionSelection(await test.rows()).selected).toBeNull();
  const absent = await readConnectionSelection(nats.store, binding, test.userId, test.serverId,
    test.personal.loadConfiguration, 'read');
  expect(absent).toEqual({ status: 'unavailable', sequence: 0 });
  test.evidence.scopes = ['openid', 'read'];
  const append = vi.spyOn(nats.store, 'append');
  const selected = await test.select();
  expect(append).toHaveBeenCalledTimes(1);
  const rows = await test.rows();
  expect(rows).toHaveLength(1);
  expect(rows[0]!.event.data).toEqual({ action: 'select', userId: test.userId,
    serverId: test.serverId, connectionId: 'installed', profileId: 'shared',
    profileRevision: test.command.profileRevision, expectedSequence: 0, ownerKind: 'company',
    siloId: 'test', generation: 1, accountDigest: test.evidence.accountDigest });
  const network = vi.spyOn(globalThis, 'fetch');
  expect(foldConnectionSelection(rows).selected).toEqual(rows[0]!.event.data);
  expect(network).not.toHaveBeenCalled();
  const foreign = structuredClone(rows);
  foreign[0]!.event.data = { ...data(foreign[0]!.event), siloId: 'foreign' };
  expect(foldConnectionSelection(foreign).selected).toBeNull();
  // Keep the existing personal dispatch reader closed to company choices.
  const read = await readConnectionSelection(nats.store, binding, test.userId, test.serverId,
    test.personal.loadConfiguration, 'read');
  expect(read).toEqual({ status: 'unavailable', sequence: selected.sequence });
  const clear = { action: 'clear', serverId: test.serverId, connectionId: 'installed',
    expectedSequence: selected.sequence, changeRef: 'clear' };
  await test.select(clear);
  const cleared = await test.rows();
  expect(foldConnectionSelection([...cleared, ...rows]).selected).toBeNull();
}
it('records one exact company choice and replays without selecting the existing personal profile',
  explicitChoice);

async function refusesEvidence(field: string, value: unknown) {
  const test = await fixture();
  Object.assign(test.evidence, { [field]: value });
  const append = vi.spyOn(nats.store, 'append');
  await expect(test.select()).rejects.toThrow(/^Selection (conflict|unavailable)$/u);
  expect(append).not.toHaveBeenCalled();
  expect(await test.rows()).toHaveLength(0);
}
it.each([
  ['status', 'saved_unverified'], ['status', 'pending'], ['status', 'disabled'],
  ['siloId', 'foreign'], ['serverId', 'foreign'], ['profileId', 'foreign'],
  ['ownerKind', 'personal'], ['profileRevision', 1], ['generation', 0],
  ['scopes', ['openid']], ['configurationDigest', 'b'.repeat(64)], ['expiresAt', 1],
])('refuses company evidence with %s=%j before append', refusesEvidence);

async function refusesDefault() {
  const test = await fixture();
  await expect(changeConnectionSelection(nats.store, binding, test.userId,
    test.command, test.personal.loadConfiguration)).rejects.toThrow();
  const personalCommand = { ...test.personal.command, ownerKind: 'personal' };
  await test.select(personalCommand);
  const selected = foldConnectionSelection(await test.rows()).selected;
  expect(selected).toMatchObject({ ownerKind: 'personal',
    profileRevision: test.personal.revision });
}
it('refuses an unverified company bearer and still permits an explicit own personal choice',
  refusesDefault);

async function changedHistory(kind: string, duringAppend: boolean) {
  const test = await fixture();
  let subject = test.subject;
  let type = 'connection.revoked';
  let fields: object = { userId: 'admin', serverId: test.serverId, profile: 'shared',
    revokedBy: 'admin' };
  if (kind === 'opt-in') {
    subject = test.optInSubject;
    type = 'connection.company_opt_in_set';
    const old = await history(nats.store, subject, 'test');
    fields = { ...data(old[0]!.event), enabled: false };
  } else if (kind === 'publication') {
    subject = `mcp-${test.serverId}`;
    type = 'mcp.server_unpublished';
    fields = { serverId: test.serverId, unpublishedBy: 'admin' };
  }
  if (kind === 'disabled') {
    type = 'connection.disabled';
    fields = { userId: 'admin', serverId: test.serverId, profile: 'shared',
      disabledBy: 'admin', expectedSequence: test.command.profileRevision, reason: 'admin_disabled' };
  } else if (kind === 'rotated') {
    const old = await history(nats.store, subject, 'test');
    const previous = companyConnectionCreatedDataSchema.parse(old[0]!.event.data);
    const operationId = connectionOperationId('test', subject, 'rotate');
    type = 'connection.refreshed';
    fields = { ...previous, secretRef: 'secret:replacement',
      activation: { ...previous.activation, reason: 'bearer_rotation', generation: 2,
        expectedSequence: test.command.profileRevision, operationId } };
  } else if (kind === 'member') {
    subject = `member-${test.userId}`;
    type = 'member.removed';
    fields = { memberId: test.userId, removedBy: 'admin' };
  }
  const changed = envelope('test', subject, type, fields);
  if (kind === 'rotated') {
    changed.id = connectionOperationId('test', subject, 'rotate');
    changed.commandId = 'rotate';
    changed.source = 'opencrane-server';
    changed.principal = { kind: 'human', id: 'admin' };
  }
  if (duringAppend) {
    const append = nats.store.append.bind(nats.store);
    async function change(command: Parameters<typeof append>[0]) {
      await nats.seed([changed]);
      return append(command);
    }
    vi.spyOn(nats.store, 'append').mockImplementationOnce(change);
  } else {
    await nats.seed([changed]);
  }
  await expect(test.select()).rejects.toThrow();
  expect(await test.rows()).toHaveLength(0);
}
it.each([
  ['profile', false], ['opt-in', false], ['publication', false],
  ['disabled', false], ['rotated', false], ['member', false],
  ['profile', true], ['opt-in', true], ['publication', true],
])('refuses changed %s history, inside append=%s', changedHistory);

async function rejectedIdentity(patch: object) {
  const test = await fixture();
  await expect(test.select({ ...test.command, ...patch })).rejects.toThrow();
  expect(await test.rows()).toHaveLength(0);
}
it.each([{ userId: 'admin' }, { ownerKind: 'validation' }, { siloId: 'foreign' },
  { accountDigest: 'b'.repeat(64) }, { profileId: 'missing' }, { ownerKind: 'personal' }])(
  'refuses requester or profile overrides %j', rejectedIdentity);

async function concurrentChoices() {
  const test = await fixture();
  const other = { ...test.personal.command, ownerKind: 'personal', changeRef: 'other' };
  const results = await Promise.allSettled([test.select(), test.select(other)]);
  function fulfilled(result: PromiseSettledResult<unknown>) {
    return result.status === 'fulfilled';
  }
  expect(results.filter(fulfilled)).toHaveLength(1);
  expect(await test.rows()).toHaveLength(1);
}
it('resolves concurrent choices with one conditional append', concurrentChoices);

async function lostReply() {
  const test = await fixture();
  const append = nats.store.append.bind(nats.store);
  async function lost(command: Parameters<typeof append>[0]): Promise<never> {
    await append(command);
    throw new Error('private-canary');
  }
  vi.spyOn(nats.store, 'append').mockImplementationOnce(lost);
  await expect(test.select()).rejects.toThrow(/^Selection unavailable$/u);
  const reference = { serverId: test.serverId, changeRef: 'choice' };
  const receipt = await readOwnSelectionChange(nats.store, binding, test.userId, reference);
  await test.select({ action: 'clear', serverId: test.serverId, connectionId: 'installed',
    expectedSequence: receipt!.sequence, changeRef: 'clear' });
  test.evidence.status = 'disabled';
  expect(await test.select()).toMatchObject({ sequence: receipt!.sequence });
  await expect(test.select({ ...test.command, ownerKind: 'personal' })).rejects.toThrow();
  expect(foldConnectionSelection(await test.rows()).selected).toBeNull();
}
it('recovers the original lost reply after clearing without choosing another account', lostReply);

async function iamFailure() {
  const test = await fixture();
  const unavailable = { ...binding, apiUrl: 'http://127.0.0.1:1' };
  await expect(changeConnectionSelection(nats.store, unavailable, test.userId,
    test.command, test.personal.loadConfiguration, test.verifiedProfile)).rejects.toThrow();
  expect(await test.rows()).toHaveLength(0);
}
it('refuses unavailable IAM before append', iamFailure);
