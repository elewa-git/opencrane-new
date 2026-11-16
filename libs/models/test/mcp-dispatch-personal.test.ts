import { body, tool, permit, send, selectedPersonalFixture, requestFromPermit }
  from './support/mcp-dispatch-fixture.ts';
import { memoryScopeId } from '@opencrane/projections';
import { memoryContextRecordedEventSchema } from '@opencrane/events';
import type { AppendCommand } from '@opencrane/event-store';
import { z } from 'zod';
import { expect, it, vi } from 'vitest';
import { grantStream } from '@opencrane/authz';
import { history } from '../src/index.ts';
import { fixture } from './fixture.ts';
import capture from './fixtures/codex-0.159.2-tools-call.json' with { type: 'json' };
import { type oauthSelectionFixture, refreshPersonalFixture } from './support/oauth-selection.ts';
import { foldConnection } from '../src/bearer-connections.ts';
import { approvalPermit, approvalForReviewedTool } from './support/mcp-dispatch-assertions.ts';

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function refusesCredentialForBlockedPersonalTool() {
  const { setup, remote, headers, accessMaterialReadCount } =
    await selectedPersonalFixture('block');
  const response = await fetch(`${setup.options.decisionUrl}/authorize/mcp/fixture/installed`,
    { method: 'POST', headers, body });

  expect(response.status).toBe(403);
  expect(accessMaterialReadCount()).toBe(0);
  expect(remote.received).toHaveLength(0);
}

it('does not release a personal credential without an approved tool rule',
  refusesCredentialForBlockedPersonalTool, 60_000);

async function selectedPersonalCall() {
  const { setup, remote, headers } = await selectedPersonalFixture();
  const rejectedPermit = await permit(setup, headers);
  const malicious = { 'x-opencrane-mcp-permit': rejectedPermit,
    cookie: 'stolen-cookie', 'proxy-authorization': 'Basic forged',
    'x-api-key': 'forged-key', 'x-opencrane-profile-id': 'bob-profile',
    'content-type': 'application/json' };
  const response = await fetch(`${setup.options.decisionUrl}/dispatch/mcp/fixture/installed`,
    { method: 'POST', headers: malicious, body });
  expect(response.status).toBe(403);
  expect(remote.received).toHaveLength(0);
  const value = await permit(setup, headers);
  const requestId = requestFromPermit(value);
  expect(await setup.nats.store.head(`credential-${requestId}`)).toBe(0);
  const sent = await send(setup, value);
  expect(sent.status, await sent.text()).toBe(200);
  expect(remote.received).toHaveLength(1);
  const outbound = remote.received[0]!.headers;
  expect(outbound.authorization).toBe('Bearer alice-access');
  expect(outbound.cookie).toBeUndefined();
  expect(outbound['proxy-authorization']).toBeUndefined();
  expect(outbound['x-api-key']).toBeUndefined();
  expect(outbound['x-opencrane-profile-id']).toBeUndefined();
  const releases = await history(setup.nats.store, `credential-${requestId}`, 'test');
  expect(releases).toHaveLength(1);
  expect(releases[0]!.event.type).toBe('credential.released');
  expect((await send(setup, value)).status).toBe(403);
  expect(remote.received).toHaveLength(1);
}

it('sends one selected personal credential after a real release append',
  selectedPersonalCall, 60_000);

