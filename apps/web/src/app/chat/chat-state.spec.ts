import type { ChatRow } from '@opencrane/protocol';
import { isBudgetStop, rejectedScreenshotIds, toolKind, transcript, turnOutcome,
  uploadedFile } from './chat-state';

it('keeps created and modified workspace files but omits deleted files', () => {
  const rows = [
    { id: 'message', position: 1, type: 'message.posted', time: '2026-10-04T10:00:00Z',
      data: { text: 'Update the report', authorId: 'me' } },
    { id: 'created', position: 2, type: 'agent.file_changed', time: '2026-10-04T10:01:00Z',
      data: { turnId: 'message', path: 'report.md', changeType: 'created' } },
    { id: 'deleted', position: 3, type: 'agent.file_changed', time: '2026-10-04T10:02:00Z',
      data: { turnId: 'message', path: 'old-report.md', changeType: 'deleted' } },
  ] as ChatRow[];

  const turns = transcript(rows, 'me');
  const agentTurn = turns.find(isAgentTurn);

  expect(agentTurn?.files).toEqual(['report.md']);
});

it('renders a rejected screenshot turn without exposing its file name', () => {
  const rows = [{ id: 'rejected', position: 1, type: 'file.rejected',
    time: '2026-10-02T10:42:01Z', data: {
      conversationId: 'chat', fileId: 'screen', uploadedBy: 'me', name: 'secret-name.png',
      size: 421888, sha256: 'hash', reason: 'infected',
      screenshot: { computerId: 'computer', generation: 4,
        capturedAt: '2026-10-02T10:42:00Z', width: 1440, height: 900 },
    } }] as ChatRow[];
  const turn = transcript(rows, 'me')[0];
  expect(turn?.screenshotRejected).toBe(true);
  expect(turn?.author).toBe('you');
  expect(turn?.files).toEqual([]);
  expect(JSON.stringify(turn)).not.toContain('secret-name.png');
  expect(rejectedScreenshotIds(rows)).toEqual(['screen']);
});

it('ignores rejected ordinary uploads and validates screenshot facts and size', () => {
  const rejected = [{ id: 'rejected-upload', position: 1, type: 'file.rejected',
    time: '2026-10-02T10:42:00Z', data: {
      conversationId: 'chat', fileId: 'upload', uploadedBy: 'me', name: 'brief.pdf',
      size: 100, sha256: 'hash', reason: 'infected',
    } }] as ChatRow[];
  expect(transcript(rejected, 'me')).toEqual([]);
  expect(rejectedScreenshotIds(rejected)).toEqual([]);
  const uploaded = { id: 'screen', position: 2, type: 'file.uploaded',
    time: '2026-10-02T10:42:00Z', data: {
      conversationId: 'chat', fileId: 'screen', uploadedBy: 'me', name: 'screen.png',
      size: 421888, mime: 'image/png',
      screenshot: { computerId: 'computer', generation: 4,
        capturedAt: '2026-10-02T10:42:00Z', width: 1440, height: 900 },
    } } as ChatRow;
  expect(uploadedFile(uploaded)).toMatchObject({ size: 421888,
    screenshot: { width: 1440, height: 900 } });
});

it('names transcript tool records without adding fields to them', () => {
  expect(toolKind({ id: 'failed', label: 'Reply failed', detail: 'Run interrupted',
    failed: true, time: '2026-10-04T10:00:00Z' })).toBe('Agent run');
  expect(toolKind({ id: 'command', label: 'Command completed', detail: 'Exit code 0',
    failed: false, time: '2026-10-04T10:00:00Z' })).toBe('Computer command');
  expect(toolKind({ id: 'call', callId: 'call-1', label: 'read_order',
    detail: 'Tool call completed', failed: false, status: 'completed',
    time: '2026-10-09T10:00:00Z' })).toBe('Governed tool call');
});

it('shows recorded native refusal with its request reference and no tool call', () => {
  const rows: ChatRow[] = [
    { id: 'message', position: 1, type: 'message.posted', time: '2026-10-16T10:00:00Z',
      data: { text: 'Help with this file', authorId: 'me' } },
    { id: 'refusal', position: 2, type: 'agent.native_consent_refused',
      time: '2026-10-16T10:00:01Z', data: { turnId: 'message', conversationId: 'chat',
        nativeRequestId: 'native-request-92', serverName: 'Files server',
        reason: 'unsupported_native_consent' } },
  ];
  const refusal = transcript(rows, 'me').find(isAgentTurn)?.tools[0];
  expect(refusal).toMatchObject({
    nativeRequestId: 'native-request-92', serverName: 'Files server', failed: true,
  });
  expect(refusal?.callId).toBeUndefined();
  expect(toolKind(refusal!)).toBe('Native consent request');
});

