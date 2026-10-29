import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { createStore, grantStream, memberAuthorisation } from '@opencrane/authz';
import { databases, openfga } from '@opencrane/authz/testing';
import { natsFixture } from '@opencrane/event-store/testing';
import { connectionCreatedDataSchema } from '@opencrane/events';
import { pgDb } from '@opencrane/projections';
import { envelope, history } from '../src/actor.ts';
import { connectionOperationId, foldConnection } from '../src/bearer-connections.ts';
import { readOwnSelectionChange } from '../src/connection-selection-change-read.ts';
import { changeConnectionSelection, readConnectionSelection } from '../src/connection-selection.ts';
import { MemberAccessRefused } from '../src/member-authority.ts';
import { toolPolicyFromRows } from '../src/tool-policy.ts';
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
async function fixture(sharedServer?: string) {
  counter += 1;
  const userId = `person${counter}`;
  const serverId = sharedServer ?? `server${counter}`;
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
  const saved = await oauthSelectionFixture(nats, userId, serverId);
  async function select(input: unknown = saved.command) {
    return changeConnectionSelection(nats.store, binding, userId, input, saved.loadConfiguration);
  }
  async function read(toolName?: string) {
    return readConnectionSelection(nats.store, binding, userId, serverId,
      saved.loadConfiguration, toolName);
  }
  return { ...saved, userId, serverId, select, read };
}
async function explicitOAuthChoice() {
  const test = await fixture();
  expect(await test.read()).toEqual({ status: 'unavailable', sequence: 0 });
  const selected = await test.select();
  expect(await test.read()).toEqual({ status: 'verified', sequence: selected.sequence,
    profileId: 'oauth', profileRevision: test.revision, generation: 1 });
}
it('selects only an explicitly chosen verified personal OAuth account', explicitOAuthChoice);

async function scopeChecks() {
  const test = await fixture();
  await test.select();
  expect((await test.read('read')).status).toBe('verified');
  expect((await test.read('write')).status).toBe('unavailable');
  expect((await test.read('provider-label')).status).toBe('unavailable');
  test.configuration.toolScopes.read.push('expanded');
  expect((await test.read('read')).status).toBe('unavailable');
}
it('uses actual per-tool scopes and requires reconsent when the reviewed map expands', scopeChecks);

async function refresh(test: Awaited<ReturnType<typeof fixture>>) {
  const before = test.saved.activation;
  const attemptId = connectionOperationId('test', test.subject, 'renew-refresh');
  const attempt = { ...test.fields, attemptId, configurationDigest: before.configurationDigest,
    generation: 1, expectedSequence: test.revision, scopes: before.account.scopes };
  const started = await test.seed('connection.refresh_started', attempt, attemptId, 'renew');
  const claimId = connectionOperationId('test', test.subject, `${attemptId}-exchange`);
  const appendUntil = Date.now() + 60_000;
  const claim = { ...test.fields, attemptId, workerId: 'worker', purpose: 'refresh',
    secretRef: test.saved.secretRef, uid: before.uid, resourceVersion: before.resourceVersion,
    expectedSequence: started, appendUntil };
  // Match the worker's fixed claim lifetime exactly.
  const now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
  const claimed = await test.seed('connection.oauth_exchange_claimed',
    { ...claim, appendUntil: now + 60_000 }, claimId);
  clock.mockRestore();
  const resultId = connectionOperationId('test', test.subject, `${claimId}-result`);
  const operationId = connectionOperationId('test', test.subject, `${resultId}-confirm`);
  const activation = { ...before, generation: 2, expectedSequence: claimed,
    appendUntil: now + 60_000, operationId,
    account: { ...before.account, expiresAt: before.account.expiresAt + 60_000 } };
  return test.seed('connection.refreshed', { ...test.saved, activation }, operationId, 'renew');
}
async function refreshedChoice() {
  const test = await fixture();
  const selected = await test.select();
  const currentRevision = await refresh(test);
  await expect(test.select({ ...test.command, changeRef: 'stale-choice',
    expectedSequence: selected.sequence })).rejects.toThrow('Selection conflict');
  expect(await test.read('read')).toEqual({ status: 'verified', sequence: selected.sequence,
    profileId: 'oauth', profileRevision: currentRevision, generation: 2 });
  expect((await test.read('write')).status).toBe('unavailable');
  vi.spyOn(Date, 'now').mockReturnValue(test.saved.activation.account.expiresAt);
  expect((await test.read('read')).status).toBe('verified');
  vi.spyOn(Date, 'now').mockReturnValue(test.saved.activation.account.expiresAt + 60_000);
  expect((await test.read('read')).status).toBe('unavailable');
  const rows = await history(nats.store, test.subject, 'test');
  expect(foldConnection(rows).status).toBe('unavailable');
  expect(await test.select()).toEqual(selected);
}
it('keeps the choice after refresh but uses only the current generation and expiry', refreshedChoice);

