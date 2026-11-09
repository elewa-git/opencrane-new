import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createStore, grantStream, memberAuthorisation } from '@opencrane/authz';
import { openfga } from '@opencrane/authz/testing';
import { natsFixture } from '@opencrane/event-store/testing';
import type { StoredEvent } from '@opencrane/event-store';
import { modernRoutineExamples } from '../../../libs/events/src/routine-events.ts';
import { envelope, history } from '../../../libs/models/src/actor.ts';
import { connectionOperationId } from '../../../libs/models/src/bearer-connections.ts';
import { oauthConfigurationDigest } from '../../../libs/models/src/oauth-attempt.ts';
import { oauthSelectionFixture } from '../../../libs/models/test/support/oauth-selection.ts';
import { checkRoutineCompanyPreflight } from '../src/routine-company-preflight.ts';

let nats: Awaited<ReturnType<typeof natsFixture>>;
let fga: Awaited<ReturnType<typeof openfga>>;
let binding: Awaited<ReturnType<typeof createStore>>;
let serial = 0;
function noSql(): never {
  throw new Error('Grant projection must not use SQL');
}
const database = { query: noSql };
async function startAccess() {
  fga = await openfga();
  binding = await createStore(fga.apiUrl, 'test');
}
async function closeAccess() {
  await fga?.close();
}
beforeAll(startAccess, 120_000);
afterAll(closeAccess);
async function startStore() {
  nats = await natsFixture();
}
async function closeStore() {
  await nats?.close();
}
beforeEach(startStore);
afterEach(closeStore);

async function fixture() {
  serial += 1;
  const serverId = `installed${serial}`;
  const profileId = 'profile';
  const ownerId = `owner${serial}`;
  const selected = await oauthSelectionFixture(nats, ownerId, serverId, profileId);
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
  const profileSubject = `connection-company:${serverId}:${profileId}`;
  const operationId = connectionOperationId('test', profileSubject, 'save');
  const activation = { connectionId: 'installed', ownerKind: 'company', purpose: 'company',
    generation: 1, uid: 'uid', resourceVersion: '1',
    endpointDigest: selected.configuration.endpointDigest, operationId,
    changedBy: 'admin', expectedSequence: 0, appendUntil: Date.now() + 60_000,
    reason: 'bearer_create', registrationRevision,
    optInRevision: await nats.store.head(optInSubject) };
  const profile = envelope('test', profileSubject, 'connection.created', {
    siloId: 'test', custodianId: 'admin', serverId, profile: profileId,
    secretRef: 'secret:synthetic', activation,
  }, operationId);
  profile.source = 'opencrane-server';
  profile.commandId = 'save';
  profile.principal = { kind: 'human', id: 'admin' };
  await nats.seed([profile]);
  const profileRevision = await nats.store.head(profileSubject);
  const accountDigest = 'a'.repeat(64);
  const accountId = 'verified-bot';
  const evidence = { status: 'verified', siloId: 'test', serverId, profileId,
    ownerKind: 'company', connectionId: 'installed', profileRevision,
    generation: 1, accountDigest,
    configurationDigest: oauthConfigurationDigest(selected.configuration),
    accountId, scopes: ['openid', 'read'], expiresAt: Date.now() + 120_000 };
  function readProfile(_rows: StoredEvent[]) {
    return evidence;
  }
  const selectionSubject = `connection-selection-${ownerId}-${serverId}`;
  const choice = { action: 'select', userId: ownerId, serverId,
    connectionId: 'installed', profileId, profileRevision, expectedSequence: 0,
    ownerKind: 'company', siloId: 'test', generation: 1, accountDigest };
  const hash = createHash('sha256');
  hash.update(JSON.stringify(['test', selectionSubject, 'choice']));
  const selection = envelope('test', selectionSubject, 'connection.selected', choice,
    hash.digest('hex'));
  selection.source = 'opencrane-server';
  selection.commandId = 'choice';
  selection.principal = { kind: 'human', id: ownerId };
  await nats.seed([selection]);
  const due = modernRoutineExamples.due;
  const definition = { ...due.definition, ownerId, serverId, connectionId: 'installed', profileId,
    profileRevision, connectionRevision: profileRevision, companyAccountId: accountId,
    scopes: ['read'] };
  const run = { ...due, definition };
  const assistantId = definition.assistantId;
  for (const [granteeKind, granteeId] of [
    ['member', ownerId], ['assistant', assistantId],
  ]) {
    const grant = envelope('test', grantStream('mcp_server', serverId), 'grant.given', {
      resourceType: 'mcp_server', resourceId: serverId, granteeKind, granteeId,
      grantedBy: ownerId,
    });
    await nats.seed([grant]);
    await memberAuthorisation(binding, nats.store).handler.handle(grant, database);
  }
  async function preflight(reader = readProfile) {
    return checkRoutineCompanyPreflight(nats.store, binding, 'test', run, 1,
      selected.loadConfiguration, reader);
  }
  return { preflight, evidence, definition, profileSubject, optInSubject,
    serverId, ownerId, assistantId, selectionSubject };
}