it('keeps a completed turn incomplete when the private reply output was lost', () => {
  const rows = [
    { id: 'message', position: 1, type: 'message.posted', time: '2026-10-06T10:00:00Z',
      data: { text: 'Review this', authorId: 'me' } },
    { id: 'started', position: 2, type: 'agent.turn_started', time: '2026-10-06T10:00:01Z',
      data: { turnId: 'message', executionMode: 'restricted' } },
    { id: 'lost', position: 3, type: 'agent.output_lost', time: '2026-10-06T10:01:00Z',
      data: { turnId: 'message' } },
    { id: 'completed', position: 4, type: 'agent.turn_completed', time: '2026-10-06T10:01:01Z',
      data: { turnId: 'message' } },
  ] as ChatRow[];

  const agentTurn = transcript(rows, 'me').find(isAgentTurn);

  expect(agentTurn?.state).toBe('lost');
  expect(agentTurn?.executionMode).toBe('restricted');
  expect(agentTurn?.text).toBe('');
});

it('keeps raw failure codes out of tool details', () => {
  const rows: ChatRow[] = [
    { id: 'request', position: 1, type: 'message.posted', time: '2026-10-06T10:02:00Z',
      data: { authorId: 'me', text: 'Request' } },
    { id: 'failed', position: 2, type: 'agent.turn_failed', time: '2026-10-06T10:03:00Z',
      data: { turnId: 'request', reason: 'computer_lost' } },
  ];
  const lost = transcript(rows, 'me').at(-1)!;
  expect(lost.reason).toBe('computer_lost');
  expect(lost.tools[0]?.detail).toBe('Computer was lost');
  rows[1]!.data.reason = 'model_error';
  expect(transcript(rows, 'me').at(-1)?.tools[0]?.detail).toBe('Run interrupted');
});

const completedToolCases = [
  { status: 'completed', failed: false, detail: 'Tool call completed' },
  { status: 'failed', failed: true, detail: 'Tool call failed' },
  { status: undefined, failed: false, detail: 'Tool call finished' },
 ] as const;

function assertFinishedToolState(
  toolCase: (typeof completedToolCases)[number],
): void {
  const { status, failed, detail } = toolCase;
  const rows: ChatRow[] = [
    { id: 'message', position: 1, type: 'message.posted', time: '2026-10-09T10:00:00Z',
      data: { authorId: 'me', text: 'Read the order' } },
    { id: 'started', position: 2, type: 'agent.tool_call_started',
      time: '2026-10-09T10:00:01Z', data: { turnId: 'message', callId: 'call-1',
        serverId: 'erp', toolName: 'read_order' } },
    { id: 'finished', position: 3, type: 'agent.tool_call_finished',
      time: '2026-10-09T10:00:02Z', data: { turnId: 'message', callId: 'call-1',
        serverId: 'erp', toolName: 'read_order', ...(status ? { status } : {}),
        durationMs: 240 } },
  ];

  const tool = transcript(rows, 'me').find(isAgentTurn)?.tools[0];

  expect(tool).toMatchObject({ id: 'started', callId: 'call-1', label: 'read_order',
    status: status ?? 'finished', failed, detail, durationMs: 240 });
  expect(tool?.time).toBe('2026-10-09T10:00:01Z');
}

it.each(completedToolCases)('updates live tool activity to $status', assertFinishedToolState);

it('keeps a finished tool visible when the saved history has no start row', () => {
  const rows: ChatRow[] = [
    { id: 'message', position: 1, type: 'message.posted', time: '2026-10-09T10:00:00Z',
      data: { authorId: 'me', text: 'Read the order' } },
    { id: 'finished', position: 2, type: 'agent.tool_call_finished',
      time: '2026-10-09T10:00:02Z', data: { turnId: 'message', callId: 'call-1',
        serverId: 'erp', toolName: 'read_order', status: 'completed' } },
  ];

  const tool = transcript(rows, 'me').find(isAgentTurn)?.tools[0];

  expect(tool).toMatchObject({ id: 'finished', label: 'read_order', status: 'completed',
    detail: 'Tool call completed' });
});

it('describes a restricted tool refusal without exposing its internal reason', () => {
  const rows: ChatRow[] = [
    { id: 'message', position: 1, type: 'message.posted', time: '2026-10-09T10:00:00Z',
      data: { authorId: 'me', text: 'Run the tool' } },
    { id: 'failed', position: 2, type: 'agent.turn_failed', time: '2026-10-09T10:00:01Z',
      data: { turnId: 'message', reason: 'restricted_tool_refused' } },
  ];

  const tool = transcript(rows, 'me').find(isAgentTurn)?.tools[0];

  expect(tool?.detail).toBe('Tool access refused');
  expect(JSON.stringify(tool)).not.toContain('restricted_tool_refused');
  expect(tool?.detail).not.toMatch(/no review/i);
});

