import { once } from 'node:events';
import * as crypto from 'node:crypto';
import { dirname } from 'node:path';
import { WebSocketServer, type RawData } from 'ws';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { grantStream } from '@opencrane/authz';
import { createEventStore, type EventStore } from '@opencrane/event-store';
import { memoryContextRecordedEventSchema } from '@opencrane/events';
import { envelope, history } from '@opencrane/models';
import { catalogueEvidence, fixture, reviewCatalogue, toolEvidence } from '@opencrane/models/testing';
import { memoryKeys, memoryProjection, memoryScopeId } from '@opencrane/projections';
import { buildServer } from '../src/server.ts';
import { connectBridge } from '../src/chat/bridge.ts';
import { readChatFacts } from '../src/chat/chat-summary.ts';
import { privateContext } from '../src/chat/private-context.ts';
import { recordReport, recordReports, ReportRejected } from '../src/chat/reports.ts';
import { testAuthConfig } from './support/test-auth-config.ts';

async function cryptoModule() {
  const actual = await vi.importActual<typeof import('node:crypto')>('node:crypto');
  return { ...actual, createHash: vi.fn(actual.createHash) };
}
vi.mock('node:crypto', cryptoModule);

let setup: Awaited<ReturnType<typeof fixture>>;
let app: ReturnType<typeof buildServer>;
const context = { silo: 'test', computerId: 'computer', assistantId: 'assistant' };
const scopeId = memoryScopeId('test', 'person', 'alice');
const canary = 'Personal memory report canary';
const refusal = 'Memory-bearing report content refused';
const route = '/mcp/memory/server';
const tool = toolEvidence({ name: 'recall', reviewed: true, costCents: 0 });
const catalogue = catalogueEvidence([tool]);
const headers = { 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call',
  'mcp-name': 'recall' };
