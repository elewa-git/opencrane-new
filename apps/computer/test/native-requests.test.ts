import capture from './fixtures/codex-0.159.2-on-request.json' with { type: 'json' };
import saved from './fixtures/codex-0.159.2-saved-thread.json' with { type: 'json' };
import { expect, it, vi } from 'vitest';
import { fixture } from './bridge-gate-fixture.ts';
import { nativeRequests } from '../src/native-requests.ts';

function answersCapturedRequests() {
  expect(capture.nativeRequests.length).toBeGreaterThan(0);
  const replies: unknown[] = [];
  const reports: unknown[] = [];
  function send(reply: unknown) { replies.push(reply); }
  function record(message: unknown) { reports.push(message); }
  const handle = nativeRequests(send, record);
  for (const entry of capture.nativeRequests) {
    expect(handle(entry.message)).toBe(true);
    expect(handle(entry.message)).toBe(true);
    expect(replies.at(-1)).toEqual(entry.reply);
  }
  expect(replies).toHaveLength(capture.nativeRequests.length);
  expect(reports).toHaveLength(replies.length);
  expect(handle({ method: 'turn/completed', params: {} })).toBe(false);
  const unknown = { id: 'unknown', method: 'future/request', params: {} };
  handle(unknown);
  handle(unknown);
  expect(replies.at(-1)).toEqual({ id: 'unknown', error: {
    code: -32601, message: 'Native request is not supported',
  } });
  expect(replies).toHaveLength(capture.nativeRequests.length + 1);
}
it('answers real captured requests and unknown methods exactly once per id', answersCapturedRequests);

function refusesPrivateRequests() {
  const replies: unknown[] = [];
  function send(reply: unknown) { replies.push(reply); }
  function report() {}
  const handle = nativeRequests(send, report, true);
  const request = { id: 1, method: 'item/commandExecution/requestApproval', params: {} };
  handle(request);
  handle(request);
  expect(replies).toEqual([{ id: 1, error: {
    code: -32601, message: 'Not available in a private turn',
  } }]);
}
it('keeps one unsupported reply for a private session', refusesPrivateRequests);

async function answersWithoutActiveTurn(state: string) {
  const test = await fixture();
  const replies: unknown[] = [];
  function send(reply: unknown) { replies.push(reply); }
  const handle = nativeRequests(send, test.channel.notification, state === 'private');
  const stdout = vi.spyOn(process.stdout, 'write');
  const stderr = vi.spyOn(process.stderr, 'write');
  try {
    if (state === 'ended' || state === 'gated') {
      test.start('first');
      function started() { expect(test.calls).toContain('turn/start:thread-1'); }
      await vi.waitFor(started);
      if (state === 'ended') test.finish('thread-1');
      else test.send(await test.signedGate());
      await test.flush();
    }
    const request = { id: 23, method: 'item/commandExecution/requestApproval', params: {
      threadId: 'thread-1', turnId: 'codex-thread-1', command: 'PRIVATE_NATIVE_MARKER',
    } };
    handle(request);
    handle(request);
    await test.flush();
    if (state === 'private') {
      expect(replies).toEqual([{ id: 23, error: {
        code: -32601, message: 'Not available in a private turn',
      } }]);
    } else {
      expect(replies).toEqual([{ id: 23, result: { decision: 'decline' } }]);
    }
    expect(JSON.stringify(test.frames)).not.toContain('agent.native_request_refused');
    expect(JSON.stringify(test.frames)).not.toContain('PRIVATE_NATIVE_MARKER');
    expect(JSON.stringify(stdout.mock.calls)).not.toContain('PRIVATE_NATIVE_MARKER');
    expect(JSON.stringify(stderr.mock.calls)).not.toContain('PRIVATE_NATIVE_MARKER');
    test.finish('thread-1');
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
    await test.close();
  }
}
it.each(['absent', 'ended', 'gated', 'private'])(
  'answers once without recording when the turn is %s', answersWithoutActiveTurn);

