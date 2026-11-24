import { z } from 'zod';
import { envelope, history } from '@opencrane/models';

import { encodeSession } from '@opencrane/auth';
import { testAuthConfig } from '@opencrane/auth/testing';
import { approvalCardsSchema } from '@opencrane/protocol';
import { auditTrail, conversations } from '@opencrane/projections';

import { buildServer } from '../../src/server.ts';
import { expect } from 'vitest';
import { grantStream } from '@opencrane/authz';
import { catalogueEvidence, fixture, reviewCatalogue,
  toolEvidence } from '@opencrane/models/testing';
export async function approvalFixture(stepUp = false,
  retainedCall?: () => Promise<{ approvalId: string; turnId: string;
    callId: string; conversationId: string; computerId: string; generation: number;
    serverId: string; connectionId: string; toolName: string;
    expiresAt: string } | undefined>, readOnly = false) {
  const setup = await fixture();
  await setup.runner.initialise(conversations);
  await setup.runner.run(conversations);
  await setup.runner.initialise(auditTrail);
  await setup.runner.run(auditTrail);
  const config = testAuthConfig({ expectedOrgId: 'org-test' });
  const chat = { silo: 'test', store: setup.nats.store, db: setup.db, binding: setup.binding, feed: { memberId: identity },
    ...(retainedCall ? { retainedCall } : {}) };
  function identity(_silo: string, _issuer: string, sub: string) {
    return Promise.resolve(sub);
  }
  let app = buildServer(config, { chat, readOnly });
  async function restartReader() {
    await app.close();
    app = buildServer(config, { chat, readOnly });
  }
  const headers = (sub = 'alice', authTime = 0, approval?: string) => ({ origin: new URL(config.redirectUri).origin,
    cookie: `${config.cookieName}=${encodeSession(config, { sub, orgId: 'org-test', roles: [], authTime,
      exp: Math.floor(Date.now() / 1000) + 3600, ...(approval ? { stepUpApproval: approval } : {}) })}` });
  await setup.append('mcp-fixture', 'mcp.server_registered', { serverId: 'fixture', kind: 'remote', locator: 'https://fixture.example.test/mcp', registeredBy: 'alice' });
  const tool = toolEvidence({ name: 'write', reviewed: true, costCents: 0 });
  function discover(stepUp: boolean) {
    const review = { action: 'Update order note', consequence: 'The order note changes immediately.',
      targetArgument: 'order', fields: ['order', 'note', 'amount'], stepUp };
    const reviewedTool = { ...tool, review };
    const catalogue = catalogueEvidence([reviewedTool]);
    const data = { serverId: 'fixture', connectionId: 'installed', accountMode: 'none',
      ...catalogue };
    return setup.append('mcp-fixture', 'mcp.server_discovered', data);
  }
  await discover(stepUp);
  await reviewCatalogue(setup);
  await setup.append('mcp-fixture', 'mcp.tool_mode_set', { serverId: 'fixture', connectionId: 'installed', toolName: 'write', toolRevision: tool.revision, mode: 'ask', setBy: 'alice' });
  await setup.append('mcp-fixture', 'mcp.server_published', { serverId: 'fixture', publishedBy: 'alice' });
  for (const [granteeId, granteeKind] of [['alice', 'member'], ['assistant', 'assistant']]) {
    const event = await setup.append(grantStream('mcp_server', 'fixture'), 'grant.given', { resourceType: 'mcp_server', resourceId: 'fixture', granteeId, granteeKind, grantedBy: 'alice' });
    await setup.auth.handler.handle(event, setup.db);
  }
  function body(args = '{"order":9007199254740993,"note":"hello","amount":1.00e2}') {
    const metadata = {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientCapabilities': {},
      threadId: 'thread', callId: 'approval-call',
    };
    const encodedMetadata = JSON.stringify(metadata);
    const parameters = `{"name":"write","arguments":${args},"_meta":${encodedMetadata}}`;
    return `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":${parameters}}`;
  }
  const call = async (args?: string, extra = {}, raw = body(args)) => {
    const response = await fetch(`http://127.0.0.1:${setup.options.port}/mcp/fixture/installed`, { method: 'POST', headers: { ...setup.headers,
      'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call', 'mcp-name': 'write', ...extra }, body: raw });
    return { status: response.status, text: await response.text() };
  };
  const url = '/api/conversations/conversation/approvals';
  const read = async (session = headers()) => {
    const response = await app.inject({ url, headers: session });
    expect(response.statusCode).toBe(200);
    return z.object({ cards: approvalCardsSchema, csrf: z.string() }).parse(response.json());
  };
  const decide = async (decision = 'approved', session = headers(), patch = {}) => {
    const { cards, csrf } = await read(session);
    return app.inject({ method: 'POST', url, headers: { ...session, 'x-csrf-token': csrf }, payload: { approvalId: cards[0]!.approvalId, decision, ...patch } });
  };
  async function close() {
    await app.close();
    await setup.close();
  }
  return { ...setup, config, restartReader, headers, read, decide, call, body, discover, close,
    get app() {
      return app;
    },
  };
}

