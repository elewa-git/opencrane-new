import type { AppendCommand } from '@opencrane/event-store';
import { setTimeout as pause } from 'node:timers/promises';
import { z } from 'zod';
import { expect, it, vi } from 'vitest';
import { mcpCatalogueWatch } from '../src/mcp-catalogue-watch.ts';
import { grantStream } from '@opencrane/authz';
import { decideApproval, history, ingestUsage, priceTableId, readApproval, readToolPolicy,
  setToolPolicy } from '../src/index.ts';
import { catalogueEvidence, fixture, reviewCatalogue, toolEvidence } from './fixture.ts';
import capture from './fixtures/codex-0.159.2-tools-call.json' with { type: 'json' };

type Fixture = Awaited<ReturnType<typeof fixture>>;
const review = { action: 'Write note', consequence: 'The order note changes.',
  targetArgument: 'order', fields: ['order', 'note'], stepUp: false };
const tool = toolEvidence({ name: 'write', reviewed: true, costCents: 0, review });
const catalogue = catalogueEvidence([tool]);
const body = JSON.stringify(capture.body);

async function prepare(setup: Fixture, kind: 'remote' | 'hosted' = 'remote') {
  let locator = 'https://fixture.example.test/mcp';
  if (kind === 'hosted') locator = `registry.example.test/fixture@sha256:${'a'.repeat(64)}`;
  const registration = { serverId: 'fixture', kind, locator, registeredBy: 'alice' };
  await setup.append('mcp-fixture', 'mcp.server_registered', registration);
  const discovery = { serverId: 'fixture', connectionId: 'installed', accountMode: 'none',
    ...catalogue };
  await setup.append('mcp-fixture', 'mcp.server_discovered', discovery);
  await reviewCatalogue(setup);
  const publication = { serverId: 'fixture', publishedBy: 'alice' };
  const mode = { serverId: 'fixture', connectionId: 'installed', toolName: 'write',
    toolRevision: tool.revision, mode: 'allow', setBy: 'alice' };
  await setup.append('mcp-fixture', 'mcp.tool_mode_set', mode);
  await setup.append('mcp-fixture', 'mcp.server_published', publication);
  for (const [granteeId, granteeKind] of [['alice', 'member'], ['assistant', 'assistant']]) {
    const grant = { resourceType: 'mcp_server', resourceId: 'fixture',
      granteeId, granteeKind, grantedBy: 'alice' };
    const event = await setup.append(grantStream('mcp_server', 'fixture'), 'grant.given', grant);
    await setup.auth.handler.handle(event, setup.db);
  }
  const thread = capture.body.params._meta.threadId;
  const claims = { ...setup.t, thread };
  const turn = { assistantId: 'assistant', computerId: 'computer',
    conversationId: 'conversation', turnId: 'turn', threadId: thread,
    requesterId: 'alice', task: 'chat_turn', payingGroupId: 'personal-default' };
  // Replace the fixture turn so its signed thread matches these captured bytes.
  await setup.append('computer-assistant', 'computer.turn_started', { ...turn, turnId: 'dispatch' });
  await setup.append('conversation-conversation', 'agent.turn_started',
    { conversationId: 'conversation', assistantId: 'assistant', turnId: 'dispatch' });
  const token = await setup.sign({ ...claims, turn: 'dispatch' }, 'decision-service');
  return { ...setup.headers, ...capture.headers, 'session-id': thread, 'x-turn-token': token };
}

async function permit(setup: Fixture, headers: Record<string, string>) {
  const request = { method: 'POST', headers, body };
  const response = await fetch(`${setup.options.decisionUrl}/authorize/mcp/fixture/installed`,
    request);
  expect(response.status, await response.text()).toBe(200);
  const value = response.headers.get('x-opencrane-mcp-permit');
  expect(value).toBeTruthy();
  return value!;
}

async function send(setup: Fixture, value: string, changedBody = body,
  path = '/dispatch/mcp/fixture/installed') {
  const headers = { 'x-opencrane-mcp-permit': value, 'content-type': 'application/json' };
  const request = { method: 'POST', headers, body: changedBody };
  return fetch(`${setup.options.decisionUrl}${path}`, request);
}

const changes = ['catalogue', 'generation', 'expiry', 'backend', 'body', 'route', 'silo', 'permit expiry'] as const;
async function refusesChangedCall(change: typeof changes[number]) {
  const setup = await fixture();
  try {
    const headers = await prepare(setup);
    let value = await permit(setup, headers);
    const route = setup.options.mcpRoutes[0]!;
    let changedBody = body;
    let path = '/dispatch/mcp/fixture/installed';
    if (change === 'catalogue') {
      const data = { serverId: 'fixture', previousSchemaDigest: catalogue.schemaDigest,
        newSchemaDigest: 'a'.repeat(64) };
      await setup.append('mcp-fixture', 'mcp.tools_changed', data);
    } else if (change === 'generation') {
      route.generation = 'instance-2';
    } else if (change === 'backend') {
      route.upstream = '127.0.0.1:1';
    } else if (change === 'expiry') {
      const checkedAt = new Date(Date.now() - 1000).toISOString();
      const expiresAt = new Date(Date.now() - 1).toISOString();
      const data = { serverId: 'fixture', schemaDigest: catalogue.schemaDigest,
        outcome: 'unchanged', checkedAt, expiresAt };
      await setup.append('mcp-fixture', 'mcp.catalogue_checked', data);
    } else if (change === 'body') {
      changedBody = body.replace('write', 'other');
    } else if (change === 'route') {
      path = '/dispatch/mcp/other/installed';
    } else if (change === 'silo') {
      const [encoded, signature] = value.split('.');
      const decodedBytes = Buffer.from(encoded!, 'base64url');
      const decoded: unknown = JSON.parse(decodedBytes.toString());
      const binding = z.record(z.string(), z.unknown()).parse(decoded);
      binding['silo'] = 'other';
      const substitutedBytes = Buffer.from(JSON.stringify(binding));
      const substituted = substitutedBytes.toString('base64url');
      value = `${substituted}.${signature}`;
    } else {
      await pause(2100);
    }
    const response = await send(setup, value, changedBody, path);
    expect(response.status).toBe(403);
    expect(setup.received()).toBe(0);
  } finally {
    await setup.close();
  }
}
it.each(changes)('refuses %s changes between the access decision and send', refusesChangedCall);

