import { expect, it } from 'vitest';
import { natsFixture } from '@opencrane/event-store/testing';
import { type EventEnvelope } from '@opencrane/events';
import { createLogger } from '@opencrane/observability';
import { conversations, ProjectionRunner, readConversation } from '../src/index.ts';
import { database } from './database.ts';

async function replaysToolFeed() {
  const nats = await natsFixture();
  const storage = await database('pg');
  try {
    async function append(type: string, subject: string, data: unknown,
      correlation: EventEnvelope['correlation'] = {}) {
      const id = `event-${await nats.store.head()}`;
      const event = { id, commandId: id, type, subject, data, correlation,
        silo: 'test', source: 'test', principal: { kind: 'system', id: 'test' }, time: '2026-10-06T12:00:00Z' };
      const result = await nats.store.append({ event,
        expectedSequence: await nats.store.head(subject) });
      expect(result.status).toBe('appended');
    }
    await append('conversation.created', 'conversation-chat', {
      conversationId: 'chat', assistantId: 'assistant', createdBy: 'alice', mode: 'agent_session',
    });
    const decision = { requestId: 'request', requesterId: 'alice', assistantId: 'assistant',
      conversationId: 'chat', turnId: 'turn', callId: 'call_1', route: 'mcp', outcome: 'ask',
      reason: 'approval_requested', contextDigest: 'a'.repeat(64) };
    await append('decision.recorded', 'decision-request', decision, { approval: 'approval' });
    await append('decision.recorded', 'decision-allow', { ...decision,
      requestId: 'allow', outcome: 'allow', reason: 'policy_allow' });
    const { conversationId: _conversationId, ...withoutConversation } = decision;
    await append('decision.recorded', 'decision-unbound', withoutConversation);
    await append('decision.recorded', 'decision-model', { ...decision,
      requestId: 'model', route: 'model', outcome: 'allow', reason: 'budget_reserved' });
    await append('decision.recorded', 'decision-budget', { ...decision,
      requestId: 'budget', route: 'model', outcome: 'deny', reason: 'budget_exhausted' });
    const started = { conversationId: 'chat', turnId: 'turn', callId: 'call_1',
      serverId: 'fixture', toolName: 'write' };
    const finished = { ...started, status: 'completed', durationMs: 75 };
    await append('agent.tool_call_started', 'conversation-chat', started);
    await append('agent.tool_call_finished', 'conversation-chat', finished);
    const logger = createLogger('tool-feed', { level: 'silent' });
    const runner = new ProjectionRunner(storage.db, nats.reader, logger);
    await runner.initialise(conversations);
    await runner.run(conversations);
    const before = await readConversation(storage.db, 'test', 'chat');
    function rowData(row: (typeof before.rows)[number]) { return row.data; }
    expect(before.rows.map(rowData)).toEqual([
      { conversationId: 'chat', assistantId: 'assistant', createdBy: 'alice', mode: 'agent_session' },
      { turnId: 'turn', callId: 'call_1', outcome: 'ask', reason: 'approval_requested',
        requestId: 'request', approvalId: 'approval' },
      { turnId: 'turn', callId: 'call_1', outcome: 'allow', reason: 'policy_allow', requestId: 'allow' },
      { turnId: 'turn', reason: 'budget_exhausted' }, started, finished,
    ]);
    expect(before.rows[1]).toMatchObject({ id: 'event-1', position: 2,
      type: 'decision.recorded', time: '2026-10-06T12:00:00Z' });
    await runner.rebuild(conversations);
    expect((await readConversation(storage.db, 'test', 'chat')).rows).toEqual(before.rows);
  } finally {
    await storage.close();
    await nats.close();
  }
}
it('copies only safe MCP decision fields and rebuilds the same tool feed from events', replaysToolFeed);
