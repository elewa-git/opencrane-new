import { createHash } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { natsFixture } from '@opencrane/event-store/testing';
import { databases, openfga } from '@opencrane/authz/testing';
import { createStore, grantStream, memberAuthorisation } from '@opencrane/authz';
import { pgDb } from '@opencrane/projections';
import { decisionRecordedDataSchema, getEventDefinition,
  routineActivationSchema, routineDefinitionSchema }
  from '@opencrane/events';
import { z } from 'zod';
import { confirmCredentialRelease } from '../src/credential-release.ts';
import { connectionOperationId } from '../src/bearer-connections.ts';
import { oauthConfigurationDigest } from '../src/oauth-attempt.ts';
import { toolPolicyFromRows } from '../src/tool-policy.ts';
import { envelope, history } from '../src/actor.ts';
import { oauthSelectionFixture } from './support/oauth-selection.ts';
import { event } from '@opencrane/event-store/testing';
import { authorityFence } from '../src/authority.ts';

let nats: Awaited<ReturnType<typeof natsFixture>>;
let storage: Awaited<ReturnType<typeof databases>>;
let fga: Awaited<ReturnType<typeof openfga>>;
let binding: Awaited<ReturnType<typeof createStore>>;
let serial = 0;
type FixtureOptions = {
  ready?: boolean;
  toolName?: 'read' | 'write';
  accountScopes?: string[];
  frozenScopes?: string[];
  missingToolMapping?: boolean;
};
beforeAll(async function start() {
  nats = await natsFixture();
  storage = await databases();
  fga = await openfga();
  binding = await createStore(fga.apiUrl, 'test');
}, 120_000);
afterAll(async function stop() {
  await fga?.close();
  await storage?.close();
  await nats?.close();
});

function digest(value: unknown) {
  const hash = createHash('sha256');
  hash.update(JSON.stringify(value));
  return hash.digest('hex');
}

