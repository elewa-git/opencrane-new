import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { grantStream } from '@opencrane/authz';
import { decideApproval, readApproval } from '../src/index.ts';
import { fixture } from './fixture.ts';

type Fixture = Awaited<ReturnType<typeof fixture>>;
interface Injection { label: string; subject: string; type: string; data: Record<string, unknown> }

const ciphertext = 'ZmFrZS1jaXBoZXJ0ZXh0';
const otherTurn = {
  assistantId: 'assistant', computerId: 'computer', conversationId: 'other',
  turnId: 'other-turn', threadId: 'other-thread', requesterId: 'alice', task: 'chat_turn',
  payingGroupId: 'personal-default',
};

async function decide(setup: Fixture, route: 'model' | 'mcp') {
  let url = `${setup.options.decisionUrl}/authorize`;
  let headers: Record<string, string> = setup.headers;
  let body: unknown = {
    model: 'gpt-6-luna', input: 'OK', max_output_tokens: 128, stream: true,
  };
  if (route === 'mcp') {
    url += '/mcp/fixture/installed';
    headers = { ...headers, 'mcp-protocol-version': '2026-07-28',
      'mcp-method': 'tools/call', 'mcp-tool-name': 'write' };
    body = { jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'write', arguments: { note: 'x' } },
      _meta: { 'io.modelcontextprotocol/protocol-version': '2026-07-28',
        'io.modelcontextprotocol/client-capabilities': {} } };
  }
  const request = { method: 'POST', headers, body: JSON.stringify(body) };
  const response = await fetch(url, request);
  const responseBody = await response.text();
  return { status: response.status, body: responseBody,
    requestId: response.headers.get('x-request-id') };
}

function injectDuringDecision(setup: Fixture, injection: Injection) {
  const read = setup.nats.store.readStream.bind(setup.nats.store);
  let changed = false;
  let appended = false;
  async function* appendAfterMemberRead(...args: Parameters<typeof read>) {
    yield* read(...args);
    if (args[0] === 'member-alice' && !changed) {
      changed = true;
      await setup.append(injection.subject, injection.type, injection.data);
      appended = true;
    }
  }
  const race = vi.spyOn(setup.nats.store, 'readStream');
  race.mockImplementation(appendAfterMemberRead);
  return {
    restore() {
      race.mockRestore();
      expect(changed).toBe(true);
      expect(appended).toBe(true);
    },
  };
}

async function setUpMcp(setup: Fixture, mode: 'allow' | 'ask' = 'allow') {
  const registration = { serverId: 'fixture', kind: 'remote',
    locator: 'https://fixture.example.test/mcp', registeredBy: 'alice' };
  await setup.append('mcp-fixture', 'mcp.server_registered', registration);
  const review = { action: 'Write note', consequence: 'The note changes.',
    targetArgument: 'note', fields: ['note'], stepUp: false };
  const tool = { name: 'write', revision: 'a'.repeat(64), reviewed: true, costCents: 0, review };
  const discovery = { serverId: 'fixture', connectionId: 'installed', accountMode: 'none',
    schemaDigest: 'a'.repeat(64), toolCount: 1, tools: [tool] };
  await setup.append('mcp-fixture', 'mcp.server_discovered', discovery);
  const publication = { serverId: 'fixture', publishedBy: 'alice' };
  await setup.append('mcp-fixture', 'mcp.server_published', publication);
  const grantees = [['alice', 'member'], ['assistant', 'assistant']];
  for (const [granteeId, granteeKind] of grantees) {
    const grant = { resourceType: 'mcp_server', resourceId: 'fixture',
      granteeId, granteeKind, grantedBy: 'alice' };
    const event = await setup.append(grantStream('mcp_server', 'fixture'), 'grant.given', grant);
    await setup.auth.handler.handle(event, setup.db);
  }
  const policy = { serverId: 'fixture', connectionId: 'installed', toolName: 'write',
    toolRevision: 'a'.repeat(64), mode, setBy: 'alice' };
  await setup.append('mcp-fixture', 'mcp.tool_mode_set', policy);
}

const otherTurnStarted: Injection = {
  label: 'another conversation starting a turn', subject: 'computer-assistant',
  type: 'computer.turn_started', data: otherTurn,
};
const grantRevoked: Injection = {
  label: 'the requester grant is revoked', subject: grantStream('model', 'gpt-6-luna'),
  type: 'grant.revoked', data: { resourceType: 'model', resourceId: 'gpt-6-luna',
    granteeId: 'alice', revokedBy: 'alice' },
};
const turnStopped: Injection = {
  label: 'the current turn is stopped', subject: 'conversation-conversation',
  type: 'agent.turn_stop_requested',
  data: { conversationId: 'conversation', turnId: 'turn', requestedBy: 'alice' },
};

