import { remoteFixture } from './support/remote-mcp.ts';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { losslessJson } from '@opencrane/events/lossless-json';
import { toolReviewDigest } from '@opencrane/events/mcp-catalogue';
import { applyToolPolicy, mcpCatalogue, readPublication,
  rebuildMcpCatalogueProjection } from '@opencrane/projections';
import { createLogger } from '@opencrane/observability';
import { gatewayObservationSchema, mcpConfigurationObservationSchema } from '@opencrane/events';
import { publicationDigest } from '../src/publication.ts';
import { startDecision } from '../src/decision.ts';
import { envelope } from '../src/actor.ts';
import { recordAdapterObservation, recordToolObservation, toolObservation } from '../src/tool-dispatch.ts';
import { reviewToolPolicy, publishToolPolicy } from '../src/tool-policy.ts';
import { prepareGatewayConfiguration } from '../src/gateway-generation.ts';
import { gatewayDelivery } from '../src/gateway-delivery.ts';
import { freePort } from './gateway-delivery-fixture.ts';
import type { AppendCommand, StoredEvent } from '@opencrane/event-store';
import { setTimeout as pause } from 'node:timers/promises';
import { z } from 'zod';
import { expect, it, onTestFinished, vi } from 'vitest';
import { mcpCatalogueWatch } from '../src/mcp-catalogue-watch.ts';
import { auditTrail, conversations } from '@opencrane/projections';
import { budgetStopHandler } from '../src/index.ts';
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

