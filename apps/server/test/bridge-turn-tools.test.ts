import { catalogueDigest, toolReviewDigest } from '@opencrane/events/mcp-catalogue';
import { losslessJson } from '@opencrane/events/lossless-json';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';
import { connectBridge } from '../src/chat/bridge.ts';
import { expect, it, vi } from 'vitest';
import { envelope } from '@opencrane/models';
import type { EventEnvelope } from '@opencrane/events';
import { processConversation, assistantSnapshot, type AgentSession,
  type WatchOptions } from '../src/chat/bridge-conversation.ts';
import type { StoredEvent } from '@opencrane/event-store';
import type { IntegrationRow } from '@opencrane/protocol';
import { agentSessionData } from '../src/chat/reports.ts';

const use = vi.hoisted(() => vi.fn());

vi.mock('@opencrane/authz', async importOriginal => {
  const original = await importOriginal<typeof import('@opencrane/authz')>();
  return { ...original, memberAuthorisation: () => ({ use }) };
});

const parsedDefinition = losslessJson('{"name":"read","inputSchema":{"type":"object"}}');
const definition = parsedDefinition.canonical;
const revision = parsedDefinition.digest;
const schemaDigest = catalogueDigest([{ name: 'read', revision }]);

function storedEvent(sequence: number, event: EventEnvelope): StoredEvent {
  return { sequence, event };
}

function serverEvents(modeValue: 'allow' | 'ask' = 'allow') {
  const registration = envelope('test', 'mcp-fixture', 'mcp.server_registered', {
    serverId: 'fixture', kind: 'remote', locator: 'https://fixture.example.test/mcp',
    registeredBy: 'person',
  });
  const checkedAt = new Date().toISOString();
  const expiresAt = new Date(Date.parse(checkedAt) + 300_000).toISOString();
  const tool = { name: 'read', revision, reviewed: true, costCents: 0,
    definition, review: { action: 'PRIVATE_REVIEW_TEXT', consequence: 'Private detail',
      targetArgument: 'id', fields: ['id'], stepUp: false } };
  const discovery = envelope('test', 'mcp-fixture', 'mcp.server_discovered', {
    checkedAt, expiresAt,
    serverId: 'fixture', connectionId: 'connection', accountMode: 'none',
    schemaDigest, toolCount: 1,
    discoverResult: 'PRIVATE_DISCOVERY_RESULT',
    tools: [tool],
  });
  const choice = { name: 'read', revision, reviewDigest: toolReviewDigest(tool),
    mode: 'block' };
  const review = envelope('test', 'mcp-fixture', 'mcp.server_reviewed', {
    serverId: 'fixture', catalogueDigest: schemaDigest, policyRevision: 2,
    connectionId: 'connection', accountMode: 'none', reviewedBy: 'person', tools: [choice],
  });
  review.principal = { kind: 'human', id: 'person' };
  const publication = envelope('test', 'mcp-fixture', 'mcp.server_published', {
    serverId: 'fixture', publishedBy: 'person',
  });
  const mode = envelope('test', 'mcp-fixture', 'mcp.tool_mode_set', {
    serverId: 'fixture', connectionId: 'connection', toolName: 'read',
    toolRevision: revision, mode: modeValue, setBy: 'person',
  });
  const events = [registration, discovery, review, mode, publication];
  function withPosition(event: EventEnvelope, index: number) {
    return storedEvent(index + 1, event);
  }
  return events.map(withPosition);
}

function conversationEvents(memoryFree = false) {
  const created = envelope('test', 'conversation-chat', 'conversation.created', {
    conversationId: 'chat', assistantId: 'assistant', createdBy: 'person',
    mode: 'agent_session',
  });
  const message = envelope('test', 'conversation-chat', 'message.posted', {
    conversationId: 'chat', authorId: 'person', authorKind: 'human',
    contentType: 'text', ciphertext: 'a'.repeat(16), keyId: 'key:unused',
    ...(memoryFree ? { executionMode: 'memory_free' } : {}),
  });
  return [storedEvent(1, created), storedEvent(2, message)];
}