async function refusesForgottenLoadedMemoryAfterPermit() {
  const { setup, remote, headers } = await selectedPersonalFixture();
  const scopeId = memoryScopeId('test', 'person', 'alice');
  const resources = [['mcp_server', 'memory'], ['memory_read', scopeId]];
  for (const [resourceType, resourceId] of resources) {
    for (const [granteeKind, granteeId] of [['member', 'alice'], ['assistant', 'assistant']]) {
      const granted = await setup.append(grantStream(resourceType!, resourceId!), 'grant.given',
        { resourceType, resourceId, granteeKind, granteeId, grantedBy: 'alice' });
      await setup.auth.handler.handle(granted, setup.db);
    }
  }
  await setup.append(`scope-${scopeId}`, 'memory.written', { scopeId,
    scopeKind: 'person', ownerId: 'alice', memoryId: 'fact', revision: 1,
    schemaVersion: 1, kind: 'preference', pinned: true, expiresAt: null,
    sources: [], dependsOn: [], ciphertext: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    keyId: `key:${'a'.repeat(64)}` });
  const position = await setup.nats.store.head(`scope-${scopeId}`);
  const context = { conversationId: 'conversation', turnId: 'dispatch', requesterId: 'alice',
    assistantId: 'assistant', computerId: 'computer', generation: 1,
    threadId: headers['session-id'], inputGeneration: 'input', action: 'prepared',
    delivery: null, callDigest: null, dispatchDigest: null, additions: [],
    scopePositions: [], projectionGeneration: 'projection', byteCount: 0,
    hasOmissions: false, reason: 'none' };
  const recorded = { id: 'personal-memory-prepared', commandId: 'personal-memory-prepared',
    type: 'agent.memory_context_recorded', source: 'opencrane-server',
    subject: 'conversation-conversation', silo: 'test', time: new Date().toISOString(),
    principal: { kind: 'system', id: 'server' }, data: context };
  const prepared = memoryContextRecordedEventSchema.parse(recorded);
  const loaded = memoryContextRecordedEventSchema.parse({ ...recorded,
    id: 'personal-memory-loaded', commandId: 'personal-memory-loaded', data: {
      ...context, action: 'loaded', delivery: 'initial', byteCount: 20,
      additions: [{ scopeId, memoryId: 'fact', revision: 1 }],
      scopePositions: [{ scopeId, position }] } });
  await setup.nats.seed([prepared, loaded]);

  const value = await permit(setup, headers);
  const requestId = requestFromPermit(value);
  await setup.append(`scope-${scopeId}`, 'memory.forgotten', { schemaVersion: 1,
    scopeId, scopeKind: 'person', ownerId: 'alice', memoryId: 'fact',
    revision: 2, expectedRevision: 1 });
  const freshDecision = await fetch(`${setup.options.decisionUrl}/authorize/mcp/fixture/installed`,
    { method: 'POST', headers, body });
  expect(freshDecision.status).toBe(403);

  const response = await send(setup, value);
  expect(response.status).toBe(403);
  expect(remote.received).toHaveLength(0);
  expect(await setup.nats.store.head(`credential-${requestId}`)).toBe(0);
}

it('refuses a personal permit after loaded memory is forgotten',
  refusesForgottenLoadedMemoryAfterPermit, 60_000);

async function rotatePersonalFixture(setup: Fixture,
  saved: Awaited<ReturnType<typeof oauthSelectionFixture>>) {
  const revision = await refreshPersonalFixture(saved);
  const rows = await history(setup.nats.store, saved.subject, 'test');
  const current = foldConnection(rows);
  expect(current).toMatchObject({ sequence: revision, lastGeneration: 2,
    data: { activation: { generation: 2 } } });
}

const personalChanges = ['cleared choice', 'revoked profile', 'rotated profile', 'admin block',
  'changed review', 'expired permit', 'lost release audit', 'closed turn',
  'computer rotation', 'turn takeover', 'new Ask message'] as const;