async function refusesReuse() {
  const setup = await fixture();
  try {
    const headers = await prepare(setup);
    const value = await permit(setup, headers);
    const first = await send(setup, value);
    expect(first.status, await first.text()).toBe(200);
    const second = await send(setup, value);
    expect(second.status).toBe(403);
    expect(setup.received()).toBe(1);
    expect(setup.upstreamBody()).toBe(body);
    expect(setup.providerHeaders()).toContain('x-opencrane-mcp-revision');
    expect(setup.providerHeaders()).not.toContain('x-opencrane-mcp-permit');
  } finally {
    await setup.close();
  }
}
it('sends original bytes with the revision precondition and consumes its permit once', refusesReuse);

async function allowsModelAndToolFromOneProcess() {
  const setup = await fixture();
  try {
    const model = await setup.call();
    expect(model.status, model.text).toBe(200);
    expect(setup.received()).toBe(1);
    const headers = await prepare(setup);
    const value = await permit(setup, headers);
    const tool = await send(setup, value);
    expect(tool.status, await tool.text()).toBe(200);
    expect(setup.received()).toBe(2);
  } finally {
    await setup.close();
  }
}
it('admits model and ordinary MCP calls from the same decision process',
  allowsModelAndToolFromOneProcess);

async function refusesUnsupported() {
  const setup = await fixture();
  try {
    const headers = await prepare(setup);
    delete setup.options.mcpRoutes[0]!.revisionHeader;
    const request = { method: 'POST', headers, body };
    const response = await fetch(`http://127.0.0.1:${setup.options.port}/mcp/fixture/installed`,
      request);
    expect(response.status, await response.text()).toBe(403);
    expect(setup.received()).toBe(0);
  } finally {
    await setup.close();
  }
}
it('denies mutable servers without an operator-reviewed atomic revision contract', refusesUnsupported);

const upstreamChanges = ['revision', 'generation'] as const;
async function refusesUpstreamChange(change: typeof upstreamChanges[number]) {
  const setup = await fixture();
  try {
    const headers = await prepare(setup);
    setup.mcpPrecondition.revision = catalogue.schemaDigest;
    const value = await permit(setup, headers);
    if (change === 'revision') {
      setup.mcpPrecondition.revision = 'a'.repeat(64);
    } else {
      setup.mcpPrecondition.generation = 'instance-2';
    }
    const response = await send(setup, value);
    expect(response.status).toBe(409);
    expect(setup.received()).toBe(0);
  } finally {
    await setup.close();
  }
}
it.each(upstreamChanges)('requires the backend to atomically refuse a changed %s',
  refusesUpstreamChange);

async function refusesUnadmittedImage() {
  const setup = await fixture();
  try {
    const headers = await prepare(setup, 'hosted');
    const request = { method: 'POST', headers, body };
    const response = await fetch(`http://127.0.0.1:${setup.options.port}/mcp/fixture/installed`,
      request);
    expect(response.status, await response.text()).toBe(403);
    expect(setup.received()).toBe(0);
  } finally {
    await setup.close();
  }
}
it('refuses a hosted image without recorded image admission', refusesUnadmittedImage);

async function refusesChangeDuringLeaderCheck() {
  const setup = await fixture();
  try {
    const headers = await prepare(setup);
    const value = await permit(setup, headers);
    async function changeBeforeSend() {
      const data = { serverId: 'fixture', previousSchemaDigest: catalogue.schemaDigest,
        newSchemaDigest: 'a'.repeat(64) };
      await setup.append('mcp-fixture', 'mcp.tools_changed', data);
    }
    setup.dispatchOptions.requireLeader = changeBeforeSend;
    expect((await send(setup, value)).status).toBe(403);
    expect(setup.received()).toBe(0);
  } finally {
    await setup.close();
  }
}
it('refuses catalogue changes while the leadership check waits', refusesChangeDuringLeaderCheck);