function bridgeFixture(options: {
  kind?: 'personal' | 'team'; binding?: boolean; memoryFree?: boolean;
  ask?: boolean; approvalWaiting?: boolean;
} = {}) {
  use.mockReset();
  const rowsBySubject = new Map<string, StoredEvent[]>([
    ['conversation-chat', conversationEvents(options.memoryFree)],
    ['mcp-fixture', serverEvents(options.ask ? 'ask' : 'allow')],
  ]);
  const joined = envelope('test', 'member-person', 'member.joined', {
    memberId: 'person', role: 'member', email: 'person@example.test',
    displayName: 'Person', invitationId: 'invite-person',
  });
  rowsBySubject.set('member-person', [storedEvent(1, joined)]);
  const reads: string[] = [];
  const store = {
    async *readStream(subject: string) {
      await Promise.resolve();
      reads.push(subject);
      yield* rowsBySubject.get(subject) ?? [];
    },
  };
  const sent: string[] = [];
  const sentTurns = new Map<string, import('../src/chat/turn-tools.ts').TurnDelivery>();
  const link = {
    connectionId: 1,
    approvalWaiting: options.approvalWaiting === true,
    socket: { send: (value: string) => sent.push(value) },
    delivered: new Set<string>(),
    sentTurns,
    deliver: vi.fn(),
  };
  const catalogueRow: IntegrationRow = {
    serverId: 'fixture', name: 'Fixture',
    source: { kind: 'remote_url', label: 'Remote URL', detail: 'fixture.example.test' },
    version: '1', accountModel: 'Not provided', toolsAllowed: 1, toolsTotal: 1,
    status: { kind: 'ready', label: 'Ready', detail: 'Ready' },
  };
  function readCatalogueRows() {
    return Promise.resolve([catalogueRow]);
  }
  const rows = vi.fn(readCatalogueRows);
  // Keep this fake small; this path reads only the store and catalogue methods.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- The path needs only these methods.
  const watchOptions = {
    silo: 'test',
    store,
    keys: { decrypt: () => 'Hello' },
    db: {},
    ...(options.binding ? { binding: {} } : {}),
    catalogue: { rows },
  } as unknown as WatchOptions;
  const conversationDetails = agentSessionData({
    conversationId: 'chat', assistantId: 'assistant', createdBy: 'person',
    mode: 'agent_session',
  });
  const conversation: AgentSession = {
    ...conversationDetails,
    conversationId: 'chat',
    createdAt: new Date().toISOString(),
    assistantKind: options.kind ?? 'personal',
  };
  const ready = envelope('test', 'computer-assistant', 'computer.ready', {
    assistantId: 'assistant', computerId: 'computer', generation: 1,
  });
  const assistant = assistantSnapshot([storedEvent(1, ready)],
    options.kind ?? 'personal', 'test');
  function process() {
    // Supply only the link fields used by processConversation in this test.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Socket I/O is captured above.
    const openLink = () => Promise.resolve(link as unknown as
      Awaited<ReturnType<Parameters<typeof processConversation>[5]>>);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- No token is read on this path.
    return processConversation(watchOptions, {} as never, conversation, assistant,
      new Set(), openLink);
  }
  return { process, sent, reads, rows, link, sentTurns, watchOptions, rowsBySubject };
}