const harmless: Injection[] = [
  { label: 'agent.message_delta',
    subject: 'conversation-conversation', type: 'agent.message_delta',
    data: { conversationId: 'conversation', turnId: 'turn', messageId: 'm1',
      ciphertext, keyId: 'key:1', contentType: 'text' } },
  { label: 'agent.command_ran',
    subject: 'conversation-conversation', type: 'agent.command_ran',
    data: { conversationId: 'conversation', turnId: 'turn', commandDigest: 'a'.repeat(64), exitCode: 0 } },
  { label: 'file.uploaded',
    subject: 'conversation-conversation', type: 'file.uploaded',
    data: { conversationId: 'conversation', fileId: 'file1', uploadedBy: 'alice',
      name: 'notes.txt', size: 5, sha256: 'a'.repeat(64), mime: 'text/plain',
      objectKey: 'test/conversation/file1' } },
  { label: 'file.delivered',
    subject: 'conversation-conversation', type: 'file.delivered',
    data: { conversationId: 'conversation', fileId: 'file1', computerId: 'computer', sha256: 'a'.repeat(64) } },
  { label: 'message.posted',
    subject: 'conversation-conversation', type: 'message.posted',
    data: { conversationId: 'conversation', authorId: 'alice', authorKind: 'human',
      ciphertext, keyId: 'key:1', contentType: 'text' } },
  otherTurnStarted,
  { label: 'another conversation closing a turn',
    subject: 'computer-assistant', type: 'computer.turn_closed',
    data: { ...otherTurn, status: 'completed' } },
  { label: 'a grant for another member',
    subject: grantStream('model', 'gpt-6-luna'), type: 'grant.given',
    data: { resourceType: 'model', resourceId: 'gpt-6-luna', granteeId: 'bob', granteeKind: 'member',
      grantedBy: 'alice' } },
];

const ownership: Injection = {
  label: 'ownership transfer to another member', subject: 'ownership-test',
  type: 'ownership.transferred', data: { memberId: 'bob', transferredBy: 'alice' },
};
const invitation: Injection = {
  label: 'an invitation on the member stream', subject: 'member-alice', type: 'member.invited',
  data: { memberId: 'alice', email: 'alice@example.test', role: 'member', invitedBy: 'bob',
    invitationId: 'invitation', invitedIdentity: { issuer: 'https://idp.test', sub: 'alice' },
    expiresAt: '2026-11-01T00:00:00Z' },
};
harmless.push(ownership, invitation);

const revoked: Injection[] = [
  grantRevoked,
  { label: 'the requester is removed from the conversation',
    subject: 'conversation-conversation', type: 'participant.removed',
    data: { conversationId: 'conversation', participantId: 'alice', removedBy: 'bob' } },
  { label: 'the conversation is closed', subject: 'conversation-conversation',
    type: 'conversation.closed', data: { conversationId: 'conversation', closedBy: 'alice' } },
  { label: 'the member is removed', subject: 'member-alice', type: 'member.removed',
    data: { memberId: 'alice', removedBy: 'bob' } },
  { label: 'the assistant is inactive', subject: 'assistant-assistant',
    type: 'assistant.settings_changed', data: { assistantId: 'assistant', changedBy: 'alice',
      changedFields: ['active'], active: false } },
  turnStopped,
  { label: 'the current turn completes', subject: 'conversation-conversation',
    type: 'agent.turn_completed', data: { conversationId: 'conversation', turnId: 'turn' } },
  { label: 'the current turn fails', subject: 'conversation-conversation',
    type: 'agent.turn_failed',
    data: { conversationId: 'conversation', turnId: 'turn', reason: 'model_error' } },
  { label: 'the current computer turn closes', subject: 'computer-assistant',
    type: 'computer.turn_closed', data: { ...otherTurn, turnId: 'turn',
      conversationId: 'conversation', status: 'completed' } },
];

async function prepareRoute(setup: Fixture, route: 'model' | 'mcp') {
  if (route === 'mcp') await setUpMcp(setup);
}

async function injectedDecision(setup: Fixture, route: 'model' | 'mcp', injection: Injection) {
  const race = injectDuringDecision(setup, injection);
  try {
    return await decide(setup, route);
  } finally {
    race.restore();
  }
}

function routeInjection(route: 'model' | 'mcp', injection: Injection): Injection {
  if (route !== 'mcp' || !injection.type.startsWith('grant.')) return injection;
  return { ...injection, subject: grantStream('mcp_server', 'fixture'),
    data: { ...injection.data, resourceType: 'mcp_server', resourceId: 'fixture' } };
}