function ignoresNonStringMethod() {
  const send = vi.fn();
  const report = vi.fn();
  const handle = nativeRequests(send, report);
  expect(handle({ id: 31, method: 42 })).toBe(false);
  expect(send).not.toHaveBeenCalled();
  expect(report).not.toHaveBeenCalled();
  expect(handle({ id: 31, method: 'future/request' })).toBe(true);
  expect(send).toHaveBeenCalledTimes(1);
}
it('ignores a non-string method without consuming its request id', ignoresNonStringMethod);

function capturesProductionPatchTool() {
  function isPatch(observation: (typeof capture.observations)[number]) {
    return observation.name === 'file_change';
  }
  const patch = capture.observations.find(isPatch);
  expect(patch?.offeredTools).toContain('apply_patch');
}
it('captures the production patch tool offered by the routed model', capturesProductionPatchTool);

type SavedRequest = (typeof saved.nativeRequests)[number];
const mcpApproval = 'mcpServer/elicitation/request';
const expectedSavedRequests = [
  { stage: 'mcp', id: 0, method: mcpApproval, kind: 'mcp_tool_call' },
  { stage: 'loaded_resume_mcp', id: 1, method: mcpApproval, kind: 'mcp_tool_call' },
  { stage: 'reloaded_mcp', id: 2, method: mcpApproval, kind: 'mcp_tool_call' },
  { stage: 'loaded_accept', id: 3, method: mcpApproval, kind: 'mcp_tool_call' },
  { stage: 'reloaded_accept', id: 4, method: mcpApproval, kind: 'mcp_tool_call' },
  { stage: 'fixture_escalated_shell', id: 5,
    method: 'item/commandExecution/requestApproval', kind: 'command' },
  { stage: 'fixture_file_change', id: 6,
    method: 'item/fileChange/requestApproval', kind: 'file_change' },
];

function checkSavedObservation(captured: typeof saved, entry: SavedRequest) {
  function matches(observation: (typeof saved.observations)[number]) {
    return observation.name === entry.stage;
  }
  const observations = captured.observations.filter(matches);
  expect(observations).toHaveLength(1);
  const observation = observations[0]!;
  expect(observation).toMatchObject({ result: 'PASS', requests: 1 });
  expect(observation.continuation).toHaveLength(1);
  expect(observation.continuation[0]?.call_id).toBe(`call_${entry.stage}`);
  const continuation = JSON.stringify(observation.continuation);
  if (entry.stage.endsWith('_accept')) {
    expect(continuation).toContain('The turn could not get a new pass. Nothing was sent.');
  } else if (entry.message.method === mcpApproval) {
    expect(continuation).toContain('user rejected MCP tool call');
  } else {
    expect(observation.markerPresent).toBe(false);
    expect(continuation).toContain('rejected by user');
  }
  function startsTurn(rpc: (typeof saved.rpc)[number]) {
    return rpc.stage === entry.stage && rpc.method === 'turn/start';
  }
  const starts = captured.rpc.filter(startsTurn);
  expect(starts).toHaveLength(1);
  expect(starts[0]?.params.threadId).toBe(entry.message.params.threadId);
}

function checkSavedDecision(captured: typeof saved, entry: SavedRequest) {
  function matches(decision: (typeof saved.gatewayAsk.decisions)[number]) {
    return decision.name === entry.stage;
  }
  const decisions = captured.gatewayAsk.decisions.filter(matches);
  expect(decisions).toHaveLength(1);
  const decision = decisions[0]!;
  expect(decision).toMatchObject({ decision: 'rejected', beforeDecision: 0,
    afterDecision: 0, nativeRequestId: entry.message.id,
    threadId: entry.message.params.threadId, turnId: entry.message.params.turnId });
  expect(decision.approvalId).toMatch(/^[a-f0-9]{64}$/u);
}