it('sends a waiting turn without tools when OpenFGA cannot check a grant', async () => {
  const fixture = bridgeFixture({ binding: true });
  use.mockRejectedValueOnce(new Error('OpenFGA offline'));
  vi.useFakeTimers();
  try {
    await fixture.process();
    await vi.advanceTimersByTimeAsync(1001);
    await fixture.process();

    expect(fixture.sent).toHaveLength(2);
    expect(JSON.parse(fixture.sent[0]!)).not.toHaveProperty('tools');
    expect(JSON.parse(fixture.sent[1]!)).not.toHaveProperty('tools');
    expect(fixture.rows).toHaveBeenCalledTimes(1);
    expect(fixture.reads.filter(subject => subject === 'mcp-fixture')).toHaveLength(1);
    expect(use).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});

it('sends only the reviewed tool definition and omits private discovery fields', async () => {
  const fixture = bridgeFixture({ binding: true });
  use.mockResolvedValue({ allowed: true });

  await fixture.process();

  expect(use.mock.calls).toEqual([
    ['person', 'person', 'mcp_server', 'fixture'],
    ['assistant', 'assistant', 'mcp_server', 'fixture'],
  ]);
  const frame = fixture.sent[0]!;
  expect(JSON.parse(frame)).toMatchObject({ tools: [{ definitions: [definition] }] });
  expect(frame).not.toContain('discoverResult');
  expect(frame).not.toContain('PRIVATE_DISCOVERY_RESULT');
  expect(frame).not.toContain('PRIVATE_REVIEW_TEXT');
});

it.each([
  ['team restricted turn', { kind: 'team' as const }],
  ['team memory-free turn', { kind: 'team' as const, memoryFree: true }],
  ['personal turn without a binding', { kind: 'personal' as const }],
])('sends %s without tools', async (_name, options) => {
  const fixture = bridgeFixture({ kind: options.kind, binding: options.kind !== 'personal',
    memoryFree: 'memoryFree' in options && options.memoryFree });
  use.mockResolvedValue({ allowed: true });

  await fixture.process();

  expect(fixture.sent).toHaveLength(1);
  expect(JSON.parse(fixture.sent[0]!)).not.toHaveProperty('tools');
  expect(use).not.toHaveBeenCalled();
});

it('reuses the tool offer and permission checks while resending a waiting turn', async () => {
  vi.useFakeTimers();
  const fixture = bridgeFixture({ binding: true });
  use.mockResolvedValue({ allowed: true });
  try {
    await fixture.process();
    for (let resend = 0; resend < 2; resend += 1) {
      await vi.advanceTimersByTimeAsync(1001);
      await fixture.process();
    }

    expect(fixture.sent).toHaveLength(3);
    expect(fixture.rows).toHaveBeenCalledTimes(1);
    expect(fixture.reads.filter(subject => subject === 'mcp-fixture')).toHaveLength(1);
    expect(use.mock.calls).toEqual([
      ['person', 'person', 'mcp_server', 'fixture'],
      ['assistant', 'assistant', 'mcp_server', 'fixture'],
    ]);
  } finally {
    vi.useRealTimers();
  }
});

async function checksComputerSupport(supported: boolean) {
  const test = bridgeFixture({ binding: true, ask: true });
  use.mockResolvedValue({ allowed: true });
  const server = createServer();
  const computers = new WebSocketServer({ server, path: '/bridge' });
  function support(headers: string[]) {
    if (supported) headers.push('x-opencrane-approval-waiting: true');
  }
  computers.on('headers', support);
  const received: Record<string, unknown>[] = [];
  function connected(socket: WebSocket) {
    function receive(bytes: Buffer) {
      const frame = z.record(z.string(), z.unknown()).parse(JSON.parse(bytes.toString()));
      received.push(frame);
      if (!supported && String(JSON.stringify(frame['tools'])).includes('"ask"')) {
        socket.close(1008, 'Old computer cannot parse Ask');
      }
    }
    socket.on('message', receive);
  }
  computers.on('connection', connected);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing bridge port');
  const options = { silo: 'test', store: test.watchOptions.store, keys: test.watchOptions.keys };
  // Supply an empty saved report stream without changing the tool and conversation fixtures.
  function emptyReports() { return Promise.resolve(0); }
  const head = vi.fn(emptyReports);
  const store = { ...options.store, head };
  // Use only reads on this connector path. No report is sent by this fake computer.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- No writes on this path.
  const bridgeOptions = { ...options, store } as unknown as Parameters<typeof connectBridge>[0];
  const input = { url: `ws://127.0.0.1:${address.port}/bridge`, computerId: 'computer',
    assistantId: 'assistant', bearer: 'test-token' };
  const link = await connectBridge(bridgeOptions, input);
  try {
    Object.assign(test.link, { socket: link.socket, approvalWaiting: link.approvalWaiting });
    await test.process();
    function receivedTurn() { expect(received.some(isTurn)).toBe(true); }
    function isTurn(frame: Record<string, unknown>) { return frame['type'] === 'turn'; }
    await vi.waitFor(receivedTurn);
    const turn = received.find(isTurn);
    if (supported) expect(turn).toMatchObject({ tools: [{ modes: { read: 'ask' } }] });
    else expect(turn).not.toHaveProperty('tools');
    expect(link.socket.readyState).toBe(WebSocket.OPEN);
  } finally {
    link.socket.terminate();
    for (const socket of computers.clients) socket.terminate();
    computers.close();
    server.close();
  }
}
it.each([false, true])('offers Ask only to a computer advertising support: %s',
  checksComputerSupport);

async function refusesQueuedTurnAndToolsAfterRemoval() {
  const fixture = bridgeFixture({ binding: true });
  use.mockResolvedValue(true);
  const removed = envelope('test', 'member-person', 'member.removed', {
    memberId: 'person', removedBy: 'owner',
  });
  const invited = envelope('test', 'member-person', 'member.invited', {
    memberId: 'person', role: 'member', email: 'person@example.test',
    invitedBy: 'owner', invitationId: 'next-invite',
  });
  const membership = fixture.rowsBySubject.get('member-person')!;
  membership.push(storedEvent(2, removed), storedEvent(3, invited));
  await expect(fixture.process()).rejects.toThrow('Active silo membership required');
  expect(fixture.sent).toEqual([]);
}
it('refuses a queued turn and its tool list after removal and a later invitation',
  refusesQueuedTurnAndToolsAfterRemoval);