async function refusesChangedPersonalCall(change: typeof personalChanges[number]) {
  const mode = change === 'new Ask message' ? 'ask' : 'allow';
  const { setup, remote, headers, saved } = await selectedPersonalFixture(mode);
  let permitHeaders: Record<string, string> = headers;
  if (mode === 'ask') {
    const approvalId = await approvalForReviewedTool(setup, headers, true);
    permitHeaders = { ...headers, 'x-opencrane-approval-id': approvalId };
  }
  const value = await permit(setup, permitHeaders);
  const requestId = requestFromPermit(value);
  if (change === 'cleared choice') {
    const previous = await setup.nats.store.head('connection-selection-alice-fixture');
    await setup.append('connection-selection-alice-fixture', 'connection.selected', {
      action: 'clear', userId: 'alice', serverId: 'fixture', connectionId: 'installed',
      expectedSequence: previous,
    });
  } else if (change === 'revoked profile') {
    await setup.append(saved.subject, 'connection.revoked', {
      userId: 'alice', serverId: 'fixture', profile: 'alice-profile',
      revokedBy: 'alice', expectedSequence: saved.revision, reason: 'owner_requested',
    });
  } else if (change === 'rotated profile') {
    await rotatePersonalFixture(setup, saved);
  } else if (change === 'admin block') {
    await setup.append('connection-control-alice-fixture', 'connection.disabled', {
      userId: 'alice', serverId: 'fixture', profile: 'alice-profile',
      disabledBy: 'admin', expectedSequence: 0, reason: 'admin_disabled',
    });
  } else if (change === 'changed review') {
    await setup.append('mcp-fixture', 'mcp.tool_mode_set', {
      serverId: 'fixture', connectionId: 'installed', toolName: 'write',
      toolRevision: tool.revision, mode: 'block', setBy: 'alice',
    });
  } else if (change === 'expired permit') {
    const encoded = value.split('.')[0]!;
    const decoded: unknown = JSON.parse(Buffer.from(encoded, 'base64url').toString());
    const lease = z.object({ expiresAt: z.number() }).parse(decoded);
    expect(lease.expiresAt).toBeLessThanOrEqual(Date.now() + 30_000);
    vi.spyOn(Date, 'now').mockReturnValue(lease.expiresAt);
  } else if (change === 'closed turn') {
    await setup.append('computer-assistant', 'computer.turn_closed', {
      assistantId: 'assistant', computerId: 'computer', conversationId: 'conversation',
      turnId: 'dispatch', threadId: headers['session-id'], requesterId: 'alice',
      task: 'chat_turn', status: 'completed',
    });
  } else if (change === 'computer rotation') {
    await setup.append('computer-assistant', 'computer.claimed', {
      assistantId: 'assistant', computerId: 'replacement', generation: 2,
      tokenId: 'token:replacement',
    });
  } else if (change === 'turn takeover') {
    await setup.append('computer-assistant', 'takeover.started', {
      assistantId: 'assistant', computerId: 'computer', requestedBy: 'alice',
    });
  } else if (change === 'new Ask message') {
    await setup.append('conversation-conversation', 'message.posted', {
      conversationId: 'conversation', authorId: 'alice', authorKind: 'human',
      contentType: 'text', ciphertext: 'ZmFrZS1jaXBoZXJ0ZXh0', keyId: 'key:1',
    });
  } else {
    const append = setup.nats.store.append.bind(setup.nats.store);
    async function lostAudit(command: AppendCommand) {
      const event = z.object({ type: z.string() }).safeParse(command.event);
      if (event.success && event.data.type === 'credential.released') {
        throw new Error('Simulated audit outage');
      }
      return append(command);
    }
    vi.spyOn(setup.nats.store, 'append').mockImplementation(lostAudit);
  }
  const response = await send(setup, value);
  vi.restoreAllMocks();
  expect(response.status).toBe(403);
  expect(remote.received).toHaveLength(0);
  expect(await setup.nats.store.head(`credential-${requestId}`)).toBe(0);
}

it.each(personalChanges)('sends no credential after %s', refusesChangedPersonalCall, 60_000);

async function refusesStalePersonalApproval() {
  const { setup, remote, headers } = await selectedPersonalFixture('ask');
  const approvalId = await approvalForReviewedTool(setup, headers, true);
  const previous = await setup.nats.store.head('connection-selection-alice-fixture');
  await setup.append('connection-selection-alice-fixture', 'connection.selected', {
    action: 'clear', userId: 'alice', serverId: 'fixture', connectionId: 'installed',
    expectedSequence: previous,
  });
  const response = await approvalPermit(setup, headers, approvalId);
  expect(response.status).toBe(403);
  expect(remote.received).toHaveLength(0);
}

it('refuses a personal approval after its selected profile is cleared',
  refusesStalePersonalApproval, 60_000);

async function refusesUnboundPersonalTurn() {
  const { setup, remote, headers } = await selectedPersonalFixture();
  const claims = { ...setup.t, thread: headers['session-id'], turn: 'dispatch' };
  const token = await setup.sign(claims, 'decision-service');
  const unsignedChoice = { ...headers, 'x-turn-token': token };
  const response = await fetch(`${setup.options.decisionUrl}/authorize/mcp/fixture/installed`,
    { method: 'POST', headers: unsignedChoice, body });
  expect(response.status).toBe(403);
  expect(remote.received).toHaveLength(0);
}

it('refuses a personal call when its turn has no signed account choice',
  refusesUnboundPersonalTurn, 60_000);

async function refusesUnsafeStoredCredential() {
  const { setup, remote, headers } = await selectedPersonalFixture('allow',
    'alice-access\r\nx-evil: yes');
  const value = await permit(setup, headers);
  const response = await send(setup, value);
  expect(response.status).toBe(403);
  expect(remote.received).toHaveLength(0);
}