const blockPoints = [
  'first policy read', 'leadership check', 'access read', 'terminating read or admission',
] as const;
async function refusesBlockDuringFinalAccessReads(point: typeof blockPoints[number]) {
  const setup = await fixture();
  try {
    const headers = await prepare(setup);
    const value = await permit(setup, headers);
    const policy = await readToolPolicy(setup.nats.store, 'test', 'fixture');
    const head = setup.nats.store.head.bind(setup.nats.store);
    const append = setup.nats.store.append.bind(setup.nats.store);
    let memberReads = 0;
    let mcpReads = 0;
    const policyRead = Promise.withResolvers<void>();
    let blocked = false;
    async function saveBlock() {
      if (blocked) return;
      blocked = true;
      const command = { commandId: 'block-during-dispatch', expectedSequence: policy.sequence,
        connectionId: 'installed', toolName: 'write', toolRevision: tool.revision, mode: 'block' };
      const result = await setToolPolicy(setup.nats.store, setup.binding, 'alice',
        'fixture', command);
      expect(result.status).toBe('appended');
    }
    async function blockDuringRead(...args: Parameters<typeof head>) {
      const position = await head(...args);
      if (args[0] === 'mcp-fixture') {
        mcpReads += 1;
        const target = point === 'terminating read or admission' ? 3 : 2;
        if (mcpReads === target) policyRead.resolve();
      }
      if (blocked) return position;
      if (point === 'first policy read' && args[0] === 'mcp-fixture') {
        await saveBlock();
      }
      if (args[0] === 'member-alice') {
        memberReads += 1;
        if (point === 'access read' && memberReads === 1) {
          await policyRead.promise;
          await saveBlock();
        }
        // Pause the old final pass. After its removal, pause the admission append instead.
        if (point === 'terminating read or admission' && memberReads === 2) {
          await policyRead.promise;
          await saveBlock();
        }
      }
      return position;
    }
    async function blockBeforeAdmission(command: AppendCommand) {
      const event = z.object({ type: z.string() }).parse(command.event);
      if (event.type === 'mcp.dispatch_admitted') await saveBlock();
      return append(command);
    }
    if (point === 'leadership check') setup.dispatchOptions.requireLeader = saveBlock;
    const delayedRead = vi.spyOn(setup.nats.store, 'head');
    const delayedAppend = vi.spyOn(setup.nats.store, 'append');
    delayedRead.mockImplementation(blockDuringRead);
    delayedAppend.mockImplementation(blockBeforeAdmission);
    try {
      const reply = await send(setup, value);
      await reply.text();
      expect(blocked).toBe(true);
      expect(setup.received()).toBe(0);
      expect(reply.status).toBe(403);
    } finally {
      delayedRead.mockRestore();
      delayedAppend.mockRestore();
    }
  } finally {
    await setup.close();
  }
}
it.each(blockPoints)('refuses a Block saved during the %s', refusesBlockDuringFinalAccessReads);

async function allowsConcurrentCalls() {
  const setup = await fixture();
  try {
    const headers = await prepare(setup);
    const firstPermit = await permit(setup, headers);
    const secondPermit = await permit(setup, headers);
    const before = await readToolPolicy(setup.nats.store, 'test', 'fixture');
    const append = setup.nats.store.append.bind(setup.nats.store);
    const bothReady = Promise.withResolvers<void>();
    let admissionAttempts = 0;
    async function overlapAdmissions(command: AppendCommand) {
      const event = z.object({ type: z.string() }).parse(command.event);
      if (event.type === 'mcp.dispatch_admitted') {
        admissionAttempts += 1;
        if (admissionAttempts === 2) bothReady.resolve();
        await bothReady.promise;
      }
      return append(command);
    }
    const delayed = vi.spyOn(setup.nats.store, 'append');
    delayed.mockImplementation(overlapAdmissions);
    try {
      const responses = await Promise.all([send(setup, firstPermit), send(setup, secondPermit)]);
      for (const response of responses) {
        expect(response.status, await response.text()).toBe(200);
      }
      expect(setup.received()).toBe(2);
      const policy = await readToolPolicy(setup.nats.store, 'test', 'fixture');
      expect(policy.policyRevision).toBe(before.policyRevision);
      expect(policy.tools[0]?.mode).toBe('allow');
    } finally {
      bothReady.resolve();
      delayed.mockRestore();
    }
  } finally {
    await setup.close();
  }
}
it('allows two concurrent calls on the same tool', allowsConcurrentCalls);

async function refusesGenerationDuringDecisionSave() {
  const setup = await fixture();
  try {
    const headers = await prepare(setup);
    const append = setup.nats.store.append.bind(setup.nats.store);
    async function replaceDuringSave(command: AppendCommand) {
      const result = await append(command);
      const event = z.object({ type: z.string() }).parse(command.event);
      if (event.type === 'decision.recorded') {
        setup.options.mcpRoutes[0]!.generation = 'instance-2';
        setup.mcpPrecondition.generation = 'instance-2';
      }
      return result;
    }
    const changed = vi.spyOn(setup.nats.store, 'append');
    changed.mockImplementation(replaceDuringSave);
    try {
      const request = { method: 'POST', headers, body };
      const response = await fetch(`http://127.0.0.1:${setup.options.port}/mcp/fixture/installed`,
        request);
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(setup.received()).toBe(0);
    } finally {
      changed.mockRestore();
    }
  } finally {
    await setup.close();
  }
}
it('refuses a replacement generation while saving the allow decision',
  refusesGenerationDuringDecisionSave);

async function allowsAdmissionBeforeBlock() {
  const setup = await fixture();
  try {
    const headers = await prepare(setup);
    const value = await permit(setup, headers);
    const append = setup.nats.store.append.bind(setup.nats.store);
    let blocked = false;
    async function blockAfterAdmission(command: AppendCommand) {
      const result = await append(command);
      const event = z.object({ type: z.string() }).parse(command.event);
      if (event.type === 'mcp.dispatch_admitted' && result.status === 'appended') {
        const block = { commandId: 'block-after-admission', expectedSequence: result.sequence,
          connectionId: 'installed', toolName: 'write', toolRevision: tool.revision, mode: 'block' };
        const saved = await setToolPolicy(setup.nats.store, setup.binding, 'alice',
          'fixture', block);
        expect(saved.status).toBe('appended');
        blocked = true;
      }
      return result;
    }
    const delayed = vi.spyOn(setup.nats.store, 'append');
    delayed.mockImplementation(blockAfterAdmission);
    try {
      const response = await send(setup, value);
      expect(response.status, await response.text()).toBe(200);
      expect(blocked).toBe(true);
      expect(setup.received()).toBe(1);
      const request = { method: 'POST', headers, body };
      const later = await fetch(`${setup.options.decisionUrl}/authorize/mcp/fixture/installed`,
        request);
      expect(later.status, await later.text()).toBe(403);
      expect(setup.received()).toBe(1);
    } finally {
      delayed.mockRestore();
    }
  } finally {
    await setup.close();
  }
}
it('allows an admitted call while a later Block refuses later calls', allowsAdmissionBeforeBlock);

