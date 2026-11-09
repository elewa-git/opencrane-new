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
import { startOAuthConfigurationChange, finishOAuthConfigurationChange }
  from '../../../libs/models/src/oauth-configuration-change.ts';
import { toolPolicyFromRows } from '../../../libs/models/src/tool-policy.ts';
import { readCurrentCompanyProfile } from '../../../libs/models/src/company-profile-reader.ts';
import * as toolPolicy from '../../../libs/models/src/tool-policy.ts';
import { oauthSelectionFixture } from '../../../libs/models/test/support/oauth-selection.ts';
import { checkRoutineCompanyPreflight, routineCompanyPreflightFromCustody }
  from '../src/routine-company-preflight.ts';

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

async function fixture(shouldRecordConfiguration = true, useSavedVerified = false) {
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
  const savedAccount = { issuer: 'https://issuer.test', subject: 'verified-bot',
    scopes: ['openid', 'read'], expiresAt: Date.now() + 120_000 };
  const accountHash = createHash('sha256');
  accountHash.update(JSON.stringify(savedAccount));
  const verifiedAccountDigest = accountHash.digest('hex');
  const activationBase = { connectionId: 'installed', ownerKind: 'company', purpose: 'company',
    generation: 1, uid: 'uid', resourceVersion: '1',
    endpointDigest: selected.configuration.endpointDigest, operationId,
    changedBy: 'admin', expectedSequence: 0, appendUntil: Date.now() + 60_000,
    registrationRevision,
    optInRevision: await nats.store.head(optInSubject) };
  const activation = useSavedVerified
    ? { ...activationBase, reason: 'oauth_confirmed', account: savedAccount,
      configurationDigest: oauthConfigurationDigest(selected.configuration) }
    : { ...activationBase, reason: 'bearer_create' };
  const profile = envelope('test', profileSubject, 'connection.created', {
    siloId: 'test', custodianId: 'admin', serverId, profile: profileId,
    secretRef: 'secret:synthetic', activation,
  }, operationId);
  profile.source = 'opencrane-server';
  profile.commandId = 'save';
  profile.principal = { kind: 'human', id: 'admin' };
  await nats.seed([profile]);
  const profileRevision = await nats.store.head(profileSubject);
  const accountDigest = useSavedVerified ? verifiedAccountDigest : 'a'.repeat(64);
  const accountId = 'verified-bot';
  const evidence = { status: 'verified', siloId: 'test', serverId, profileId,
    ownerKind: 'company', connectionId: 'installed', profileRevision,
    generation: 1, accountDigest,
    configurationDigest: oauthConfigurationDigest(selected.configuration),
    accountId, scopes: ['openid', 'read'], expiresAt: Date.now() + 120_000 };
  function readProfile(_rows: StoredEvent[]) {
    return evidence;
  }
  const recover = vi.fn().mockResolvedValue({ status: 'recovered', identity: {
    reference: 'synthetic', uid: 'uid', resourceVersion: '1' } });
  const savedReader = readCurrentCompanyProfile({ recover });
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
  async function recordConfiguration() {
    const change = await startOAuthConfigurationChange(nats.store, 'test', serverId);
    await finishOAuthConfigurationChange(nats.store, 'test', serverId, change,
      selected.loadConfiguration);
  }
  if (shouldRecordConfiguration) await recordConfiguration();
  async function preflight(reader = useSavedVerified ? savedReader : readProfile) {
    return checkRoutineCompanyPreflight(nats.store, binding, 'test', run, 1,
      selected.loadConfiguration, reader);
  }
  return { preflight, evidence, definition, tool, recover,
    configuration: selected.configuration, loadConfiguration: selected.loadConfiguration,
    profileSubject, optInSubject, serverId, ownerId, assistantId, selectionSubject };
}

async function valid() {
  const current = await fixture();
  const append = vi.spyOn(nats.store, 'append');
  const result = await current.preflight();
  expect(result.occurrenceId).toBe(modernRoutineExamples.due.occurrenceId);
  expect(result.rootId).toBe(modernRoutineExamples.due.rootId);
  expect(result.computerGeneration).toBe(1);
  expect(result.configurationDigest).toBe(oauthConfigurationDigest(current.configuration));
  expect(append).not.toHaveBeenCalled();
  append.mockRestore();
}
it('checks one current company binding for the saved occurrence without sending', valid);

