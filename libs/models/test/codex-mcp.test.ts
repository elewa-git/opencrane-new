import { setTimeout as pause } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { z } from 'zod';
import { conversations, readConversation } from '@opencrane/projections';
import { grantStream } from '@opencrane/authz';
import { approvalCards, decideApproval, history, readApproval } from '../src/index.ts';
import { fixture } from './fixture.ts';
import capture from './fixtures/codex-0.159.2-tools-call.json' with { type: 'json' };

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function prepareCapturedCall(setup: Fixture, toolMode: 'allow' | 'ask' = 'allow') {
  const registration = { serverId: 'fixture', kind: 'remote',
    locator: 'https://fixture.example.test/mcp', registeredBy: 'alice' };
  await setup.append('mcp-fixture', 'mcp.server_registered', registration);
  const review = { action: 'Write note', consequence: 'The order note changes.',
    targetArgument: 'order', fields: ['order', 'note'], stepUp: false };
  const tool = { name: 'write', revision: 'a'.repeat(64), reviewed: true, costCents: 0, review };
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
    toolRevision: 'a'.repeat(64), mode: toolMode, setBy: 'alice' };
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
    const capturedHeaders = await prepareCapturedCall(setup);
    const headers = { ...capturedHeaders, 'mcp-tool-name': 'read',
      'x-memory-context': 'caller-context-must-not-leave' };
    const request = { method: 'POST', headers, body: JSON.stringify(capture.body) };
    const response = await fetch(`http://127.0.0.1:${setup.options.port}/mcp/fixture/installed`,
      request);
    expect(response.status, await response.text()).toBe(200);
    expect(setup.upstreamBody()).toBe(request.body);
    expect(setup.providerHeaders()).toContain('mcp-name');
    expect(setup.providerRequests()[0]?.mcpName).toBe('write');
    for (const privateHeader of ['authorization', 'x-turn-token', 'session-id', 'mcp-tool-name',
      'x-memory-context']) {
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
  ['long sessionId', { sessionId: 's'.repeat(201) }],
  ['long itemId', { itemId: 'i'.repeat(201) }],
  ['long windowId', { windowId: 'w'.repeat(403) }],
  ['long progressToken', { progressToken: 'p'.repeat(201) }],
  ['long client name', { 'io.modelcontextprotocol/clientInfo':
    { name: 'n'.repeat(201), version: '1' } }],
  ['long client version', { 'io.modelcontextprotocol/clientInfo':
    { name: 'Codex', version: 'v'.repeat(201) } }],
  ['long client title', { 'io.modelcontextprotocol/clientInfo':
    { name: 'Codex', version: '1', title: 't'.repeat(201) } }],
  ['unknown client info key', { 'io.modelcontextprotocol/clientInfo':
    { name: 'Codex', version: '1', unexpected: true } }],
  ['too many capabilities', { 'io.modelcontextprotocol/clientCapabilities':
    Object.fromEntries(Array.from({ length: 33 }, metadataEntry)) }],
  ['long turn metadata key', { 'x-codex-turn-metadata': { ['k'.repeat(201)]: true } }],
  ['long turn metadata value', { 'x-codex-turn-metadata': { model: 'm'.repeat(2001) } }],
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
    const invalidObjects = [
      { ...capture.body, params: { ...capture.body.params, unexpected: true } },
      { ...capture.body, params: { ...capture.body.params, name: 'n'.repeat(201) } },
      { ...capture.body, id: 'i'.repeat(201) },
    ];
    for (const body of invalidObjects) {
      await assertRefused(setup, headers, JSON.stringify(body), 'invalid request object');
    }
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

const unsafeCallIds = ['call\u0000', 'call\u202e'];

async function refusesUnsafeCallId(callId: string) {
  const setup = await fixture();
  try {
    const headers = await prepareCapturedCall(setup);
    await setup.runner.initialise(conversations);
    await setup.runner.run(conversations);
    const body = structuredClone(capture.body);
    body.params._meta.callId = callId;
    body.params._meta.threadId = 'another-thread';
    const request = { method: 'POST', headers, body: JSON.stringify(body) };
    const response = await fetch(`${setup.options.decisionUrl}/authorize/mcp/fixture/installed`,
      request);
    expect(response.status, await response.text()).toBe(403);
    const requestId = response.headers.get('x-request-id');
    const rows = await history(setup.nats.store, `decision-${requestId}`, 'test');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.event.data).toMatchObject({ outcome: 'deny', route: 'mcp' });
    expect(rows[0]?.event.data).not.toHaveProperty('callId');
    await setup.runner.run(conversations);
    const feed = await readConversation(setup.db, 'test', 'conversation');
    expect(feed.rows.at(-1)?.data).toEqual({ turnId: 'captured-turn', outcome: 'deny',
      reason: 'request_refused', requestId });
    const completed = { conversationId: 'conversation', turnId: 'captured-turn' };
    await setup.append('conversation-conversation', 'agent.turn_completed', completed);
    await setup.runner.run(conversations);
    const continued = await readConversation(setup.db, 'test', 'conversation');
    expect(continued.rows.at(-1)?.type).toBe('agent.turn_completed');
    await setup.runner.rebuild(conversations);
    const rebuilt = await readConversation(setup.db, 'test', 'conversation');
    expect(rebuilt.rows).toEqual(continued.rows);
  } finally {
    await setup.close();
  }
}
it.each(unsafeCallIds)('refuses unsafe call id %j without stopping the conversation feed',
  refusesUnsafeCallId);

