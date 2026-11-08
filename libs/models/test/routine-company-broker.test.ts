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
import { routineCompanyAskFacts } from '../src/routine-company-release.ts';
import { proveRoutineSuccess } from '../../../apps/server/src/routine-success.ts';

let nats: Awaited<ReturnType<typeof natsFixture>>;
let storage: Awaited<ReturnType<typeof databases>>;
let fga: Awaited<ReturnType<typeof openfga>>;
let binding: Awaited<ReturnType<typeof createStore>>;
let serial = 0;
type FixtureOptions = {
  ready?: boolean;
  toolName?: 'read' | 'write';
  toolMode?: 'ask' | 'block';
  unchangedCatalogue?: boolean;
  accountScopes?: string[];
  frozenScopes?: string[];
  missingToolMapping?: boolean;
  missingApproval?: boolean;
  changedApproval?: 'owner' | 'thread' | 'schema' | 'account' | 'destination' |
    'arguments' | 'profile' | 'connection' | 'payer' | 'root' | 'occurrence';
  approvalState?: 'requested' | 'denied' | 'approved' | 'used_twice';
  missingFields?: boolean;
  wrongDecision?: boolean;
  decisionActor?: 'other-member' | 'admin' | 'successor';
  successRequestId?: string;
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
  let policy = toolPolicyFromRows(serverRows);
  if (options.toolMode) {
    const requestedTool = policy.tools.find(function matchesRequestedTool(tool) {
      return tool.name === (options.toolName ?? 'read');
    });
    const mode = envelope('test', serverSubject, 'mcp.tool_mode_set', {
      serverId, connectionId: 'installed', toolName: requestedTool!.name,
      toolRevision: requestedTool!.revision, mode: options.toolMode, setBy: 'admin',
    });
    await nats.seed([mode]);
    const modeRows = await history(nats.store, serverSubject, 'test');
    policy = toolPolicyFromRows(modeRows);
    personal.configuration.policyRevision = policy.policyRevision;
  }
  if (options.unchangedCatalogue) {
    const now = Date.now();
    const checked = envelope('test', serverSubject, 'mcp.catalogue_checked', {
      serverId, outcome: 'unchanged', schemaDigest: policy.catalogue!.schemaDigest,
      checkedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 300_000).toISOString(),
    });
    await nats.seed([checked]);
    const checkedRows = await history(nats.store, serverSubject, 'test');
    policy = toolPolicyFromRows(checkedRows);
  }
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
    policyRevision: policy.policyRevision, schemaDigest: requestedTool!.revision,
    catalogueDigest: policy.catalogue!.schemaDigest,
    profileSubject, selectionSubject, routineSubject };
}