async function refusesPublicationAfterDrift(recapture: boolean) {
  const setup = await fixture();
  try {
    const headers = await prepare(setup);
    const value = await permit(setup, headers);
    const before = await readToolPolicy(setup.nats.store, 'test', 'fixture');
    const snapshot = before.catalogue!;
    // Keep this tool unchanged to prove that the whole server stays held.
    const added = toolEvidence({ name: 'another', reviewed: false, costCents: 0 });
    const evidence = catalogueEvidence([tool, added]);
    const changed = { ...snapshot, ...evidence };
    const data = { serverId: 'fixture', previousSchemaDigest: snapshot.schemaDigest,
      newSchemaDigest: changed.schemaDigest, catalogue: changed };
    await setup.append('mcp-fixture', 'mcp.tools_changed', data);
    if (recapture) {
      await setup.append('mcp-fixture', 'mcp.server_discovered', changed);
    }
    await reviewCatalogue(setup);
    const mode = { serverId: 'fixture', connectionId: 'installed', toolName: 'write',
      toolRevision: tool.revision, mode: 'allow', setBy: 'alice' };
    await setup.append('mcp-fixture', 'mcp.tool_mode_set', mode);
    const publication = { serverId: 'fixture', publishedBy: 'alice' };
    await setup.append('mcp-fixture', 'mcp.server_published', publication);
    await setup.restart();
    expect((await send(setup, value)).status).toBe(403);
    const request = { method: 'POST', headers, body };
    const response = await fetch(`http://127.0.0.1:${setup.options.port}/mcp/fixture/installed`,
      request);
    expect(response.status, await response.text()).toBe(403);
    expect(setup.received()).toBe(0);
    const policy = await readToolPolicy(setup.nats.store, 'test', 'fixture');
    expect(policy.tools[0]).toMatchObject({ reviewed: true, mode: 'allow' });
    expect(policy.published).toBe(false);
  } finally {
    await setup.close();
  }
}
it.each([false, true])('keeps reviewed tools held through publication and gateway restart (recapture %s)',
  refusesPublicationAfterDrift);
async function stopBudget(setup: Fixture, scopeId = 'personal-default') {
  const limit = { scope: 'paying_group', scopeId, ceilingCents: 0, setBy: 'alice' };
  await setup.actor.configure(limit);
}

const budgetChanges = ['old pass', 'renewed token', 'other payer', 'recovered limit'] as const;
async function checksBudgetBeforeToolSend(change: typeof budgetChanges[number]) {
  const setup = await fixture();
  try {
    const headers = await prepare(setup);
    const value = await permit(setup, headers);
    await stopBudget(setup, change === 'other payer' ? 'other' : 'personal-default');
    if (change === 'recovered limit') {
      const limit = { scope: 'paying_group', scopeId: 'personal-default',
        ceilingCents: 20000, setBy: 'alice' };
      await setup.actor.configure(limit);
    }
    let response: Response;
    if (change === 'renewed token') {
      const input = { assistantId: 'assistant', conversationId: 'conversation', turnId: 'dispatch',
        threadId: capture.body.params._meta.threadId, requesterId: 'alice',
        task: 'chat_turn', model: 'gpt-6-luna' };
      const renewed = await setup.credentials.turn(input);
      const renewedHeaders = { ...headers, 'x-turn-token': renewed.value };
      const request = { method: 'POST', headers: renewedHeaders, body };
      response = await fetch(`http://127.0.0.1:${setup.options.port}/mcp/fixture/installed`,
        request);
    } else {
      response = await send(setup, value);
    }
    const allowed = change === 'other payer';
    const expected = allowed ? [200] : [402, 403];
    expect(expected, await response.text()).toContain(response.status);
    expect(setup.received()).toBe(allowed ? 1 : 0);
    expect(setup.actor.state.reservations).toEqual([]);
    expect(setup.actor.state.dispatches).toHaveLength(allowed ? 1 : 0);
  } finally {
    await setup.close();
  }
}
it.each(budgetChanges)('checks zero-cost MCP spending stops for %s', checksBudgetBeforeToolSend);

