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
      callId: 'functions.write:0', serverId: 'fixture', toolName: 'write' };
    const finished = { ...started, sequence: 2, type: 'agent.tool_call_finished',
      status: 'completed', durationMs: 75 };
    const consent = { sequence: 3, conversationId: 'chat', turnId: 'message',
      assistantId: 'assistant', type: 'agent.native_consent_refused', nativeRequestId: '17',
      serverName: 'oc_0123456789', serverId: 'fixture', reason: 'unsupported_native_consent' };
    const native = { sequence: 4, conversationId: 'chat', turnId: 'message',
      assistantId: 'assistant', type: 'agent.native_request_refused', nativeRequestId: '19',
      requestKind: 'shell', outcome: 'declined' };
    for (const field of ['callId', 'command', 'extra']) {
      const invalid = { ...native, [field]: 'PRIVATE_NATIVE_MARKER' };
      await expect(recordReport(nats.store, keys, context, invalid)).rejects.toThrow();
    }
    for (const report of [started, finished, consent, native]) {
      await expect(recordReport(nats.store, keys, context, report)).resolves.toBe('recorded');
      await expect(recordReport(nats.store, keys, context, report)).resolves.toBe('duplicate');
    }
    await expect(recordReport(nats.store, keys, context,
      { ...finished, status: 'failed' })).rejects.toThrow('Report sequence reused');
    const rows = await chatHistory(nats.store, 'test', 'chat');
    const toolRows = rows.slice(2);
    expect(toolRows.map(toolReportData)).toEqual([
      { conversationId: 'chat', turnId: 'message', callId: 'functions.write:0',
        serverId: 'fixture', toolName: 'write' },
      { conversationId: 'chat', turnId: 'message', callId: 'functions.write:0',
        serverId: 'fixture', toolName: 'write', status: 'completed', durationMs: 75 },
      { conversationId: 'chat', turnId: 'message', nativeRequestId: '17',
        serverName: 'oc_0123456789', serverId: 'fixture', reason: 'unsupported_native_consent' },
      { conversationId: 'chat', turnId: 'message', nativeRequestId: '19',
        requestKind: 'shell', outcome: 'declined' },
    ]);
    expect(JSON.stringify(rows)).not.toContain('PRIVATE_NATIVE_MARKER');
    const next = { ...finished, sequence: 5 };
    const invalidReports = [
      { ...next, arguments: { private: 'text' } }, { ...next, result: 'private' },
      { ...next, error: 'private' }, { ...next, callId: 'bad\nid' },
      { ...next, serverId: '' }, { ...next, toolName: 'x'.repeat(201) },
      { ...next, callId: '' }, { ...next, callId: 'x'.repeat(201) },
      { ...next, toolName: '' }, { ...next, toolName: 'write\n' },
      { ...next, status: 'inProgress' }, { ...next, durationMs: -1 },
      { ...next, durationMs: 1.5 }, { ...next, callId: undefined },
      { ...next, type: 'agent.tool_call_started', status: undefined, durationMs: undefined,
        toolName: undefined },
    ];
    for (const report of invalidReports) {
      await expect(recordReport(nats.store, keys, context, report)).rejects.toThrow();
    }
    expect(await nats.store.head()).toBe(6);
  } finally {
    await nats.close();
    await rm(directory, { recursive: true, force: true });
  }
}
function toolReportData(row: Awaited<ReturnType<typeof chatHistory>>[number]) {
  return row.event.data;
}
it('records tool progress once and refuses private payloads or invalid fields', recordsToolReportsOnce);

async function refusesUnrequestedToolReport(change: Record<string, unknown>, reason: string) {
  const nats = await natsFixture();
  const directory = await mkdtemp(`${tmpdir()}/unrequested-tool-report-`);
  try {
    const keys = conversationKeys(directory);
    const person = { silo: 'test', memberId: 'alice' };
    keys.provision('test', 'chat');
    keys.provision('test', 'other');
    const chats = [{ conversationId: 'chat', assistantId: 'assistant' },
      { conversationId: 'other', assistantId: 'other-assistant' }];
    for (const chat of chats) {
      const create = { id: `create-${chat.conversationId}`, ...chat };
      await chatCommand(nats.store, keys, person, create);
      const message = { id: `message-${chat.conversationId}`,
        conversationId: chat.conversationId, text: 'Use a tool' };
      await chatCommand(nats.store, keys, person, message);
    }
    const context = { silo: 'test', computerId: 'computer', assistantId: 'assistant' };
    const report = { sequence: 1, previousSequence: 0, conversationId: 'chat',
      turnId: 'message-chat', assistantId: 'assistant', type: 'agent.tool_call_started',
      callId: 'call_1', serverId: 'fixture', toolName: 'write', ...change };
    const before = await nats.store.head();
    await expect(recordReport(nats.store, keys, context, report)).rejects.toThrow(reason);
    expect(await nats.store.head()).toBe(before);
  } finally {
    await nats.close();
    await rm(directory, { recursive: true, force: true });
  }
}
const forgedReports = [
  { change: { assistantId: 'forged' }, reason: 'Assistant mismatch' },
  { change: { turnId: 'message-other' }, reason: 'Unrequested report' },
  { change: { conversationId: 'other', turnId: 'message-other' }, reason: 'Unrequested report' },
];
async function refusesForgedReport(test: (typeof forgedReports)[number]) {
  await refusesUnrequestedToolReport(test.change, test.reason);
}
it.each(forgedReports)('refuses a forged tool report $change without appending', refusesForgedReport);

async function recordsTerminalCause(reason: string) {
  const nats = await natsFixture();
  const directory = await mkdtemp(`${tmpdir()}/terminal-cause-`);
  try {
    const keys = conversationKeys(directory);
    keys.provision('test', 'chat');
    const person = { silo: 'test', memberId: 'alice' };
    await chatCommand(nats.store, keys, person,
      { id: 'create', conversationId: 'chat', assistantId: 'assistant' });
    await chatCommand(nats.store, keys, person,
      { id: 'message', conversationId: 'chat', text: 'Reply' });
    const context = { silo: 'test', computerId: 'computer', assistantId: 'assistant' };
    const report = { sequence: 1, conversationId: 'chat', turnId: 'message',
      assistantId: 'assistant', type: 'agent.turn_failed', reason };
    expect(await recordReport(nats.store, keys, context, report)).toBe('recorded');
    expect(await recordReport(nats.store, keys, context, report)).toBe('duplicate');
    const rows = await chatHistory(nats.store, 'test', 'chat');
    expect(rows.at(-1)?.event.data).toEqual({ conversationId: 'chat', turnId: 'message',
      reason });
  } finally {
    await nats.close();
    await rm(directory, { recursive: true, force: true });
  }
}

it.each(['stop_interrupted', 'model_error', 'bridge_interrupted'])(
  'saves and recognises a repeated terminal report with reason %s', recordsTerminalCause);