async function readyHistory(userId: string, serverId: string, profileId: string,
  routineId: string, occurrenceId: string, options: FixtureOptions) {
  const personal = await oauthSelectionFixture(nats, userId, serverId, 'personal');
  if (options.missingToolMapping) {
    Reflect.deleteProperty(personal.configuration.toolScopes, 'write');
  }
  const serverSubject = `mcp-${serverId}`;
  const serverRows = await history(nats.store, serverSubject, 'test');
  const registrationRevision = serverRows[0]!.sequence;
  const policy = toolPolicyFromRows(serverRows);
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
    endpointDigest: personal.configuration.endpointDigest, operationId,
    changedBy: 'admin', expectedSequence: 0, appendUntil: Date.now() + 60_000,
    reason: 'bearer_create', registrationRevision,
    optInRevision: await nats.store.head(optInSubject) };
  const saved = envelope('test', profileSubject, 'connection.created', {
    siloId: 'test', custodianId: 'admin', serverId, profile: profileId,
    secretRef: 'secret:synthetic', activation,
  }, operationId);
  saved.source = 'opencrane-server';
  saved.commandId = 'save';
  saved.principal = { kind: 'human', id: 'admin' };
  await nats.seed([saved]);
  const profileRevision = await nats.store.head(profileSubject);
  const evidence = { status: 'verified', siloId: 'test', serverId, profileId,
    ownerKind: 'company', connectionId: 'installed', profileRevision,
    generation: 1, accountId: 'company-bot', accountDigest: digest('company-bot'),
    configurationDigest: oauthConfigurationDigest(personal.configuration),
    scopes: options.accountScopes ?? ['openid', 'read'], expiresAt: Date.now() + 120_000 };
  const selectionSubject = `connection-selection-${userId}-${serverId}`;
  const selection = envelope('test', selectionSubject, 'connection.selected', {
    action: 'select', userId, serverId, connectionId: 'installed', profileId,
    profileRevision, expectedSequence: 0, ownerKind: 'company', siloId: 'test',
    generation: 1, accountDigest: evidence.accountDigest,
  }, digest(['test', selectionSubject, 'choice']));
  selection.source = 'opencrane-server';
  selection.commandId = 'choice';
  selection.principal = { kind: 'human', id: userId };
  await nats.seed([selection]);
  const routineSubject = `routine-${routineId}`;
  const fields = z.record(z.string(), z.unknown());
  const original = fields.parse(getEventDefinition('routine.created')!.example);
  const originalDefinition = routineDefinitionSchema.parse(original['definition']);
  const definition = { ...originalDefinition, ownerId: userId, assistantId: 'assistant',
    payingGroupId: 'payer', assistantPayingGroupId: 'payer', connectionId: 'installed',
    profileId, profileRevision, connectionRevision: profileRevision,
    companyAccountId: evidence.accountId, scopes: options.frozenScopes ?? evidence.scopes };
  const created = { ...event(`created-${routineId}`, routineSubject, 'routine.created'),
    source: 'opencrane-server', commandId: `created-${routineId}`,
    principal: { kind: 'human' as const, id: userId },
    data: { ...original, routineId, actorId: userId, status: 'active', definition } };
  const originalDue = fields.parse(getEventDefinition('routine.due')!.example);
  const due = { ...event(`due-${routineId}`, routineSubject, 'routine.due'),
    source: 'opencrane-server', commandId: `due-${routineId}`,
    principal: { kind: 'system' as const, id: 'opencrane-server' },
    data: { ...originalDue, routineId, occurrenceId, definition,
      conversationId: 'conversation', turnId: 'turn' } };
  const originalActivation = routineActivationSchema.parse(
    getEventDefinition('routine.run_activation_admitted')!.example);
  const activationEvent = { ...event(`activation-${routineId}`, routineSubject,
    'routine.run_activation_admitted'), source: 'opencrane-server',
    principal: { kind: 'system' as const, id: 'opencrane-server' },
    commandId: `activation-${routineId}`,
    data: { ...originalActivation, routineId, occurrenceId,
      conversationId: 'conversation', turnId: 'turn' } };
  await nats.seed([created, due, activationEvent]);
  const requestedTool = policy.tools.find(function matchesRequestedTool(tool) {
    return tool.name === (options.toolName ?? 'read');
  });
  return { personal, evidence, profileRevision, selectionRevision: await nats.store.head(selectionSubject),
    policyRevision: await nats.store.head(serverSubject), schemaDigest: requestedTool!.revision,
    profileSubject, selectionSubject, routineSubject };
}