async function savedVerifiedProfile() {
  const current = await fixture(true, true);
  const append = vi.spyOn(nats.store, 'append');
  const preflight = routineCompanyPreflightFromCustody(nats.store, binding, 'test',
    current.loadConfiguration, { recover: current.recover });
  const company = await preflight({ ...modernRoutineExamples.due,
    definition: current.definition }, 1);
  expect(company.configurationDigest).toBe(oauthConfigurationDigest(current.configuration));
  expect(current.recover).toHaveBeenCalled();
  expect(append).not.toHaveBeenCalled();
  current.recover.mockResolvedValue({ status: 'not_found' });
  await expect(company.confirmCurrent()).rejects.toThrow('Routine company unavailable');
  append.mockRestore();
}
it('checks a saved verified company profile and refuses lost custody before use',
  savedVerifiedProfile);

async function missingRecordedConfiguration() {
  const current = await fixture(false);
  await expect(current.preflight()).rejects.toThrow('Routine company unavailable');
}
it('refuses company preflight when no OAuth configuration has been recorded',
  missingRecordedConfiguration);

async function unfinishedConfigurationEdit() {
  const current = await fixture();
  await startOAuthConfigurationChange(nats.store, 'test', current.serverId);
  await expect(current.preflight()).rejects.toThrow('Routine company unavailable');
}
it('refuses company preflight while an OAuth configuration edit is unfinished',
  unfinishedConfigurationEdit);

async function changedConfigurationDigest() {
  const current = await fixture();
  const mismatchedRecord = envelope('test', `mcp-${current.serverId}`,
    'mcp.oauth_configuration_recorded', { serverId: current.serverId,
      changeId: '00000000-0000-4000-8000-000000000001', status: 'ready',
      configurationDigest: '0'.repeat(64) });
  await nats.seed([mismatchedRecord]);
  await expect(current.preflight()).rejects.toThrow('Routine company unavailable');
}
it('refuses company preflight when loaded OAuth settings differ from the recorded digest',
  changedConfigurationDigest);

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
  const change = await startOAuthConfigurationChange(nats.store, 'test', current.serverId);
  current.configuration.policyRevision = policy.policyRevision;
  current.evidence.configurationDigest = oauthConfigurationDigest(current.configuration);
  await finishOAuthConfigurationChange(nats.store, 'test', current.serverId, change,
    current.loadConfiguration);
  function isWriteTool(tool: (typeof policy.tools)[number]) {
    return tool.name === 'write';
  }
  const writeTool = policy.tools.find(isWriteTool)!;
  expect(policy.published).toBe(true);
  expect(writeTool.mode).toBe('allow');
  await expect(current.preflight()).rejects.toThrow('Routine company unavailable');
  current.tool.name = 'write';
  current.tool.revision = writeTool.revision;
  current.definition.scopes = ['write'];
  await expect(current.preflight()).resolves.toBeDefined();
}
it.each(['block', 'ask'] as const)(
  'refuses a currently %s selected tool while another tool is usable', currentToolMode);