it('refuses stored credential bytes that could become another HTTP header',
  refusesUnsafeStoredCredential, 60_000);

async function keepsUnknownPersonalOutcomeUnknown() {
  const { setup, remote, headers } = await selectedPersonalFixture();
  const value = await permit(setup, headers);
  remote.reset();
  const response = await send(setup, value);
  expect([502, 504]).toContain(response.status);
  expect(remote.received).toHaveLength(1);
  expect((await send(setup, value)).status).toBe(403);
  expect(remote.received).toHaveLength(1);
}

it('keeps a credentialed transport failure unknown and never resends',
  keepsUnknownPersonalOutcomeUnknown, 60_000);

async function hidesCredentialEchoInRemoteError() {
  const { setup, remote, headers } = await selectedPersonalFixture();
  function echoedError() {
    return '{"jsonrpc":"2.0","id":REQUEST_ID,"error":{"code":-32603,'
      + '"message":"Bearer alice-access","data":{"credential":"alice-access"}}}';
  }
  remote.respond(echoedError);
  const value = await permit(setup, headers);
  const response = await send(setup, value);
  expect(response.status).toBe(200);
  const returned = await response.text();
  expect(returned).not.toContain('alice-access');
  expect(returned).not.toContain('Bearer');
  expect(remote.received).toHaveLength(1);
  expect(remote.received[0]!.headers.authorization).toBe('Bearer alice-access');
}

it('does not return an upstream error that echoes the injected credential',
  hidesCredentialEchoInRemoteError, 60_000);

async function hidesNumericCredentialEchoInRemoteCode() {
  const { setup, remote, headers } = await selectedPersonalFixture('allow', '12345');
  function echoedCode() {
    return '{"jsonrpc":"2.0","id":REQUEST_ID,"error":{"code":12345,'
      + '"message":"Remote call failed"}}';
  }
  remote.respond(echoedCode);
  const value = await permit(setup, headers);
  const response = await send(setup, value);
  expect(response.status).toBe(200);
  const returned = await response.text();
  expect(returned).not.toContain('12345');
  expect(remote.received).toHaveLength(1);
  expect(remote.received[0]!.headers.authorization).toBe('Bearer 12345');
}

it('does not return an upstream error code that echoes a numeric credential',
  hidesNumericCredentialEchoInRemoteCode, 60_000);

const credentialReplyCases = [
  { name: 'result text', material: 'alice-access',
    result: { content: [{ type: 'text', text: 'Bearer alice-access' }] } },
  { name: 'tool error text', material: 'alice-access',
    result: { isError: true, content: [{ type: 'text', text: 'alice-access' }] } },
  { name: 'structured content', material: 'alice-access',
    result: { structuredContent: { account: { token: 'alice-access' } } } },
  { name: 'nested string', material: 'alice-access',
    result: { metadata: [{ details: { credential: 'alice-access' } }] } },
  { name: 'text split across content blocks', material: 'alice-access',
    result: { content: [{ type: 'text', text: 'alice-' },
      { type: 'text', text: 'access' }] } },
  { name: 'text split across structured fields', material: 'alice-access',
    result: { structuredContent: { first: 'alice-', second: 'access' } } },
  { name: 'text split across nested arrays', material: 'alice-access',
    result: { structuredContent: { parts: [['alice-'], [{ more: ['access'] }]] } } },
  { name: 'credential substring', material: 'alice-access',
    result: { content: [{ type: 'text', text: 'alice-acc' }] } },
  { name: 'encoded credential substring', material: 'alice-access',
    result: { content: [{ type: 'text', text: Buffer.from('alice-acc').toString('base64') }] } },
  { name: 'base64 JSON object', material: 'alice-access',
    result: { content: [{ type: 'text',
      text: Buffer.from('{"token":"alice-access"}').toString('base64') }] } },
  { name: 'twice URL encoded text', material: 'alice/access',
    result: { content: [{ type: 'text', text: 'alice%252Faccess' }] } },
  { name: 'URL encoded text after an invalid escape', material: 'alice/access',
    result: { content: [{ type: 'text', text: '%invalid alice%2Faccess' }] } },
  { name: 'nested key', material: 'alice-access',
    result: { structuredContent: { 'alice-access': true } } },
  { name: 'encoded content', material: 'alice-access',
    result: { content: [{ type: 'text', text: 'YWxpY2UtYWNjZXNz' }] } },
  { name: 'URL encoded content', material: 'alice/access',
    result: { content: [{ type: 'text', text: 'alice%2Faccess' }] } },
  { name: 'numeric value', material: '12345',
    result: { structuredContent: { count: 12345 } } },
  { name: 'Unicode escaped content', material: 'alice-access',
    result: { content: [{ type: 'text', text: 'alice-access' }] }, unicode: true },
] as const;