it('ignores a late tool reply after the server ended the turn', () => {
  const rows: ChatRow[] = [
    { id: 'message', position: 1, type: 'message.posted', time: '2026-10-09T10:00:00Z',
      data: { authorId: 'me', text: 'Read the order' } },
    { id: 'started', position: 2, type: 'agent.tool_call_started',
      time: '2026-10-09T10:00:01Z', data: { turnId: 'message', callId: 'call-1',
        serverId: 'erp', toolName: 'read_order' } },
    { id: 'ended', position: 3, type: 'agent.turn_failed', time: '2026-10-09T10:00:02Z',
      data: { turnId: 'message', reason: 'bridge_interrupted' } },
    { id: 'late-finish', position: 4, type: 'agent.tool_call_finished',
      time: '2026-10-09T10:00:03Z', data: { turnId: 'message', callId: 'call-1',
        serverId: 'erp', toolName: 'read_order', status: 'completed' } },
  ];

  const turn = transcript(rows, 'me').find(isAgentTurn);

  expect(turn?.state).toBe('failed');
  const unconfirmedTool = turn?.tools.find(isCallOne);
  expect(unconfirmedTool).toMatchObject({
    status: 'unconfirmed', detail: 'No finish report was received before the turn ended',
  });
  expect(turn?.tools[0]?.failed).toBe(false);
  expect(turn?.tools[0]?.status).not.toBe('completed');
});

function isCallOne(tool: { callId?: string }): boolean {
  return tool.callId === 'call-1';
}

const endedTurnCases = [
  { eventType: 'agent.turn_completed', state: 'done' },
  { eventType: 'agent.turn_failed', state: 'failed' },
  { eventType: 'agent.output_lost', state: 'lost' },
] as const;

function assertUnconfirmedToolAfterEnd(
  turnCase: (typeof endedTurnCases)[number],
): void {
  const { eventType, state } = turnCase;
  const rows: ChatRow[] = [
    { id: 'message', position: 1, type: 'message.posted', time: '2026-10-09T10:00:00Z',
      data: { authorId: 'me', text: 'Read the order' } },
    { id: 'started', position: 2, type: 'agent.tool_call_started',
      time: '2026-10-09T10:00:01Z', data: { turnId: 'message', callId: 'call-1',
        serverId: 'erp', toolName: 'read_order' } },
    { id: 'ended', position: 3, type: eventType, time: '2026-10-09T10:00:02Z',
      data: { turnId: 'message' } },
  ];

  const agentTurn = transcript(rows, 'me').find(isAgentTurn);

  expect(agentTurn?.state).toBe(state);
  expect(agentTurn?.endedAt).toBe('2026-10-09T10:00:02Z');
  expect(agentTurn?.tools[0]?.status).toBe('unconfirmed');
  expect(agentTurn?.tools[0]?.failed).toBe(false);
}

it.each(endedTurnCases)(
  'marks an unfinished tool unconfirmed when its turn ends',
  assertUnconfirmedToolAfterEnd,
);

it('keeps a stop request pending and accepts tool finishes until the turn ends', () => {
  const rows: ChatRow[] = [
    { id: 'message', position: 1, type: 'message.posted', time: '2026-10-09T10:00:00Z',
      data: { authorId: 'me', text: 'Read the order' } },
    { id: 'started', position: 2, type: 'agent.tool_call_started',
      time: '2026-10-09T10:00:01Z', data: { turnId: 'message', callId: 'call-1',
        serverId: 'erp', toolName: 'read_order' } },
    { id: 'stop-requested', position: 3, type: 'agent.turn_stop_requested',
      time: '2026-10-09T10:00:02Z', data: { turnId: 'message' } },
    { id: 'finished', position: 4, type: 'agent.tool_call_finished',
      time: '2026-10-09T10:00:03Z', data: { turnId: 'message', callId: 'call-1',
        serverId: 'erp', toolName: 'read_order', status: 'completed' } },
  ];

  const turn = transcript(rows, 'me').find(isAgentTurn);

  expect(turn?.state).toBe('working');
  expect(turn?.endedAt).toBeUndefined();
  expect(turn?.tools[0]?.status).toBe('completed');

  rows.push({ id: 'ended', position: 5, type: 'agent.turn_failed',
    time: '2026-10-09T10:00:04Z', data: { turnId: 'message' } });
  const stoppedTurn = transcript(rows, 'me').find(isAgentTurn);
  expect(stoppedTurn?.state).toBe('stopped');
  expect(stoppedTurn?.endedAt).toBe('2026-10-09T10:00:04Z');
});