async function missingExactToolScopes() {
  const current = await fixture();
  current.evidence.scopes = ['openid', 'read', 'write'];
  const change = await startOAuthConfigurationChange(nats.store, 'test', current.serverId);
  current.configuration.toolScopes.read = ['write'];
  current.evidence.configurationDigest = oauthConfigurationDigest(current.configuration);
  await finishOAuthConfigurationChange(nats.store, 'test', current.serverId, change,
    current.loadConfiguration);
  await expect(current.preflight()).rejects.toThrow('Routine company unavailable');
  current.definition.scopes = ['read', 'write'];
  await expect(current.preflight()).resolves.toBeDefined();
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
  await expect(current.preflight()).resolves.toBeDefined();
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

async function changedAccountAfterPreflight() {
  const current = await fixture();
  const company = await current.preflight();
  current.evidence.accountId = 'different';
  await expect(company.confirmCurrent()).rejects.toThrow('Routine company unavailable');
}
it('refuses a changed account result from the trusted reader after preflight',
  changedAccountAfterPreflight);

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

function holdRaceClocks() {
  const wallClock = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
  const monotonicClock = vi.spyOn(performance, 'now').mockReturnValue(1);
  function restore() {
    monotonicClock.mockRestore();
    wallClock.mockRestore();
  }
  return { restore };
}

function holdPositionRead(subjectToHold: string,
  phase: 'before-read' | 'after-read' = 'after-read') {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const readPosition = nats.store.readStream.bind(nats.store);
  async function* heldPosition(...args: Parameters<typeof nats.store.readStream>) {
    const [subject] = args;
    if (subject === subjectToHold && phase === 'before-read') {
      entered.resolve();
      await release.promise;
    }
    const rows = readPosition(...args);
    const first = await rows.next();
    if (subject === subjectToHold && phase === 'after-read') {
      entered.resolve();
      await release.promise;
    }
    if (!first.done) yield first.value;
  }
  const spy = vi.spyOn(nats.store, 'readStream');
  spy.mockImplementation(heldPosition);
  return { entered: entered.promise, release: release.resolve, spy };
}

function independentWrite(current: Awaited<ReturnType<typeof fixture>>) {
  return envelope('test', `ownership-race${current.serverId}`, 'ownership.seeded',
    { ownerIds: [current.ownerId] });
}

async function policyChangedDuringLaterRead() {
  const current = await fixture();
  const company = await current.preflight();
  const grantSubject = grantStream('mcp_server', current.serverId);
  const clock = holdRaceClocks();
  const held = holdPositionRead(grantSubject);
  try {
    const confirmation = company.confirmCurrent();
    await held.entered;
    const block = envelope('test', `mcp-${current.serverId}`, 'mcp.tool_mode_set', {
      serverId: current.serverId, connectionId: 'installed', toolName: current.tool.name,
      toolRevision: current.tool.revision, mode: 'block', setBy: 'admin',
    });
    await nats.seed([block]);
    held.release();
    await expect(confirmation).rejects.toThrow('Routine company unavailable');
  } finally {
    held.release();
    held.spy.mockRestore();
    clock.restore();
  }
}
it('refuses a policy Block saved during a later grant position read',
  policyChangedDuringLaterRead);

async function addTeamGrant(current: Awaited<ReturnType<typeof fixture>>) {
  const teamId = `group-${current.ownerId}`;
  const teamSubject = `team-${teamId}`;
  const created = envelope('test', teamSubject, 'team.created', {
    teamId, name: 'Test group', createdBy: current.ownerId,
  });
  const added = envelope('test', teamSubject, 'team.member_added', {
    teamId, memberId: current.ownerId, addedBy: current.ownerId,
  });
  const grant = envelope('test', grantStream('mcp_server', current.serverId), 'grant.given', {
    resourceType: 'mcp_server', resourceId: current.serverId, granteeKind: 'team',
    granteeId: teamId, grantedBy: current.ownerId,
  });
  const handler = memberAuthorisation(binding, nats.store).handler;
  for (const event of [created, added, grant]) {
    await nats.seed([event]);
    await handler.handle(event, database);
  }
  return { teamId, teamSubject };
}

async function teamGrantRevokedDuringLaterRead() {
  const current = await fixture();
  const team = await addTeamGrant(current);
  const company = await current.preflight();
  const clock = holdRaceClocks();
  const held = holdPositionRead(team.teamSubject);
  try {
    const confirmation = company.confirmCurrent();
    await held.entered;
    const revoke = envelope('test', grantStream('mcp_server', current.serverId),
      'grant.revoked', { resourceType: 'mcp_server', resourceId: current.serverId,
        granteeKind: 'team', granteeId: team.teamId, revokedBy: current.ownerId });
    await nats.seed([revoke]);
    held.release();
    await expect(confirmation).rejects.toThrow('Routine company unavailable');
  } finally {
    held.release();
    held.spy.mockRestore();
    clock.restore();
  }
}
it('refuses a team grant revoked during a later team position read',
  teamGrantRevokedDuringLaterRead);

async function changedCompanyStreamDuringRead() {
  const clock = holdRaceClocks();
  try {
    for (let readIndex = 0; readIndex < 12; readIndex += 1) {
      for (let streamIndex = 0; streamIndex < 7; streamIndex += 1) {
        const current = await fixture();
        const team = await addTeamGrant(current);
        const company = await current.preflight();
        const subjects = [current.profileSubject, `mcp-${current.serverId}`,
          current.optInSubject, current.selectionSubject,
          grantStream('mcp_server', current.serverId), team.teamSubject];
        const changedSubject = subjects[streamIndex];
        let change: ReturnType<typeof envelope> | undefined;
        if (changedSubject) {
          const rows = await history(nats.store, changedSubject, 'test');
          const previous = rows.at(-1)!.event;
          change = envelope('test', changedSubject, previous.type, previous.data);
        }
        async function changeCompany() {
          if (change) {
            await nats.seed([change]);
          } else {
            current.configuration.toolScopes.read = ['write'];
          }
        }
        const phase = readIndex < subjects.length ? 'before-read' : 'after-read';
        const subjectToHold = subjects[readIndex % subjects.length];
        if (!subjectToHold) throw new Error('Missing company position subject');
        const held = holdPositionRead(subjectToHold, phase);
        let refused: boolean;
        try {
          const confirmation = company.confirmCurrent();
          await held.entered;
          await changeCompany();
          held.release();
          try {
            await confirmation;
            refused = false;
          } catch (error) {
            if (!(error instanceof Error)) throw error;
            expect(error.message).toBe('Routine company unavailable');
            refused = true;
          }
        } finally {
          held.release();
          held.spy.mockRestore();
        }
        expect(refused, `stream ${streamIndex}, read ${readIndex}`).toBe(true);
      }
    }
  } finally {
    clock.restore();
  }
}
it('refuses all 84 company and OAuth changes during position reads',
  changedCompanyStreamDuringRead, 120_000);

async function changedCompanyStreamBeforeWrite() {
  for (let streamIndex = 0; streamIndex < 7; streamIndex += 1) {
    const current = await fixture();
    const team = await addTeamGrant(current);
    const company = await current.preflight();
    const subjects = [current.profileSubject, `mcp-${current.serverId}`,
      current.optInSubject, current.selectionSubject,
      grantStream('mcp_server', current.serverId), team.teamSubject];
    const changedSubject = subjects[streamIndex];
    const snapshot = await company.confirmCurrent();
    let change: ReturnType<typeof envelope> | undefined;
    if (changedSubject) {
      const rows = await history(nats.store, changedSubject, 'test');
      const previous = rows.at(-1)!.event;
      change = envelope('test', changedSubject, previous.type, previous.data);
      await nats.seed([change]);
    } else {
      current.configuration.toolScopes.read = ['write'];
    }
    const event = independentWrite(current);
    if (changedSubject) {
      const result = await nats.store.append({ event, expectedSequence: 0,
        expectedGlobalSequence: snapshot });
      expect(result.status, `stream ${streamIndex}`).toBe('conflict');
    } else {
      const result = await nats.store.append({ event, expectedSequence: 0,
        expectedGlobalSequence: snapshot, checkAccess: company.confirmCurrent });
      expect(result.status, 'OAuth configuration').toBe('unavailable');
    }
  }
}
it('refuses a change to every company stream between check and write',
  changedCompanyStreamBeforeWrite, 30_000);

async function oauthChangedAfterLastRead(kind: 'scopes' | 'client') {
  const current = await fixture();
  const company = await current.preflight();
  const event = independentWrite(current);
  function updateConfiguration() {
    if (kind === 'scopes') {
      current.configuration.toolScopes.read = ['write'];
    } else {
      current.configuration.clientId = 'replacement';
    }
  }
  async function checkThenChangeConfiguration() {
    await company.confirmCurrent();
    const change = await startOAuthConfigurationChange(nats.store, 'test', current.serverId);
    updateConfiguration();
    await finishOAuthConfigurationChange(nats.store, 'test', current.serverId, change,
      current.loadConfiguration);
  }
  const command = { event, expectedSequence: 0,
    checkAccess: checkThenChangeConfiguration };
  const result = await nats.store.append(command);
  expect(result.status).toBe('conflict');
  expect(await nats.store.head(event.subject)).toBe(0);
  const serverRows = await history(nats.store, `mcp-${current.serverId}`, 'test');
  const lastConfiguration = serverRows.at(-1)!.event;
  expect(lastConfiguration.type).toBe('mcp.oauth_configuration_recorded');
  const expectedConfiguration = { status: 'ready',
    configurationDigest: oauthConfigurationDigest(current.configuration) };
  expect(lastConfiguration.data).toMatchObject(expectedConfiguration);
}
it.each(['scopes', 'client'] as const)(
  'refuses an OAuth %s change after the final read and before publication',
  oauthChangedAfterLastRead);

async function custodyChangedAfterRecover(kind: 'deleted' | 'changed') {
  const current = await fixture(true, true);
  const recovered = { status: 'recovered' as const, identity: {
    reference: 'synthetic', uid: 'uid', resourceVersion: '1' } };
  let custodyResult:
    Awaited<ReturnType<Parameters<typeof readCurrentCompanyProfile>[0]['recover']>> = recovered;
  let reads = 0;
  let preflightComplete = false;
  let changed = false;
  function recover() {
    reads += 1;
    const result = custodyResult;
    if (preflightComplete && !changed) {
      changed = true;
      queueMicrotask(changeCustody);
    }
    return Promise.resolve(result);
  }
  function changeCustody() {
    if (kind === 'deleted') {
      custodyResult = { status: 'not_found' };
    } else {
      custodyResult = { status: 'recovered', identity: {
        reference: 'synthetic', uid: 'uid', resourceVersion: '2' } };
    }
  }
  const preflight = routineCompanyPreflightFromCustody(nats.store, binding, 'test',
    current.loadConfiguration, { recover });
  const company = await preflight({ ...modernRoutineExamples.due,
    definition: current.definition }, 1);
  preflightComplete = true;
  const event = independentWrite(current);
  const command = { event, expectedSequence: 0, checkAccess: company.confirmCurrent };
  const result = await nats.store.append(command);
  expect(result.status).toBe('unavailable');
  expect(await nats.store.head(event.subject)).toBe(0);
  expect(changed).toBe(true);
  expect(reads).toBeGreaterThan(3);
}
it.each(['deleted', 'changed'] as const)(
  'refuses a credential %s after recover returns and before send authorisation',
  custodyChangedAfterRecover);

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
