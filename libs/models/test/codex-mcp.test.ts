import { expect, it } from 'vitest';
import { grantStream } from '@opencrane/authz';
import { history } from '../src/index.ts';
import { fixture } from './fixture.ts';
import capture from './fixtures/codex-0.159.2-tools-call.json' with { type: 'json' };

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function prepareCapturedCall(setup: Fixture) {
  const registration = { serverId: 'fixture', kind: 'remote',
    locator: 'https://fixture.example.test/mcp', registeredBy: 'alice' };
  await setup.append('mcp-fixture', 'mcp.server_registered', registration);
  const tool = { name: 'write', revision: 'a'.repeat(64), reviewed: true, costCents: 0 };
  const discovery = { serverId: 'fixture', connectionId: 'installed', accountMode: 'none',
    schemaDigest: 'a'.repeat(64), toolCount: 1, tools: [tool] };
  await setup.append('mcp-fixture', 'mcp.server_discovered', discovery);
  const publication = { serverId: 'fixture', publishedBy: 'alice' };
  await setup.append('mcp-fixture', 'mcp.server_published', publication);
  for (const [granteeId, granteeKind] of [['alice', 'member'], ['assistant', 'assistant']]) {
    const grant = { resourceType: 'mcp_server', resourceId: 'fixture',
      granteeId, granteeKind, grantedBy: 'alice' };
    const event = await setup.append(grantStream('mcp_server', 'fixture'), 'grant.given', grant);
    await setup.auth.handler.handle(event, setup.db);
  }
  const mode = { serverId: 'fixture', connectionId: 'installed', toolName: 'write',
    toolRevision: 'a'.repeat(64), mode: 'allow', setBy: 'alice' };
  await setup.append('mcp-fixture', 'mcp.tool_mode_set', mode);
  const threadId = capture.body.params._meta.threadId;
  const turn = { assistantId: 'assistant', computerId: 'computer',
    conversationId: 'conversation', turnId: 'captured-turn', threadId,
    requesterId: 'alice', task: 'chat_turn', payingGroupId: 'personal-default' };
  await setup.append('computer-assistant', 'computer.turn_started', turn);
  const started = { conversationId: 'conversation', assistantId: 'assistant',
    turnId: 'captured-turn' };
  await setup.append('conversation-conversation', 'agent.turn_started', started);
  const claims = { ...setup.t, turn: 'captured-turn', thread: threadId };
  const token = await setup.sign(claims, 'decision-service');
  return { ...setup.headers, ...capture.headers, 'session-id': threadId, 'x-turn-token': token };
}

async function admitsCapturedCall() {
  const setup = await fixture();
  try {
    const headers = await prepareCapturedCall(setup);
    const request = { method: 'POST', headers, body: JSON.stringify(capture.body) };
    const response = await fetch(`${setup.options.decisionUrl}/authorize/mcp/fixture/installed`,
      request);
    expect(response.status, await response.text()).toBe(200);
  } finally {
    await setup.close();
  }
}
it('admits the captured Codex tool call through the decision HTTP route', admitsCapturedCall);

async function refusesDifferentThread(field: 'threadId' | 'metadata') {
  const setup = await fixture();
  try {
    const headers = await prepareCapturedCall(setup);
    const body = structuredClone(capture.body);
    if (field === 'threadId') {
      body.params._meta.threadId = 'another-thread';
    } else {
      body.params._meta['x-codex-turn-metadata'].thread_id = 'another-thread';
    }
    const request = { method: 'POST', headers, body: JSON.stringify(body) };
    const response = await fetch(`${setup.options.decisionUrl}/authorize/mcp/fixture/installed`,
      request);
    expect(response.status, await response.text()).toBe(403);
    const requestId = response.headers.get('x-request-id');
    const rows = await history(setup.nats.store, `decision-${requestId}`, 'test');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.event.data).toMatchObject({ outcome: 'deny', callId: 'call_probe_1' });
    expect(setup.actor.state.reservations).toHaveLength(0);
  } finally {
    await setup.close();
  }
}
const threadFields = ['threadId', 'metadata'] as const;
it.each(threadFields)('refuses a %s thread that differs from the signed turn token',
  refusesDifferentThread);