async function refusesChangedEvidence(kind: string) {
  const test = await fixture();
  const selected = await test.select();
  const rows = await history(nats.store, test.subject, 'test');
  const changed = structuredClone(test.saved);
  if (kind === 'unconfirmed') {
    rows.pop();
  }
  if (kind === 'foreign') {
    changed.userId = 'another-member';
  }
  if (kind === 'issuer') {
    changed.activation.account.issuer = 'https://other.example.test/';
  }
  if (kind === 'subject') {
    await refresh(test);
    const newer = await history(nats.store, test.subject, 'test');
    rows.push(...newer.slice(3));
    const refreshed = connectionCreatedDataSchema.parse(rows.at(-1)!.event.data);
    if (refreshed.activation?.reason !== 'oauth_confirmed') {
      throw new Error('Missing account');
    }
    refreshed.activation.account.subject = 'another-account';
    rows.at(-1)!.event.data = refreshed;
  } else if (kind !== 'unconfirmed') {
    rows[2]!.event.data = changed;
  }
  if (kind === 'configuration') {
    test.configuration.clientId = 'replacement';
  }
  if (kind === 'expired') {
    vi.spyOn(Date, 'now').mockReturnValue(changed.activation.account.expiresAt);
  }
  if (kind === 'disabled') {
    const event = envelope('test', `connection-control-${test.userId}-${test.serverId}`,
      'connection.disabled', { userId: test.userId, serverId: test.serverId, profile: 'oauth',
        disabledBy: 'admin', expectedSequence: 0, reason: 'admin_disabled' });
    await nats.seed([event]);
  }
  if (kind === 'revoked') {
    const event = envelope('test', test.subject, 'connection.revoked',
      { userId: test.userId, serverId: test.serverId, profile: 'oauth', revokedBy: test.userId });
    rows.push({ event, sequence: rows.at(-1)!.sequence + 1 });
  }
  const readStream = nats.store.readStream.bind(nats.store);
  async function* read(subject: string, from?: number, deadline?: number) {
    if (subject === test.subject) {
      yield* rows;
      return;
    }
    yield* readStream(subject, from, deadline);
  }
  vi.spyOn(nats.store, 'readStream').mockImplementation(read);
  expect((await test.read('read')).status).toBe('unavailable');
  await expect(test.select({ ...test.command, expectedSequence: selected.sequence,
    changeRef: 'replacement' })).rejects.toThrow();
}
it.each(['unconfirmed', 'foreign', 'issuer', 'subject', 'configuration', 'expired',
  'disabled', 'revoked'])('refuses %s OAuth evidence', refusesChangedEvidence);

async function clearsAndRecovers() {
  const test = await fixture();
  const append = nats.store.append.bind(nats.store);
  async function lostReply(command: Parameters<typeof append>[0]): Promise<never> {
    await append(command);
    throw new Error('private-canary');
  }
  vi.spyOn(nats.store, 'append').mockImplementationOnce(lostReply);
  await expect(test.select()).rejects.toThrow();
  const reference = { serverId: test.serverId, changeRef: 'choice' };
  const receipt = await readOwnSelectionChange(nats.store, binding, test.userId, reference);
  expect(receipt).toMatchObject({ action: 'select', profileId: 'oauth' });
  const clear = { action: 'clear', serverId: test.serverId, connectionId: 'installed',
    expectedSequence: receipt!.sequence, changeRef: 'clear' };
  await test.select(clear);
  await refresh(test);
  expect((await test.read('read')).status).toBe('unavailable');
  expect(await test.select()).toMatchObject({ sequence: receipt!.sequence });
  await expect(test.select({ ...test.command, profileId: 'another-account' })).rejects.toThrow();
  expect((await test.read('read')).status).toBe('unavailable');
}
it('recovers a lost receipt without restoring a cleared choice or accepting another account',
  clearsAndRecovers);