async function valid() {
  const current = await fixture();
  const append = vi.spyOn(nats.store, 'append');
  const result = await current.preflight();
  expect(result.occurrenceId).toBe(modernRoutineExamples.due.occurrenceId);
  expect(result.rootId).toBe(modernRoutineExamples.due.rootId);
  expect(result.computerGeneration).toBe(1);
  expect(append).not.toHaveBeenCalled();
  append.mockRestore();
}
it('checks one current company binding for the saved occurrence without sending', valid);

async function stale() {
  const current = await fixture();
  const binding = await current.preflight();
  const changed = envelope('test', current.optInSubject,
    'connection.company_opt_in_set', { serverId: current.serverId,
      connectionId: 'installed', registrationRevision: 1, enabled: false,
      changedBy: 'admin', expectedSequence: await nats.store.head(current.optInSubject) });
  await nats.seed([changed]);
  await expect(binding.confirmCurrent()).rejects.toThrow('Routine company unavailable');
}
it('refuses a preflight kept across a later connection change', stale);

async function staleGrant() {
  const current = await fixture();
  const company = await current.preflight();
  const revoke = envelope('test', grantStream('mcp_server', current.serverId),
    'grant.revoked', { resourceType: 'mcp_server', resourceId: current.serverId,
      granteeKind: 'assistant', granteeId: current.assistantId,
      revokedBy: current.ownerId });
  await nats.seed([revoke]);
  await expect(company.confirmCurrent()).rejects.toThrow('Routine company unavailable');
}
it('refuses an MCP grant revoked after preflight', staleGrant);

async function unappliedGrant() {
  const current = await fixture();
  const grant = envelope('test', grantStream('mcp_server', current.serverId),
    'grant.given', { resourceType: 'mcp_server', resourceId: current.serverId,
      granteeKind: 'assistant', granteeId: current.assistantId,
      grantedBy: current.ownerId });
  await nats.seed([grant]);
  await expect(current.preflight()).rejects.toThrow('Routine company unavailable');
}
it('refuses a server grant whose access receipt is not applied', unappliedGrant);

async function changed(kind: string) {
  const current = await fixture();
  if (kind === 'account') current.evidence.accountId = 'different';
  if (kind === 'scopes') current.evidence.scopes = ['openid'];
  if (kind === 'revision') current.evidence.profileRevision += 1;
  if (kind === 'generation') current.evidence.generation += 1;
  if (kind === 'missing-server') Object.assign(current.definition, { serverId: undefined });
  if (kind === 'choice') {
    const changed = envelope('test', current.selectionSubject, 'connection.selected', {
      action: 'clear', userId: current.ownerId, serverId: current.serverId,
      connectionId: 'installed', expectedSequence: await nats.store.head(current.selectionSubject),
    });
    await nats.seed([changed]);
  }
  if (kind === 'opt-in') {
    const changed = envelope('test', current.optInSubject,
      'connection.company_opt_in_set', { serverId: current.serverId,
        connectionId: 'installed', registrationRevision: 1, enabled: false,
        changedBy: 'admin', expectedSequence: await nats.store.head(current.optInSubject) });
    await nats.seed([changed]);
  }
  if (kind === 'publication') {
    const changed = envelope('test', `mcp-${current.serverId}`,
      'mcp.server_unpublished', { serverId: current.serverId, unpublishedBy: 'admin' });
    await nats.seed([changed]);
  }
  function unavailable(): never {
    throw new Error('Custody unavailable');
  }
  const reader = kind === 'custody' ? unavailable : undefined;
  const append = vi.spyOn(nats.store, 'append');
  await expect(current.preflight(reader)).rejects.toThrow('Routine company unavailable');
  expect(append).not.toHaveBeenCalled();
  append.mockRestore();
}
it.each(['account', 'scopes', 'custody', 'revision', 'generation', 'missing-server',
  'choice', 'opt-in', 'publication'])(
  'refuses changed company %s before any allowance', changed);

async function revokedGrant(kind: 'member' | 'assistant', applied: boolean) {
  const current = await fixture();
  const granteeId = kind === 'member' ? current.ownerId : current.assistantId;
  const revoke = envelope('test', grantStream('mcp_server', current.serverId),
    'grant.revoked', { resourceType: 'mcp_server', resourceId: current.serverId,
      granteeKind: kind, granteeId, revokedBy: current.ownerId });
  await nats.seed([revoke]);
  if (applied) {
    await memberAuthorisation(binding, nats.store).handler.handle(revoke, database);
  }
  await expect(current.preflight()).rejects.toThrow('Routine company unavailable');
}
for (const kind of ['member', 'assistant'] as const) {
  const checkGrant = revokedGrant.bind(undefined, kind);
  it.each([true, false])(`refuses ${kind} MCP grant loss, applied=%s`, checkGrant);
}