function checksSavedCapture(captured: typeof saved) {
  expect(captured.nativeRequests).toHaveLength(expectedSavedRequests.length);
  const replies: unknown[] = [];
  const reports: unknown[] = [];
  function send(reply: unknown) {
    replies.push(reply);
  }
  function record(message: unknown) {
    reports.push(message);
  }
  const handle = nativeRequests(send, record);
  for (const expected of expectedSavedRequests) {
    function matches(entry: SavedRequest) {
      return entry.stage === expected.stage;
    }
    const entries = captured.nativeRequests.filter(matches);
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    expect(entry.message).toMatchObject({ id: expected.id, method: expected.method });
    const params = entry.message.params;
    if (expected.kind === 'mcp_tool_call') {
      expect(params._meta?.codex_approval_kind).toBe(expected.kind);
      expect(params.serverName).toBe('oc_aaaaaaaaaa');
    } else if (expected.kind === 'command') {
      expect(params.kind).toBe(expected.kind);
    } else {
      expect(params.itemId).toBe('call_fixture_file_change');
      expect(params.kind).toBeUndefined();
    }
    expect(entry.repliesPerId).toBe(1);
    checkSavedObservation(captured, entry);
    if (entry.stage.endsWith('_accept')) {
      expect(entry.reply).toEqual({ id: entry.message.id, result: { action: 'accept' } });
      checkSavedDecision(captured, entry);
      continue;
    }
    const before = replies.length;
    expect(handle(entry.message)).toBe(true);
    expect(handle(entry.message)).toBe(true);
    expect(replies).toHaveLength(before + 1);
    expect(replies.at(-1)).toEqual(entry.reply);
    expect(reports).toHaveLength(replies.length);
    expect(reports.at(-1)).toEqual(entry.message);
  }
  for (const observation of captured.observations) {
    function matches(entry: SavedRequest) {
      return entry.stage === observation.name;
    }
    const requests = captured.nativeRequests.filter(matches);
    expect(observation.requests).toBe(requests.length);
  }
  expect(captured.gatewayAsk).toMatchObject({ result: 'PASS',
    beforeDecision: 0, afterDecision: 0 });
  expect(captured.gatewayAsk.decisions).toHaveLength(2);
  const approvalIds = new Set<string>();
  for (const decision of captured.gatewayAsk.decisions) {
    approvalIds.add(decision.approvalId);
  }
  expect(approvalIds.size).toBe(2);
}
function checksCommittedSavedCapture() {
  checksSavedCapture(saved);
}
it('replays real fixture declines once and keeps both saved-thread calls behind Ask',
  checksCommittedSavedCapture);

function rejectsMissingSavedRequests(stage: string) {
  const incomplete = structuredClone(saved);
  function keepRequest(entry: (typeof saved.nativeRequests)[number]) {
    return stage !== 'all' && entry.stage !== stage;
  }
  incomplete.nativeRequests = incomplete.nativeRequests.filter(keepRequest);
  function checkIncompleteCapture() {
    checksSavedCapture(incomplete);
  }
  expect(checkIncompleteCapture).toThrow();
}
it.each(['all', 'mcp', 'loaded_resume_mcp', 'reloaded_mcp', 'loaded_accept',
  'reloaded_accept', 'fixture_escalated_shell', 'fixture_file_change'])(
  'rejects a saved capture missing %s requests', rejectsMissingSavedRequests);

function rejectsChangedSavedEvidence(change: string) {
  const changed = structuredClone(saved);
  const request = changed.nativeRequests[0]!;
  const observation = changed.observations[0]!;
  const decision = changed.gatewayAsk.decisions[0]!;
  switch (change) {
    case 'request id':
      request.message.id = 99;
      request.reply.id = 99;
      break;
    case 'request method':
      request.message.method = 'future/request';
      break;
    case 'request kind':
      request.message.params._meta!.codex_approval_kind = 'other';
      break;
    case 'reply id':
      changed.nativeRequests[3]!.reply.id = 99;
      break;
    case 'accepted reply':
      changed.nativeRequests[3]!.reply.result!.action = 'decline';
      break;
    case 'observation count':
      observation.requests = 0;
      break;
    case 'continuation':
      observation.continuation = changed.observations[7]!.continuation;
      break;
    case 'decision name':
      decision.name = 'reloaded_accept';
      break;
    case 'decision id':
      decision.approvalId = '';
      break;
    default:
      throw new Error('Unknown fixture mutation');
  }
  function checkChangedCapture() {
    checksSavedCapture(changed);
  }
  expect(checkChangedCapture).toThrow();
}
it.each(['request id', 'request method', 'request kind', 'reply id', 'accepted reply',
  'observation count', 'continuation', 'decision name', 'decision id'])(
  'rejects changed saved %s evidence', rejectsChangedSavedEvidence);