async function racingCheck(kind: string) {
  const test = await fixture();
  const selected = await test.select();
  let loads = 0;
  async function loadConfiguration() {
    loads += 1;
    if (loads === 2) {
      if (kind === 'refresh') {
        await refresh(test);
      }
      if (kind === 'clear') {
        await test.select({ action: 'clear', serverId: test.serverId, connectionId: 'installed',
          expectedSequence: selected.sequence, changeRef: 'clear' });
      }
      if (kind === 'revoke') {
        await test.seed('connection.revoked', { userId: test.userId, serverId: test.serverId,
          profile: 'oauth', revokedBy: test.userId }, 'revoke');
      }
    }
    return test.configuration;
  }
  const result = await readConnectionSelection(nats.store, binding, test.userId,
    test.serverId, loadConfiguration, 'read');
  expect(result.status).toBe('unavailable');
}
it.each(['refresh', 'clear', 'revoke'])('cannot return stale eligibility during %s', racingCheck);

async function replayHasNoEffects() {
  const test = await fixture();
  await test.select();
  const append = vi.spyOn(nats.store, 'append');
  const provider = vi.spyOn(globalThis, 'fetch');
  const rows = await history(nats.store, test.subject, 'test');
  expect(foldConnection(rows).status).toBe('unavailable');
  expect((await test.read('read')).status).toBe('verified');
  expect((await test.read('read')).status).toBe('verified');
  expect(append).not.toHaveBeenCalled();
  expect(provider).not.toHaveBeenCalled();
}
it('replays and checks eligibility without refresh, custody or upstream calls', replayHasNoEffects);

async function requesterIsolation() {
  const alice = await fixture();
  const bob = await fixture(alice.serverId);
  await alice.select();
  expect((await bob.read('read')).status).toBe('unavailable');
  await expect(bob.select(alice.command)).rejects.toThrow();
  await bob.select();
  await refresh(alice);
  expect(await alice.read('read')).toMatchObject({ generation: 2 });
  expect(await bob.read('read')).toMatchObject({ generation: 1 });
}
it('keeps each requester’s choice separate on the same server', requesterIsolation);

async function unavailableConfiguration(removed: boolean) {
  const test = await fixture();
  await test.select();
  if (removed) {
    const event = envelope('test', `member-${test.userId}`, 'member.removed',
      { memberId: test.userId, removedBy: 'admin' });
    await nats.seed([event]);
  }
  function failed() {
    return Promise.reject(new Error('private-canary'));
  }
  const pending = readConnectionSelection(nats.store, binding, test.userId,
    test.serverId, failed, 'read');
  const message = removed ? 'Active silo membership required' : 'Selection configuration unavailable';
  await expect(pending).rejects.toThrow(message);
  await expect(pending).rejects.not.toHaveProperty('cause');
}
it.each([false, true])('hides configuration errors after checking access (removed: %s)',
  unavailableConfiguration);