async function prepare(setup: Fixture, kind: 'remote' | 'hosted' = 'remote', remote = false, declared = true) {
  let locator = remote ? 'https://mcp.example.test/mcp' : 'https://fixture.example.test/mcp';
  if (kind === 'hosted') locator = `registry.example.test/fixture@sha256:${'a'.repeat(64)}`;
  const registration = { serverId: 'fixture', kind, locator, registeredBy: 'alice' };
  await setup.append('mcp-fixture', 'mcp.server_registered', registration);
  const discovery = { serverId: 'fixture', connectionId: 'installed', accountMode: 'none',
    ...catalogue, ...(remote && declared ? { discoverResult: JSON.stringify({ capabilities:
      { experimental: { 'io.opencrane/expectedRevision': {} } } }) } : {}) };
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

async function permit(setup: Fixture, headers: Record<string, string>, raw = body) {
  const request = { method: 'POST', headers, body: raw };
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
    const requireLeader = setup.dispatchOptions.requireLeader.bind(setup.dispatchOptions);
    const options = { serverIds: ['fixture'], capture, timeoutMs: 500, requireLeader };
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
      const checkStartedAt = performance.now();
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
        expect(performance.now() - checkStartedAt).toBeLessThan(3000);
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

async function grantToolApproval(setup: Fixture, headers: Record<string, string>, approve = true) {
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
  if (!approve) return answer.approvalId;
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
    const initialCapture = { ...initial.catalogue, expiresAt };
    const capture = vi.fn();
    capture.mockResolvedValue(initialCapture);
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
      const writer = vi.spyOn(setup.nats.store, 'append');
      writer.mockImplementation(crossExpiryDuringAppend);
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

const finalReadCases = ['fresh', 'expired observed', 'expired unread',
  'expired recovery observed'] as const;
async function checksApprovalAfterFinalRead(timing: typeof finalReadCases[number]) {
  const setup = await fixture();
  let watch: ReturnType<typeof mcpCatalogueWatch> | undefined;
  try {
    const headers = await prepare(setup);
    const initial = await readToolPolicy(setup.nats.store, 'test', 'fixture');
    const startedAt = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(startedAt);
    const initialCapture = { ...initial.catalogue,
      expiresAt: new Date(startedAt + 10_000).toISOString() };
    const capture = vi.fn();
    capture.mockResolvedValue(initialCapture);
    const options = { serverIds: ['fixture'], capture,
      requireLeader: setup.dispatchOptions.requireLeader.bind(setup.dispatchOptions) };
    watch = mcpCatalogueWatch(setup.nats.store, 'test', options);
    setup.dispatchOptions.requireCatalogue = watch.requireCurrent;
    await watch.check('fixture');
    const approvalId = await grantToolApproval(setup, headers);
    const before = await readToolPolicy(setup.nats.store, 'test', 'fixture');
    const renewed = { ...initial.catalogue!, checkedAt: new Date(startedAt + 9500).toISOString(),
      expiresAt: new Date(startedAt + 20_000).toISOString() };
    capture.mockResolvedValue(renewed);
    vi.setSystemTime(startedAt + 9500);
    const readStream = setup.nats.store.readStream.bind(setup.nats.store);
    const append = setup.nats.store.append.bind(setup.nats.store);
    let captureSaved = false;
    let readFinished = false;
    async function saveRenewal(command: AppendCommand) {
      const result = await append(command);
      const event = z.object({ type: z.string(), data: z.object({ outcome: z.string() }) })
        .safeParse(command.event);
      if (event.success && event.data.type === 'mcp.catalogue_checked' &&
          event.data.data.outcome === 'unchanged') captureSaved = true;
      return result;
    }
    const writer = vi.spyOn(setup.nats.store, 'append');
    writer.mockImplementation(saveRenewal);
    function requireCurrent() {
      watch!.requireCurrent('fixture');
    }
    async function* finishFinalRead(...parameters: Parameters<typeof readStream>) {
      yield* readStream(...parameters);
      if (parameters[0] !== 'mcp-fixture') return;
      if (!captureSaved || readFinished) return;
      readFinished = true;
      let finishedAt = startedAt + 10_500;
      if (timing === 'fresh') finishedAt = startedAt + 9900;
      vi.setSystemTime(finishedAt);
      if (timing === 'expired observed' || timing === 'expired recovery observed') {
        expect(requireCurrent).toThrow('watch unavailable');
      }
    }
    const reader = vi.spyOn(setup.nats.store, 'readStream');
    reader.mockImplementation(finishFinalRead);
    if (timing === 'expired recovery observed') {
      vi.setSystemTime(startedAt + 10_000);
      expect(requireCurrent).toThrow('watch unavailable');
    }
    const checking = watch.check('fixture');
    if (timing === 'fresh') {
      await checking;
      expect(requireCurrent).not.toThrow();
    } else {
      await expect.soft(checking).rejects.toThrow();
      expect.soft(requireCurrent).toThrow('watch unavailable');
    }
    reader.mockRestore();
    writer.mockRestore();
    expect(readFinished).toBe(true);
    const after = await readToolPolicy(setup.nats.store, 'test', 'fixture');
    const approval = await readApproval(setup.nats.store, 'test', approvalId);
    const response = await approvalPermit(setup, headers, approvalId);
    const value = response.headers.get('x-opencrane-mcp-permit');
    if (value) await send(setup, value);
    if (timing === 'fresh') {
      expect(after.policyRevision).toBe(before.policyRevision);
      expect(approval.state).toBe('approved');
      expect(value).toBeTruthy();
      expect(setup.received()).toBe(1);
    } else {
      expect.soft(after.policyRevision).toBeGreaterThan(before.policyRevision);
      expect.soft(approval.state).toBe('cancelled');
      expect.soft(value).toBeNull();
      expect.soft(setup.received()).toBe(0);
      await watch.check('fixture');
      expect(requireCurrent).not.toThrow();
      const recovered = await readApproval(setup.nats.store, 'test', approvalId);
      expect(recovered.state).toBe('cancelled');
      const retried = await approvalPermit(setup, headers, approvalId);
      expect(retried.headers.get('x-opencrane-mcp-permit')).toBeNull();
      expect(setup.received()).toBe(0);
    }
  } finally {
    vi.useRealTimers();
    vi.restoreAllMocks();
    watch?.close();
    await setup.close();
  }
}
it.each(finalReadCases)('keeps approval safety through the final watch read: %s',
  checksApprovalAfterFinalRead);

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
    const capture = vi.fn();
    capture.mockResolvedValue(initial.catalogue);
    const options = { serverIds: ['fixture'], capture, timeoutMs: 500,
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
    const capture = vi.fn();
    capture.mockResolvedValue(initial.catalogue);
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
    const writer = vi.spyOn(setup.nats.store, 'append');
    writer.mockImplementation(holdAfterAdmission);
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

async function budgetHandlerEndsApproval() {
  const setup = await fixture();
  try {
    const headers = await prepare(setup);
    const approvalId = await grantToolApproval(setup, headers, false);
    const waiting = await readApproval(setup.nats.store, 'test', approvalId);
    await setup.actor.configure({ scope: 'paying_group', scopeId: 'personal-default',
      ceilingCents: 0, setBy: 'alice' });
    const rows = await history(setup.nats.store, 'budget-test', 'test');
    const stop = rows.at(-1)!.event;
    await setup.runner.initialise(conversations);
    await setup.runner.run(conversations);
    await budgetStopHandler(setup.nats.store).handle(stop, setup.db);
    await setup.actor.configure({ scope: 'paying_group', scopeId: 'personal-default',
      ceilingCents: 20000, setBy: 'alice' });
    const approval = await readApproval(setup.nats.store, 'test', approvalId);
    expect(approval.state).toBe('cancelled');
    async function fresh() {}
    const late = await decideApproval(setup.nats.store, 'test', approvalId,
      'alice', 'approved', true, fresh, waiting);
    expect(late.status).toBe('conflict');
    const response = await approvalPermit(setup, headers, approvalId);
    expect(response.status).not.toBe(200);
    expect(setup.received()).toBe(0);
  } finally {
    await setup.close();
  }
}
it('ends a waiting approval through the saved budget turn stop', budgetHandlerEndsApproval);

async function reviewRestoration(setup: Fixture, commandId: string, mode = 'allow',
  serverId = 'fixture') {
  const policy = await readToolPolicy(setup.nats.store, 'test', serverId);
  const catalogue = policy.catalogue!;
  function choice(declaration: NonNullable<typeof catalogue.tools>[number]) {
    return { name: declaration.name, revision: declaration.revision,
      reviewDigest: toolReviewDigest(declaration), mode };
  }
  const command = { commandId, expectedSequence: policy.sequence,
    policyRevision: policy.policyRevision, catalogueDigest: catalogue.schemaDigest,
    connectionId: policy.connectionId, accountMode: policy.accountMode,
    tools: catalogue.tools!.map(choice) };
  const result = await reviewToolPolicy(setup.nats.store, setup.binding, 'alice',
    serverId, command);
  expect(result.status).toBe('appended');
}

async function publishRestoration(setup: Fixture, commandId: string, serverId = 'fixture') {
  const policy = await readToolPolicy(setup.nats.store, 'test', serverId);
  const command = { commandId, expectedSequence: policy.sequence,
    reviewRevision: policy.reviewRevision };
  const result = await publishToolPolicy(setup.nats.store, setup.binding, 'alice',
    serverId, command);
  expect(result.status).toBe('appended');
  return prepareGatewayConfiguration(setup.nats.store, 'test', serverId, commandId);
}

const restorationCases = ['exact', 'legacy', 'review only', 'intent only', 'new intent',
  'unpublish', 'second drift', 'expired', 'failed check', 'older generation',
  'restart before', 'restart after', 'restart recovery', 'duplicate after drift',
  'drift during final read', 'expired approval'] as const;
type RestorationCase = typeof restorationCases[number];
type RestorationFixture = Awaited<ReturnType<typeof restorationFixture>>;

async function restorationFixture(expireApproval = false) {
  const setup = await fixture();
  async function closeSetup() {
    await setup.close();
  }
  onTestFinished(closeSetup);
  const headers = await prepare(setup);
  const initial = await readToolPolicy(setup.nats.store, 'test', 'fixture');
  const capture = vi.fn();
  capture.mockResolvedValue(initial.catalogue);
  const options = { serverIds: ['fixture'], capture,
    requireLeader: setup.dispatchOptions.requireLeader.bind(setup.dispatchOptions) };
  const watch = mcpCatalogueWatch(setup.nats.store, 'test', options);
  const context = { setup, headers, initial, capture, options, watch };
  function closeWatch() {
    context.watch.close();
  }
  onTestFinished(closeWatch);
  setup.dispatchOptions.requireCatalogue = watch.requireCurrent;
  await watch.check('fixture');
  const approvalId = await grantToolApproval(setup, headers);
  if (expireApproval) {
    const approval = await readApproval(setup.nats.store, 'test', approvalId);
    const options = { now: new Date(approval.request.expiresAt) };
    const expired = await readApproval(setup.nats.store, 'test', approvalId, options);
    expect(expired.state).toBe('expired');
  }
  const added = toolEvidence({ name: 'another', reviewed: false, costCents: 0 });
  const changed = { ...initial.catalogue!, ...catalogueEvidence([tool, added]) };
  capture.mockResolvedValue(changed);
  await watch.check('fixture');
  function requireCurrent() {
    watch.requireCurrent('fixture');
  }
  expect(requireCurrent).toThrow();
  return Object.assign(context, { approvalId, changed });
}

async function restorationDelivery(setup: Fixture, preserveMemory = true) {
  let settings: typeof setup.options & { memoryRoute?: typeof setup.options.mcpRoutes[number] } =
    setup.options;
  if (preserveMemory) {
    settings = { ...settings,
      memoryRoute: { serverId: 'memory', connectionId: 'internal', upstream: 'unused' } };
  }
  const options = { db: setup.db, mode: 'live' as const, store: setup.nats.store, silo: 'test',
    child: setup.gatewayChild()!, configFile: setup.options.configFile,
    controlPort: await freePort(), settings };
  const delivery = gatewayDelivery(options);
  setup.dispatchOptions.acknowledged = delivery.acknowledged;
  async function waitForWitness(record: Awaited<ReturnType<typeof publishRestoration>>) {
    const bytes = await readFile(options.configFile, 'utf8');
    const path = /\/configuration\/\d+\/[a-f0-9-]+/u.exec(bytes)![0];
    const url = `http://127.0.0.1:${options.controlPort}${path}`;
    async function servesWitness() {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      expect(response.status).toBe(200);
      const identity: unknown = await response.json();
      expect(identity).toMatchObject({ generation: record.generation,
        recordDigest: record.recordDigest });
    }
    await expect.poll(servesWitness, { timeout: 5000 }).toBeUndefined();
  }
  return { ...delivery, waitForWitness, options };
}

async function restartRestoration(context: RestorationFixture) {
  context.watch.close();
  await context.setup.restart();
  context.watch = mcpCatalogueWatch(context.setup.nats.store, 'test', context.options);
  context.setup.dispatchOptions.requireCatalogue = context.watch.requireCurrent;
  function requireCurrent() {
    context.watch.requireCurrent('fixture');
  }
  expect(requireCurrent).toThrow();
  await context.watch.check('fixture');
}

async function invalidateRestoration(context: RestorationFixture, change: RestorationCase,
  delivery: Awaited<ReturnType<typeof restorationDelivery>>,
  record: Awaited<ReturnType<typeof publishRestoration>>) {
  const { setup, capture, watch } = context;
  let liveRecord = record;
  if (change === 'new intent' || change === 'older generation') {
    const newer = await publishRestoration(setup, 'restore-newer');
    expect(await delivery.observe()).toBeNull();
    if (change === 'older generation') {
      await delivery.deliver(newer);
      liveRecord = newer;
    }
    const before = await readFile(setup.options.configFile);
    const position = await setup.nats.store.head();
    await expect(delivery.deliver(record)).rejects.toThrow('Gateway delivery unavailable');
    expect(await readFile(setup.options.configFile)).toEqual(before);
    expect(await delivery.observe()).toBeNull();
    expect(await setup.nats.store.head()).toBe(position);
    const policy = await readToolPolicy(setup.nats.store, 'test', 'fixture');
    expect(policy).toMatchObject({ driftHeld: true, published: false });
  } else if (change === 'unpublish') {
    await setup.append('mcp-fixture', 'mcp.server_unpublished',
      { serverId: 'fixture', unpublishedBy: 'alice' });
  } else if (change === 'second drift') {
    capture.mockResolvedValue(context.initial.catalogue);
    await watch.check('fixture');
  } else if (change === 'failed check') {
    capture.mockRejectedValueOnce(new Error('Capture unavailable'));
    await expect(watch.check('fixture')).rejects.toThrow();
  } else if (change === 'expired') {
    const checkedAt = new Date(Date.now() - 1000).toISOString();
    const expiresAt = new Date(Date.now() - 1).toISOString();
    await setup.append('mcp-fixture', 'mcp.catalogue_checked', { serverId: 'fixture',
      outcome: 'unchanged', schemaDigest: context.changed.schemaDigest, checkedAt, expiresAt });
  } else if (change === 'restart before') {
    await restartRestoration(context);
  }
  return liveRecord;
}

async function observeRestoration(context: RestorationFixture, change: RestorationCase,
  delivery: Awaited<ReturnType<typeof restorationDelivery>>,
  record: Awaited<ReturnType<typeof publishRestoration>>) {
  const { setup, watch } = context;
  async function acknowledged() {
    expect(await delivery.observe()).not.toBeNull();
  }
  const succeeds = ['exact', 'restart after', 'restart recovery',
    'duplicate after drift', 'drift during final read', 'expired approval'].includes(change);
  if (!succeeds) {
    if (change !== 'intent only') {
      expect(await delivery.observe()).toBeNull();
    }
    return;
  }
  await expect.poll(acknowledged, { timeout: 5000 }).toBeUndefined();
  const restored = await readToolPolicy(setup.nats.store, 'test', 'fixture');
  expect(restored).toMatchObject({ driftHeld: false, published: true });
  if (change === 'drift during final read') {
    await driftDuringFinalRead(context);
    return;
  }
  await watch.check('fixture');
  watch.requireCurrent('fixture');
  const checked = await readToolPolicy(setup.nats.store, 'test', 'fixture');
  await delivery.observe();
  const repeated = await readToolPolicy(setup.nats.store, 'test', 'fixture');
  expect(repeated).toEqual(checked);
  if (change === 'restart after' || change === 'restart recovery') {
    const previousChild = setup.gatewayChild();
    await setup.runner.initialise(mcpCatalogue);
    await setup.runner.run(mcpCatalogue);
    expect(await readPublication(setup.db, 'test', 'fixture')).toMatchObject({ status: 'ready' });
    await restartRestoration(context);
    expect(setup.gatewayChild()).not.toBe(previousChild);
    expect(delivery.acknowledged()).toBeNull();
    const recovered = await readToolPolicy(setup.nats.store, 'test', 'fixture');
    expect(recovered).toMatchObject({ driftHeld: false, published: true,
      configurationObservation: restored.configurationObservation });
    if (change === 'restart recovery') {
      delivery = await restorationDelivery(setup);
      await delivery.deliver(record);
      await delivery.waitForWitness(record);
      await expect.poll(acknowledged, { timeout: 5000 }).toBeUndefined();
      await context.watch.check('fixture');
      await setup.runner.run(mcpCatalogue);
      expect(await readPublication(setup.db, 'test', 'fixture')).toMatchObject({
        status: 'ready', changeRef: 'restore', generation: record.generation,
        recordDigest: record.recordDigest });
      const renewed = await readToolPolicy(setup.nats.store, 'test', 'fixture');
      expect(renewed).toMatchObject({ published: true, driftHeld: false,
        policyRevision: recovered.policyRevision });
      expect(renewed.configurationObservation!.processRef).not.toBe(
        restored.configurationObservation!.processRef);
    }
  } else if (change === 'duplicate after drift') {
    context.capture.mockResolvedValue(context.initial.catalogue);
    await watch.check('fixture');
    expect(await delivery.observe()).toBeNull();
  }
}

async function driftDuringFinalRead(context: RestorationFixture) {
  const { setup, watch } = context;
  const readStream = setup.nats.store.readStream.bind(setup.nats.store);
  const append = setup.nats.store.append.bind(setup.nats.store);
  let captureSaved = false;
  async function saveRenewal(command: AppendCommand) {
    const result = await append(command);
    const event = z.object({ type: z.string() }).parse(command.event);
    if (event.type === 'mcp.catalogue_checked') captureSaved = true;
    return result;
  }
  const writer = vi.spyOn(setup.nats.store, 'append');
  writer.mockImplementation(saveRenewal);
  async function* changeDuringRead(...parameters: Parameters<typeof readStream>) {
    if (parameters[0] === 'mcp-fixture' && captureSaved) {
      captureSaved = false;
      const data = { serverId: 'fixture', previousSchemaDigest: context.changed.schemaDigest,
        newSchemaDigest: context.initial.catalogue!.schemaDigest,
        catalogue: context.initial.catalogue };
      await setup.append('mcp-fixture', 'mcp.tools_changed', data);
    }
    yield* readStream(...parameters);
  }
  const reader = vi.spyOn(setup.nats.store, 'readStream');
  reader.mockImplementation(changeDuringRead);
  try {
    await watch.check('fixture');
  } finally {
    reader.mockRestore();
    writer.mockRestore();
  }
  function requireCurrent() {
    watch.requireCurrent('fixture');
  }
  expect(requireCurrent).toThrow('watch unavailable');
  const policy = await readToolPolicy(setup.nats.store, 'test', 'fixture');
  expect(policy.driftHeld).toBe(true);
}

async function restoresReviewedDrift(change: RestorationCase) {
  const context = await restorationFixture(change === 'expired approval');
  const { setup, headers, approvalId } = context;
  if (change === 'legacy') {
    await setup.append('mcp-fixture', 'mcp.server_published',
      { serverId: 'fixture', publishedBy: 'alice' });
  } else {
    await reviewRestoration(setup, 'review-restoration');
  }
  if (change !== 'legacy' && change !== 'review only') {
    const record = await publishRestoration(setup, 'restore');
    if (change === 'exact') {
      await refuseUnrelatedRestorationReceipts(setup, headers, record);
    }
    const delivery = await restorationDelivery(setup);
    await delivery.deliver(record);
    await delivery.waitForWitness(record);
    const liveRecord = await invalidateRestoration(context, change, delivery, record);
    if (change !== 'restart before') {
      await delivery.waitForWitness(liveRecord);
    }
    await observeRestoration(context, change, delivery, record);
  }
  const observation = setup.dispatchOptions.acknowledged?.();
  if (observation) Object.assign(headers, generationHeaders(observation));
  const request = { method: 'POST', headers, body };
  const response = await fetch(`${setup.options.decisionUrl}/authorize/mcp/fixture/installed`,
    request);
  if (change === 'exact' || change === 'restart recovery' || change === 'expired approval') {
    expect(response.status, await response.text()).toBe(200);
    const value = response.headers.get('x-opencrane-mcp-permit')!;
    expect((await send(setup, value)).status).toBe(200);
    expect(setup.received()).toBe(1);
    const oldApproval = await readApproval(setup.nats.store, 'test', approvalId);
    let expectedState = 'cancelled';
    if (change === 'expired approval') expectedState = 'expired';
    expect(oldApproval.state).toBe(expectedState);
    if (change === 'restart recovery') {
      await verifyCatalogueRecoveryReplay(setup);
      expect(await readPublication(setup.db, 'test', 'fixture')).toMatchObject({
        status: 'ready', changeRef: 'restore' });
    } else {
      await verifyRestorationReplay(setup);
    }
  } else {
    expect(response.status, await response.text()).toBe(403);
    expect(setup.received()).toBe(0);
  }
}
it.each(restorationCases)('restores drift only through exact live publication: %s',
  restoresReviewedDrift, 60_000);

async function verifyRestorationReplay(setup: Fixture, received = 1) {
  await setup.stopDispatch();
  await setup.runtime.stop();
  await setup.decisionDown();
  await setup.runner.initialise(mcpCatalogue);
  await setup.runner.run(mcpCatalogue);
  const before = await setup.db.query('SELECT policy FROM mcp_catalogue');
  const position = await setup.nats.store.head();
  const execute = promisify(execFile);
  const env = { ...process.env, ...setup.nats.env('projection'),
    DATABASE_URL: setup.databaseUrl };
  const result = await execute('npm', ['run', 'replay', '--', 'mcp-catalogue', '--verify'],
    { env, timeout: 10_000 });
  expect(result.stdout).toContain('rebuilt state matched the live projection');
  const after = await setup.db.query('SELECT policy FROM mcp_catalogue');
  expect(after.rows).toEqual(before.rows);
  await setup.runner.initialise(conversations);
  await setup.runner.run(conversations);
  const unsupported = execute('npm', ['run', 'replay', '--', 'conversations', '--verify'],
    { env, timeout: 10_000 });
  await expect(unsupported).rejects.toMatchObject({ code: 1 });
  const rebuilt = await execute('npm', ['run', 'replay', '--', 'conversations',
    '--confirm-conversations-stopped'], { env, timeout: 10_000 });
  expect(rebuilt.stdout).toContain('PASS: conversations rebuilt');
  await setup.runner.initialise(auditTrail);
  await setup.runner.run(auditTrail);
  const audit = await execute('npm', ['run', 'replay', '--', 'audit', '--verify'],
    { env, timeout: 10_000 });
  expect(audit.stdout).toContain('rebuilt state matched the live projection');
  expect(await setup.nats.store.head()).toBe(position);
  expect(setup.received()).toBe(received);
}

async function refuseUnrelatedRestorationReceipts(setup: Fixture,
  headers: Record<string, string>, record: Awaited<ReturnType<typeof publishRestoration>>) {
  const policy = await readToolPolicy(setup.nats.store, 'test', 'fixture');
  const member = record.members[0]!;
  const receipt = { serverId: 'fixture', changeRef: member.changeRef,
    reviewRevision: member.entry.reviewRevision, fragmentDigest: member.fragmentDigest,
    sourceSequence: member.sourceSequence, generation: record.generation,
    recordDigest: record.recordDigest, configDigest: 'a'.repeat(64),
    processRef: '00000000-0000-4000-8000-000000000001', observedAt: new Date().toISOString() };
  const substitutions = [{ changeRef: 'unknown' }, { fragmentDigest: 'b'.repeat(64) },
    { reviewRevision: 1 }, { sourceSequence: 1 }, { sourceSequence: policy.sequence + 1000 }];
  for (const substitution of substitutions) {
    const data = { ...receipt, ...substitution };
    await setup.append('mcp-fixture', 'mcp.configuration_observed', data);
    const refused = await readToolPolicy(setup.nats.store, 'test', 'fixture');
    expect(refused).toMatchObject({ driftHeld: true, published: false });
    const request = { method: 'POST', headers, body };
    const response = await fetch(`${setup.options.decisionUrl}/authorize/mcp/fixture/installed`,
      request);
    expect(response.status).toBe(403);
    expect(setup.received()).toBe(0);
  }
  for (const outcome of ['failed', 'unknown']) {
    const invalid = { ...receipt, outcome };
    expect(mcpConfigurationObservationSchema.safeParse(invalid).success).toBe(false);
  }
  for (const silo of ['test', 'other']) {
    const serverId = silo === 'test' ? 'other' : 'fixture';
    const data = { ...receipt, serverId };
    const event = envelope(silo, `mcp-${serverId}`, 'mcp.configuration_observed', data);
    function applyForeignReceipt() {
      return applyToolPolicy(policy, event, policy.sequence + 1);
    }
    expect(applyForeignReceipt).toThrow('identity mismatch');
  }
  const event = envelope('test', 'mcp-fixture', 'mcp.configuration_observed', receipt);
  const expired = { ...policy, expiresAt: event.time };
  const failed = { ...policy, expiresAt: null };
  for (const unavailable of [expired, failed]) {
    const refused = applyToolPolicy(unavailable, event, policy.sequence + 1);
    expect(refused).toMatchObject({ driftHeld: true, published: false });
  }
  const request = { method: 'POST', headers, body };
  const response = await fetch(`${setup.options.decisionUrl}/authorize/mcp/fixture/installed`,
    request);
  expect(response.status).toBe(403);
  expect(setup.received()).toBe(0);
}
async function stopsRootPermit(reason: 'requester_stop' | 'allowance_exhausted') {
  const setup = await fixture();
  try {
    const headers = await prepare(setup);
    const binding = { requesterId: 'alice', conversationId: 'conversation', turnId: 'dispatch',
      threadId: capture.body.params._meta.threadId, assistantId: 'assistant',
      computerId: 'computer', generation: 1, payingGroupId: 'personal-default',
      allowanceCents: 1000 };
    const root = await setup.actor.setRootAllowance(binding, 1);
    const value = await permit(setup, headers);
    if (reason === 'requester_stop') {
      const subject = 'conversation-conversation';
      const payload = { conversationId: 'conversation', turnId: 'dispatch', requestedBy: 'alice' };
      await setup.append(subject, 'agent.turn_stop_requested', payload);
      const position = await setup.nats.store.head(subject);
      await setup.actor.stopRoot(root.rootId, reason, subject, position);
    } else {
      // Save the actor stop directly to isolate the budget check from conversation activity.
      const modelCall = { requesterId: 'alice', conversationId: 'conversation',
        turnId: 'dispatch', threadId: binding.threadId, assistantId: 'assistant',
        computerId: 'computer', generation: 1, payingGroupId: 'personal-default',
        model: 'gpt-6-luna', priceTableId, contextDigest: '0'.repeat(64) };
      await expect(setup.actor.reserve(modelCall, 1001, undefined, undefined, root.rootId))
        .rejects.toThrow('Root budget refused');
    }
    const before = await setup.nats.store.head();
    expect((await send(setup, value)).status).toBe(403);
    expect(setup.received()).toBe(0);
    expect(setup.actor.state.dispatches).toHaveLength(0);
    expect(await setup.nats.store.head()).toBe(before);
    const denied = { method: 'POST', headers, body };
    const response = await fetch(
      `${setup.options.decisionUrl}/authorize/mcp/fixture/installed`, denied);
    expect(response.status).toBe(403);
  } finally {
    await setup.close();
  }
}
it.each(['requester_stop', 'allowance_exhausted'] as const)(
  'refuses an old MCP permit and a new grant after its root stops: %s', stopsRootPermit);

function generationHeaders(record: { generation: number; recordDigest: string;
  members: { entry: { serverId: string; connectionId: string; reviewRevision: number } }[] }) {
  const entry = record.members[0]!.entry;
  return { 'x-opencrane-gateway-generation': String(record.generation),
    'x-opencrane-record-digest': record.recordDigest, 'x-opencrane-server-id': entry.serverId,
    'x-opencrane-connection-id': entry.connectionId,
    'x-opencrane-review-revision': String(entry.reviewRevision) };
}

async function publishedFixture(mode = 'allow', remote = false, declared = true) {
  const setup = await fixture();
  onTestFinished(setup.close.bind(setup));
  const headers = await prepare(setup, 'remote', remote, declared);
  await reviewRestoration(setup, 'review-generation', mode);
  const record = await publishRestoration(setup, 'publish-generation');
  const delivery = await restorationDelivery(setup);
  await delivery.deliver(record);
  await delivery.waitForWitness(record);
  expect(await delivery.observe()).not.toBeNull();
  const constants = generationHeaders(record);
  return { setup, headers, record, delivery, constants };
}

async function nextCarriedGeneration(context: Awaited<ReturnType<typeof publishedFixture>>) {
  const { recordDigest: _digest, ...previous } = context.record;
  const saved = { ...previous, generation: previous.generation + 1, changeRef: 'carried-next' };
  const record = { ...saved, recordDigest: publicationDigest(saved) };
  await context.setup.append('gateway-config-test', 'gateway.configuration_requested', record);
  return record;
}

function gatewayCall(context: Awaited<ReturnType<typeof publishedFixture>>,
  extra: Record<string, string | string[]> = {}, raw = body) {
  const headers = { ...context.headers, ...extra };
  const options = { method: 'POST', headers };
  const url = `http://127.0.0.1:${context.setup.options.port}/mcp/fixture/installed`;
  function sendRequest(resolve: (status: number) => void, reject: (error: Error) => void) {
    function receive(response: IncomingMessage) {
      function finished() {
        resolve(response.statusCode!);
      }
      response.on('end', finished);
      response.on('error', reject);
      response.resume();
    }
    const request = httpRequest(url, options, receive);
    request.on('error', reject);
    request.end(raw);
  }
  return new Promise<number>(sendRequest);
}

async function acceptsCurrentAndCarriedGeneration() {
  const context = await publishedFixture();
  const { setup, delivery } = context;
  expect(await gatewayCall(context)).toBe(200);
  expect(setup.received()).toBe(1);
  await expectDispatchStarted(setup, context.record, 0);
  const next = await nextCarriedGeneration(context);
  expect(await gatewayCall(context)).toBe(403);
  const writing = delivery.deliver(next);
  expect(delivery.acknowledged()).toBeNull();
  await writing;
  expect(delivery.acknowledged()).toBeNull();
  await delivery.waitForWitness(next);
  expect(await gatewayCall(context)).toBe(403);
  expect(await delivery.observe()).not.toBeNull();
  const request = { method: 'POST', headers: { ...context.headers, ...context.constants }, body };
  const old = await fetch(`${setup.options.decisionUrl}/authorize/mcp/fixture/installed`, request);
  expect(old.status).toBe(403);
  expect(await gatewayCall(context)).toBe(200);
  expect(setup.received()).toBe(2);
  await expectDispatchStarted(setup, next, 1);
  const rows = await history(setup.nats.store, 'mcp-fixture', 'test');
  function isReceipt(row: typeof rows[number]) {
    return row.event.type === 'mcp.configuration_observed';
  }
  const receipts = rows.filter(isReceipt);
  expect(receipts).toHaveLength(2);
  expect(receipts[0]!.event.data).toMatchObject({ generation: context.record.generation,
    recordDigest: context.record.recordDigest });
  expect(receipts[1]!.event.data).toMatchObject({ generation: next.generation,
    recordDigest: next.recordDigest, changeRef: context.record.members[0]!.changeRef });
  const position = await setup.nats.store.head();
  expect(await delivery.observe()).not.toBeNull();
  expect(await setup.nats.store.head()).toBe(position);
}
it('accepts only the current acknowledged generation, including a carried member',
  acceptsCurrentAndCarriedGeneration);

async function expectDispatchStarted(setup: Fixture,
  record: Awaited<ReturnType<typeof publishRestoration>>, requestIndex: number) {
  const request = setup.providerRequests()[requestIndex]!;
  const requestId = z.string().parse(request.correlationHeaders['x-request-id']);
  const rows = await history(setup.nats.store, `decision-${requestId}`, 'test');
  function isStarted(row: typeof rows[number]) {
    return row.event.type === 'tool.dispatch_started';
  }
  const started = rows.filter(isStarted);
  expect(started).toHaveLength(1);
  expect(started[0]!.event.data).toEqual({ requestId, serverId: 'fixture',
    connectionId: 'installed', generation: record.generation, recordDigest: record.recordDigest,
    reviewRevision: record.members[0]!.entry.reviewRevision });
  expect(rows[0]!.event.type).toBe('decision.recorded');
  expect(started[0]!.sequence).toBeGreaterThan(rows[0]!.sequence);
}

const constantChanges = ['missing', 'generation', 'record-digest', 'server-id',
  'connection-id', 'review-revision', 'duplicate'] as const;
async function refusesInvalidConstants(change: typeof constantChanges[number]) {
  const context = await publishedFixture();
  const headers: Record<string, string> = { ...context.headers, ...context.constants };
  let key = `x-opencrane-${change}`;
  if (change === 'generation') key = 'x-opencrane-gateway-generation';
  if (change === 'missing') {
    for (const name of Object.keys(context.constants)) delete headers[name];
  } else if (change === 'duplicate') {
    const value = headers['x-opencrane-gateway-generation']!;
    headers['x-opencrane-gateway-generation'] = `${value}, ${value}`;
  } else {
    headers[key] = 'wrong';
  }
  const request = { method: 'POST', headers, body };
  const response = await fetch(
    `${context.setup.options.decisionUrl}/authorize/mcp/fixture/installed`, request);
  expect(response.status).toBe(403);
  expect(context.setup.received()).toBe(0);
}
it.each(constantChanges)('refuses publication constants: %s', refusesInvalidConstants);

async function refusesSpoofedNewGeneration(copies: number) {
  const context = await publishedFixture();
  const next = await nextCarriedGeneration(context);
  const constants: Record<string, string | string[]> = generationHeaders(next);
  constants['x-opencrane-gateway-generation'] = Array<string>(copies).fill('2');
  expect(await gatewayCall(context, constants)).toBe(403);
  expect(context.setup.received()).toBe(0);
}
it.each([1, 2])('refuses spoofed unacknowledged constants with %s copies',
  refusesSpoofedNewGeneration);

async function refusesConstantsOnLegacy(name: string) {
  const setup = await fixture();
  onTestFinished(setup.close.bind(setup));
  const headers = await prepare(setup);
  const constants = { ...headers, [name]: '1' };
  const request = { method: 'POST', headers: constants, body };
  const response = await fetch(`${setup.options.decisionUrl}/authorize/mcp/fixture/installed`,
    request);
  expect(response.status).toBe(403);
  expect(setup.received()).toBe(0);
}
const legacyConstants = ['x-opencrane-gateway-generation', 'x-opencrane-record-digest',
  'x-opencrane-server-id', 'x-opencrane-connection-id', 'x-opencrane-review-revision'];
it.each(legacyConstants)('refuses a constant on a legacy publication: %s',
  refusesConstantsOnLegacy);

async function refusesGenerationDuringDispatch(afterAdmission: boolean) {
  const context = await publishedFixture();
  const { setup } = context;
  const headers = { ...context.headers, ...context.constants };
  const value = await permit(setup, headers);
  const append = setup.nats.store.append.bind(setup.nats.store);
  async function changeAfterAdmission(command: AppendCommand) {
    const result = await append(command);
    const event = z.object({ type: z.string() }).parse(command.event);
    if (event.type === 'mcp.dispatch_admitted') await nextCarriedGeneration(context);
    return result;
  }
  if (afterAdmission) {
    vi.spyOn(setup.nats.store, 'append').mockImplementation(changeAfterAdmission);
  } else {
    await nextCarriedGeneration(context);
  }
  try {
    expect((await send(setup, value)).status).toBe(403);
    expect((await send(setup, value)).status).toBe(403);
    expect(setup.received()).toBe(0);
  } finally {
    vi.restoreAllMocks();
  }
}
it.each([false, true])('refuses changed gateway generation after admission: %s',
  refusesGenerationDuringDispatch);

async function consumesPublishedPermitOnce(concurrent: boolean) {
  const context = await publishedFixture();
  const { setup } = context;
  const headers = { ...context.headers, ...context.constants };
  const value = await permit(setup, headers);
  let replies;
  if (concurrent) {
    replies = await Promise.all([send(setup, value), send(setup, value)]);
  } else {
    replies = [await send(setup, value), await send(setup, value)];
  }
  function status(reply: Response) {
    return reply.status;
  }
  const statuses = replies.map(status);
  expect(statuses.sort()).toEqual([200, 403]);
  expect(setup.received()).toBe(1);
  await expectDispatchStarted(setup, context.record, 0);
  const unused = await permit(setup, headers);
  const restarted = await startDecision(setup.actor, setup.identity, setup.binding,
    0, setup.keys, undefined, setup.dispatchOptions);
  onTestFinished(restarted.close);
  const request = { method: 'POST', headers: { 'x-opencrane-mcp-permit': unused }, body };
  const response = await fetch(`${restarted.url}/dispatch/mcp/fixture/installed`, request);
  expect(response.status).toBe(403);
  expect(setup.received()).toBe(1);
}
it.each([false, true])('consumes a published permit once, concurrent: %s',
  consumesPublishedPermitOnce);

async function waitsForDispatchStartReply() {
  const context = await publishedFixture();
  const { setup } = context;
  const saved = Promise.withResolvers<string>();
  const release = Promise.withResolvers<void>();
  const append = setup.nats.store.append.bind(setup.nats.store);
  async function holdStartReply(command: AppendCommand) {
    const result = await append(command);
    const event = z.object({ type: z.string(), subject: z.string() }).parse(command.event);
    if (event.type === 'tool.dispatch_started') {
      saved.resolve(event.subject);
      await release.promise;
    }
    return result;
  }
  const writer = vi.spyOn(setup.nats.store, 'append').mockImplementation(holdStartReply);
  const dispatch = gatewayCall(context);
  function repliedTooSoon(): never {
    throw new Error('Gateway replied before saving the start');
  }
  try {
    const subject = await Promise.race([saved.promise, dispatch.then(repliedTooSoon)]);
    const rows = await history(setup.nats.store, subject, 'test');
    expect(rows.at(-1)!.event.type).toBe('tool.dispatch_started');
    expect(setup.received()).toBe(0);
  } finally {
    release.resolve();
    writer.mockRestore();
  }
  expect(await dispatch).toBe(200);
  expect(setup.received()).toBe(1);
  await expectDispatchStarted(setup, context.record, 0);
  async function recordsOutcome() {
    await ingestUsage(setup.actor, setup.options.usageFile);
    const subject = await saved.promise;
    const rows = await history(setup.nats.store, subject, 'test');
    expect(rows.at(-1)!.event.type).toBe('tool.dispatch_recorded');
    expect(rows).toHaveLength(3);
  }
  await expect.poll(recordsOutcome).toBeUndefined();
  await verifyRestorationReplay(setup);
}
it('saves tool.dispatch_started before any upstream byte and keeps the outcome last',
  waitsForDispatchStartReply, 60_000);

const startFailures = ['lost reply', 'throw', 'conflict', 'rejected', 'withdrawal',
  'access revoked', 'acknowledgement lost', 'new generation', 'backend changed'] as const;
async function refusesAfterDispatchStart(change: typeof startFailures[number]) {
  const context = await publishedFixture();
  const { setup, delivery } = context;
  const headers = { ...context.headers, ...context.constants };
  const value = await permit(setup, headers);
  const append = setup.nats.store.append.bind(setup.nats.store);
  let subject = '';
  let attempts = 0;
  async function interruptStart(command: AppendCommand) {
    const event = z.object({ type: z.string(), subject: z.string() }).parse(command.event);
    if (event.type !== 'tool.dispatch_started') return append(command);
    subject = event.subject;
    attempts++;
    if (change === 'conflict') return { status: 'conflict' as const };
    if (change === 'rejected') {
      return { status: 'rejected' as const, reason: 'duplicate_id' as const };
    }
    const result = await append(command);
    expect(result.status).toBe('appended');
    expect(setup.received()).toBe(0);
    if (change === 'lost reply') {
      return { status: 'unavailable' as const, cause: new Error('START_REPLY_CANARY') };
    }
    if (change === 'throw') throw new Error('START_REPLY_CANARY');
    if (change === 'withdrawal') {
      await setup.append('mcp-fixture', 'mcp.server_unpublished',
        { serverId: 'fixture', unpublishedBy: 'alice' });
    } else if (change === 'access revoked') {
      await setup.append('member-alice', 'member.removed',
        { memberId: 'alice', removedBy: 'alice' });
    } else if (change === 'acknowledgement lost') {
      delivery.close();
    } else if (change === 'new generation') {
      await nextCarriedGeneration(context);
    } else if (change === 'backend changed') {
      setup.options.mcpRoutes[0]!.generation = 'instance-2';
    }
    return result;
  }
  const writer = vi.spyOn(setup.nats.store, 'append').mockImplementation(interruptStart);
  try {
    const first = await send(setup, value);
    expect(first.status).toBe(403);
    expect(await first.json()).toEqual({});
    expect((await send(setup, value)).status).toBe(403);
  } finally {
    writer.mockRestore();
  }
  expect(attempts).toBe(1);
  expect(setup.received()).toBe(0);
  const rows = await history(setup.nats.store, subject, 'test');
  if (change === 'conflict' || change === 'rejected') {
    expect(rows).toHaveLength(1);
  } else {
    expect(rows).toHaveLength(3);
    expect(rows[2]!.event.type).toBe('tool.dispatch_recorded');
    expect(rows[2]!.event.data).toMatchObject({
      outcome: 'not_dispatched', evidence: 'dispatch_refused',
    });
    const event = rows[1]!.event;
    expect(event.type).toBe('tool.dispatch_started');
    const requestId = z.object({ requestId: z.string() }).parse(event.data).requestId;
    expect(event.id).toBe(`${requestId}:tool-dispatch-started`);
    expect(event.commandId).toBe(event.id);
  }
}
it.each(startFailures)('sends nothing after tool.dispatch_started: %s',
  refusesAfterDispatchStart);

async function refusesGenerationDuringLastMcpRead(afterStart: boolean) {
  const context = await publishedFixture();
  const { setup, delivery } = context;
  const headers = { ...context.headers, ...context.constants };
  const value = await permit(setup, headers);
  const encoded = value.split('.')[0]!;
  const decoded: unknown = JSON.parse(Buffer.from(encoded, 'base64url').toString());
  const { requestId } = z.object({ requestId: z.string() }).parse(decoded);
  const append = setup.nats.store.append.bind(setup.nats.store);
  const head = setup.nats.store.head.bind(setup.nats.store);
  const waiting = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let admitted = false;
  let started = false;
  let gatewayChecked = false;
  let held = false;
  async function noteAppend(command: AppendCommand) {
    const result = await append(command);
    const event = z.object({ type: z.string() }).parse(command.event);
    if (event.type === 'mcp.dispatch_admitted') {
      admitted = true;
    }
    if (event.type === 'tool.dispatch_started') {
      started = true;
    }
    return result;
  }
  async function holdMcpRead(...parameters: Parameters<typeof head>) {
    const position = await head(...parameters);
    if (parameters[0] === 'gateway-config-test' && admitted && (!afterStart || started)) {
      gatewayChecked = true;
    }
    if (parameters[0] === 'mcp-fixture' && gatewayChecked && !held) {
      held = true;
      waiting.resolve();
      await release.promise;
    }
    return position;
  }
  const writer = vi.spyOn(setup.nats.store, 'append').mockImplementation(noteAppend);
  const reader = vi.spyOn(setup.nats.store, 'head').mockImplementation(holdMcpRead);
  const dispatch = send(setup, value);
  function repliedTooSoon(): never {
    throw new Error('Dispatch replied before the MCP read barrier');
  }
  try {
    await Promise.race([waiting.promise, dispatch.then(repliedTooSoon)]);
    const mcpPosition = await head('mcp-fixture');
    const acknowledgement = delivery.acknowledged();
    const next = await nextCarriedGeneration(context);
    expect(next.generation).toBe(context.record.generation + 1);
    expect(await head('mcp-fixture')).toBe(mcpPosition);
    expect(delivery.acknowledged()).toEqual(acknowledgement);
    expect(await head('gateway-config-test')).toBeGreaterThan(acknowledgement!.position);
    release.resolve();
    const response = await dispatch;
    expect.soft(response.status).toBe(403);
    expect.soft(setup.received()).toBe(0);
    const rows = await history(setup.nats.store, `decision-${requestId}`, 'test');
    function isStarted(row: typeof rows[number]) {
      return row.event.type === 'tool.dispatch_started';
    }
    expect(rows.filter(isStarted)).toHaveLength(afterStart ? 1 : 0);
    if (afterStart) {
      expect(rows).toHaveLength(3);
      expect(rows[2]!.event.type).toBe('tool.dispatch_recorded');
      expect(rows[2]!.event.data).toMatchObject({
        requestId, outcome: 'not_dispatched', evidence: 'dispatch_refused',
      });
    }
    expect((await send(setup, value)).status).toBe(403);
  } finally {
    release.resolve();
    await dispatch;
    reader.mockRestore();
    writer.mockRestore();
  }
}
it.each([false, true])('refuses a saved generation during the last MCP read, after start: %s',
  refusesGenerationDuringLastMcpRead);

async function ordersDispatchAtLastGatewayRead(savedAfterRead: boolean) {
  const context = await publishedFixture();
  const { setup, delivery } = context;
  const headers = { ...context.headers, ...context.constants };
  const value = await permit(setup, headers);
  const append = setup.nats.store.append.bind(setup.nats.store);
  const head = setup.nats.store.head.bind(setup.nats.store);
  const waiting = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let started = false;
  let gatewayChecked = false;
  let mcpChecked = false;
  let held = false;
  let subject = '';
  async function noteStart(command: AppendCommand) {
    const result = await append(command);
    const event = z.object({ type: z.string(), subject: z.string() }).parse(command.event);
    if (event.type === 'tool.dispatch_started') {
      started = true;
      subject = event.subject;
    }
    return result;
  }
  async function holdLastGatewayRead(...parameters: Parameters<typeof head>) {
    if (started && parameters[0] === 'gateway-config-test') {
      gatewayChecked = true;
    }
    if (gatewayChecked && parameters[0] === 'mcp-fixture') {
      mcpChecked = true;
    }
    if (parameters[0] !== 'gateway-config-test' || !mcpChecked || held) {
      return head(...parameters);
    }
    held = true;
    if (savedAfterRead) {
      const position = await head(...parameters);
      waiting.resolve();
      await release.promise;
      return position;
    }
    waiting.resolve();
    await release.promise;
    return head(...parameters);
  }
  const writer = vi.spyOn(setup.nats.store, 'append').mockImplementation(noteStart);
  const reader = vi.spyOn(setup.nats.store, 'head').mockImplementation(holdLastGatewayRead);
  const dispatch = send(setup, value);
  function repliedTooSoon(): never {
    throw new Error('Dispatch replied before the final gateway read barrier');
  }
  try {
    await Promise.race([waiting.promise, dispatch.then(repliedTooSoon)]);
    const mcpPosition = await head('mcp-fixture');
    const acknowledgement = delivery.acknowledged();
    const next = await nextCarriedGeneration(context);
    expect(next.generation).toBe(context.record.generation + 1);
    expect(await head('mcp-fixture')).toBe(mcpPosition);
    expect(delivery.acknowledged()).toEqual(acknowledgement);
    expect(await head('gateway-config-test')).toBeGreaterThan(acknowledgement!.position);
    expect(setup.received()).toBe(0);
    release.resolve();
    const response = await dispatch;
    expect(response.status).toBe(savedAfterRead ? 200 : 403);
    expect(setup.received()).toBe(savedAfterRead ? 1 : 0);
    const rows = await history(setup.nats.store, subject, 'test');
    expect(rows[1]!.event.type).toBe('tool.dispatch_started');
    expect(rows[1]!.event.data).toMatchObject({ generation: context.record.generation });
    if (savedAfterRead) {
      expect(rows).toHaveLength(2);
    } else {
      expect(rows).toHaveLength(3);
      expect(rows[2]!.event.type).toBe('tool.dispatch_recorded');
      expect(rows[2]!.event.data).toMatchObject({
        outcome: 'not_dispatched', evidence: 'dispatch_refused',
      });
    }
    expect((await send(setup, value)).status).toBe(403);
    expect(setup.received()).toBe(savedAfterRead ? 1 : 0);
  } finally {
    release.resolve();
    await dispatch;
    reader.mockRestore();
    writer.mockRestore();
  }
}
it.each([false, true])('orders dispatch at the last gateway read, saved after read: %s',
  ordersDispatchAtLastGatewayRead);

async function refusesCompetingOutcome(afterRead: boolean) {
  const context = await publishedFixture();
  const { setup } = context;
  const headers = { ...context.headers, ...context.constants };
  const value = await permit(setup, headers);
  const encoded = value.split('.')[0]!;
  const decoded: unknown = JSON.parse(Buffer.from(encoded, 'base64url').toString());
  const { requestId } = z.object({ requestId: z.string() }).parse(decoded);
  const subject = `decision-${requestId}`;
  const append = setup.nats.store.append.bind(setup.nats.store);
  const readEvent = setup.nats.store.readEvent.bind(setup.nats.store);
  const observation = { id: requestId, toolOutcome: 'outcome_unknown' as const,
    evidence: 'transport_uncertain' as const, observedAt: new Date().toISOString(),
    durationMs: 0 };
  let admitted = false;
  let recorded = false;
  let startResult: string | undefined;
  async function saveOutcome() {
    recorded = true;
    await recordToolObservation(setup.actor, observation);
  }
  async function appendWithOutcome(command: AppendCommand) {
    const result = await append(command);
    const event = z.object({ type: z.string() }).parse(command.event);
    if (event.type === 'mcp.dispatch_admitted') {
      admitted = true;
      if (!afterRead) {
        await saveOutcome();
      }
    }
    if (event.type === 'tool.dispatch_started') {
      startResult = result.status;
    }
    return result;
  }
  async function readWithOutcome(...parameters: Parameters<typeof readEvent>) {
    const row = await readEvent(...parameters);
    if (afterRead && admitted && !recorded && row.event.subject === subject) {
      await saveOutcome();
    }
    return row;
  }
  const writer = vi.spyOn(setup.nats.store, 'append').mockImplementation(appendWithOutcome);
  const reader = vi.spyOn(setup.nats.store, 'readEvent').mockImplementation(readWithOutcome);
  try {
    expect((await send(setup, value)).status).toBe(403);
    expect((await send(setup, value)).status).toBe(403);
    expect(recorded).toBe(true);
    expect(setup.received()).toBe(0);
    if (afterRead) {
      expect(startResult).toBe('conflict');
    } else {
      expect(startResult).toBeUndefined();
    }
    const rows = await history(setup.nats.store, subject, 'test');
    expect(rows).toHaveLength(2);
    expect(rows[1]!.event.type).toBe('tool.dispatch_recorded');
  } finally {
    reader.mockRestore();
    writer.mockRestore();
  }
}
it.each([false, true])('keeps a competing outcome last, saved after decision read: %s',
  refusesCompetingOutcome);

async function refusesDuringFinalPublishedRead(
  change: 'withdrawal' | 'acknowledgement' | 'expiry',
) {
  const context = await publishedFixture();
  const { setup, delivery } = context;
  const headers = { ...context.headers, ...context.constants };
  const value = await permit(setup, headers);
  const append = setup.nats.store.append.bind(setup.nats.store);
  const head = setup.nats.store.head.bind(setup.nats.store);
  let started = false;
  let gatewayChecked = false;
  let changed = false;
  async function noteStart(command: AppendCommand) {
    const result = await append(command);
    const event = z.object({ type: z.string() }).parse(command.event);
    if (event.type === 'tool.dispatch_started') started = true;
    return result;
  }
  async function changeDuringRead(...parameters: Parameters<typeof head>) {
    const position = await head(...parameters);
    if (!started || changed) return position;
    if (parameters[0] === 'gateway-config-test') {
      gatewayChecked = true;
      if (change === 'withdrawal') {
        changed = true;
        await setup.append('mcp-fixture', 'mcp.server_unpublished',
          { serverId: 'fixture', unpublishedBy: 'alice' });
      }
    } else if (parameters[0] === 'mcp-fixture' && gatewayChecked) {
      changed = true;
      if (change === 'expiry') {
        vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3000);
      } else {
        delivery.close();
      }
    }
    return position;
  }
  const writer = vi.spyOn(setup.nats.store, 'append').mockImplementation(noteStart);
  const reader = vi.spyOn(setup.nats.store, 'head').mockImplementation(changeDuringRead);
  try {
    expect((await send(setup, value)).status).toBe(403);
    expect((await send(setup, value)).status).toBe(403);
    expect(changed).toBe(true);
    expect(setup.received()).toBe(0);
  } finally {
    reader.mockRestore();
    writer.mockRestore();
    vi.restoreAllMocks();
  }
}
it.each(['withdrawal', 'acknowledgement', 'expiry'] as const)(
  'refuses a final read change after tool.dispatch_started: %s', refusesDuringFinalPublishedRead);

async function refusesRejectedGeneration() {
  const context = await publishedFixture();
  const next = await nextCarriedGeneration(context);
  const { setup, delivery } = context;
  const logs: string[] = [];
  function record(chunk: Buffer) {
    logs.push(chunk.toString());
  }
  setup.gatewayChild()!.stdout?.on('data', record);
  setup.gatewayChild()!.stderr?.on('data', record);
  const settings = { ...delivery.options.settings, keyFile: `${setup.options.configFile}.missing` };
  const options = { ...delivery.options, settings };
  const rejected = gatewayDelivery(options);
  await rejected.deliver(next);
  function reloadRejected() {
    return logs.join('').includes('Failed to reload config');
  }
  await expect.poll(reloadRejected, { timeout: 5000 }).toBe(true);
  expect(await rejected.observe()).toBeNull();
  expect(rejected.acknowledged()).toBeNull();
  expect(await gatewayCall(context)).toBe(403);
  expect(setup.received()).toBe(0);
}
it('refuses an old gateway route after its replacement configuration is rejected',
  refusesRejectedGeneration);

async function refusesWithdrawnPublishedPermit() {
  const context = await publishedFixture();
  const { setup } = context;
  const headers = { ...context.headers, ...context.constants };
  const value = await permit(setup, headers);
  const withdrawal = { serverId: 'fixture', unpublishedBy: 'alice' };
  await setup.append('mcp-fixture', 'mcp.server_unpublished', withdrawal);
  expect((await send(setup, value)).status).toBe(403);
  expect(await gatewayCall(context)).toBe(403);
  expect(setup.received()).toBe(0);
}
it('refuses withdrawal before admitting a published permit', refusesWithdrawnPublishedPermit);

async function keepsApprovalAcrossCarriedGeneration() {
  const context = await publishedFixture('ask');
  const { setup, delivery } = context;
  const headers = { ...context.headers, ...context.constants };
  const request = { method: 'POST', headers, body };
  const response = await fetch(`${setup.options.decisionUrl}/authorize/mcp/fixture/installed`,
    request);
  const data: unknown = await response.json();
  const { approvalId } = z.object({ approvalId: z.string() }).parse(data);
  const before = await readApproval(setup.nats.store, 'test', approvalId);
  expect(before.state).toBe('requested');
  const next = await nextCarriedGeneration(context);
  await delivery.deliver(next);
  await delivery.waitForWitness(next);
  expect(await delivery.observe()).not.toBeNull();
  const after = await readApproval(setup.nats.store, 'test', approvalId);
  expect(after.request).toEqual(before.request);
  expect(after.state).toBe('requested');
  async function fresh() {}
  const result = await decideApproval(setup.nats.store, 'test', approvalId,
    'alice', 'approved', true, fresh, after, setup.actor.now());
  expect(result.status).toBe('appended');
  const currentHeaders = { ...context.headers, ...generationHeaders(next) };
  const value = await permit(setup, currentHeaders);
  expect((await send(setup, value)).status).toBe(200);
  expect(setup.received()).toBe(1);
}
it('keeps a waiting approval bound to its review across a carried generation',
  keepsApprovalAcrossCarriedGeneration);
async function approvalForReviewedTool(setup: Fixture, headers: Record<string, string>,
  approve: boolean) {
  const request = { method: 'POST', headers, body };
  const response = await fetch(`${setup.options.decisionUrl}/authorize/mcp/fixture/installed`,
    request);
  const answer = z.object({ approvalId: z.string() }).parse(await response.json());
  const waiting = await readApproval(setup.nats.store, 'test', answer.approvalId);
  if (approve) {
    async function fresh() {}
    const result = await decideApproval(setup.nats.store, 'test', answer.approvalId,
      'alice', 'approved', true, fresh, waiting);
    expect(result.status).toBe('appended');
  }
  return answer.approvalId;
}

const descriptionCanary = 'UNTRUSTED_DESCRIPTION_RELOAD_CANARY';

async function reviewedReloadFixture(setup: Fixture) {
  const headers = await prepare(setup);
  const savedDefinition = z.string().parse(tool.definition);
  const parsed: unknown = JSON.parse(savedDefinition);
  const definition = z.record(z.string(), z.unknown()).parse(parsed);
  definition['description'] = descriptionCanary;
  const encoded = losslessJson(JSON.stringify(definition));
  const declaration = { ...tool, definition: encoded.canonical, revision: encoded.digest };
  const discovery = { serverId: 'fixture', connectionId: 'installed', accountMode: 'none',
    ...catalogueEvidence([declaration]) };
  await setup.append('mcp-fixture', 'mcp.server_discovered', discovery);
  const policy = await readToolPolicy(setup.nats.store, 'test', 'fixture');
  function captureCatalogue() {
    return Promise.resolve(policy.catalogue!);
  }
  const options = { serverIds: ['fixture'], capture: captureCatalogue,
    requireLeader: setup.dispatchOptions.requireLeader.bind(setup.dispatchOptions) };
  const watch = mcpCatalogueWatch(setup.nats.store, 'test', options);
  onTestFinished(watch.close);
  setup.dispatchOptions.requireCatalogue = watch.requireCurrent;
  await watch.check('fixture');
  await reviewRestoration(setup, 'review-reload', 'ask');
  // Start from a callable legacy publication; activation of new servers is separate work.
  await setup.append('mcp-fixture', 'mcp.server_published',
    { serverId: 'fixture', publishedBy: 'alice' });
  await reviewRestoration(setup, 'review-initial-reload', 'ask');
  const delivery = await restorationDelivery(setup);
  const first = await publishRestoration(setup, 'initial-reload');
  await acknowledgeReload(delivery, first);
  Object.assign(headers, generationHeaders(first));
  await watch.check('fixture');
  watch.requireCurrent('fixture');
  return { headers, watch, delivery, first };
}

async function acknowledgeReload(delivery: Awaited<ReturnType<typeof restorationDelivery>>,
  record: Awaited<ReturnType<typeof publishRestoration>>) {
  await delivery.deliver(record);
  await delivery.waitForWitness(record);
  async function acknowledged() {
    expect(await delivery.observe()).not.toBeNull();
  }
  await expect.poll(acknowledged, { timeout: 5000 }).toBeUndefined();
}

async function cancelsApprovalOnSavedReload(approve: boolean, readPending: boolean) {
  const setup = await fixture();
  async function close() {
    await setup.close();
  }
  onTestFinished(close);
  const output: string[] = [];
  function recordOutput(chunk: Buffer) {
    output.push(chunk.toString());
  }
  const child = setup.gatewayChild()!;
  child.stdout?.on('data', recordOutput);
  child.stderr?.on('data', recordOutput);
  const { headers, watch, delivery, first } = await reviewedReloadFixture(setup);
  const approvalId = await approvalForReviewedTool(setup, headers, approve);
  const before = await readToolPolicy(setup.nats.store, 'test', 'fixture');
  const record = await publishRestoration(setup, 'reload');
  expect(record.generation).toBe(first.generation + 1);
  expect(await delivery.observe()).toBeNull();
  await expect(delivery.deliver(first)).rejects.toThrow('Gateway delivery unavailable');
  await setup.append('mcp-fixture', 'mcp.configuration_observed',
    before.configurationObservation);
  await watch.check('fixture');
  function requireCurrent() {
    watch.requireCurrent('fixture');
  }
  expect(requireCurrent).toThrow('watch unavailable');
  const pending = await readToolPolicy(setup.nats.store, 'test', 'fixture');
  expect.soft(pending.policyRevision).toBeGreaterThan(before.policyRevision);
  if (readPending) {
    const cancelled = await readApproval(setup.nats.store, 'test', approvalId);
    expect(cancelled.state).toBe('cancelled');
  }
  await acknowledgeReload(delivery, record);
  await watch.check('fixture');
  watch.requireCurrent('fixture');
  const restored = await readToolPolicy(setup.nats.store, 'test', 'fixture');
  const observedPosition = await setup.nats.store.head();
  await delivery.observe();
  expect(await setup.nats.store.head()).toBe(observedPosition);
  expect(restored.published).toBe(true);
  expect(restored.policyRevision).toBe(pending.policyRevision);
  const old = await readApproval(setup.nats.store, 'test', approvalId);
  expect(old.state).toBe('cancelled');
  async function fresh() {}
  for (const action of ['approved', 'retry'] as const) {
    const result = await decideApproval(setup.nats.store, 'test', approvalId,
      'alice', action, true, fresh, old);
    expect(result.status).toBe('conflict');
  }
  Object.assign(headers, generationHeaders(record));
  const refused = await approvalPermit(setup, headers, approvalId);
  expect(refused.status).not.toBe(200);
  expect(await refused.text()).not.toContain(descriptionCanary);
  const approvalRows = await history(setup.nats.store, `approval-${approvalId}`, 'test');
  expect(JSON.stringify(approvalRows)).not.toContain(descriptionCanary);
  expect(setup.received()).toBe(0);
  const position = await setup.nats.store.head();
  await setup.restart();
  expect(await readToolPolicy(setup.nats.store, 'test', 'fixture')).toEqual(restored);
  expect(await readApproval(setup.nats.store, 'test', approvalId)).toEqual(old);
  expect(await setup.nats.store.head()).toBe(position);
  await verifyRestorationReplay(setup, 0);
  expect(output.join('')).not.toContain(descriptionCanary);
}
it.each([[false, false], [true, false], [false, true], [true, true]])(
  'cancels old approvals on saved reload (approved %s, read pending %s)',
  cancelsApprovalOnSavedReload, 60_000);

async function preservesApprovalForOtherReload(serverId: string) {
  const setup = await fixture();
  try {
    const { headers, first } = await reviewedReloadFixture(setup);
    const approvalId = await approvalForReviewedTool(setup, headers, true);
    const before = await readToolPolicy(setup.nats.store, 'test', 'fixture');
    const approved = await readApproval(setup.nats.store, 'test', approvalId);
    const registration = { serverId, kind: 'remote',
      locator: 'https://other.example.test/mcp', registeredBy: 'alice' };
    await setup.append(`mcp-${serverId}`, 'mcp.server_registered', registration);
    const discovery = { ...before.catalogue!, serverId };
    await setup.append(`mcp-${serverId}`, 'mcp.server_discovered', discovery);
    await reviewRestoration(setup, 'review-other', 'ask', serverId);
    const record = await publishRestoration(setup, 'reload-other', serverId);
    expect(record.generation).toBe(first.generation + 1);
    expect(record.members[0]).toEqual(first.members[0]);
    const delivery = await restorationDelivery(setup, false);
    await delivery.deliver(record);
    await delivery.waitForWitness(record);
    async function acknowledged() {
      expect(await delivery.observe()).not.toBeNull();
    }
    await expect.poll(acknowledged, { timeout: 5000 }).toBeUndefined();
    const observation = await delivery.observe();
    const { outcome: _outcome, ...observed } =
      gatewayObservationSchema.parse(observation!.event.data);
    const expectedReceipt = { ...before.configurationObservation!, ...observed };
    const rows = await history(setup.nats.store, 'mcp-fixture', 'test');
    const receipt = rows.at(-1)!;
    expect(receipt.event.type).toBe('mcp.configuration_observed');
    expect(receipt.event.data).toEqual(expectedReceipt);
    expect(receipt.sequence).toBeGreaterThan(before.sequence);
    const expectedPolicy = { ...before, sequence: receipt.sequence,
      configurationObservation: expectedReceipt };
    expect(await readToolPolicy(setup.nats.store, 'test', 'fixture')).toEqual(expectedPolicy);
    expect(await readApproval(setup.nats.store, 'test', approvalId)).toEqual(approved);
    Object.assign(headers, generationHeaders(record));
    const response = await approvalPermit(setup, headers, approvalId);
    expect(response.status).toBe(200);
    const value = response.headers.get('x-opencrane-mcp-permit')!;
    expect((await send(setup, value)).status).toBe(200);
    expect((await send(setup, value)).status).toBe(403);
    expect(setup.received()).toBe(1);
  } finally {
    await setup.close();
  }
}
it.each(['odoo', 'memory'])('keeps another server approval through %s reload',
  preservesApprovalForOtherReload, 60_000);

async function preservesConsumedApproval() {
  const setup = await fixture();
  try {
    const headers = await prepare(setup);
    await reviewRestoration(setup, 'review-consumed', 'ask');
    const approvalId = await approvalForReviewedTool(setup, headers, true);
    const response = await approvalPermit(setup, headers, approvalId);
    const value = response.headers.get('x-opencrane-mcp-permit')!;
    expect((await send(setup, value)).status).toBe(200);
    const before = await readApproval(setup.nats.store, 'test', approvalId);
    expect(before.state).toBe('outcome_unknown');
    const rows = await history(setup.nats.store, `approval-${approvalId}`, 'test');
    await publishRestoration(setup, 'reload-consumed');
    expect(await readApproval(setup.nats.store, 'test', approvalId)).toEqual(before);
    expect(await history(setup.nats.store, `approval-${approvalId}`, 'test')).toEqual(rows);
    expect((await send(setup, value)).status).toBe(403);
    expect(setup.received()).toBe(1);
  } finally {
    await setup.close();
  }
}
it('keeps a consumed approval and its historical outcome through reload',
  preservesConsumedApproval, 60_000);

async function refusesReloadDuringFinalRead() {
  const setup = await fixture();
  try {
    const { headers, watch } = await reviewedReloadFixture(setup);
    const approvalId = await approvalForReviewedTool(setup, headers, true);
    const readStream = setup.nats.store.readStream.bind(setup.nats.store);
    const append = setup.nats.store.append.bind(setup.nats.store);
    let captureSaved = false;
    let changed = false;
    async function saveCapture(command: AppendCommand) {
      const result = await append(command);
      const event = z.object({ type: z.string() }).parse(command.event);
      if (event.type === 'mcp.catalogue_checked') captureSaved = true;
      return result;
    }
    async function* reloadDuringRead(...parameters: Parameters<typeof readStream>) {
      if (parameters[0] === 'mcp-fixture' && captureSaved && !changed) {
        changed = true;
        await publishRestoration(setup, 'reload-final-read');
      }
      yield* readStream(...parameters);
    }
    const writer = vi.spyOn(setup.nats.store, 'append');
    const reader = vi.spyOn(setup.nats.store, 'readStream');
    writer.mockImplementation(saveCapture);
    reader.mockImplementation(reloadDuringRead);
    try {
      await watch.check('fixture');
    } finally {
      writer.mockRestore();
      reader.mockRestore();
    }
    expect(changed).toBe(true);
    function requireCurrent() {
      watch.requireCurrent('fixture');
    }
    expect(requireCurrent).toThrow('watch unavailable');
    const approval = await readApproval(setup.nats.store, 'test', approvalId);
    expect(approval.state).toBe('cancelled');
    expect((await approvalPermit(setup, headers, approvalId)).status).not.toBe(200);
    expect(setup.received()).toBe(0);
  } finally {
    await setup.close();
  }
}
it('refuses a saved reload during the final awaited watch read',
  refusesReloadDuringFinalRead, 60_000);

const remoteGuards = ['gateway', 'bytes', 'private', 'metadata', 'mixed', 'empty', 'rebind',
  'untrusted', 'wrong_name', 'redirect', 'oversize', 'session', 'mime', 'reply_fields',
  'undeclared', 'revision', 'dns_timeout', 'permit_timeout', 'held_start', 'lost_start',
  'deadline', 'watch_admission', 'watch_final'] as const;
async function guardsRemoteCall(mode: typeof remoteGuards[number]) {
  const raw = body.replace('"arguments":{', '"arguments":{"number":1.0e3,');
  const context = await publishedFixture('allow', true, mode !== 'undeclared');
  const { setup } = context;
  const remote = await remoteFixture(mode === 'wrong_name');
  onTestFinished(remote.close);
  setup.dispatchOptions.routes.length = 0;
  Object.assign(setup.dispatchOptions, { remoteNetwork: remote.network });
  let held = mode === 'watch_admission';
  function requireCatalogue() {
    if (held) throw new Error('Catalogue watch unavailable');
  }
  setup.dispatchOptions.requireCatalogue = requireCatalogue;
  remote.revision(catalogue.schemaDigest);
  if (mode === 'private') remote.setAnswers(['127.0.0.1']);
  if (mode === 'metadata') remote.setAnswers(['169.254.169.254']);
  if (mode === 'mixed') remote.setAnswers(['93.184.216.34', '127.0.0.1']);
  function emptyDns() { return Promise.resolve([]); }
  if (mode === 'empty') remote.network.resolve = emptyDns;
  if (mode === 'rebind') remote.rebind();
  if (mode === 'untrusted') remote.untrust();
  if (mode === 'redirect') remote.status(307);
  function largeReply() { return 'x'.repeat(1024 * 1024 + 1); }
  if (mode === 'oversize') remote.respond(largeReply);
  if (mode === 'mime') remote.replyFields({ 'content-type': 'text/plain' });
  if (mode === 'session') remote.replyFields({ 'mcp-session-id': 'REPLY_CANARY' });
  if (mode === 'reply_fields') remote.replyFields({ 'set-cookie': 'REPLY_CANARY' });
  if (mode === 'revision') remote.revision('a'.repeat(64));
  const releaseDns = Promise.withResolvers<{ address: string; family: number }[]>();
  if (mode === 'dns_timeout' || mode === 'permit_timeout') {
    function heldDns() { return releaseDns.promise; }
    remote.network.resolve = heldDns;
  }
  const rowsBefore = await setup.nats.store.head();
  if (mode === 'undeclared' || mode === 'watch_admission') {
    expect(await gatewayCall(context)).toBe(403);
    expect(remote.dnsCalls()).toBe(0);
  } else if (mode === 'gateway') {
    expect(await gatewayCall(context, {}, raw)).toBe(200);
    expect(remote.received[0]!.raw).toEqual(Buffer.from(raw));
  } else {
    const headers = { ...context.headers, ...context.constants };
    const value = await permit(setup, headers, raw);
    const append = setup.nats.store.append.bind(setup.nats.store);
    const startSaved = Promise.withResolvers<void>();
    const releaseStart = Promise.withResolvers<void>();
    async function holdStart(command: AppendCommand) {
      const result = await append(command);
      const event = z.object({ type: z.string() }).parse(command.event);
      if (event.type === 'tool.dispatch_started') {
        startSaved.resolve();
        if (mode === 'watch_final') held = true;
        if (mode === 'lost_start') throw new Error('Save reply lost');
        if (mode === 'held_start') await releaseStart.promise;
      }
      return result;
    }
    const writer = vi.spyOn(setup.nats.store, 'append').mockImplementation(holdStart);
    const timer = globalThis.setTimeout;
    let expire: (() => void) | undefined;
    function captureDeadline(callback: (...args: unknown[]) => void, delay?: number,
      ...args: unknown[]) {
      if (delay === 30_000) {
        expire = callback;
        return timer(function heldDeadline() {}, 60_000);
      }
      return timer(callback, delay, ...args);
    }
    function noReply() { return undefined; }
    if (mode === 'deadline') {
      remote.respond(noReply);
      const replacement = Object.assign(captureDeadline, timer);
      vi.spyOn(globalThis, 'setTimeout').mockImplementation(replacement);
    }
    if (mode === 'permit_timeout') await pause(1500);
    const canaries = { host: 'caller.example.test', authorization: 'CANARY',
      'x-turn-token': 'CANARY', cookie: 'CANARY', 'session-id': 'CANARY',
      'mcp-session-id': 'CANARY', 'x-forwarded-for': 'CANARY', 'x-memory-context': 'CANARY',
      'x-opencrane-mcp-permit': value };
    const request = { method: 'POST', headers: canaries, body: raw };
    const beforeSend = performance.now();
    const sending = fetch(`${setup.options.decisionUrl}/dispatch/mcp/fixture/installed`, request);
    try {
      if (mode === 'held_start') {
        await startSaved.promise;
        await pause(50);
        expect(remote.connections()).toBe(0);
        releaseStart.resolve();
      }
      if (mode === 'deadline') {
        function received() { return remote.received.length; }
        await expect.poll(received).toBe(1);
        expect(expire).toBeDefined();
        expire!();
      }
      const response = await sending;
      const success = ['bytes', 'rebind', 'reply_fields', 'held_start'].includes(mode);
      let expected = success ? 200 : 502;
      if (['private', 'metadata', 'mixed', 'empty', 'dns_timeout', 'permit_timeout',
        'lost_start', 'watch_final'].includes(mode)) expected = 403;
      if (mode === 'deadline') expected = 504;
      const responseBody = await response.text();
      expect(response.status, responseBody).toBe(expected);
      if (mode === 'wrong_name' || mode === 'untrusted') {
        expect(responseBody).toBe('');
        expect(remote.pooling).toEqual([false]);
      }
      expect(response.headers.get('set-cookie')).toBeNull();
      expect(response.headers.get('location')).toBeNull();
      expect(response.headers.get('mcp-session-id')).toBeNull();
      if (mode === 'dns_timeout') expect(performance.now() - beforeSend).toBeLessThan(1300);
      if (mode === 'permit_timeout') expect(performance.now() - beforeSend).toBeLessThan(700);
      if (success || ['redirect', 'oversize', 'session', 'mime', 'revision', 'deadline'].includes(mode)) {
        expect(remote.received).toHaveLength(1);
        expect(remote.received[0]!.raw).toEqual(Buffer.from(raw));
        expect(remote.received[0]!.hostname).toBe('mcp.example.test');
        expect(remote.received[0]!.headers).toEqual({ host: 'mcp.example.test',
          'content-type': 'application/json', accept: 'application/json',
          'content-length': String(Buffer.byteLength(raw)), 'mcp-protocol-version': '2026-07-28',
          'mcp-method': 'tools/call', 'mcp-name': 'write',
          'x-opencrane-mcp-revision': catalogue.schemaDigest });
        expect(remote.dnsCalls()).toBe(1);
        expect(remote.pinned).toEqual(['93.184.216.34']);
        expect(remote.pooling).toEqual([false]);
      } else {
        expect(remote.received).toHaveLength(0);
      }
    } finally {
      releaseStart.resolve();
      releaseDns.resolve([{ address: '93.184.216.34', family: 4 }]);
      writer.mockRestore();
      vi.restoreAllMocks();
    }
  }
  const rows: StoredEvent[] = [];
  const last = await setup.nats.store.head();
  for (let position = rowsBefore + 1; position <= last; position++) {
    rows.push(await setup.nats.store.readEvent(position));
  }
  const encoded = JSON.stringify(rows);
  if (mode === 'watch_final') {
    function recorded(row: StoredEvent) {
      return row.event.type === 'tool.dispatch_recorded';
    }
    const observations = rows.filter(recorded);
    expect(observations).toHaveLength(1);
    const expectedRefusal = { outcome: 'not_dispatched',
      evidence: 'adapter_dispatch_refused',
      adapter: { connectionId: 'installed', generation: context.record.generation } };
    expect(observations[0]!.event.data).toMatchObject(expectedRefusal);
  } else {
    expect(encoded).not.toContain('not_dispatched');
  }
  if (['lost_start', 'watch_final'].includes(mode)) expect(remote.connections()).toBe(0);
  if (['redirect', 'untrusted', 'wrong_name', 'lost_start', 'watch_final'].includes(mode)) {
    expect(encoded).toContain('tool.dispatch_started');
  }
  if (['private', 'metadata', 'mixed', 'empty', 'undeclared', 'dns_timeout',
    'permit_timeout', 'watch_admission'].includes(mode)) {
    expect(remote.connections()).toBe(0);
    expect(encoded).not.toContain('tool.dispatch_started');
    expect(encoded).not.toContain('mcp.dispatch_admitted');
  }
  expect(setup.received()).toBe(0);
}
it.each(remoteGuards)('guards published HTTPS tool calls: %s', guardsRemoteCall);

async function remoteOutcomeFixture() {
  const context = await publishedFixture('allow', true);
  const remote = await remoteFixture();
  onTestFinished(remote.close);
  context.setup.dispatchOptions.routes.length = 0;
  context.setup.dispatchOptions.remoteNetwork = remote.network;
  remote.revision(catalogue.schemaDigest);
  const headers = { ...context.headers, ...context.constants };
  const value = await permit(context.setup, headers);
  const encoded = value.split('.')[0]!;
  const decoded: unknown = JSON.parse(Buffer.from(encoded, 'base64url').toString());
  const { requestId } = z.object({ requestId: z.uuid() }).parse(decoded);
  const subject = `decision-${requestId}`;
  return { ...context, remote, value, requestId, subject };
}

async function adapterRecorderFixture() {
  const context = await remoteOutcomeFixture();
  const { setup, requestId, subject, record } = context;
  const decisions = await history(setup.nats.store, subject, 'test');
  const startId = `${requestId}:tool-dispatch-started`;
  const binding = {
    silo: 'test',
    decisionId: decisions[0]!.event.id,
    startId,
    connectionId: 'installed',
    generation: record.generation,
    recordDigest: record.recordDigest,
    reviewRevision: record.members[0]!.entry.reviewRevision,
  };
  const startData = {
    requestId,
    serverId: 'fixture',
    connectionId: binding.connectionId,
    generation: binding.generation,
    recordDigest: binding.recordDigest,
    reviewRevision: binding.reviewRevision,
    adapter: 'remote_https',
  };
  const start = envelope('test', subject, 'tool.dispatch_started', startData, startId);
  // Seed a saved start so callbacks can be tested without sending an HTTP request.
  const events = [start];
  await setup.nats.seed(events);
  const observation = {
    id: requestId,
    toolOutcome: 'responded' as const,
    evidence: 'adapter_response_received' as const,
    observedAt: new Date().toISOString(),
    durationMs: 1,
  };
  return { ...context, binding, observation };
}

async function repeatsIdenticalAdapterCallback() {
  const { setup, remote, subject, binding, observation } = await adapterRecorderFixture();
  await recordAdapterObservation(setup.actor, binding, observation);
  const rows = await history(setup.nats.store, subject, 'test');
  expect(rows).toHaveLength(3);
  const writer = vi.spyOn(setup.nats.store, 'append');
  try {
    await recordAdapterObservation(setup.actor, binding, observation);
    expect(writer).not.toHaveBeenCalled();
    expect(await history(setup.nats.store, subject, 'test')).toEqual(rows);
    expect(remote.received).toHaveLength(0);
    expect(remote.connections()).toBe(0);
    expect(setup.received()).toBe(0);
  } finally {
    writer.mockRestore();
  }
}
it('adds nothing for an identical direct adapter callback', repeatsIdenticalAdapterCallback);

async function refusesForeignAdapterCallback() {
  const { setup, remote, subject, binding, observation } = await adapterRecorderFixture();
  const rows = await history(setup.nats.store, subject, 'test');
  expect(rows).toHaveLength(2);
  const foreignBinding = { ...binding, silo: 'other' };
  const recording = recordAdapterObservation(setup.actor, foreignBinding, observation);
  await expect(recording).rejects.toThrow('Tool dispatch evidence unavailable');
  expect(await history(setup.nats.store, subject, 'test')).toEqual(rows);
  expect(remote.received).toHaveLength(0);
  expect(remote.connections()).toBe(0);
  expect(setup.received()).toBe(0);
}
it('refuses a direct adapter callback from a foreign silo', refusesForeignAdapterCallback);

async function refusesChangedAdapterCallback() {
  const { setup, remote, subject, binding, observation } = await adapterRecorderFixture();
  const uncertain = {
    ...observation,
    toolOutcome: 'outcome_unknown' as const,
    evidence: 'adapter_transport_uncertain' as const,
  };
  await recordAdapterObservation(setup.actor, binding, uncertain);
  const rows = await history(setup.nats.store, subject, 'test');
  expect(rows).toHaveLength(3);
  expect(rows[2]!.event.data).toMatchObject({
    outcome: 'outcome_unknown',
    evidence: 'adapter_transport_uncertain',
  });
  const recording = recordAdapterObservation(setup.actor, binding, observation);
  await expect(recording).rejects.toThrow('Tool dispatch evidence unavailable');
  expect(await history(setup.nats.store, subject, 'test')).toEqual(rows);
  expect(remote.received).toHaveLength(0);
  expect(remote.connections()).toBe(0);
  expect(setup.received()).toBe(0);
}
it('refuses a direct responded callback after a saved unknown outcome', refusesChangedAdapterCallback);

async function refusesConflictingAdapterReadback() {
  const { setup, remote, subject, binding, observation } = await adapterRecorderFixture();
  const uncertain = {
    ...observation,
    toolOutcome: 'outcome_unknown' as const,
    evidence: 'adapter_transport_uncertain' as const,
  };
  await recordAdapterObservation(setup.actor, binding, uncertain);
  const rows = await history(setup.nats.store, subject, 'test');
  expect(rows).toHaveLength(3);
  const readStream = setup.nats.store.readStream.bind(setup.nats.store);
  let reads = 0;
  async function* staleFirstRead(...args: Parameters<typeof readStream>) {
    if (args[0] === subject) reads += 1;
    for await (const row of readStream(...args)) {
      // Model an initial read that finished before another callback saved its outcome.
      if (args[0] === subject && reads === 1 && row.event.type === 'tool.dispatch_recorded') {
        continue;
      }
      yield row;
    }
  }
  function lostSaveReply(): Promise<never> {
    const error = new Error('Save reply lost');
    return Promise.reject(error);
  }
  const reader = vi.spyOn(setup.nats.store, 'readStream');
  const writer = vi.spyOn(setup.nats.store, 'append');
  reader.mockImplementation(staleFirstRead);
  writer.mockImplementation(lostSaveReply);
  try {
    const recording = recordAdapterObservation(setup.actor, binding, observation);
    await expect(recording).rejects.toThrow('Tool dispatch evidence unavailable');
    expect(writer).toHaveBeenCalledTimes(1);
    expect(reads).toBe(2);
  } finally {
    reader.mockRestore();
    writer.mockRestore();
  }
  expect(await history(setup.nats.store, subject, 'test')).toEqual(rows);
  expect(remote.received).toHaveLength(0);
  expect(remote.connections()).toBe(0);
  expect(setup.received()).toBe(0);
}
it('refuses conflicting saved evidence on direct adapter callback readback',
  refusesConflictingAdapterReadback);

async function savesRemoteResponse(mode: 'result' | 'tool_error' | 'rpc_error') {
  const { setup, remote, value, requestId, subject, record } = await remoteOutcomeFixture();
  function toolError() { return { isError: true, content: [] }; }
  function rpcError() {
    return '{"jsonrpc":"2.0","id":REQUEST_ID,"error":{"code":-32603,"message":"REPLY_CANARY"}}';
  }
  if (mode === 'tool_error') remote.respond(toolError);
  if (mode === 'rpc_error') remote.respond(rpcError);
  const response = await send(setup, value);
  expect(response.status).toBe(200);
  const rows = await history(setup.nats.store, subject, 'test');
  expect(rows).toHaveLength(3);
  expect(rows[2]!.event).toMatchObject({ type: 'tool.dispatch_recorded', silo: 'test',
    data: { requestId, outcome: 'responded', evidence: 'adapter_response_received',
      adapter: { decisionId: rows[0]!.event.id, startId: rows[1]!.event.id,
        connectionId: 'installed', generation: record.generation,
        recordDigest: record.recordDigest, reviewRevision: record.members[0]!.entry.reviewRevision } } });
  expect((await send(setup, value)).status).toBe(403);
  expect(await history(setup.nats.store, subject, 'test')).toEqual(rows);
  expect(remote.received).toHaveLength(1);
  expect(JSON.stringify(rows)).not.toMatch(/REPLY_CANARY|mcp.example.test/u);
}
it.each(['result', 'tool_error', 'rpc_error'] as const)(
  'saves a checked remote response against its consumed permit once: %s', savesRemoteResponse);

const remoteFailures = ['reset', 'timeout', 'redirect', 'invalid_json', 'wrong_id',
  'duplicate_key', 'invalid_error', 'gateway_502', 'gateway_refused'] as const;
async function keepsRemoteFailureUnknown(mode: typeof remoteFailures[number]) {
  const context = await remoteOutcomeFixture();
  const { setup, remote, value, requestId, subject } = context;
  function invalidReply() { return 'INVALID_REPLY_CANARY'; }
  function wrongId() { return '{"jsonrpc":"2.0","id":"other","result":{}}'; }
  function invalidError() {
    return '{"jsonrpc":"2.0","id":REQUEST_ID,"error":{}}';
  }
  function duplicateKey() {
    return '{"jsonrpc":"2.0","id":REQUEST_ID,"result":{},"result":{}}';
  }
  function noReply() { return undefined; }
  if (mode === 'reset') remote.reset();
  if (mode === 'redirect') remote.status(307);
  if (mode === 'invalid_json') remote.respond(invalidReply);
  if (mode === 'wrong_id') remote.respond(wrongId);
  if (mode === 'duplicate_key') remote.respond(duplicateKey);
  if (mode === 'invalid_error') remote.respond(invalidError);
  if (mode.startsWith('gateway_')) remote.status(502);
  const timer = globalThis.setTimeout;
  let expire: (() => void) | undefined;
  function captureDeadline(callback: (...args: unknown[]) => void, delay?: number,
    ...args: unknown[]) {
    if (delay === 30_000) {
      expire = callback;
      return timer(function heldDeadline() {}, 60_000);
    }
    return timer(callback, delay, ...args);
  }
  if (mode === 'timeout') {
    remote.respond(noReply);
    const replacement = Object.assign(captureDeadline, timer);
    const timerSpy = vi.spyOn(globalThis, 'setTimeout');
    timerSpy.mockImplementation(replacement);
  }
  const append = setup.nats.store.append.bind(setup.nats.store);
  let gatewayRecorded = false;
  async function gatewayFirst(command: AppendCommand) {
    const event = z.object({ type: z.string() }).parse(command.event);
    if (event.type === 'tool.dispatch_recorded' && mode.startsWith('gateway_') && !gatewayRecorded) {
      gatewayRecorded = true;
      let suffix = 'http.status=502';
      if (mode === 'gateway_refused') {
        suffix = 'error="upstream call failed: Connect: Connection refused (os error 111)"';
      }
      const line = `${new Date().toISOString()} route=default/mcp-fixture ` +
        `toolRequestId="${requestId}" duration=1ms ${suffix}`;
      await recordToolObservation(setup.actor, toolObservation(line)!);
    }
    return append(command);
  }
  const writer = vi.spyOn(setup.nats.store, 'append');
  writer.mockImplementation(gatewayFirst);
  try {
    const sending = send(setup, value);
    if (mode === 'timeout') {
      function received() { return remote.received.length; }
      await expect.poll(received).toBe(1);
      expect(expire).toBeDefined();
      expire!();
    }
    const response = await sending;
    expect(response.status).toBe(mode === 'timeout' ? 504 : 502);
    expect(await response.text()).toBe('');
    const rows = await history(setup.nats.store, subject, 'test');
    expect(rows).toHaveLength(3);
    expect(rows[2]!.event.data).toMatchObject({ outcome: 'outcome_unknown',
      evidence: 'adapter_transport_uncertain' });
    const success = { id: requestId, toolOutcome: 'responded' as const,
      evidence: 'response_received' as const, observedAt: new Date().toISOString(), durationMs: 1 };
    await recordToolObservation(setup.actor, success);
    expect(await history(setup.nats.store, subject, 'test')).toEqual(rows);
    expect(JSON.stringify(rows)).not.toMatch(/not_dispatched|INVALID_REPLY_CANARY|mcp.example.test/u);
    expect((await send(setup, value)).status).toBe(403);
    expect(remote.received).toHaveLength(1);
  } finally {
    vi.restoreAllMocks();
  }
}
it.each(remoteFailures)('keeps remote adapter failure unknown: %s', keepsRemoteFailureUnknown);

const remoteSaveFailures = ['lost_reply', 'outage', 'lost_start', 'decision', 'silo',
  'start', 'generation', 'forged'] as const;
async function checksRemoteEvidence(mode: typeof remoteSaveFailures[number]) {
  const { setup, remote, value, requestId, subject } = await remoteOutcomeFixture();
  const append = setup.nats.store.append.bind(setup.nats.store);
  const readStream = setup.nats.store.readStream.bind(setup.nats.store);
  async function save(command: AppendCommand) {
    const event = z.object({ type: z.string() }).parse(command.event);
    if (event.type === 'tool.dispatch_recorded' && mode === 'outage') {
      throw new Error('Store unavailable');
    }
    const result = await append(command);
    if ((event.type === 'tool.dispatch_recorded' && mode === 'lost_reply') ||
        (event.type === 'tool.dispatch_started' && mode === 'lost_start')) {
      throw new Error('Save reply lost');
    }
    return result;
  }
  async function* changedHistory(...args: Parameters<typeof readStream>) {
    for await (const row of readStream(...args)) {
      const copy = structuredClone(row);
      if (args[0] === subject && remote.received.length > 0) {
        if (mode === 'silo') copy.event.silo = 'other';
        if (mode === 'decision' && copy.event.type === 'decision.recorded') {
          copy.event.id = 'foreign-decision';
        }
        if (copy.event.type === 'tool.dispatch_started') {
          if (mode === 'start') copy.event.id = 'foreign-start';
          if (mode === 'generation') {
            const data = z.record(z.string(), z.unknown()).parse(copy.event.data);
            copy.event.data = { ...data, generation: 99 };
          }
        }
      }
      yield copy;
    }
  }
  const writer = vi.spyOn(setup.nats.store, 'append');
  const reader = vi.spyOn(setup.nats.store, 'readStream');
  writer.mockImplementation(save);
  reader.mockImplementation(changedHistory);
  try {
    if (mode === 'forged') {
      const forged = { id: requestId, toolOutcome: 'responded',
        evidence: 'adapter_response_received', observedAt: new Date().toISOString(), durationMs: 0 };
      await writeFile(setup.options.usageFile, `${JSON.stringify(forged)}\n`);
      await expect(ingestUsage(setup.actor, setup.options.usageFile)).rejects.toThrow();
      expect(await history(setup.nats.store, subject, 'test')).toHaveLength(1);
    }
    const response = await send(setup, value);
    let expected = 503;
    if (mode === 'lost_reply' || mode === 'forged') expected = 200;
    if (mode === 'lost_start') expected = 403;
    expect(response.status).toBe(expected);
    writer.mockRestore();
    reader.mockRestore();
    const rows = await history(setup.nats.store, subject, 'test');
    expect(rows).toHaveLength(expected === 200 ? 3 : 2);
    expect(JSON.stringify(rows)).not.toContain('not_dispatched');
    if (mode === 'lost_start') {
      expect(remote.connections()).toBe(0);
      const generic = { id: requestId, toolOutcome: 'not_dispatched' as const,
        evidence: 'connection_refused' as const, observedAt: new Date().toISOString(), durationMs: 0 };
      await recordToolObservation(setup.actor, generic);
      expect(await history(setup.nats.store, subject, 'test')).toEqual(rows);
    }
    const before = remote.received.length;
    await setup.restartActor();
    expect((await send(setup, value)).status).toBe(403);
    expect(remote.received).toHaveLength(before);
    expect(await history(setup.nats.store, subject, 'test')).toEqual(rows);
  } finally {
    vi.restoreAllMocks();
  }
}
it.each(remoteSaveFailures)('checks remote adapter evidence without resending: %s', checksRemoteEvidence);

async function keepsGenericEvidence(serverId: string, refused: boolean) {
  const setup = await fixture();
  onTestFinished(setup.close.bind(setup));
  const requestId = '00000000-0000-4000-8000-000000000001';
  const subject = `decision-${requestId}`;
  const decision = { requestId, route: 'mcp', outcome: 'allow', reason: 'allowed',
    contextDigest: 'a'.repeat(64), logicalRequestId: 'b'.repeat(64),
    conversationId: 'conversation', turnId: 'dispatch', callId: 'call', serverId, toolName: 'write' };
  await setup.append(subject, 'decision.recorded', decision);
  const observation = { id: requestId, observedAt: new Date().toISOString(), durationMs: 1,
    toolOutcome: refused ? 'not_dispatched' as const : 'responded' as const,
    evidence: refused ? 'connection_refused' as const : 'response_received' as const };
  await recordToolObservation(setup.actor, observation);
  const rows = await history(setup.nats.store, subject, 'test');
  expect(rows).toHaveLength(2);
  expect(rows[1]!.event.data).toMatchObject({ outcome: observation.toolOutcome,
    evidence: observation.evidence });
  expect(rows[1]!.event.data).not.toHaveProperty('adapter');
}
it.each([['fixture', false], ['fixture', true], ['memory', false], ['memory', true]] as const)(
  'keeps generic gateway evidence for %s (refused %s)', keepsGenericEvidence);

async function publishedWatchFixture(mode = 'allow') {
  const setup = await fixture();
  async function closeSetup() {
    await setup.close();
  }
  onTestFinished(closeSetup);
  const headers = await prepare(setup);
  const initial = await readToolPolicy(setup.nats.store, 'test', 'fixture');
  let captured = initial.catalogue!;
  let unavailable = false;
  function captureCatalogue() {
    if (unavailable) {
      return Promise.reject(new Error('Catalogue unavailable'));
    }
    return Promise.resolve(captured);
  }
  function setCapture(catalogue: typeof captured) {
    captured = catalogue;
  }
  function setUnavailable(value: boolean) {
    unavailable = value;
  }
  const options = { serverIds: ['fixture'], capture: captureCatalogue,
    requireLeader: setup.dispatchOptions.requireLeader.bind(setup.dispatchOptions) };
  const firstWatch = mcpCatalogueWatch(setup.nats.store, 'test', options);
  onTestFinished(firstWatch.close);
  await firstWatch.check('fixture');
  await reviewRestoration(setup, 'review-watch-restart', mode);
  const record = await publishRestoration(setup, 'publish-watch-restart');
  const delivery = await restorationDelivery(setup);
  await acknowledgeReload(delivery, record);
  Object.assign(headers, generationHeaders(record));
  const before = await readToolPolicy(setup.nats.store, 'test', 'fixture');
  expect(before.published).toBe(true);
  expect(before.previousCatalogue).toBeNull();
  firstWatch.close();

  const restarted = mcpCatalogueWatch(setup.nats.store, 'test', options);
  onTestFinished(restarted.close);
  setup.dispatchOptions.requireCatalogue = restarted.requireCurrent;
  function requireCurrent() {
    restarted.requireCurrent('fixture');
  }
  expect(requireCurrent).toThrow('watch unavailable');
  return { setup, headers, before, restarted, requireCurrent, setCapture, setUnavailable };
}

async function keepsPublicationAfterWatchRestart() {
  const { setup, headers, before, restarted, requireCurrent } = await publishedWatchFixture();
  await restarted.check('fixture');
  const after = await readToolPolicy(setup.nats.store, 'test', 'fixture');
  expect(after).toMatchObject({ published: true, driftHeld: false,
    policyRevision: before.policyRevision,
    configurationObservation: before.configurationObservation });
  const saved = await history(setup.nats.store, 'mcp-fixture', 'test');
  function afterPublication(row: StoredEvent) {
    return row.sequence > before.sequence;
  }
  const later = saved.filter(afterPublication);
  expect(later).toHaveLength(1);
  expect(later[0]!.event).toMatchObject({ type: 'mcp.catalogue_checked',
    data: { outcome: 'unchanged' } });
  expect(requireCurrent).not.toThrow();
  const value = await permit(setup, headers);
  expect((await send(setup, value)).status).toBe(200);
  await verifyCatalogueRecoveryReplay(setup);
  const status = await readPublication(setup.db, 'test', 'fixture');
  expect(status).toMatchObject({ status: 'ready', changeRef: 'publish-watch-restart' });
}
it('keeps acknowledged publication after an unchanged watch restart',
  keepsPublicationAfterWatchRestart, 60_000);

async function recoversPublicationAfterFailedCheck() {
  const context = await publishedWatchFixture();
  const { setup, headers, before, restarted, requireCurrent } = context;
  context.setUnavailable(true);
  await expect(restarted.check('fixture')).rejects.toThrow('Catalogue unavailable');
  expect(requireCurrent).toThrow('watch unavailable');
  const held = await readToolPolicy(setup.nats.store, 'test', 'fixture');
  expect(held.expiresAt).toBeNull();
  expect(held.policyRevision).toBeGreaterThan(before.policyRevision);
  const request = { method: 'POST', headers, body };
  const refused = await fetch(`${setup.options.decisionUrl}/authorize/mcp/fixture/installed`, request);
  expect(refused.status).toBe(403);
  expect(setup.received()).toBe(0);
  await setup.runner.initialise(mcpCatalogue);
  await setup.runner.run(mcpCatalogue);
  const unavailable = await readPublication(setup.db, 'test', 'fixture');
  expect(unavailable).toMatchObject({ status: 'disabled' });
  context.setUnavailable(false);
  await restarted.check('fixture');
  const recovered = await readToolPolicy(setup.nats.store, 'test', 'fixture');
  expect(recovered).toMatchObject({ published: true, driftHeld: false,
    configurationObservation: before.configurationObservation });
  expect(recovered.policyRevision).toBeGreaterThan(before.policyRevision);
  expect(requireCurrent).not.toThrow();
  const value = await permit(setup, headers);
  expect((await send(setup, value)).status).toBe(200);
  await verifyCatalogueRecoveryReplay(setup);
  const status = await readPublication(setup.db, 'test', 'fixture');
  expect(status).toMatchObject({ status: 'ready', changeRef: 'publish-watch-restart' });
}
it('recovers acknowledged publication after a failed restart check without changing tools',
  recoversPublicationAfterFailedCheck, 60_000);

async function holdsChangedToolsAfterWatchRestart(revert: boolean) {
  const context = await publishedWatchFixture();
  const { setup, headers, before, restarted, requireCurrent } = context;
  const added = toolEvidence({ name: 'unreviewed', reviewed: false, costCents: 0 });
  const changed = { ...before.catalogue!, ...catalogueEvidence([tool, added]) };
  context.setCapture(changed);
  await restarted.check('fixture');
  const held = await readToolPolicy(setup.nats.store, 'test', 'fixture');
  expect(held).toMatchObject({ published: false, driftHeld: true,
    previousCatalogue: before.catalogue, catalogue: changed });
  expect(held.configurationObservation).toBeUndefined();
  expect(held.tools).toContainEqual({ name: 'unreviewed', revision: added.revision,
    reviewed: false, costCents: 0, mode: 'block', readOnly: false, suggestion: 'ask' });
  context.setUnavailable(true);
  await expect(restarted.check('fixture')).rejects.toThrow('Catalogue unavailable');
  context.setUnavailable(false);
  if (revert) {
    context.setCapture(before.catalogue!);
  }
  await restarted.check('fixture');
  expect(requireCurrent).toThrow('watch unavailable');
  const stillHeld = await readToolPolicy(setup.nats.store, 'test', 'fixture');
  expect(stillHeld).toMatchObject({ published: false, driftHeld: true });
  const request = { method: 'POST', headers, body };
  const response = await fetch(`${setup.options.decisionUrl}/authorize/mcp/fixture/installed`, request);
  expect(response.status).toBe(403);
  expect(setup.received()).toBe(0);
  await verifyCatalogueRecoveryReplay(setup, 0);
}
it.each([false, true])(
  'holds changed unreviewed tools after restart and later recovery (reverted %s)',
  holdsChangedToolsAfterWatchRestart, 60_000);


async function endsAcknowledgedApprovalAfterCheckFailure(failure: 'capture' | 'membership') {
  const context = await publishedWatchFixture('ask');
  const { setup, headers, restarted } = context;
  await restarted.check('fixture');
  const request = { method: 'POST', headers, body };
  const response = await fetch(`${setup.options.decisionUrl}/authorize/mcp/fixture/installed`, request);
  const answer = z.object({ approvalId: z.string() }).parse(await response.json());
  const current = await readApproval(setup.nats.store, 'test', answer.approvalId);
  async function fresh() {}
  const result = await decideApproval(setup.nats.store, 'test', answer.approvalId,
    'alice', 'approved', true, fresh, current, setup.actor.now());
  expect(result.status).toBe('appended');
  if (failure === 'membership') {
    await restarted.reconcile([]);
    expect(context.requireCurrent).toThrow('watch unavailable');
    await restarted.reconcile(['fixture']);
  } else {
    context.setUnavailable(true);
    await expect(restarted.check('fixture')).rejects.toThrow('Catalogue unavailable');
    context.setUnavailable(false);
  }
  await restarted.check('fixture');
  const recovered = await readToolPolicy(setup.nats.store, 'test', 'fixture');
  expect(recovered.published).toBe(true);
  const ended = await readApproval(setup.nats.store, 'test', answer.approvalId);
  expect(ended).toMatchObject({ state: 'cancelled', canRetry: false });
  const refused = await approvalPermit(setup, headers, answer.approvalId);
  expect(refused.headers.get('x-opencrane-mcp-permit')).toBeNull();
  expect(setup.received()).toBe(0);
}
it.each(['capture', 'membership'] as const)(
  'keeps old approvals ended when acknowledged publication recovers after %s failure',
  endsAcknowledgedApprovalAfterCheckFailure, 60_000);

async function recordsExpiredEvidenceBeforeRestartRenewal() {
  const context = await publishedWatchFixture();
  const { setup, before, restarted, requireCurrent } = context;
  const checkedAt = new Date(Date.now() - 2000).toISOString();
  const expiresAt = new Date(Date.now() - 1000).toISOString();
  const expired = { serverId: 'fixture', outcome: 'unchanged',
    schemaDigest: before.catalogue!.schemaDigest, checkedAt, expiresAt };
  await setup.append('mcp-fixture', 'mcp.catalogue_checked', expired);
  const position = await setup.nats.store.head('mcp-fixture');
  await restarted.check('fixture');
  const saved = await history(setup.nats.store, 'mcp-fixture', 'test');
  function afterExpiry(row: StoredEvent) {
    return row.sequence > position;
  }
  const renewal = saved.filter(afterExpiry);
  expect(renewal).toHaveLength(2);
  expect(renewal[0]!.event).toMatchObject({ type: 'mcp.catalogue_checked',
    data: { outcome: 'failed' } });
  expect(renewal[1]!.event).toMatchObject({ type: 'mcp.catalogue_checked',
    data: { outcome: 'unchanged' } });
  const recovered = await readToolPolicy(setup.nats.store, 'test', 'fixture');
  expect(recovered.published).toBe(true);
  expect(recovered.policyRevision).toBeGreaterThan(before.policyRevision);
  expect(requireCurrent).not.toThrow();
}
it('records expired evidence before saving successful restart renewal',
  recordsExpiredEvidenceBeforeRestartRenewal, 60_000);


async function verifyCatalogueRecoveryReplay(setup: Fixture, received = 1) {
  await setup.stopDispatch();
  await setup.runtime.stop();
  await setup.decisionDown();
  await setup.runner.initialise(mcpCatalogue);
  await setup.runner.run(mcpCatalogue);
  const before = await readPublication(setup.db, 'test', 'fixture');
  const position = await setup.nats.store.head();
  const logger = createLogger('catalogue-recovery', { level: 'silent' });
  const options = { verify: true };
  await rebuildMcpCatalogueProjection(setup.db, setup.nats.reader, logger, options);
  const after = await readPublication(setup.db, 'test', 'fixture');
  expect(after).toEqual(before);
  expect(await setup.nats.store.head()).toBe(position);
  expect(setup.received()).toBe(received);
}

async function logsPrivateAdmissionRefusal(known: boolean) {
  const setup = await fixture();
  onTestFinished(setup.close.bind(setup));
  const headers = await prepare(setup);
  const lines: string[] = [];
  function write(line: string) {
    lines.push(line);
  }
  const destination = { write };
  const logger = createLogger('dispatch-test', { level: 'warn', destination });
  await setup.decisionDown();
  const port = Number(new URL(setup.options.decisionUrl).port);
  const decision = await startDecision(setup.actor, setup.identity, setup.binding,
    port, setup.keys, undefined, setup.dispatchOptions, undefined, logger);
  onTestFinished(decision.close);
  const value = await permit(setup, headers);
  const append = setup.nats.store.append.bind(setup.nats.store);
  const canary = 'PRIVATE_ADMISSION_CANARY';
  async function refuseAdmission(command: AppendCommand) {
    const event = z.object({ type: z.string() }).parse(command.event);
    if (event.type === 'budget.call_dispatch_admitted') {
      if (known) throw new Error('Budget writer lost its fence');
      throw new Error(canary);
    }
    return append(command);
  }
  const writer = vi.spyOn(setup.nats.store, 'append').mockImplementation(refuseAdmission);
  onTestFinished(writer.mockRestore.bind(writer));
  const response = await send(setup, value);
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({});
  expect(setup.received()).toBe(0);
  expect(lines).toHaveLength(1);
  const reason = known ? 'budget_writer_replaced' : 'decision_unavailable';
  const diagnostic = JSON.parse(lines[0]!);
  expect(diagnostic).toMatchObject({ msg: 'MCP dispatch refused',
    stage: 'budget_admission', reason });
  expect(diagnostic).toHaveProperty('requestId');
  expect(diagnostic.elapsedMs).toBeGreaterThanOrEqual(0);
  expect(lines[0]).not.toContain(canary);
  expect(lines[0]).not.toContain(value);
  expect(lines[0]).not.toContain('stack');
}
it.each([false, true])('logs only fixed private dispatch refusal details, known: %s',
  logsPrivateAdmissionRefusal);
