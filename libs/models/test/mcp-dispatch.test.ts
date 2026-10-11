import { setTimeout as pause } from 'node:timers/promises';
import { z } from 'zod';
import { expect, it } from 'vitest';
import { grantStream } from '@opencrane/authz';
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
      const decoded: unknown = JSON.parse(Buffer.from(encoded!, 'base64url').toString());
      const binding = z.record(z.string(), z.unknown()).parse(decoded);
      binding['silo'] = 'other';
      const substituted = Buffer.from(JSON.stringify(binding)).toString('base64url');
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