async function catalogueDuringRead(kind: string) {
  const test = await fixture();
  const selected = await test.select();
  const subject = `mcp-${test.serverId}`;
  const rows = await history(nats.store, subject, 'test');
  const policy = toolPolicyFromRows(rows);
  const now = Date.now();
  let event = envelope('test', subject, 'mcp.catalogue_checked', {
    serverId: test.serverId, outcome: 'unchanged', schemaDigest: policy.catalogue!.schemaDigest,
    checkedAt: new Date(now).toISOString(), expiresAt: new Date(now + 300_000).toISOString(),
  });
  if (kind === 'failed') {
    event = envelope('test', subject, 'mcp.catalogue_checked', {
      serverId: test.serverId, outcome: 'failed', checkedAt: new Date(now).toISOString(),
      reason: 'discovery_failed',
    });
  }
  if (kind === 'policy') {
    event = envelope('test', subject, 'mcp.tool_mode_set', {
      serverId: test.serverId, connectionId: 'installed', toolName: 'read',
      toolRevision: policy.tools[0]!.revision, mode: 'block', setBy: 'admin',
    });
  }
  const auth = memberAuthorisation(binding);
  const use = auth.use.bind(auth);
  async function changeAfterPermission(...args: Parameters<typeof use>) {
    const permission = await use(...args);
    await nats.seed([event]);
    return permission;
  }
  const permission = vi.spyOn(auth, 'use').mockImplementationOnce(changeAfterPermission);
  const result = await test.read('read');
  if (kind === 'unchanged') {
    expect(result).toEqual({ status: 'verified', sequence: selected.sequence,
      profileId: 'oauth', profileRevision: test.revision, generation: 1 });
  } else {
    expect(result).toEqual({ status: 'unavailable', sequence: selected.sequence });
  }
  expect(permission).toHaveBeenCalledTimes(1);
}
it.each(['unchanged', 'failed', 'policy'])(
  'checks relevant evidence when a %s catalogue event arrives during a read', catalogueDuringRead);

async function savedRefusalWithFailure(kind: string, failure: string, operation: string) {
  const test = await fixture();
  const selected = await test.select();
  const memberSubject = `member-${test.userId}`;
  const selectionSubject = `connection-selection-${test.userId}-${test.serverId}`;
  const grantsSubject = grantStream('mcp_server', test.serverId);
  let event = envelope('test', memberSubject, 'member.removed', {
    memberId: test.userId, removedBy: 'admin',
  });
  if (kind === 'grant') {
    event = envelope('test', grantsSubject, 'grant.revoked', {
      resourceType: 'mcp_server', resourceId: test.serverId, granteeKind: 'member',
      granteeId: test.userId, revokedBy: 'admin',
    });
  }
  await nats.seed([event]);
  const auth = memberAuthorisation(binding);
  const use = vi.spyOn(auth, 'use');
  const readStream = nats.store.readStream.bind(nats.store);
  let membershipReads = 0;
  async function* failHistory(subject: string, from?: number, deadline?: number) {
    if (subject === memberSubject) {
      membershipReads += 1;
    }
    if ((failure === 'selection' && subject === selectionSubject) ||
        (failure === 'grant' && subject === grantsSubject)) {
      throw new Error('private-history-canary');
    }
    yield* readStream(subject, from, deadline);
  }
  vi.spyOn(nats.store, 'readStream').mockImplementation(failHistory);
  if (failure === 'receipt' || failure === 'membership receipt') {
    const applied = auth.applied.bind(auth);
    function failReceipt(eventId: string) {
      if (eventId === event.id || failure === 'membership receipt') {
        throw new Error('private-receipt-canary');
      }
      return applied(eventId);
    }
    vi.spyOn(auth, 'applied').mockImplementation(failReceipt);
  }
  const writes = vi.spyOn(nats.store, 'append');
  let pending: Promise<unknown>;
  if (operation === 'write') {
    pending = test.select({ ...test.command, expectedSequence: selected.sequence,
      changeRef: 'another-choice' });
  } else {
    pending = test.read('read');
  }
  await expect(pending).rejects.toBeInstanceOf(MemberAccessRefused);
  expect(membershipReads).toBe(1);
  expect(use).not.toHaveBeenCalled();
  expect(writes).not.toHaveBeenCalled();
}
const refusalCases = [
  ['member', 'selection', 'read'], ['member', 'grant', 'read'],
  ['member', 'selection', 'write'], ['member', 'grant', 'write'],
  ['grant', 'none', 'read'], ['grant', 'selection', 'read'],
  ['grant', 'receipt', 'read'], ['grant', 'none', 'write'],
  ['grant', 'selection', 'write'], ['grant', 'receipt', 'write'],
  ['grant', 'membership receipt', 'read'], ['grant', 'membership receipt', 'write'],
];
it.each(refusalCases)(
  'preserves saved %s refusal with failed %s preparation on %s', savedRefusalWithFailure);