async function fixture(options: FixtureOptions = {}) {
  serial += 1;
  const userId = `owner${serial}`;
  const serverId = `server${serial}`;
  const profileId = `profile${serial}`;
  const requestId = `request${serial}`;
  const decisionId = `decision${serial}`;
  const routineId = `routine${serial}`;
  const occurrenceId = `occurrence${serial}`;
  const joined = envelope('test', `member-${userId}`, 'member.joined', {
    memberId: userId, role: 'member', email: `${userId}@example.test`, displayName: userId });
  const grant = envelope('test', grantStream('mcp_server', serverId), 'grant.given', {
    resourceType: 'mcp_server', resourceId: serverId, granteeKind: 'member',
    granteeId: userId, grantedBy: 'admin' });
  await nats.seed([joined, grant]);
  const auth = memberAuthorisation(binding);
  const db = pgDb(storage.queue);
  await auth.handler.handle(joined, db);
  await auth.handler.handle(grant, db);
  const prepared = options.ready === false ? undefined : await readyHistory(userId, serverId,
    profileId, routineId, occurrenceId, options);
  const issuedAt = Date.now();
  const release = {
    requestId, permitId: requestId, leaseId: requestId, purpose: 'tool_call' as const,
    userId, ownerId: userId, ownerKind: 'company' as const,
    assistantId: 'assistant', computerId: 'computer', computerGeneration: 1,
    conversationId: 'conversation', turnId: 'turn', threadId: 'thread',
    serverId, toolName: options.toolName ?? 'read', argumentsDigest: 'a'.repeat(64),
    connectionId: 'installed', profileId, generation: 1,
    profileRevision: prepared?.profileRevision ?? 1,
    connectionRevision: prepared?.profileRevision ?? 1,
    selectionRevision: prepared?.selectionRevision ?? 1,
    policyRevision: prepared?.policyRevision ?? 1,
    accountDigest: prepared?.evidence.accountDigest ?? 'b'.repeat(64),
    scopeDigest: digest(prepared?.evidence.scopes ?? []),
    routineId, occurrenceId, companyAccountId: 'company-bot',
    schemaDigest: prepared?.schemaDigest ?? 'd'.repeat(64),
    payingGroupId: 'payer', issuedAt, expiresAt: issuedAt + 30_000,
  };
  const decision = envelope('test', `decision-${requestId}`, 'decision.recorded', {
    requestId, requesterId: userId, assistantId: 'assistant', conversationId: 'conversation',
    turnId: 'turn', permitId: requestId, serverId, toolName: options.toolName ?? 'read', route: 'mcp',
    outcome: 'allow', reason: 'policy_allow', contextDigest: 'e'.repeat(64), release,
  }, decisionId);
  await nats.seed([decision]);
  const loadConfiguration = prepared?.personal.loadConfiguration ?? function emptyConfiguration() {
    return Promise.resolve({});
  };
  function readProfile() {
    return prepared?.evidence;
  }
  const rights = { owner: true, assistant: true, payer: true, computer: true, root: true };
  async function prepareAccess() {
    const fresh = await authorityFence(nats.store, performance.now(), [
      `member-${userId}`, grantStream('mcp_server', serverId),
      'assistant-assistant', 'team-payer']);
    async function checkAccess() {
      if (Object.values(rights).some(function missing(allowed) { return !allowed; })) {
        throw new Error('Access changed');
      }
      const member = await auth.check(userId, 'member');
      const use = await auth.use('person', userId, 'mcp_server', serverId);
      if (!member.allowed || !use.allowed) {
        throw new Error('Access changed');
      }
      await fresh();
    }
    return { deadline: fresh.deadline, checkAccess };
  }
  function confirm(action: 'claim' | 'recover' = 'claim') {
    return confirmCredentialRelease(nats.store, 'test', userId, decisionId,
      release, prepareAccess, action, loadConfiguration, readProfile);
  }
  return { userId, serverId, requestId, release, prepared, rights, auth, confirm };
}

it('audits one bound company request without releasing material', async function boundAccount() {
  const test = await fixture();
  expect(decisionRecordedDataSchema.shape.release?.safeParse(test.release).success).toBe(true);
  const first = await test.confirm();
  expect(first).toMatchObject({ status: 'confirmed' });
  await expect(test.confirm()).rejects.toThrow('Release unavailable');
  expect(await test.confirm('recover')).toEqual(first);
  const rows = await history(nats.store, `credential-${test.requestId}`, 'test');
  expect(rows).toHaveLength(1);
  expect(rows[0]!.event.data).toMatchObject({ userId: test.userId,
    companyAccountId: 'company-bot', ownerKind: 'company' });
});

it('audits a requested tool covered by verified and frozen scopes',
  async function coveredWriteTool() {
    const test = await fixture({ toolName: 'write',
      accountScopes: ['openid', 'read', 'write'] });
    await expect(test.confirm()).resolves.toMatchObject({ status: 'confirmed' });
    const rows = await history(nats.store, `credential-${test.requestId}`, 'test');
    expect(rows).toHaveLength(1);
  });

it('refuses when no company profile was selected', async function absentProfile() {
  const test = await fixture({ ready: false });
  await expect(test.confirm()).rejects.toThrow('Release unavailable');
  expect(await nats.store.head(`credential-${test.requestId}`)).toBe(0);
});

it('refuses a personal-only choice for the same owner', async function personalChoice() {
  const test = await fixture();
  const subject = test.prepared!.selectionSubject;
  const commandId = `personal-${test.requestId}`;
  const selected = envelope('test', subject, 'connection.selected', {
    action: 'select', userId: test.userId, serverId: test.serverId,
    connectionId: 'installed', profileId: 'personal',
    profileRevision: test.prepared!.personal.revision,
    expectedSequence: test.prepared!.selectionRevision,
  }, digest(['test', subject, commandId]));
  selected.source = 'opencrane-server';
  selected.principal = { kind: 'human', id: test.userId };
  selected.commandId = commandId;
  await nats.seed([selected]);
  await expect(test.confirm()).rejects.toThrow('Release unavailable');
});