it('does not restore a saved Stop request as Stopping after reload', () => {
  const rows: ChatRow[] = [
    { id: 'message', position: 1, type: 'message.posted', time: '2026-10-09T10:00:00Z',
      data: { authorId: 'me', text: 'Read the order' } },
    { id: 'stop-requested', position: 2, type: 'agent.turn_stop_requested',
      time: '2026-10-09T10:00:02Z', data: { turnId: 'message' } },
  ];

  const reloadedTurn = transcript(rows, 'me').find(isAgentTurn);

  expect(reloadedTurn?.state).toBe('working');
  expect(reloadedTurn?.stopRequested).toBe(true);
});

it('marks only the matching budget stop and ends work that never started', () => {
  const rows: ChatRow[] = [
    { id: 'first', position: 1, type: 'message.posted', time: '2026-10-09T10:00:00Z',
      data: { authorId: 'me', text: 'First' } },
    { id: 'manual', position: 2, type: 'agent.turn_stop_requested',
      time: '2026-10-09T10:00:01Z', data: { turnId: 'first', reason: 'requester_stop' } },
    { id: 'second', position: 3, type: 'message.posted', time: '2026-10-09T10:00:02Z',
      data: { authorId: 'me', text: 'Second' } },
    { id: 'budget', position: 4, type: 'agent.turn_stop_requested',
      time: '2026-10-09T10:00:03Z', data: { turnId: 'second', reason: 'budget' } },
  ];
  const turns = transcript(rows, 'me').filter(isAgentTurn);
  expect(isBudgetStop(rows[1]!)).toBe(false);
  expect(isBudgetStop(rows[3]!)).toBe(true);
  expect(turns[0]?.budgetStop).toBeUndefined();
  expect(turns[1]?.budgetStop).toBe('budget_exhausted');
  expect(turns[1]?.state).toBe('stopped');
  expect(turns[1]?.endedAt).toBe('2026-10-09T10:00:03Z');
  expect(turns[1]).not.toHaveProperty('endReportedAt');
  expect(turnOutcome(turns[1]!)).toBe('Stopped · nothing was repeated');
  rows.push({ id: 'ended', position: 5, type: 'agent.turn_failed',
    time: '2026-10-09T10:00:04Z', data: { turnId: 'second' } });
  expect(transcript(rows, 'me').filter(isAgentTurn)[1]?.endedAt)
    .toBe('2026-10-09T10:00:03Z');
  expect(transcript(rows, 'me').filter(isAgentTurn)[1])
    .toHaveProperty('endReportedAt', '2026-10-09T10:00:04Z');
  rows.push({ id: 'later-end', position: 6, type: 'agent.turn_completed',
    time: '2026-10-09T10:00:05Z', data: { turnId: 'second' } });
  expect(transcript(rows, 'me').filter(isAgentTurn)[1])
    .toHaveProperty('endReportedAt', '2026-10-09T10:00:04Z');
});

it('shows started budget work as stopping until its ending report arrives', () => {
  const rows: ChatRow[] = [
    { id: 'message', position: 1, type: 'message.posted',
      time: '2026-10-09T10:00:00Z', data: { authorId: 'me', text: 'Work' } },
    { id: 'started', position: 2, type: 'agent.turn_started',
      time: '2026-10-09T10:00:01Z', data: { turnId: 'message' } },
    { id: 'stop', position: 3, type: 'agent.turn_stop_requested',
      time: '2026-10-09T10:00:02Z', data: { turnId: 'message', reason: 'budget' } },
  ];
  expect(transcript(rows, 'me').find(isAgentTurn)?.state).toBe('stopping');
  rows.push({ id: 'ended', position: 4, type: 'agent.turn_failed',
    time: '2026-10-09T10:00:03Z', data: { turnId: 'message' } });
  const stoppedTurn = transcript(rows, 'me').find(isAgentTurn);
  expect(stoppedTurn?.state).toBe('stopped');
  expect(stoppedTurn?.tools).toEqual([]);
});

it('keeps a completed turn completed when a late Stop request is replayed', () => {
  const rows: ChatRow[] = [
    { id: 'message', position: 1, type: 'message.posted', time: '2026-10-09T10:00:00Z',
      data: { authorId: 'me', text: 'Read the order' } },
    { id: 'ended', position: 2, type: 'agent.turn_completed',
      time: '2026-10-09T10:00:01Z', data: { turnId: 'message' } },
    { id: 'stop-requested', position: 3, type: 'agent.turn_stop_requested',
      time: '2026-10-09T10:00:02Z', data: { turnId: 'message' } },
  ];

  const completedTurn = transcript(rows, 'me').find(isAgentTurn);

  expect(completedTurn?.state).toBe('done');
});

function isAgentTurn(turn: { author: string }): boolean {
  return turn.author === 'agent';
}