const approvalStops = ['before approval', 'after approval.used', 'before Ask'] as const;
async function stopsWaitingApproval(point: typeof approvalStops[number]) {
  const setup = await fixture();
  try {
    const headers = await prepare(setup);
    const mode = { serverId: 'fixture', connectionId: 'installed', toolName: 'write',
      toolRevision: tool.revision, mode: 'ask', setBy: 'alice' };
    await setup.append('mcp-fixture', 'mcp.tool_mode_set', mode);
    const publication = { serverId: 'fixture', publishedBy: 'alice' };
    await setup.append('mcp-fixture', 'mcp.server_published', publication);
    const request = { method: 'POST', headers, body };
    const url = `http://127.0.0.1:${setup.options.port}/mcp/fixture/installed`;
    if (point === 'before Ask') await stopBudget(setup);
    const asked = await fetch(url, request);
    const answer = z.object({ approvalId: z.string().optional() }).parse(await asked.json());
    if (point === 'before Ask') {
      expect(answer.approvalId).toBeUndefined();
      expect(setup.received()).toBe(0);
      return;
    }
    const approvalId = z.string().parse(answer.approvalId);
    if (point === 'before approval') {
      const call = { model: 'gpt-6-luna', priceTableId, computerId: 'computer',
        assistantId: 'assistant', requesterId: 'alice', conversationId: 'conversation',
        turnId: 'exhausting', threadId: 'thread', payingGroupId: 'personal-default',
        contextDigest: '0'.repeat(64) };
      await expect(setup.actor.reserve(call, 20001)).rejects.toThrow('spending cap');
    }
    async function fresh() {}
    const current = await readApproval(setup.nats.store, 'test', approvalId);
    const approved = await decideApproval(setup.nats.store, 'test', approvalId,
      'alice', 'approved', true, fresh, current, setup.actor.now());
    expect(approved.status).toBe('appended');
    const append = setup.nats.store.append.bind(setup.nats.store);
    async function pauseAfterUse(command: AppendCommand) {
      const result = await append(command);
      const event = z.object({ type: z.string() }).parse(command.event);
      if (event.type === 'approval.used' && point === 'after approval.used') {
        await stopBudget(setup);
      }
      return result;
    }
    const writer = vi.spyOn(setup.nats.store, 'append');
    writer.mockImplementation(pauseAfterUse);
    try {
      const retryHeaders = { ...headers, 'x-opencrane-approval-id': approvalId };
      const retry = { ...request, headers: retryHeaders };
      const response = await fetch(url, retry);
      expect(response.status, await response.text()).not.toBe(200);
      expect(setup.received()).toBe(0);
      expect(setup.actor.state.dispatches).toEqual([]);
      expect(setup.actor.state.reservations).toEqual([]);
      const rows = await history(setup.nats.store, `approval-${approvalId}`, 'test');
      function isUse(row: (typeof rows)[number]) {
        return row.event.type === 'approval.used';
      }
      expect(rows.filter(isUse)).toHaveLength(point === 'after approval.used' ? 1 : 0);
    } finally {
      writer.mockRestore();
    }
  } finally {
    await setup.close();
  }
}
it.each(approvalStops)('refuses stopped Ask calls %s without sending upstream', stopsWaitingApproval);

const recoveryCalls = ['refused MCP pass', 'untouched turn', 'renewed token'] as const;
async function refusesModelAfterFreeTurnStop(attempt: typeof recoveryCalls[number]) {
  const setup = await fixture();
  try {
    const headers = await prepare(setup);
    const value = await permit(setup, headers);
    await stopBudget(setup);
    if (attempt === 'refused MCP pass') {
      const refused = await send(setup, value);
      expect(refused.status, await refused.text()).toBe(403);
    }
    const limit = { scope: 'paying_group', scopeId: 'personal-default',
      ceilingCents: 20000, setBy: 'alice' };
    await setup.actor.configure(limit);
    if (attempt === 'renewed token') {
      const input = { assistantId: 'assistant', conversationId: 'conversation', turnId: 'dispatch',
        threadId: capture.body.params._meta.threadId, requesterId: 'alice',
        task: 'chat_turn', model: 'gpt-6-luna' };
      const renewed = await setup.credentials.turn(input);
      headers['x-turn-token'] = renewed.value;
    }
    const response = await setup.call(headers);
    expect.soft(response.status, response.text).toBe(402);
    expect.soft(setup.received()).toBe(0);
    expect.soft(setup.actor.state.reservations).toEqual([]);
    expect.soft(setup.actor.state.dispatches).toEqual([]);

    const turn = { assistantId: 'assistant', computerId: 'computer',
      conversationId: 'conversation', turnId: 'fresh', threadId: 'fresh-thread',
      requesterId: 'alice', task: 'chat_turn', payingGroupId: 'personal-default' };
    await setup.append('computer-assistant', 'computer.turn_started', turn);
    const started = { conversationId: 'conversation', assistantId: 'assistant', turnId: 'fresh' };
    await setup.append('conversation-conversation', 'agent.turn_started', started);
    const claims = { ...setup.t, turn: 'fresh', thread: 'fresh-thread' };
    const token = await setup.sign(claims, 'decision-service');
    const freshHeaders = { 'x-turn-token': token, 'session-id': 'fresh-thread' };
    const fresh = await setup.call(freshHeaders);
    expect(fresh.status, fresh.text).toBe(200);
    expect(setup.received()).toBe(1);
    expect(setup.actor.state.reservations).toHaveLength(1);
    expect(setup.actor.state.dispatches).toHaveLength(1);
  } finally {
    await setup.close();
  }
}
it.each(recoveryCalls)('keeps a stopped free turn from model sends after recovery: %s',
  refusesModelAfterFreeTurnStop);

async function checksAdmissionOrder(stopped: boolean) {
  const setup = await fixture();
  try {
    const headers = await prepare(setup);
    const value = await permit(setup, headers);
    const append = setup.nats.store.append.bind(setup.nats.store);
    const order: string[] = [];
    async function stopAfterBudgetAdmission(command: AppendCommand) {
      const result = await append(command);
      const event = z.object({ type: z.string() }).parse(command.event);
      if (result.status !== 'appended') return result;
      if (event.type === 'mcp.dispatch_admitted') order.push(event.type);
      if (event.type === 'budget.call_dispatch_admitted') {
        order.push(event.type);
        if (stopped) {
          const stop = { conversationId: 'conversation', turnId: 'dispatch', requestedBy: 'alice' };
          await setup.append('conversation-conversation', 'agent.turn_stop_requested', stop);
          order.push('agent.turn_stop_requested');
        }
      }
      return result;
    }
    const writer = vi.spyOn(setup.nats.store, 'append');
    writer.mockImplementation(stopAfterBudgetAdmission);
    try {
      const response = await send(setup, value);
      if (stopped) {
        expect(response.status, await response.text()).toBe(403);
        expect(order).toEqual(['budget.call_dispatch_admitted', 'agent.turn_stop_requested']);
        expect(setup.received()).toBe(0);
      } else {
        expect(response.status, await response.text()).toBe(200);
        expect(order).toEqual(['budget.call_dispatch_admitted', 'mcp.dispatch_admitted']);
        expect(setup.received()).toBe(1);
      }
      expect(setup.actor.state.reservations).toEqual([]);
    } finally {
      writer.mockRestore();
    }
  } finally {
    await setup.close();
  }
}
it.each([false, true])('orders budget before tool admission and checks Stop between them: %s',
  checksAdmissionOrder);