async function forwardsCapturedCall() {
  const setup = await fixture();
  try {
    const headers = await prepareCapturedCall(setup);
    const request = { method: 'POST', headers, body: JSON.stringify(capture.body) };
    const response = await fetch(`http://127.0.0.1:${setup.options.port}/mcp/fixture/installed`,
      request);
    expect(response.status, await response.text()).toBe(200);
    expect(setup.upstreamBody()).toBe(request.body);
    expect(setup.providerHeaders()).toContain('mcp-name');
    expect(setup.providerRequests()[0]?.mcpName).toBe('write');
    for (const privateHeader of ['authorization', 'x-turn-token', 'session-id', 'mcp-tool-name']) {
      expect(setup.providerHeaders()).not.toContain(privateHeader);
    }
    expect(setup.received()).toBe(1);
  } finally {
    await setup.close();
  }
}
it('forwards captured Codex bytes through the real gateway with only public MCP headers',
  forwardsCapturedCall);

async function recordsCallId() {
  const setup = await fixture();
  try {
    const headers = await prepareCapturedCall(setup);
    const request = { method: 'POST', headers, body: JSON.stringify(capture.body) };
    const response = await fetch(`${setup.options.decisionUrl}/authorize/mcp/fixture/installed`,
      request);
    expect(response.status, await response.text()).toBe(200);
    const requestId = response.headers.get('x-request-id');
    const rows = await history(setup.nats.store, `decision-${requestId}`, 'test');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.event.data).toMatchObject({ callId: 'call_probe_1' });
  } finally {
    await setup.close();
  }
}
it('records the captured call id on its admission decision', recordsCallId);

const invalidMetadata: [string, Record<string, unknown>][] = [
  ['missing threadId', { threadId: undefined }],
  ['missing callId', { callId: undefined }],
  ['long threadId', { threadId: 't'.repeat(201) }],
  ['long callId', { callId: 'c'.repeat(201) }],
  ['empty threadId', { threadId: '' }],
  ['empty callId', { callId: '' }],
  ['unknown key', { unexpected: true }],
  ['wrong version', { 'io.modelcontextprotocol/protocolVersion': '2025-06-18' }],
  ['missing version', { 'io.modelcontextprotocol/protocolVersion': undefined }],
  ['missing capabilities', { 'io.modelcontextprotocol/clientCapabilities': undefined }],
  ['array capabilities', { 'io.modelcontextprotocol/clientCapabilities': [] }],
  ['oversized capabilities', { 'io.modelcontextprotocol/clientCapabilities':
    { large: 'x'.repeat(16_384) } }],
  ['fractional progress', { progressToken: 1.5 }],
  ['nested turn metadata', { 'x-codex-turn-metadata': { thread_id: {} } }],
  ['oversized turn metadata', { 'x-codex-turn-metadata':
    Object.fromEntries(Array.from({ length: 33 }, metadataEntry)) }],
];
function metadataEntry(_unused: unknown, index: number): [string, boolean] {
  return [`key${index}`, true];
}

async function assertRefused(setup: Fixture, headers: Record<string, string>,
  body: string, label: string) {
  const request = { method: 'POST', headers, body };
  const response = await fetch(`${setup.options.decisionUrl}/authorize/mcp/fixture/installed`,
    request);
  expect(response.status, label).toBe(403);
  await response.text();
  const requestId = response.headers.get('x-request-id');
  const rows = await history(setup.nats.store, `decision-${requestId}`, 'test');
  expect(rows, label).toHaveLength(1);
  expect(rows[0]?.event.data, label).toMatchObject({ outcome: 'deny', route: 'mcp' });
  expect(setup.actor.state.reservations, label).toHaveLength(0);
  expect(setup.received(), label).toBe(0);
}

