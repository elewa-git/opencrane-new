import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { natsFixture } from '@opencrane/event-store/testing';
import { chatCommand, chatHistory } from '../src/chat/commands.ts';
import { conversationKeys } from '../src/chat/keys.ts';
import { recordReport } from '../src/chat/reports.ts';

async function recordsToolReportsOnce() {
  const nats = await natsFixture();
  const directory = await mkdtemp(`${tmpdir()}/tool-reports-`);
  try {
    const keys = conversationKeys(directory);
    keys.provision('test', 'chat');
    const person = { silo: 'test', memberId: 'alice' };
    await chatCommand(nats.store, keys, person,
      { id: 'create', conversationId: 'chat', assistantId: 'assistant' });
    await chatCommand(nats.store, keys, person,
      { id: 'message', conversationId: 'chat', text: 'Use a tool' });
    const context = { silo: 'test', computerId: 'computer', assistantId: 'assistant' };
    const started = { sequence: 1, conversationId: 'chat', turnId: 'message',
      assistantId: 'assistant', type: 'agent.tool_call_started',
      callId: 'call_1', serverId: 'fixture', toolName: 'write' };
    const finished = { ...started, sequence: 2, type: 'agent.tool_call_finished',
      status: 'completed', durationMs: 75 };
    for (const report of [started, finished]) {
      await expect(recordReport(nats.store, keys, context, report)).resolves.toBe('recorded');
      await expect(recordReport(nats.store, keys, context, report)).resolves.toBe('duplicate');
    }
    await expect(recordReport(nats.store, keys, context,
      { ...finished, status: 'failed' })).rejects.toThrow('Report sequence reused');
    const rows = await chatHistory(nats.store, 'test', 'chat');
    const toolRows = rows.slice(2);
    expect(toolRows.map(toolReportData)).toEqual([
      { conversationId: 'chat', turnId: 'message', callId: 'call_1',
        serverId: 'fixture', toolName: 'write' },
      { conversationId: 'chat', turnId: 'message', callId: 'call_1',
        serverId: 'fixture', toolName: 'write', status: 'completed', durationMs: 75 },
    ]);
    const next = { ...finished, sequence: 3 };
    const invalidReports = [
      { ...next, arguments: { private: 'text' } }, { ...next, result: 'private' },
      { ...next, error: 'private' }, { ...next, callId: 'bad/id' },
      { ...next, serverId: '' }, { ...next, toolName: 'x'.repeat(201) },
      { ...next, status: 'inProgress' }, { ...next, durationMs: -1 },
      { ...next, durationMs: 1.5 }, { ...next, callId: undefined },
      { ...next, type: 'agent.tool_call_started', status: undefined, durationMs: undefined,
        toolName: undefined },
    ];
    for (const report of invalidReports) {
      await expect(recordReport(nats.store, keys, context, report)).rejects.toThrow();
    }
    expect(await nats.store.head()).toBe(4);
  } finally {
    await nats.close();
    await rm(directory, { recursive: true, force: true });
  }
}
function toolReportData(row: Awaited<ReturnType<typeof chatHistory>>[number]) {
  return row.event.data;
}
it('records tool progress once and refuses private payloads or invalid fields', recordsToolReportsOnce);