async function watchesCatalogue(failure: 'drift append' | 'drift saved' | 'failed' | 'stalled' | 'replacement') {
  const setup = await fixture();
  let watch: ReturnType<typeof mcpCatalogueWatch> | undefined;
  let expectedCalls = 0;
  try {
    const headers = await prepare(setup);
    const value = await permit(setup, headers);
    const before = await readToolPolicy(setup.nats.store, 'test', 'fixture');
    const capture = vi.fn().mockResolvedValue(before.catalogue);
    const options = { serverIds: ['fixture'], capture, requireLeader: setup.dispatchOptions.requireLeader.bind(setup.dispatchOptions) };
    watch = mcpCatalogueWatch(setup.nats.store, 'test', options);
    setup.dispatchOptions.requireCatalogue = watch.requireCurrent;
    expect((await send(setup, value)).status).toBe(403);
    const startup = watch.check('fixture');
    expect(watch.check('fixture')).toBe(startup);
    await startup;
    expect(capture).toHaveBeenCalledTimes(1);
    const freshPermit = await permit(setup, headers);
    if (failure === 'replacement') {
      const started = Promise.withResolvers<void>();
      const late = Promise.withResolvers<NonNullable<typeof before.catalogue>>();
      function pendingCapture() {
        started.resolve();
        return late.promise;
      }
      capture.mockImplementation(pendingCapture);
      const checking = watch.check('fixture');
      const cancelled = expect(checking).rejects.toThrow();
      await started.promise;
      watch.close();
      await cancelled;
      capture.mockResolvedValue(before.catalogue);
      watch = mcpCatalogueWatch(setup.nats.store, 'test', options);
      setup.dispatchOptions.requireCatalogue = watch.requireCurrent;
      expect((await send(setup, freshPermit)).status).toBe(403);
      await watch.check('fixture');
      expect(capture).toHaveBeenCalledTimes(3);
      const current = await readToolPolicy(setup.nats.store, 'test', 'fixture');
      late.resolve(before.catalogue!);
      await pause(0);
      const afterLateResult = await readToolPolicy(setup.nats.store, 'test', 'fixture');
      expect(afterLateResult.sequence).toBe(current.sequence);
    } else {
      const append = setup.nats.store.append.bind(setup.nats.store);
      let driftAppendAttempted = false;
      const captureStarted = Promise.withResolvers<void>();
      const stalled = Promise.withResolvers<NonNullable<typeof before.catalogue>>();
      async function failDriftAppend(command: AppendCommand) {
        const event = z.object({ type: z.string() }).parse(command.event);
        if (event.type === 'mcp.tools_changed') {
          driftAppendAttempted = true;
          expect((await send(setup, freshPermit)).status).toBe(403);
          throw new Error('Event store unavailable');
        }
        return append(command);
      }
      if (failure === 'drift append' || failure === 'drift saved') {
        const added = toolEvidence({ name: 'another', reviewed: false, costCents: 0 });
        capture.mockResolvedValue({ ...before.catalogue, ...catalogueEvidence([tool, added]) });
        if (failure === 'drift append') {
          vi.spyOn(setup.nats.store, 'append').mockImplementation(failDriftAppend);
        }
      } else if (failure === 'failed') {
        capture.mockRejectedValue(new Error('Upstream unavailable'));
      } else {
        function stallCapture() {
          captureStarted.resolve();
          return stalled.promise;
        }
        capture.mockImplementation(stallCapture);
      }
      const checking = watch.check('fixture');
      let refused: Promise<unknown>;
      if (failure === 'drift saved') refused = checking;
      else refused = expect(checking).rejects.toThrow();
      if (failure === 'stalled') {
        await captureStarted.promise;
      }
      await refused;
      if (failure === 'drift append') expect(driftAppendAttempted).toBe(true);
      if (failure === 'stalled') {
        stalled.resolve(before.catalogue!);
        await pause(0);
      }
      expect((await send(setup, freshPermit)).status).toBe(403);
      expect(() => watch!.requireCurrent('fixture')).toThrow();
      if (failure === 'drift saved') {
        const held = await readToolPolicy(setup.nats.store, 'test', 'fixture');
        expect(held.driftHeld).toBe(true);
        expect(held.previousCatalogue).toEqual(before.catalogue);
      } else if (failure !== 'drift append') {
        const failed = await readToolPolicy(setup.nats.store, 'test', 'fixture');
        expect(failed.expiresAt).toBeNull();
        expect(failed.policyRevision).toBeGreaterThan(before.policyRevision);
        capture.mockResolvedValue(before.catalogue);
        await watch.check('fixture');
        const recovered = await readToolPolicy(setup.nats.store, 'test', 'fixture');
        expect(recovered.policyRevision).toBeGreaterThan(before.policyRevision);
        const newPermit = await permit(setup, headers);
        expect((await send(setup, newPermit)).status).toBe(200);
        expectedCalls = 1;
      }
    }
    expect(setup.received()).toBe(expectedCalls);
  } finally {
    vi.restoreAllMocks();
    watch?.close();
    await setup.close();
  }
}
it.each(['drift append', 'drift saved', 'failed', 'stalled', 'replacement'] as const)(
  'holds recording upstream through %s and recaptures on worker replacement', watchesCatalogue, 60_000);