async function hidesCredentialEchoInRemoteResult(testCase: typeof credentialReplyCases[number]) {
  const { setup, remote, headers } = await selectedPersonalFixture('allow', testCase.material);
  function echoedResult() {
    const encoded = `{"jsonrpc":"2.0","id":REQUEST_ID,"result":${JSON.stringify(testCase.result)}}`;
    if ('unicode' in testCase) {
      return encoded.replace('alice-access', 'alice\\u002daccess');
    }
    return encoded;
  }
  remote.respond(echoedResult);
  const value = await permit(setup, headers);
  const response = await send(setup, value);
  expect(response.status).toBe(200);
  const returned = await response.text();
  expect(JSON.parse(returned)).toEqual({ jsonrpc: '2.0', id: capture.body.id,
    error: { code: -32603, message: 'Remote tool error' } });
  expect(remote.received).toHaveLength(1);
  expect(remote.received[0]!.headers.authorization).toBe(`Bearer ${testCase.material}`);
}

it.each(credentialReplyCases)('refuses a credential echoed in $name',
  hidesCredentialEchoInRemoteResult, 60_000);

async function hidesCredentialEchoInRemoteContentType() {
  const { setup, remote, headers } = await selectedPersonalFixture();
  remote.replyFields({ 'content-type': 'application/json; token=alice-access' });
  const value = await permit(setup, headers);
  const response = await send(setup, value);
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('application/json');
  expect(await response.json()).toEqual({ jsonrpc: '2.0', id: capture.body.id,
    error: { code: -32603, message: 'Remote tool error' } });
  expect(remote.received).toHaveLength(1);
}

it('does not forward credential text in an upstream content type',
  hidesCredentialEchoInRemoteContentType, 60_000);

async function hidesCredentialEchoInRemoteRequestId() {
  const { setup, remote, headers } = await selectedPersonalFixture();
  const raw = body.replace('"id":2', '"id":"alice-access"');
  function echoedResult() {
    return JSON.stringify({ jsonrpc: '2.0', id: 'alice-access',
      result: { content: [{ type: 'text', text: 'alice-access' }] } });
  }
  remote.respond(echoedResult);
  const value = await permit(setup, headers, raw);
  const response = await send(setup, value, raw);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ jsonrpc: '2.0', id: null,
    error: { code: -32603, message: 'Remote tool error' } });
  expect(remote.received).toHaveLength(1);
}

it('does not copy a credential-bearing request id into a sanitised refusal',
  hidesCredentialEchoInRemoteRequestId, 60_000);

async function refusesScopeMismatchBeforePermit() {
  const { setup, remote, headers, saved } = await selectedPersonalFixture();
  saved.configuration.toolScopes.write.push('missing-scope');
  const response = await fetch(`${setup.options.decisionUrl}/authorize/mcp/fixture/installed`,
    { method: 'POST', headers, body });
  expect(response.status).toBe(403);
  expect(remote.received).toHaveLength(0);
}

it('refuses changed required scopes before issuing a personal permit',
  refusesScopeMismatchBeforePermit, 60_000);

async function ignoresForgedProfileArgument() {
  const { setup, remote, headers } = await selectedPersonalFixture();
  const raw = body.replace('"arguments":{', '"arguments":{"profileId":"bob-profile",');
  const value = await permit(setup, headers, raw);
  const response = await send(setup, value, raw);
  expect(response.status, await response.text()).toBe(200);
  expect(remote.received[0]!.headers.authorization).toBe('Bearer alice-access');
  const sent: unknown = JSON.parse(remote.received[0]!.raw.toString());
  expect(sent).toHaveProperty('params.arguments', {
    profileId: 'bob-profile', ...capture.body.params.arguments });
  expect(sent).toHaveProperty('params._meta', {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientCapabilities': {} });
}

it('treats a profile-shaped tool argument as data and keeps Alice’s selection',
  ignoresForgedProfileArgument, 60_000);