async function allowsHarmlessEvent(route: 'model' | 'mcp', injection: Injection) {
  const setup = await fixture();
  try {
    await prepareRoute(setup, route);
    const event = routeInjection(route, injection);
    const response = await injectedDecision(setup, route, event);
    expect(response.status, response.body).toBe(200);
  } finally {
    await setup.close();
  }
}

async function refusesRevocation(route: 'model' | 'mcp', injection: Injection) {
  const setup = await fixture();
  try {
    await prepareRoute(setup, route);
    const event = routeInjection(route, injection);
    const response = await injectedDecision(setup, route, event);
    expect(response.status, response.body).toBe(403);
    expect(setup.actor.state.reservations).toHaveLength(0);
    expect(setup.received()).toBe(0);
  } finally {
    await setup.close();
  }
}

for (const route of ['model', 'mcp'] as const) {
  async function allowEvent(injection: Injection) {
    await allowsHarmlessEvent(route, injection);
  }
  async function refuseEvent(injection: Injection) {
    await refusesRevocation(route, injection);
  }
  it.each(harmless)(`${route} allows $label during its access check`, allowEvent, 40_000);
  it.each(revoked)(`${route} refuses when $label during its access check without reserving money`,
    refuseEvent, 40_000);
}

async function refusesAlreadyStoppedTurn() {
  const setup = await fixture();
  try {
    const stop = turnStopped;
    await setup.append(stop.subject, stop.type, stop.data);
    const response = await decide(setup, 'model');
    expect(response.status, response.body).toBe(403);
    expect(setup.actor.state.reservations).toHaveLength(0);
  } finally {
    await setup.close();
  }
}
it('refuses a turn stopped before the decision without reserving money',
  refusesAlreadyStoppedTurn, 40_000);

async function readsConversationBeforeAccessCheck() {
  const setup = await fixture();
  const read = setup.nats.store.readStream.bind(setup.nats.store);
  let accessStarted = false;
  const fullConversationReads: boolean[] = [];
  async function* recordRead(...args: Parameters<typeof read>) {
    if (args[0] === 'member-alice') accessStarted = true;
    if (args[0] === 'conversation-conversation' && args[1] === 1) {
      fullConversationReads.push(accessStarted);
    }
    yield* read(...args);
  }
  const reads = vi.spyOn(setup.nats.store, 'readStream');
  reads.mockImplementation(recordRead);
  try {
    const response = await decide(setup, 'model');
    expect(response.status, response.body).toBe(200);
    expect(fullConversationReads).toEqual([false]);
  } finally {
    reads.mockRestore();
    await setup.close();
  }
}
it('reads full conversation history once before the short access check',
  readsConversationBeforeAccessCheck, 40_000);

async function handlesEventDuringAudit(injection: Injection, allowed: boolean) {
  const setup = await fixture();
  const append = setup.nats.store.append.bind(setup.nats.store);
  let changed = false;
  let appended = false;
  async function appendDuringAudit(command: Parameters<typeof append>[0]) {
    const result = await append(command);
    const event = z.object({ type: z.string() }).parse(command.event);
    if (event.type === 'decision.recorded' && !changed) {
      changed = true;
      await setup.append(injection.subject, injection.type, injection.data);
      appended = true;
    }
    return result;
  }
  const audit = vi.spyOn(setup.nats.store, 'append');
  audit.mockImplementation(appendDuringAudit);
  try {
    const response = await decide(setup, 'model');
    expect(changed).toBe(true);
    expect(appended).toBe(true);
    expect(setup.actor.state.reservations).toHaveLength(1);
    if (allowed) {
      expect(response.status, response.body).toBe(200);
      expect(setup.actor.state.reservations[0]?.settledCents).toBeUndefined();
    } else {
      expect(response.status, response.body).toBe(503);
      expect(setup.actor.state.reservations[0]?.settledCents).toBe(0);
    }
    expect(setup.received()).toBe(0);
  } finally {
    audit.mockRestore();
    await setup.close();
  }
}
async function allowsOtherTurnDuringAudit() {
  await handlesEventDuringAudit(otherTurnStarted, true);
}
async function releasesMoneyAfterLateRevocation() {
  await handlesEventDuringAudit(grantRevoked, false);
}
it('allows another conversation to start a turn during the model allow audit',
  allowsOtherTurnDuringAudit, 40_000);
it('releases an unsent model reservation at zero after a revocation during the allow audit',
  releasesMoneyAfterLateRevocation, 40_000);