it.each(['status', 'accountId', 'generation', 'profileRevision', 'expiresAt'])(
  'refuses changed verified company evidence: %s', async function changedEvidence(field) {
    const test = await fixture();
    const evidence = test.prepared!.evidence;
    const changes: Record<string, unknown> = { status: 'disabled', accountId: 'other-account',
      generation: 2, profileRevision: evidence.profileRevision + 1, expiresAt: 1 };
    Object.assign(evidence, { [field]: changes[field] });
    await expect(test.confirm()).rejects.toThrow('Release unavailable');
  });

it('refuses a changed published tool before audit', async function changedTool() {
  const test = await fixture();
  const changed = envelope('test', `mcp-${test.serverId}`, 'mcp.server_unpublished', {
    serverId: test.serverId, unpublishedBy: 'admin' });
  await nats.seed([changed]);
  await expect(test.confirm()).rejects.toThrow('Release unavailable');
});

it.each([
  { name: 'missing tool mapping', options: { toolName: 'write', missingToolMapping: true,
    accountScopes: ['openid', 'read', 'write'] } },
  { name: 'missing verified scope', options: { toolName: 'write',
    frozenScopes: ['openid', 'read', 'write'] } },
  { name: 'missing frozen scope', options: { toolName: 'write',
    accountScopes: ['openid', 'read', 'write'], frozenScopes: ['openid', 'read'] } },
] satisfies { name: string; options: FixtureOptions }[])(
  'refuses a requested tool with a $name', async function missingScope(testCase) {
    const test = await fixture(testCase.options);
    await expect(test.confirm()).rejects.toThrow('Release unavailable');
    expect(await nats.store.head(`credential-${test.requestId}`)).toBe(0);
  });

it('refuses when the owner loses their saved tool grant', async function lostGrant() {
  const test = await fixture();
  const revoked = envelope('test', grantStream('mcp_server', test.serverId), 'grant.revoked', {
    resourceType: 'mcp_server', resourceId: test.serverId, granteeKind: 'member',
    granteeId: test.userId, revokedBy: 'admin' });
  await nats.seed([revoked]);
  await test.auth.handler.handle(revoked, pgDb(storage.queue));
  await expect(test.confirm()).rejects.toThrow('Release unavailable');
});

it.each(['owner', 'assistant', 'payer', 'computer', 'root'])(
  'refuses a stale %s before audit', async function changedAccess(field) {
    const test = await fixture();
    Object.assign(test.rights, { [field]: false });
    await expect(test.confirm()).rejects.toThrow('Release unavailable');
  });

it('does not claim one request twice during concurrent audits', async function concurrent() {
  const test = await fixture();
  const outcomes = await Promise.allSettled([test.confirm(), test.confirm()]);
  expect(outcomes.filter(function succeeded(item) { return item.status === 'fulfilled'; }))
    .toHaveLength(1);
  expect(await history(nats.store, `credential-${test.requestId}`, 'test')).toHaveLength(1);
});

it('does not claim again after a lost audit reply', async function lostReply() {
  const test = await fixture();
  const append = nats.store.append.bind(nats.store);
  async function uncertain(command: Parameters<typeof append>[0]) {
    await append(command);
    return { status: 'unavailable' as const, cause: new Error('reply lost') };
  }
  vi.spyOn(nats.store, 'append').mockImplementationOnce(uncertain);
  await expect(test.confirm()).rejects.toThrow('Release unavailable');
  await expect(test.confirm()).rejects.toThrow('Release unavailable');
  expect(await history(nats.store, `credential-${test.requestId}`, 'test')).toHaveLength(1);
});

it('allows unrelated chat activity before a company audit', async function chatActivity() {
  const test = await fixture();
  await nats.seed([event(`chat-${test.requestId}`, 'conversation-other', 'message.posted')]);
  await expect(test.confirm()).resolves.toMatchObject({ status: 'confirmed' });
});