async function fixture(options: FixtureOptions = {}) {
  serial += 1;
  const userId = `owner${serial}`;
  const serverId = `server${serial}`;
  const profileId = `profile${serial}`;
  const requestId = options.successRequestId ?? `request${serial}`;
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
  const approvalId = digest(['approval', requestId]);
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
    schemaDigest: prepared?.catalogueDigest ?? 'd'.repeat(64),
    toolRevision: prepared?.schemaDigest ?? 'd'.repeat(64),
    payingGroupId: 'payer', issuedAt, expiresAt: issuedAt + 30_000,
    approvalId, rootId: 'root', destinationDigest: digest('https://example.test'),
  };
  if (!options.missingApproval) {
    const changed = options.changedApproval;
    const routine = { routineId,
      occurrenceId: changed === 'occurrence' ? 'replacement' : occurrenceId,
      rootId: changed === 'root' ? 'replacement' : release.rootId,
      threadId: changed === 'thread' ? 'replacement' : release.threadId,
      payingGroupId: changed === 'payer' ? 'replacement' : release.payingGroupId,
      profileId: release.profileId,
      profileRevision: changed === 'profile' ? release.profileRevision + 1 :
        release.profileRevision,
      connectionRevision: changed === 'connection' ? release.connectionRevision + 1 :
        release.connectionRevision,
      selectionRevision: release.selectionRevision,
      companyAccountId: changed === 'account' ? 'replacement' : release.companyAccountId,
      accountDigest: release.accountDigest, scopeDigest: release.scopeDigest,
      destinationDigest: changed === 'destination' ? digest('https://other.example') :
        release.destinationDigest };
    const request = envelope('test', `approval-${approvalId}`, 'tool.approval_requested', {
      approvalId, conversationId: release.conversationId, turnId: release.turnId,
      assistantId: release.assistantId,
      requesterId: changed === 'owner' ? 'successor' : userId,
      tool: release.toolName, serverId, toolRevision: release.toolRevision,
      schemaDigest: changed === 'schema' ? digest('replacement') : release.schemaDigest,
      connectionId: release.connectionId, profile: release.profileId,
      policySequence: release.policyRevision, digestVersion: 'lossless-json-v1',
      argumentsDigest: changed === 'arguments' ? digest('replacement') :
        release.argumentsDigest,
      expiresAt: new Date(issuedAt + 900_000).toISOString(), stepUp: false,
      ...(options.missingFields ? { missingFields: ['target'] } : {}),
      ciphertext: 'ZmFrZS1lbmNyeXB0ZWQ=', keyId: 'key:1', reviewDigest: digest('review'),
      routine,
    });
    const decidedBy = options.decisionActor ?? userId;
    const approved = envelope('test', `approval-${approvalId}`, 'approval.decided', {
      approvalId, decidedBy,
      decision: options.approvalState === 'denied' ? 'rejected' : 'approved',
    });
    approved.source = 'opencrane-server';
    approved.principal = { kind: 'human', id: decidedBy };
    const used = envelope('test', `approval-${approvalId}`, 'approval.used', {
      approvalId, permitId: requestId,
    });
    const approvalRows = [request];
    if (options.approvalState !== 'requested') approvalRows.push(approved);
    if (!options.approvalState || options.approvalState === 'denied' ||
        options.approvalState === 'used_twice') {
      approvalRows.push(used);
    }
    if (options.approvalState === 'used_twice') {
      approvalRows.push(envelope('test', `approval-${approvalId}`, 'approval.used', {
        approvalId, permitId: 'another-request',
      }));
    }
    await nats.seed(approvalRows);
  }
  const decision = envelope('test', `decision-${requestId}`, 'decision.recorded', {
    requestId, requesterId: userId, assistantId: 'assistant', conversationId: 'conversation',
    turnId: 'turn', permitId: requestId, serverId, toolName: options.toolName ?? 'read', route: 'mcp',
    outcome: 'allow', reason: options.wrongDecision ? 'policy_allow' : 'approval_used',
    ...(options.successRequestId ? { callId: 'company-call' } : {}),
    contextDigest: 'e'.repeat(64), release,
  }, decisionId);
  decision.correlation.approval = approvalId;
  await nats.seed([decision]);
  const loadConfiguration = prepared?.personal.loadConfiguration ?? function emptyConfiguration() {
    return Promise.resolve({});
  };
  function readProfile() {
    return prepared?.evidence;
  }
  const rights = { owner: true, assistant: true, payer: true, computer: true,
    root: true, thread: true };
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
  return { userId, serverId, requestId, approvalId, release, prepared, rights, auth, confirm };
}

it('refuses a company release without a used owner Ask', async function missingAsk() {
  const test = await fixture({ missingApproval: true });
  await expect(test.confirm()).rejects.toThrow('Release unavailable');
  expect(await nats.store.head(`credential-${test.requestId}`)).toBe(0);
});

it.each(['owner', 'thread', 'schema', 'account', 'destination', 'arguments',
  'profile', 'connection', 'payer', 'root', 'occurrence'] as const)(
  'refuses a changed %s in the saved owner Ask', async function changedAsk(field) {
    const test = await fixture({ changedApproval: field });
    await expect(test.confirm()).rejects.toThrow('Release unavailable');
    expect(await nats.store.head(`credential-${test.requestId}`)).toBe(0);
  });