type ApprovalFixture = Awaited<ReturnType<typeof approvalFixture>>;

export async function seedLongConversation(setup: ApprovalFixture, messageCount = 5000) {
  const messages = [];
  for (let index = 0; index < messageCount; index++) {
    const data = { conversationId: 'conversation', authorId: 'alice', authorKind: 'human',
      contentType: 'text', utterance: 'Earlier message' };
    messages.push(envelope('test', 'conversation-conversation', 'message.posted', data));
  }
  await setup.nats.seed(messages);
  await seedMessageProjection(setup, messages);
  const turn = { assistantId: 'assistant', computerId: 'computer',
    conversationId: 'conversation', turnId: 'long-turn', threadId: 'thread',
    requesterId: 'alice', task: 'chat_turn', payingGroupId: 'personal-default' };
  await setup.append('computer-assistant', 'computer.turn_started', turn);
  const started = { conversationId: 'conversation', assistantId: 'assistant',
    turnId: 'long-turn' };
  await setup.append('conversation-conversation', 'agent.turn_started', started);
  const claims = { ...setup.t, turn: 'long-turn' };
  const token = await setup.sign(claims, 'decision-service');
  const headers = { 'x-turn-token': token };
  return headers;
}

async function seedMessageProjection(setup: ApprovalFixture,
  messages: ReturnType<typeof envelope>[]) {
  const throughPosition = await setup.nats.store.head();
  const fromPosition = throughPosition - messages.length;
  const rows: { position: number; event_id: string; type: string;
    data: unknown; time: string }[] = [];
  for (const [index, event] of messages.entries()) {
    const row = { position: fromPosition + index + 1, event_id: event.id,
      type: event.type, data: event.data, time: event.time };
    rows.push(row);
  }
  // Seed identical earlier messages in bulk. The measured decision still reads real NATS events.
  // Keep these fixture tables and their position together, as the projection runner does.
  async function saveProjection(tx: Parameters<Parameters<typeof setup.db.transaction>[0]>[0]) {
    const parameters = [JSON.stringify(rows)];
    await tx.query(`INSERT INTO conversation_feed
      SELECT 'test', 'conversation', position, event_id, type, data, time
      FROM jsonb_to_recordset($1::jsonb)
        AS row(position BIGINT, event_id TEXT, type TEXT, data JSONB, time TEXT)`, parameters);
    await tx.query(`INSERT INTO decision_conversation_events
      SELECT 'test', 'conversation', position, event_id, type, NULL
      FROM jsonb_to_recordset($1::jsonb) AS row(position BIGINT, event_id TEXT, type TEXT)`,
    parameters);
    await tx.query(`UPDATE decision_conversation_coverage
      SET event_count=event_count+$1, position=$2
      WHERE silo='test' AND conversation_id='conversation'`,
    [messages.length, throughPosition]);
    await tx.query(`INSERT INTO projection_events
      SELECT 'conversations', event_id FROM jsonb_to_recordset($1::jsonb)
        AS row(event_id TEXT)`, parameters);
    const saved = await tx.query(`UPDATE projection_checkpoints SET sequence=$1
      WHERE name='conversations' AND sequence=$2 RETURNING sequence`,
    [throughPosition, fromPosition]);
    expect(saved.rows).toHaveLength(1);
  }
  await setup.db.transaction(saveProjection);
}

export async function prepareLongConversation(setup: ApprovalFixture) {
  const headers = await seedLongConversation(setup);
  const response = await setup.call(undefined, headers);
  expect(response.status, response.text).toBe(403);
  const rows = await history(setup.nats.store, 'conversation-conversation', 'test');
  function isMessage(row: typeof rows[number]) {
    return row.event.type === 'message.posted';
  }
  const savedMessages = rows.filter(isMessage);
  expect(savedMessages).toHaveLength(5000);
}
