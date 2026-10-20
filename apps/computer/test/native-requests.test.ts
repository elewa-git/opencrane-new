import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { fixture } from './bridge-gate-fixture.ts';
import { nativeRequests } from '../src/native-requests.ts';

function answersCapturedRequests() {
  const path = new URL('./fixtures/codex-0.159.2-on-request.json', import.meta.url);
  const fixture = JSON.parse(readFileSync(path, 'utf8')) as {
    nativeRequests: { message: Record<string, unknown>; reply: unknown }[];
  };
  expect(fixture.nativeRequests.length).toBeGreaterThan(0);
  const replies: unknown[] = [];
  const reports: unknown[] = [];
  function send(reply: unknown) { replies.push(reply); }
  function record(message: unknown) { reports.push(message); }
  const handle = nativeRequests(send, record);
  for (const entry of fixture.nativeRequests) {
    expect(handle(entry.message)).toBe(true);
    expect(handle(entry.message)).toBe(true);
    expect(replies.at(-1)).toEqual(entry.reply);
  }
  expect(replies).toHaveLength(fixture.nativeRequests.length);
  expect(reports).toHaveLength(replies.length);
  expect(handle({ method: 'turn/completed', params: {} })).toBe(false);
  const unknown = { id: 'unknown', method: 'future/request', params: {} };
  handle(unknown);
  handle(unknown);
  expect(replies.at(-1)).toEqual({ id: 'unknown', error: {
    code: -32601, message: 'Native request is not supported',
  } });
  expect(replies).toHaveLength(fixture.nativeRequests.length + 1);
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
  const handle = nativeRequests(send, test.channel.notification);
  try {
    if (state !== 'absent') {
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
    expect(replies).toEqual([{ id: 23, result: { decision: 'decline' } }]);
    expect(JSON.stringify(test.frames)).not.toContain('agent.native_request_refused');
    expect(JSON.stringify(test.frames)).not.toContain('PRIVATE_NATIVE_MARKER');
    test.finish('thread-1');
  } finally { await test.close(); }
}
it.each(['absent', 'ended', 'gated'])(
  'answers once without recording when the turn is %s', answersWithoutActiveTurn);