it('lets the matching owner request reach a recording upstream once',
  async function oneCompanyCall() {
    const test = await fixture();
    const calls: string[] = [];
    async function dispatch() {
      await test.confirm();
      calls.push(test.requestId);
    }
    const outcomes = await Promise.allSettled([dispatch(), dispatch()]);
    const successful = outcomes.filter(function succeeded(item) {
      return item.status === 'fulfilled';
    });
    expect(successful).toHaveLength(1);
    expect(calls).toEqual([test.requestId]);
  });

it('audits one approved owner Ask for an Ask-mode tool', async function approvedAskTool() {
  const test = await fixture({ toolMode: 'ask' });
  const rows = await history(nats.store, `mcp-${test.serverId}`, 'test');
  const policy = toolPolicyFromRows(rows);
  const requestedTool = policy.tools.find(function matchesRequestedTool(tool) {
    return tool.name === test.release.toolName;
  });
  expect(requestedTool?.mode).toBe('ask');
  await expect(test.confirm()).resolves.toMatchObject({ status: 'confirmed' });
  expect(await nats.store.head(`credential-${test.requestId}`)).toBeGreaterThan(0);
});

it('accepts an owner Ask after an unchanged catalogue refresh',
  async function refreshedAskTool() {
    const test = await fixture({ toolMode: 'ask', unchangedCatalogue: true });
    const rows = await history(nats.store, `mcp-${test.serverId}`, 'test');
    const policy = toolPolicyFromRows(rows);
    const requestedTool = policy.tools.find(function matchesRequestedTool(tool) {
      return tool.name === test.release.toolName;
    });
    expect(requestedTool?.mode).toBe('ask');
    expect(policy.sequence).toBeGreaterThan(test.release.policyRevision);
    expect(policy.policyRevision).toBe(test.release.policyRevision);
    await expect(test.confirm()).resolves.toMatchObject({ status: 'confirmed' });
    expect(await nats.store.head(`credential-${test.requestId}`)).toBeGreaterThan(0);
  });

it.each(['requested', 'denied', 'approved', 'used_twice'] as const)(
  'refuses a %s Ask without one valid use', async function unusableAsk(state) {
    const test = await fixture({ approvalState: state });
    await expect(test.confirm()).rejects.toThrow('Release unavailable');
  });

it('refuses approval when consequence fields are missing', async function incompleteAsk() {
  const test = await fixture({ missingFields: true });
  await expect(test.confirm()).rejects.toThrow('Release unavailable');
});

it.each(['other-member', 'admin', 'successor'] as const)(
  'refuses a decision by %s in place of the original owner', async function foreignActor(actor) {
    const test = await fixture({ decisionActor: actor });
    await expect(test.confirm()).rejects.toThrow('Release unavailable');
  });

it('refuses an allowed decision that did not consume the saved Ask',
  async function unlinkedDecision() {
    const test = await fixture({ wrongDecision: true });
    await expect(test.confirm()).rejects.toThrow('Release unavailable');
  });

it('refuses a Block saved after the owner approved', async function blockedTool() {
  const test = await fixture({ toolMode: 'block',
    accountScopes: ['openid', 'read', 'write'] });
  const rows = await history(nats.store, `mcp-${test.serverId}`, 'test');
  const policy = toolPolicyFromRows(rows);
  expect(policy.policyRevision).toBe(test.release.policyRevision);
  expect(policy.tools[0]?.mode).toBe('block');
  await expect(test.confirm()).rejects.toThrow('Release unavailable');
  expect(await nats.store.head(`credential-${test.requestId}`)).toBe(0);
});

