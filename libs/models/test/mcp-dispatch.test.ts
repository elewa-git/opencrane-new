import type { AppendCommand } from '@opencrane/event-store';
import { setTimeout as pause } from 'node:timers/promises';
import { z } from 'zod';
import { expect, it, vi } from 'vitest';
import { grantStream } from '@opencrane/authz';
import { readToolPolicy, setToolPolicy } from '../src/index.ts';
import { catalogueEvidence, fixture, toolEvidence } from './fixture.ts';
import capture from './fixtures/codex-0.159.2-tools-call.json' with { type: 'json' };

type Fixture = Awaited<ReturnType<typeof fixture>>;
const tool = toolEvidence({ name: 'write', reviewed: true, costCents: 0 });
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
  const publication = { serverId: 'fixture', publishedBy: 'alice' };
  await setup.append('mcp-fixture', 'mcp.server_published', publication);
  const mode = { serverId: 'fixture', connectionId: 'installed', toolName: 'write',
    toolRevision: tool.revision, mode: 'allow', setBy: 'alice' };
  await setup.append('mcp-fixture', 'mcp.tool_mode_set', mode);
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

const blockPoints = ['first policy read', 'access read', 'terminating read or admission'] as const;
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