async function refusesComputerChangeAfterCredentialRead() {
  const setup = await fixture();
  const read = setup.nats.store.readStream.bind(setup.nats.store);
  let changed = false;
  let appended = false;
  async function* suspendAfterCredentialRead(...args: Parameters<typeof read>) {
    yield* read(...args);
    if (args[0] === 'computer-assistant' && !changed) {
      changed = true;
      const suspended = { assistantId: 'assistant', computerId: 'computer' };
      await setup.append('computer-assistant', 'computer.suspended', suspended);
      appended = true;
    }
  }
  const race = vi.spyOn(setup.nats.store, 'readStream');
  race.mockImplementation(suspendAfterCredentialRead);
  try {
    const response = await decide(setup, 'model');
    expect(changed).toBe(true);
    expect(appended).toBe(true);
    expect(response.status, response.body).toBe(403);
    expect(setup.actor.state.reservations).toHaveLength(0);
  } finally {
    race.mockRestore();
    await setup.close();
  }
}
it('refuses a computer suspended after checking its token and before reading turn history',
  refusesComputerChangeAfterCredentialRead, 40_000);

async function allowsOtherGrantBeforeSnapshot() {
  const setup = await fixture();
  try {
    const grant = { resourceType: 'model', resourceId: 'gpt-6-luna', granteeId: 'bob',
      granteeKind: 'member', grantedBy: 'alice' };
    await setup.append(grantStream('model', 'gpt-6-luna'), 'grant.given', grant);
    const response = await decide(setup, 'model');
    expect(response.status, response.body).toBe(200);
  } finally {
    await setup.close();
  }
}
it('allows a call while another member grant is waiting to reach the permissions service',
  allowsOtherGrantBeforeSnapshot, 40_000);

async function allowsApprovedToolDuringOtherActivity() {
  const setup = await fixture();
  try {
    await setUpMcp(setup, 'ask');
    const requested = await decide(setup, 'mcp');
    expect(requested.status).toBe(403);
    const parsed = z.object({ approvalId: z.string() }).parse(JSON.parse(requested.body));
    function currentAccess() {
      return Promise.resolve();
    }
    const approved = await decideApproval(setup.nats.store, 'test', parsed.approvalId,
      'alice', 'approved', true, currentAccess, setup.actor.now());
    expect(approved.status).toBe('appended');
    const race = injectDuringDecision(setup, otherTurnStarted);
    try {
      const response = await decide(setup, 'mcp');
      expect(response.status, response.body).toBe(200);
      const used = await readApproval(setup.nats.store, 'test', parsed.approvalId);
      expect(used.state).toBe('outcome_unknown');
      expect(setup.actor.state.reservations).toHaveLength(0);
    } finally {
      race.restore();
    }
  } finally {
    await setup.close();
  }
}
it('uses an approved tool once while another conversation starts a turn',
  allowsApprovedToolDuringOtherActivity, 40_000);

const otherGroupMemberRemoved: Injection = {
  label: 'another team member is removed', subject: 'team-sales', type: 'team.member_removed',
  data: { teamId: 'sales', memberId: 'bob', removedBy: 'alice' },
};
const requesterGroupRemoved: Injection = {
  label: 'the requester is removed from the team', subject: 'team-sales',
  type: 'team.member_removed',
  data: { teamId: 'sales', memberId: 'alice', removedBy: 'bob' },
};

async function sharedMemberDecision(route: 'model' | 'mcp', injection: Injection,
  allowed: boolean) {
  const setup = await fixture(2000, 20000, false, 'gpt-6-luna', true);
  try {
    await prepareRoute(setup, route);
    const joined = { memberId: 'bob', email: 'bob@example.test', displayName: 'Bob',
      role: 'member' };
    const membership = await setup.append('member-bob', 'member.joined', joined);
    await setup.auth.handler.handle(membership, setup.db);
    const added = { teamId: 'sales', memberId: 'bob', addedBy: 'alice' };
    await setup.append('team-sales', 'team.member_added', added);
    const response = await injectedDecision(setup, route, injection);
    if (allowed) {
      expect(response.status, response.body).toBe(200);
    } else {
      expect(response.status, response.body).toBe(403);
      expect(setup.actor.state.reservations).toHaveLength(0);
    }
  } finally {
    await setup.close();
  }
}

async function allowsOtherGroupMemberRemoval(route: 'model' | 'mcp') {
  await sharedMemberDecision(route, otherGroupMemberRemoved, true);
}
async function refusesRequesterGroupRemoval(route: 'model' | 'mcp') {
  await sharedMemberDecision(route, requesterGroupRemoved, false);
}
const routes = ['model', 'mcp'] as const;
it.each(routes)('%s allows another team member to leave during the access check',
  allowsOtherGroupMemberRemoval, 40_000);
it.each(routes)('%s refuses the requester leaving the team without reserving money',
  refusesRequesterGroupRemoval, 40_000);