it('refuses an expired owner Ask without calling the recorded upstream',
  async function expiredAsk() {
    const test = await fixture();
    const calls: string[] = [];
    async function dispatch() {
      await routineCompanyAskFacts(nats.store, 'test', test.release,
        performance.now() + 10_000);
      calls.push(test.requestId);
    }
    const clock = vi.spyOn(Date, 'now');
    clock.mockReturnValue(test.release.issuedAt + 900_001);
    try {
      await expect(dispatch()).rejects.toThrow('Release unavailable');
      expect(calls).toHaveLength(0);
    } finally {
      clock.mockRestore();
    }
  });

it('reads a waiting Ask without saving a decision or calling upstream',
  async function waitingRead() {
    const test = await fixture({ approvalState: 'requested' });
    const before = await nats.store.head(`approval-${test.approvalId}`);
    await expect(routineCompanyAskFacts(nats.store, 'test', test.release,
      performance.now() + 10_000)).rejects.toThrow('Release unavailable');
    expect(await nats.store.head(`approval-${test.approvalId}`)).toBe(before);
    expect(await nats.store.head(`credential-${test.requestId}`)).toBe(0);
  });

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

it('accepts a successful call after the existing company release audit',
  async function auditedSuccess() {
    const test = await fixture({
      successRequestId: `00000000-0000-4000-8000-${String(serial + 1).padStart(12, '0')}`,
    });
    await expect(test.confirm()).resolves.toMatchObject({ status: 'confirmed' });
    const release = test.release;
    const call = { conversationId: release.conversationId, turnId: release.turnId,
      callId: 'company-call', serverId: release.serverId, toolName: release.toolName };
    const upstream = envelope('test', `decision-${release.requestId}`, 'tool.dispatch_recorded', {
      ...call, requestId: release.requestId, logicalRequestId: '2'.repeat(64),
      startedAt: new Date().toISOString(), durationMs: 3, outcome: 'responded',
      evidence: 'response_received',
    });
    await nats.seed([upstream]);
    const privateResult = envelope('test', `conversation-${release.conversationId}`,
      'agent.tool_call_finished', { ...call, status: 'completed' });
    privateResult.source = 'computer-bridge';
    privateResult.principal = { kind: 'agent', id: release.assistantId };
    await nats.seed([privateResult]);
    const resultReference = { eventId: privateResult.id,
      position: await nats.store.head(privateResult.subject) };
    const reservationId = `model-hold-${release.requestId}`;
    const modelCall = { model: 'gpt-6-luna', priceTableId: 'openai-2026-10-02-all-eur95',
      computerId: release.computerId, generation: release.computerGeneration,
      requesterId: release.userId, assistantId: release.assistantId,
      conversationId: release.conversationId, turnId: release.turnId,
      threadId: release.threadId, payingGroupId: release.payingGroupId,
      contextDigest: '1'.repeat(64) };
    const hold = envelope('test', 'budget-test', 'budget.reserved', {
      reservationId, permitId: reservationId, amountCents: 500,
      rootId: release.rootId, payingGroupId: release.payingGroupId,
      assistantId: release.assistantId, modelCall,
    });
    const settlement = envelope('test', 'budget-test', 'budget.settled', {
      reservationId, permitId: reservationId, settledCents: 260,
    });
    await nats.seed([hold, settlement]);
    const root = { rootId: release.rootId, requesterId: release.userId,
      assistantId: release.assistantId, computerId: release.computerId,
      generation: release.computerGeneration, conversationId: release.conversationId,
      turnId: release.turnId, threadId: release.threadId,
      payingGroupId: release.payingGroupId };
    const definition = { connectionId: release.connectionId, profileId: release.profileId,
      profileRevision: release.profileRevision, connectionRevision: release.connectionRevision,
      companyAccountId: release.companyAccountId, ownerId: release.ownerId };
    const budgetRows = await history(nats.store, 'budget-test', 'test');
    const evidence = { requestId: release.requestId, resultReference, reservationId };
    const outcome = await proveRoutineSuccess(nats.store, 'test', evidence, root, definition,
      release.routineId, release.occurrenceId, budgetRows, performance.now() + 10_000);
    expect(outcome).toEqual({ resultReference, heldCents: 0, settledCents: 260 });
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