async function grantToolApproval(setup: Fixture, headers: Record<string, string>) {
  const mode = { serverId: 'fixture', connectionId: 'installed', toolName: 'write',
    toolRevision: tool.revision, mode: 'ask', setBy: 'alice' };
  await setup.append('mcp-fixture', 'mcp.tool_mode_set', mode);
  const publication = { serverId: 'fixture', publishedBy: 'alice' };
  await setup.append('mcp-fixture', 'mcp.server_published', publication);
  const request = { method: 'POST', headers, body };
  const response = await fetch(`${setup.options.decisionUrl}/authorize/mcp/fixture/installed`,
    request);
  const answer = z.object({ approvalId: z.string() }).parse(await response.json());
  const current = await readApproval(setup.nats.store, 'test', answer.approvalId);
  async function fresh() {}
  const result = await decideApproval(setup.nats.store, 'test', answer.approvalId,
    'alice', 'approved', true, fresh, current, setup.actor.now());
  expect(result.status).toBe('appended');
  const approved = await readApproval(setup.nats.store, 'test', answer.approvalId);
  expect(approved.state).toBe('approved');
  return answer.approvalId;
}

async function approvalPermit(setup: Fixture, headers: Record<string, string>, approvalId: string) {
  const approvalHeaders = { ...headers, 'x-opencrane-approval-id': approvalId };
  const request = { method: 'POST', headers: approvalHeaders, body };
  return fetch(`${setup.options.decisionUrl}/authorize/mcp/fixture/installed`, request);
}

const renewalCases = ['fresh', 'expired observed', 'expired unread', 'expired during append'] as const;
async function checksApprovalAfterRenewal(renewal: typeof renewalCases[number]) {
  const setup = await fixture();
  let watch: ReturnType<typeof mcpCatalogueWatch> | undefined;
  try {
    const headers = await prepare(setup);
    const initial = await readToolPolicy(setup.nats.store, 'test', 'fixture');
    const startedAt = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(startedAt);
    const expiresAt = new Date(startedAt + 10_000).toISOString();
    const capture = vi.fn().mockResolvedValue({ ...initial.catalogue, expiresAt });
    const options = { serverIds: ['fixture'], capture,
      requireLeader: setup.dispatchOptions.requireLeader.bind(setup.dispatchOptions) };
    watch = mcpCatalogueWatch(setup.nats.store, 'test', options);
    setup.dispatchOptions.requireCatalogue = watch.requireCurrent;
    await watch.check('fixture');
    const approvalId = await grantToolApproval(setup, headers);
    const before = await readToolPolicy(setup.nats.store, 'test', 'fixture');
    const captureStarted = Promise.withResolvers<void>();
    const captured = Promise.withResolvers<NonNullable<typeof initial.catalogue>>();
    function pendingCapture() {
      captureStarted.resolve();
      return captured.promise;
    }
    capture.mockImplementation(pendingCapture);
    vi.setSystemTime(startedAt + 1000);
    const checking = watch.check('fixture');
    await captureStarted.promise;
    if (renewal === 'expired observed') {
      vi.setSystemTime(startedAt + 10_000);
      expect(() => watch!.requireCurrent('fixture')).toThrow('watch unavailable');
    }
    let finishedAt = startedAt + 10_500;
    if (renewal === 'fresh' || renewal === 'expired during append') finishedAt = startedAt + 9500;
    vi.setSystemTime(finishedAt);
    const append = setup.nats.store.append.bind(setup.nats.store);
    async function crossExpiryDuringAppend(command: AppendCommand) {
      const result = await append(command);
      const event = z.object({ type: z.string() }).parse(command.event);
      if (event.type === 'mcp.catalogue_checked') vi.setSystemTime(startedAt + 10_500);
      return result;
    }
    if (renewal === 'expired during append') {
      vi.spyOn(setup.nats.store, 'append').mockImplementation(crossExpiryDuringAppend);
    }
    const renewed = { ...initial.catalogue!, checkedAt: new Date(finishedAt).toISOString(),
      expiresAt: new Date(startedAt + 11_000).toISOString() };
    captured.resolve(renewed);
    await checking;
    expect(() => watch!.requireCurrent('fixture')).not.toThrow();
    const after = await readToolPolicy(setup.nats.store, 'test', 'fixture');
    const approval = await readApproval(setup.nats.store, 'test', approvalId);
    const response = await approvalPermit(setup, headers, approvalId);
    if (renewal === 'fresh') {
      expect(after.policyRevision).toBe(before.policyRevision);
      expect(approval.state).toBe('approved');
      expect(response.headers.get('x-opencrane-mcp-permit')).toBeTruthy();
    } else {
      expect.soft(after.policyRevision).toBeGreaterThan(before.policyRevision);
      expect.soft(approval.state).toBe('cancelled');
      expect.soft(response.headers.get('x-opencrane-mcp-permit')).toBeNull();
    }
    expect(setup.received()).toBe(0);
  } finally {
    vi.useRealTimers();
    vi.restoreAllMocks();
    watch?.close();
    await setup.close();
  }
}
it.each(renewalCases)('keeps approvals valid only across uninterrupted renewal: %s',
  checksApprovalAfterRenewal);

