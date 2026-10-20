import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
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