async function refusesEmptyMetadataField(field: 'sessionId' | 'itemId' | 'windowId') {
  const setup = await fixture();
  try {
    const headers = await prepareCapturedCall(setup);
    const metadata = { ...capture.body.params._meta, [field]: '' };
    const params = { ...capture.body.params, _meta: metadata };
    const body = { ...capture.body, params };
    await assertRefused(setup, headers, JSON.stringify(body), `empty ${field}`);
  } finally {
    await setup.close();
  }
}
async function refusesEmptySessionId() {
  await refusesEmptyMetadataField('sessionId');
}
it('refuses an empty sessionId', refusesEmptySessionId);

async function refusesEmptyItemId() {
  await refusesEmptyMetadataField('itemId');
}
it('refuses an empty itemId', refusesEmptyItemId);

async function refusesDuplicateToolHeader(testCase: { names: string[] }) {
  const setup = await fixture();
  try {
    const capturedHeaders = await prepareCapturedCall(setup);
    const headers = { ...capturedHeaders, 'mcp-name': testCase.names };
    const url = `http://127.0.0.1:${setup.options.port}/mcp/fixture/installed`;
    const options = { method: 'POST', headers };
    const body = JSON.stringify(capture.body);
    function sendRequest(resolve: (response: IncomingMessage) => void,
      reject: (error: Error) => void) {
      const request = httpRequest(url, options, resolve);
      request.on('error', reject);
      request.end(body);
    }
    const response = await new Promise<IncomingMessage>(sendRequest);
    for await (const _chunk of response) {
      // Drain the reply before closing the disposable gateway.
    }
    expect(response.statusCode).toBe(403);
    expect(setup.received()).toBe(0);
    const requestId = z.string().parse(response.headers['x-request-id']);
    const rows = await history(setup.nats.store, `decision-${requestId}`, 'test');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.event.data).toMatchObject({ outcome: 'deny', route: 'mcp' });
  } finally {
    await setup.close();
  }
}
const duplicateToolHeaders = [
  { names: ['write', 'read'] }, { names: ['read', 'write'] }, { names: ['write', 'write'] },
];
it.each(duplicateToolHeaders)(
  'refuses duplicate mcp-name headers $names through the real gateway before forwarding',
  refusesDuplicateToolHeader);