const metadata = { threadId: 'thread', callId: 'memory-report',
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': {} };
const call = { jsonrpc: '2.0', id: 1, method: 'tools/call',
  params: { name: 'recall', arguments: { scopeId }, _meta: metadata } };

function memberId() { return Promise.resolve('alice'); }
async function prepare() {
  setup = undefined!;
  app = undefined!;
  setup = await fixture(2000, 20000, false, 'gpt-6-luna', false, 'manual', 'sales', 'restricted');
  await setup.stopDispatch();
  await setup.runtime.stop();
  const registration = { serverId: 'memory', kind: 'hosted', registeredBy: 'alice',
    locator: `registry.example.test/memory@sha256:${'a'.repeat(64)}` };
  await setup.append('mcp-memory', 'mcp.server_registered', registration);
  const discovery = { serverId: 'memory', connectionId: 'server', accountMode: 'none',
    ...catalogue };
  await setup.append('mcp-memory', 'mcp.server_discovered', discovery);
  await reviewCatalogue(setup, 'memory');
  const mode = { serverId: 'memory', connectionId: 'server', toolName: 'recall',
    toolRevision: tool.revision, mode: 'allow', setBy: 'alice' };
  await setup.append('mcp-memory', 'mcp.tool_mode_set', mode);
  await setup.append('mcp-memory', 'mcp.server_published',
    { serverId: 'memory', publishedBy: 'alice' });
  const resources = [['mcp_server', 'memory'], ['memory_read', scopeId]] as const;
  for (const [resourceType, resourceId] of resources) {
    for (const [granteeKind, granteeId] of [['member', 'alice'], ['assistant', 'assistant']]) {
      const grant = { resourceType, resourceId, granteeKind, granteeId, grantedBy: 'alice' };
      const saved = await setup.append(grantStream(resourceType, resourceId), 'grant.given', grant);
      await setup.auth.handler.handle(saved, setup.db);
    }
  }
  await humanMessage('turn', 'alice');
  const keyDirectory = dirname(setup.options.configFile);
  const keys = memoryKeys(keyDirectory);
  const identity = { silo: 'test', scopeId, scopeKind: 'person' as const,
    ownerId: 'alice', memoryId: 'fact', revision: 1 };
  keys.provision(identity);
  const fact = { schemaVersion: 1, scopeId, scopeKind: 'person', ownerId: 'alice',
    memoryId: 'fact', revision: 1, kind: 'fact', pinned: false, expiresAt: null,
    sources: [], dependsOn: [], ...keys.encrypt(identity, canary) };
  await setup.append(`scope-${scopeId}`, 'memory.written', fact);
  const projection = memoryProjection({ decrypt: keys.decrypt });
  await setup.runner.initialise(projection);
  await setup.runner.run(projection);
  const memory = { silo: 'test', store: setup.nats.store, db: setup.db,
    binding: setup.binding, feed: { memberId }, identity: setup.identity, keyDirectory,
    dispatchGeneration: 'memory-instance' };
  app = buildServer(testAuthConfig(), { memory });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const configured = { serverId: 'memory', connectionId: 'server', upstream: new URL(address).host,
    generation: 'memory-instance', revisionHeader: 'x-opencrane-mcp-revision' as const };
  setup.options.mcpRoutes.push(configured);
  await setup.restart('SIGKILL');
  const discoveryHeaders = { ...headers, 'mcp-method': 'tools/list', 'mcp-name': '' };
  const discover = { ...call, method: 'tools/list', params: { _meta: metadata } };
  const ready = await setup.call(discoveryHeaders, discover, route);
  expect(ready.status).toBe(200);
}
async function close() {
  vi.restoreAllMocks();
  setup?.gatewayChild()?.kill('SIGKILL');
  if (app?.server.listening) app.server.close();
  app?.server.closeAllConnections();
  await app?.close();
  await setup?.close();
}
beforeEach(prepare, 120_000);
afterEach(close);

async function humanMessage(id: string, authorId: string) {
  const data = { conversationId: 'conversation', authorKind: 'human', authorId,
    contentType: 'text', ...setup.keys.encrypt('test', 'conversation', `${authorId} statement`) };
  const event = envelope('test', 'conversation-conversation', 'message.posted', data, id);
  await setup.nats.seed([event]);
}
async function recall() {
  const response = await setup.call(headers, call, route);
  expect(response.status).toBe(200);
  expect(response.text).toContain(canary);
  const facts = await readChatFacts(setup.nats.store, 'test', 'conversation', 'turn');
  expect(facts.memoryContext?.references).toEqual([{ scopeId, memoryId: 'fact', revision: 1 }]);
}
function report(type = 'agent.message_completed', sequence = 1) {
  return { sequence, previousSequence: sequence - 1, conversationId: 'conversation',
    turnId: 'turn', assistantId: 'assistant', requesterId: 'alice',
    messageId: 'reply', type, text: canary };
}
function status(type: string, sequence: number) {
  return { sequence, previousSequence: sequence - 1, conversationId: 'conversation',
    turnId: 'turn', assistantId: 'assistant', requesterId: 'alice', type };
}
function save(value: unknown, store: EventStore = setup.nats.store) {
  return recordReport(store, setup.keys, context, value);
}
async function coldHistory() {
  const cold = await createEventStore(setup.nats.connection);
  return history(cold, 'conversation-conversation', 'test');
}
function decrypt(data: unknown) { return setup.keys.decrypt('test', 'conversation', data); }
async function assertNoReportSaved() {
  const rows = await coldHistory();
  for (const row of rows) expect(row.event.report).toBeUndefined();
  expect(JSON.stringify(rows)).not.toContain(canary);
  return rows;
}
async function rejectsContent(type: string) {
  await recall();
  const encrypt = vi.spyOn(setup.keys, 'encrypt');
  const hash = vi.mocked(crypto.createHash);
  hash.mockClear();
  await expect(save(report(type))).rejects.toThrow(new ReportRejected(refusal));
  expect(encrypt).not.toHaveBeenCalled();
  expect(hash).not.toHaveBeenCalled();
  await assertNoReportSaved();
}
it.each(['agent.message_delta', 'agent.message_completed', 'agent.reasoning_summarised'])(
  'refuses recalled %s before encryption or hashing', rejectsContent);

async function rejectsBatchesAndHiddenText() {
  await recall();
  const encrypt = vi.spyOn(setup.keys, 'encrypt');
  const values = [report('agent.message_delta'), report('agent.message_delta', 2)];
  await expect(recordReports(setup.nats.store, setup.keys, context, values))
    .rejects.toThrow(new ReportRejected(refusal));
  await expect(save(report('agent.turn_completed'))).rejects.toThrow(refusal);
  const command = { ...status('agent.command_ran', 1), commandDigest: 'b'.repeat(64), exitCode: 0 };
  await expect(save(command)).rejects.toThrow(refusal);
  const artifacts = [{ id: 'a'.repeat(64), name: 'report.txt', size: 5, sha256: 'b'.repeat(64) }];
  const completed = { ...status('agent.turn_completed', 1), artifacts };
  await expect(save(completed)).rejects.toThrow(refusal);
  expect(encrypt).not.toHaveBeenCalled();
  await assertNoReportSaved();
}
it('refuses batched deltas and text hidden on a completion report', rejectsBatchesAndHiddenText);

async function acceptsLostAcknowledgements() {
  await recall();
  const append = setup.nats.store.append.bind(setup.nats.store);
  async function loseReply(command: Parameters<typeof append>[0]): Promise<never> {
    await append(command);
    throw new Error('Test acknowledgement lost');
  }
  const appends = vi.spyOn(setup.nats.store, 'append');
  appends.mockImplementationOnce(loseReply);
  const lost = status('agent.output_lost', 1);
  await expect(save(lost)).rejects.toThrow('Test acknowledgement lost');
  expect(await save(lost)).toBe('duplicate');
  expect(await save(status('agent.turn_completed', 2))).toBe('recorded');
  expect(await save(status('agent.turn_completed', 2))).toBe('duplicate');
  const rows = await coldHistory();
  const saved = rows.filter(hasReport);
  expect(saved).toHaveLength(2);
  expect(JSON.stringify(saved)).not.toMatch(/ciphertext|Personal memory report canary/u);
  await expect(save(report())).rejects.toThrow(refusal);
}
function hasReport(row: Awaited<ReturnType<typeof coldHistory>>[number]) {
  return row.event.report !== undefined;
}
it('reconciles lost acknowledgements and duplicates for text-free loss and completion',
  acceptsLostAcknowledgements);

async function rejectsChangedTurn(state: string) {
  const append = setup.nats.store.append.bind(setup.nats.store);
  async function stopBeforeLoading(command: Parameters<typeof append>[0]) {
    const parsed = memoryContextRecordedEventSchema.safeParse(command.event);
    if (parsed.success && parsed.data.data.action === 'loaded') {
      throw new Error('Test stops before loading');
    }
    return append(command);
  }
  if (state === 'prepared') {
    vi.spyOn(setup.nats.store, 'append').mockImplementation(stopBeforeLoading);
    expect((await setup.call(headers, call, route)).status).toBe(403);
  } else {
    await recall();
  }
  if (state === 'invalidated' || state === 'ended') {
    const rows = await coldHistory();
    const first = rows.find(isMemoryEvidence)!;
    const prepared = memoryContextRecordedEventSchema.parse(first.event);
    const reason = state === 'ended' ? 'ended' : 'access_changed';
    const data = { ...prepared.data, action: state, reason };
    const id = crypto.randomUUID();
    const event = { ...prepared, id, commandId: id, data };
    await setup.nats.seed([event]);
  }
  if (state === 'closed') {
    await setup.append('conversation-conversation', 'conversation.closed',
      { conversationId: 'conversation', closedBy: 'alice' });
  }
  const facts = await readChatFacts(setup.nats.store, 'test', 'conversation', 'turn');
  expect(facts.memoryContext?.status).toBe(state === 'closed' ? 'ended' : state);
  const encrypt = vi.spyOn(setup.keys, 'encrypt');
  await expect(save(report())).rejects.toThrow(refusal);
  expect(encrypt).not.toHaveBeenCalled();
  await assertNoReportSaved();
  expect(await save(status('agent.output_lost', 1))).toBe('recorded');
  expect(await save(status('agent.turn_completed', 2))).toBe('recorded');
}
function isMemoryEvidence(row: Awaited<ReturnType<typeof coldHistory>>[number]) {
  return row.event.type === 'agent.memory_context_recorded';
}
it.each(['prepared', 'invalidated', 'ended', 'closed'])(
  'keeps %s memory evidence protective while allowing text-free closure', rejectsChangedTurn);

async function rejectsEvidenceDuringAppend() {
  const append = setup.nats.store.append.bind(setup.nats.store);
  let raced = false;
  async function recallBeforeAppend(command: Parameters<typeof append>[0]) {
    const event = command.event;
    if (!raced && event && typeof event === 'object' && 'report' in event) {
      raced = true;
      await recall();
    }
    return append(command);
  }
  vi.spyOn(setup.nats.store, 'append').mockImplementation(recallBeforeAppend);
  const values = [report('agent.message_delta'), report('agent.message_delta', 2)];
  await expect(recordReports(setup.nats.store, setup.keys, context, values))
    .rejects.toThrow(refusal);
  expect(raced).toBe(true);
  await assertNoReportSaved();
  expect(await save(status('agent.output_lost', 1))).toBe('recorded');
}
it('reloads after recall wins the conditional append against a report batch',
  rejectsEvidenceDuringAppend);

async function excludesEarlierRepliesAfterColdReplay() {
  expect(await save(report())).toBe('recorded');
  await recall();
  expect(await save(status('agent.turn_completed', 2))).toBe('recorded');
  await humanMessage('bob-turn', 'bob');
  const bob = { ...report('agent.message_completed', 3), turnId: 'bob-turn', requesterId: 'bob',
    text: 'Bob memory-free reply' };
  expect(await save(bob)).toBe('recorded');
  const bobComplete = { ...status('agent.turn_completed', 4), turnId: 'bob-turn', requesterId: 'bob' };
  expect(await save(bobComplete)).toBe('recorded');
  await humanMessage('next', 'alice');
  const rows = await coldHistory();
  const current = rows.at(-1)!;
  const decryptions = vi.fn(decrypt);
  const aliceContext = privateContext(rows, current, 'alice', decryptions);
  expect(aliceContext?.exchanges).toMatchObject([
    { member: 'alice statement', assistant: [] },
  ]);
  expect(decryptions).toHaveBeenCalledTimes(1);
  const bobContext = privateContext(rows, current, 'bob', decrypt);
  expect(bobContext?.exchanges).toMatchObject([
    { member: 'bob statement', assistant: ['Bob memory-free reply'] },
  ]);
  expect(JSON.stringify([aliceContext, bobContext])).not.toContain(canary);
  await expect(save(report())).rejects.toThrow(refusal);
}
it('excludes replies saved before recall on cold replay and keeps each requester separate',
  excludesEarlierRepliesAfterColdReplay);

async function savesMemoryFreeReports() {
  const values = [report('agent.message_delta'), report('agent.message_delta', 2)];
  expect(await recordReports(setup.nats.store, setup.keys, context, values)).toBe('recorded');
  expect(await save(values[0])).toBe('duplicate');
  expect(await save(values[1])).toBe('duplicate');
  expect(await save(report('agent.reasoning_summarised', 3))).toBe('recorded');
  expect(await save(report('agent.message_completed', 4))).toBe('recorded');
  expect(await save(status('agent.turn_completed', 5))).toBe('recorded');
  await humanMessage('next', 'alice');
  const rows = await coldHistory();
  const rebuilt = privateContext(rows, rows.at(-1)!, 'alice', decrypt);
  expect(rebuilt?.exchanges).toMatchObject([
    { member: 'alice statement', assistant: [canary] },
  ]);
  expect(rows.filter(hasReport)).toHaveLength(4);
}
it('saves memory-free batches, reasoning and completed replies and rebuilds them',
  savesMemoryFreeReports);

async function permanentlyRefusesContent() {
  await recall();
  const sockets = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(sockets, 'listening');
  const address = sockets.address();
  if (!address || typeof address === 'string') throw new Error('Missing socket address');
  const connection = once(sockets, 'connection');
  const options = { silo: 'test', store: setup.nats.store, keys: setup.keys };
  const input = { url: `ws://127.0.0.1:${address.port}`, computerId: 'computer',
    assistantId: 'assistant', bearer: 'test' };
  const bridge = await connectBridge(options, input);
  await connection;
  const socket = [...sockets.clients][0]!;
  const acknowledged = Promise.withResolvers<unknown[]>();
  function receive(raw: RawData) {
    if (!Buffer.isBuffer(raw)) throw new Error('Unexpected test frame');
    const value: unknown = JSON.parse(raw.toString());
    if (value && typeof value === 'object' && 'type' in value && value.type === 'ack') {
      acknowledged.resolve(['ack']);
    }
  }
  socket.on('message', receive);
  try {
    const closed = once(socket, 'close');
    socket.send(JSON.stringify(report('agent.turn_completed')));
    const result: unknown[] = await Promise.race([closed, acknowledged.promise]);
    expect(result[0]).toBe(1008);
    expect(bridge.rejection).toBe(refusal);
    await assertNoReportSaved();
  } finally {
    socket.off('message', receive);
    bridge.socket.terminate();
    socket.terminate();
    await bridge.settled();
    sockets.close();
  }
}
it('permanently refuses text hidden on a bridge completion report', permanentlyRefusesContent);