async function verifyApprovalRetry(setup: Fixture, headers: Record<string, string>,
  approvalId: string) {
  await setup.refuseMcpConnection();
  const approvalHeaders = { ...headers, 'x-opencrane-approval-id': approvalId };
  const request = { method: 'POST', headers: approvalHeaders, body };
  const response = await fetch(`http://127.0.0.1:${setup.options.port}/mcp/fixture/installed`,
    request);
  expect(response.status).toBe(503);
  await setup.restart();
  await ingestUsage(setup.actor, setup.options.usageFile);
  const current = await readApproval(setup.nats.store, 'test', approvalId);
  expect(current).toMatchObject({ state: 'outcome_unknown', canRetry: true });
  async function fresh() {}
  const retry = await decideApproval(setup.nats.store, 'test', approvalId,
    'alice', 'retry', true, fresh, current, setup.actor.now());
  expect(retry.status).toBe('appended');
  const approved = await readApproval(setup.nats.store, 'test', approvalId);
  expect(approved.state).toBe('approved');
}

const recoveryApprovals = [
  { failure: 'failed', retry: false }, { failure: 'failed', retry: true },
  { failure: 'stalled', retry: false }, { failure: 'stalled', retry: true },
] as const;
async function refusesOldApprovalAfterRecovery(testCase: typeof recoveryApprovals[number]) {
  const setup = await fixture();
  let watch: ReturnType<typeof mcpCatalogueWatch> | undefined;
  try {
    const headers = await prepare(setup);
    const initial = await readToolPolicy(setup.nats.store, 'test', 'fixture');
    const capture = vi.fn().mockResolvedValue(initial.catalogue);
    const options = { serverIds: ['fixture'], capture,
      requireLeader: setup.dispatchOptions.requireLeader.bind(setup.dispatchOptions) };
    watch = mcpCatalogueWatch(setup.nats.store, 'test', options);
    setup.dispatchOptions.requireCatalogue = watch.requireCurrent;
    await watch.check('fixture');
    const approvalId = await grantToolApproval(setup, headers);
    if (testCase.retry) await verifyApprovalRetry(setup, headers, approvalId);
    const before = await readToolPolicy(setup.nats.store, 'test', 'fixture');
    const stalled = Promise.withResolvers<NonNullable<typeof initial.catalogue>>();
    if (testCase.failure === 'failed') {
      capture.mockRejectedValue(new Error('Upstream unavailable'));
    } else {
      capture.mockReturnValue(stalled.promise);
    }
    await expect(watch.check('fixture')).rejects.toThrow();
    expect(() => watch!.requireCurrent('fixture')).toThrow();
    capture.mockResolvedValue(initial.catalogue);
    await watch.check('fixture');
    expect(() => watch!.requireCurrent('fixture')).not.toThrow();
    const after = await readToolPolicy(setup.nats.store, 'test', 'fixture');
    expect.soft(after.policyRevision).toBeGreaterThan(before.policyRevision);
    const approval = await readApproval(setup.nats.store, 'test', approvalId);
    expect.soft(approval).toMatchObject({ state: 'cancelled', canRetry: false });
    const response = await approvalPermit(setup, headers, approvalId);
    expect.soft(response.headers.get('x-opencrane-mcp-permit')).toBeNull();
    expect.soft(setup.received()).toBe(0);
  } finally {
    watch?.close();
    await setup.close();
  }
}
it.each(recoveryApprovals)('refuses old approval after watch recovery: $failure, retry $retry',
  refusesOldApprovalAfterRecovery, 45_000);

async function refusesFinalSendDuringLocalHold() {
  const setup = await fixture();
  let watch: ReturnType<typeof mcpCatalogueWatch> | undefined;
  try {
    const headers = await prepare(setup);
    const initial = await readToolPolicy(setup.nats.store, 'test', 'fixture');
    const capture = vi.fn().mockResolvedValue(initial.catalogue);
    const options = { serverIds: ['fixture'], capture,
      requireLeader: setup.dispatchOptions.requireLeader.bind(setup.dispatchOptions) };
    watch = mcpCatalogueWatch(setup.nats.store, 'test', options);
    setup.dispatchOptions.requireCatalogue = watch.requireCurrent;
    await watch.check('fixture');
    const value = await permit(setup, headers);
    const before = await readToolPolicy(setup.nats.store, 'test', 'fixture');
    const append = setup.nats.store.append.bind(setup.nats.store);
    let admitted = false;
    async function holdAfterAdmission(command: AppendCommand) {
      const event = z.object({ type: z.string() }).parse(command.event);
      if (event.type === 'mcp.catalogue_checked') throw new Error('Event store unavailable');
      const result = await append(command);
      if (event.type === 'mcp.dispatch_admitted' && result.status === 'appended') {
        admitted = true;
        capture.mockRejectedValue(new Error('Upstream unavailable'));
        await expect(watch!.check('fixture')).rejects.toThrow('Event store unavailable');
      }
      return result;
    }
    vi.spyOn(setup.nats.store, 'append').mockImplementation(holdAfterAdmission);
    const response = await send(setup, value);
    expect(admitted).toBe(true);
    expect.soft(response.status).toBe(403);
    expect.soft(setup.received()).toBe(0);
    const after = await readToolPolicy(setup.nats.store, 'test', 'fixture');
    expect(after.policyRevision).toBe(before.policyRevision);
    expect(() => watch!.requireCurrent('fixture')).toThrow();
  } finally {
    vi.restoreAllMocks();
    watch?.close();
    await setup.close();
  }
}
it('refuses a final send when a local hold arrives after tool admission',
  refusesFinalSendDuringLocalHold);