async function preservesApprovalForWrongThread(field: 'threadId' | 'metadata') {
  const setup = await fixture();
  try {
    const headers = await prepareCapturedCall(setup, 'ask');
    const url = `${setup.options.decisionUrl}/authorize/mcp/fixture/installed`;
    const request = { method: 'POST', headers, body: JSON.stringify(capture.body) };
    const asked = await fetch(url, request);
    expect(asked.status).toBe(403);
    const approval = z.object({ approvalId: z.string() }).parse(await asked.json());
    function currentAccess() {
      return Promise.resolve();
    }
    const current = await readApproval(setup.nats.store, 'test', approval.approvalId);
    const approved = await decideApproval(setup.nats.store, 'test', approval.approvalId,
      'alice', 'approved', true, currentAccess, current, setup.actor.now());
    expect(approved.status).toBe('appended');
    const body = structuredClone(capture.body);
    if (field === 'threadId') {
      body.params._meta.threadId = 'another-thread';
    } else {
      body.params._meta['x-codex-turn-metadata'].thread_id = 'another-thread';
    }
    await assertRefused(setup, headers, JSON.stringify(body), `wrong ${field} with approval`);
    const rows = await history(setup.nats.store, `approval-${approval.approvalId}`, 'test');
    function isApprovalUsed(row: (typeof rows)[number]) {
      return row.event.type === 'approval.used';
    }
    expect(rows.some(isApprovalUsed)).toBe(false);
    const remaining = await readApproval(setup.nats.store, 'test', approval.approvalId);
    expect(remaining.state).toBe('approved');
    const retried = await fetch(url, request);
    expect(retried.status, await retried.text()).toBe(200);
    const used = await history(setup.nats.store, `approval-${approval.approvalId}`, 'test');
    const uses = used.filter(isApprovalUsed);
    expect(uses).toHaveLength(1);
  } finally {
    await setup.close();
  }
}
it.each(threadFields)('preserves an approved Ask request when %s names another thread',
  preservesApprovalForWrongThread);

async function refusesEmptyWindowId() {
  await refusesEmptyMetadataField('windowId');
}
it('refuses an empty windowId', refusesEmptyWindowId);

async function bindsHeldApproval(change: string) {
  const setup = await fixture();
  try {
    const base = await prepareCapturedCall(setup, 'ask');
    const headers = { ...base, 'x-opencrane-tool-mode': 'ask' };
    const options = { method: 'POST', headers, body: JSON.stringify(capture.body) };
    const url = `http://127.0.0.1:${setup.options.port}/mcp/fixture/installed`;
    const asked = await fetch(url, options);
    const decision = z.object({ approvalId: z.string() }).parse(await asked.json());
    const current = await readApproval(setup.nats.store, 'test', decision.approvalId);
    expect(Date.parse(current.request.expiresAt) - setup.actor.now().getTime()).toBe(900_000);
    async function fresh() {
      if (change === 'decision-race') await pause(30);
    }
    if (change === 'decision-race') setup.advance(899_990);
    if (change === 'timeout') {
      setup.advance(900_001);
    }
    const approved = await decideApproval(setup.nats.store, 'test', decision.approvalId,
      'alice', 'approved', true, fresh, current, setup.actor.now());
    expect(approved.status).toBe(['timeout', 'decision-race'].includes(change) ? 'conflict' : 'appended');
    if (change === 'decision-race') {
      const rows = await history(setup.nats.store, `approval-${decision.approvalId}`, 'test');
      expect(rows.at(-1)?.event.type).toBe('approval.expired');
    }
    const retryHeaders = { ...headers, 'x-opencrane-approval-id': decision.approvalId };
    const retry = { ...options, headers: retryHeaders };
    if (change === 'wrong-id') retryHeaders['x-opencrane-approval-id'] = 'f'.repeat(64);
    if (change === 'bytes') {
      const body = structuredClone(capture.body);
      body.params.arguments.note = 'Another note';
      retry.body = JSON.stringify(body);
    }
    if (change === 'allow') {
      await setup.append('mcp-fixture', 'mcp.tool_mode_set', { serverId: 'fixture',
        connectionId: 'installed', toolName: 'write', toolRevision: 'a'.repeat(64),
        mode: 'allow', setBy: 'alice' });
    }

    const result = await fetch(url, retry);
    expect(result.status, await result.text()).toBe(change === 'same' ? 200 : 403);
    expect(setup.received()).toBe(change === 'same' ? 1 : 0);
    if (change === 'bytes' || change === 'wrong-id') {
      const cards = await approvalCards(setup.nats.store, 'test', 'conversation',
        'alice', setup.keys);
      expect(cards).toHaveLength(1);
      expect(cards[0]?.approvalId).toBe(decision.approvalId);
    }
    expect((await fetch(url, retry)).status).toBe(403);
    expect(setup.received()).toBe(change === 'same' ? 1 : 0);
  } finally { await setup.close(); }
}
it.each(['same', 'wrong-id', 'bytes', 'allow', 'timeout', 'decision-race'])(
  'uses only this held approval through the real gateway: %s', bindsHeldApproval, 40_000);