async function refusesInvalidWireInput() {
  const setup = await fixture();
  try {
    const headers = await prepareCapturedCall(setup);
    for (const [label, patch] of invalidMetadata) {
      const params = { ...capture.body.params, _meta: { ...capture.body.params._meta, ...patch } };
      const call = { ...capture.body, params };
      const body = JSON.stringify(call);
      await assertRefused(setup, headers, body, label);
    }
    const { _meta, ...parameters } = capture.body.params;
    const oldBody = { ...capture.body, params: parameters, _meta: {
      'io.modelcontextprotocol/protocol-version': '2026-07-28',
      'io.modelcontextprotocol/client-capabilities': {},
    } };
    const legacyHeaders = { ...headers, 'mcp-tool-name': 'write' };
    await assertRefused(setup, legacyHeaders, JSON.stringify(oldBody), 'old top-level metadata');
    const raw = JSON.stringify(capture.body);
    const invalidBodies: [string, string][] = [
      ['batch', `[${raw}]`],
      ['duplicate name', raw.replace('"name":"write"', '"name":"write","name":"write"')],
      ['forbidden argument', raw.replace('"order":', '"__proto__":')],
      ['unknown method', raw.replace('tools/call', 'tools/list')],
      ['oversized request', raw.replace('SO-1042', 'x'.repeat(1_048_576))],
    ];
    for (const [label, body] of invalidBodies) {
      await assertRefused(setup, headers, body, label);
    }
    const invalidHeaders = [
      { 'mcp-name': 'read' }, { 'mcp-name': '' }, { 'mcp-method': 'tools/list' },
      { 'mcp-protocol-version': '2025-06-18' }, { 'mcp-protocol-version': '' },
    ];
    for (const patch of invalidHeaders) {
      const patchedHeaders = { ...headers, ...patch };
      await assertRefused(setup, patchedHeaders, raw, JSON.stringify(patch));
    }
  } finally {
    await setup.close();
  }
}
it('refuses invalid MCP wire input and records each refusal without holding money',
  refusesInvalidWireInput);

async function refusesOtherSignedContext() {
  const setup = await fixture();
  try {
    const headers = await prepareCapturedCall(setup);
    const otherConversation = { conversationId: 'another-conversation',
      assistantId: 'assistant', createdBy: 'alice', mode: 'agent_session' };
    await setup.append('conversation-another-conversation', 'conversation.created',
      otherConversation);
    const otherStart = { conversationId: 'another-conversation', assistantId: 'assistant',
      turnId: 'captured-turn' };
    await setup.append('conversation-another-conversation', 'agent.turn_started', otherStart);
    const raw = JSON.stringify(capture.body);
    const base = { ...setup.t, turn: 'captured-turn', thread: capture.body.params._meta.threadId };
    for (const patch of [
      { turn: 'another-turn' }, { conversation: 'another-conversation' }, { thread: 'another-thread' },
    ]) {
      const claims = { ...base, ...patch };
      const token = await setup.sign(claims, 'decision-service');
      const requestHeaders = { ...headers, 'x-turn-token': token, 'session-id': claims.thread };
      const body = structuredClone(capture.body);
      body.params._meta.threadId = claims.thread;
      body.params._meta['x-codex-turn-metadata'].thread_id = claims.thread;
      await assertRefused(setup, requestHeaders, JSON.stringify(body), JSON.stringify(patch));
    }
    const computer = { ...setup.c, computer: 'another-computer' };
    const token = await setup.sign(computer, 'agentgateway');
    const computerHeaders = { ...headers, authorization: `Bearer ${token}` };
    await assertRefused(setup, computerHeaders, raw, 'another computer');
  } finally {
    await setup.close();
  }
}
it('refuses calls for another signed thread, turn, conversation or computer',
  refusesOtherSignedContext);
