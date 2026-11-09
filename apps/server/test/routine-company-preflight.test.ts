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
import { toolPolicyFromRows } from '../../../libs/models/src/tool-policy.ts';
import * as toolPolicy from '../../../libs/models/src/tool-policy.ts';
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
  const policy = toolPolicyFromRows(serverRows);
  function isReadTool(tool: (typeof policy.tools)[number]) {
    return tool.name === 'read';
  }
  const reviewedTool = policy.tools.find(isReadTool)!;
  const destination = new URL('https://example.test/mcp').origin;
  const destinationHash = createHash('sha256');
  destinationHash.update(JSON.stringify(destination));
  const destinationDigest = destinationHash.digest('hex');
  const tool = { name: reviewedTool.name, revision: reviewedTool.revision,
    schemaDigest: policy.catalogue!.schemaDigest, destinationDigest,
    policyRevision: policy.policyRevision, costCents: 0 as const };
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
    scopes: ['read'], tool };
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
  return { preflight, evidence, definition, tool, configuration: selected.configuration,
    profileSubject, optInSubject, serverId, ownerId, assistantId, selectionSubject };
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

async function changedSavedTool(field: string) {
  const current = await fixture();
  const changed = { ...current.tool };
  if (field === 'name') changed.name = 'write';
  if (field === 'revision') changed.revision = 'f'.repeat(64);
  if (field === 'schemaDigest') changed.schemaDigest = 'f'.repeat(64);
  if (field === 'destinationDigest') changed.destinationDigest = 'f'.repeat(64);
  if (field === 'policyRevision') changed.policyRevision += 1;
  if (field === 'costCents') Object.assign(changed, { costCents: 1 });
  if (field === 'missingTariff') Object.assign(changed, { costCents: undefined });
  Object.assign(current.definition, { tool: changed });
  const append = vi.spyOn(nats.store, 'append');
  await expect(current.preflight()).rejects.toThrow('Routine company unavailable');
  expect(append).not.toHaveBeenCalled();
  append.mockRestore();
}
it.each(['name', 'revision', 'schemaDigest', 'destinationDigest',
  'policyRevision', 'costCents', 'missingTariff'])(
  'refuses a changed saved company tool %s without sending', changedSavedTool);

async function currentToolMode(mode: 'block' | 'ask') {
  const current = await fixture();
  current.evidence.scopes = ['openid', 'read', 'write'];
  const changed = envelope('test', `mcp-${current.serverId}`, 'mcp.tool_mode_set', {
    serverId: current.serverId, connectionId: 'installed', toolName: 'read',
    toolRevision: current.tool.revision, mode, setBy: 'admin',
  });
  await nats.seed([changed]);
  const rows = await history(nats.store, `mcp-${current.serverId}`, 'test');
  const policy = toolPolicyFromRows(rows);
  current.tool.policyRevision = policy.policyRevision;
  current.configuration.policyRevision = policy.policyRevision;
  current.evidence.configurationDigest = oauthConfigurationDigest(current.configuration);
  function isWriteTool(tool: (typeof policy.tools)[number]) {
    return tool.name === 'write';
  }
  expect(policy.tools.find(isWriteTool)?.mode).toBe('allow');
  await expect(current.preflight()).rejects.toThrow('Routine company unavailable');
}
it.each(['block', 'ask'] as const)(
  'refuses a currently %s selected tool while another tool is usable', currentToolMode);

async function missingExactToolScopes() {
  const current = await fixture();
  current.evidence.scopes = ['openid', 'read', 'write'];
  current.configuration.toolScopes.read = ['write'];
  current.evidence.configurationDigest = oauthConfigurationDigest(current.configuration);
  await expect(current.preflight()).rejects.toThrow('Routine company unavailable');
}
it('refuses missing frozen scopes for the exact tool while another tool is usable',
  missingExactToolScopes);

async function unknownCurrentTariff() {
  const current = await fixture();
  current.evidence.scopes = ['openid', 'read', 'write'];
  const rows = await history(nats.store, `mcp-${current.serverId}`, 'test');
  const policy = toolPolicyFromRows(rows);
  function removeReadTariff(tool: (typeof policy.tools)[number]) {
    if (tool.name !== 'read') return tool;
    const withoutTariff = { ...tool };
    Reflect.deleteProperty(withoutTariff, 'costCents');
    return withoutTariff;
  }
  const policyWithoutReadTariff = { ...policy, tools: policy.tools.map(removeReadTariff) };
  const policySpy = vi.spyOn(toolPolicy, 'toolPolicyFromRows');
  policySpy.mockReturnValue(policyWithoutReadTariff);
  try {
    await expect(current.preflight()).rejects.toThrow('Routine company unavailable');
  } finally {
    policySpy.mockRestore();
  }
}
it('refuses an unknown current tariff even when another tool is usable', unknownCurrentTariff);

async function missingSavedTool() {
  const current = await fixture();
  Object.assign(current.definition, { tool: undefined });
  await expect(current.preflight()).rejects.toThrow('Routine company unavailable');
}
it('refuses a routine without an exact saved company tool', missingSavedTool);

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

async function changedToolBeforeSender() {
  const current = await fixture();
  const company = await current.preflight();
  const changed = envelope('test', `mcp-${current.serverId}`, 'mcp.tool_mode_set', {
    serverId: current.serverId, connectionId: 'installed', toolName: current.tool.name,
    toolRevision: current.tool.revision, mode: 'block', setBy: 'admin',
  });
  await nats.seed([changed]);
  await expect(company.confirmCurrent()).rejects.toThrow('Routine company unavailable');
}
it('refuses a tool policy change between preflight and sender', changedToolBeforeSender);

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
  if (kind === 'server') Object.assign(current.definition, { serverId: 'replacement' });
  if (kind === 'connection') Object.assign(current.definition, { connectionId: 'replacement' });
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
  'server', 'connection', 'choice', 'opt-in', 'publication'])(
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
