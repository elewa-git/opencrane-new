import { TestBed } from '@angular/core/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { ScreenshotCapture, captureView, type CaptureState } from './screenshot-capture';
import type { ChatAttachment } from './chat-state';

interface RecordedFetch {
  url: string;
  options: RequestInit | undefined;
}

function requestUrl(input: RequestInfo | URL): string {
  if (input instanceof Request) return input.url;
  if (input instanceof URL) return input.href;
  return input;
}

afterEach(function resetCaptureTests() {
  vi.restoreAllMocks();
  TestBed.resetTestingModule();
});

function createCapture(): ScreenshotCapture {
  TestBed.configureTestingModule({ providers: [ScreenshotCapture] });
  return TestBed.inject(ScreenshotCapture);
}

function reply(status: number, body = '{}'): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/json' } });
}

function stubFetch(responses: Array<Response | Error>): RecordedFetch[] {
  const requests: RecordedFetch[] = [];
  const remainingResponses = [...responses];
  vi.spyOn(globalThis, 'fetch').mockImplementation(function recordRequest(input, options) {
    requests.push({ url: requestUrl(input), options });
    const response = remainingResponses.shift() ?? reply(500);
    if (response instanceof Error) return Promise.reject(response);
    return Promise.resolve(response);
  });
  return requests;
}

function fetchKey(requests: RecordedFetch[], index = 0): string | undefined {
  const request = requests[index];
  if (!request) return undefined;
  return new Headers(request.options?.headers).get('idempotency-key') ?? undefined;
}

it.each([
  { status: 201, body: '{"status":"appended","fileId":"file"}', phase: 'saved', kept: false },
  { status: 201, body: 'bad json', phase: 'unknown', kept: false },
  { status: 422, body: '{"fileId":"rejected"}', phase: 'rejected', kept: false },
  { status: 422, body: 'bad json', phase: 'rejected', kept: false },
  { status: 401, body: '{}', phase: 'access_changed', kept: false },
  { status: 403, body: '{}', phase: 'access_changed', kept: false },
  { status: 409, body: '{}', phase: 'failed', kept: false },
  { status: 400, body: '{}', phase: 'failed', kept: false },
  { status: 503, body: '{}', phase: 'failed', kept: true },
  { status: 202, body: '{}', phase: 'failed', kept: false },
  { status: 500, body: '{}', phase: 'failed', kept: false },
])('maps HTTP $status to $phase and keeps key=$kept', async ({ status, body, phase, kept }) => {
  const requests = stubFetch([reply(status, body)]);
  const capture = createCapture();
  await capture.start('chat', []);
  expect(capture.state().phase).toBe(phase);
  await capture.repeat('chat', []);
  expect(requests).toHaveLength(kept ? 2 : 1);
});

it('sends the same key after 503 and replaces it for a new capture', async () => {
  const requests = stubFetch([
    reply(503), reply(201, '{"status":"appended","fileId":"new"}'), reply(503),
  ]);
  const capture = createCapture();
  await capture.start('chat', []);
  const firstKey = fetchKey(requests);
  await capture.repeat('chat', []);
  expect(fetchKey(requests, 1)).toBe(firstKey);
  await capture.start('chat', []);
  expect(fetchKey(requests, 2)).not.toBe(firstKey);
});

it('sends the same key after an unknown outcome and replaces it for Screenshot', async () => {
  const requests = stubFetch([
    new TypeError('Network lost'), reply(503),
    reply(201, '{"status":"appended","fileId":"new"}'),
  ]);
  const capture = createCapture();
  await capture.start('chat', []);
  const firstKey = fetchKey(requests);
  const unknown = capture.state();
  if (unknown.phase !== 'unknown') throw new Error('Expected an unknown capture');
  await capture.start('chat', []);
  expect(requests).toHaveLength(1);
  capture.markChecked(unknown.startedAt);
  await capture.repeat('chat', []);
  expect(fetchKey(requests, 1)).toBe(firstKey);
  await capture.start('chat', []);
  expect(fetchKey(requests, 2)).not.toBe(firstKey);
});

it('sends the required headers without a request body', async () => {
  const requests = stubFetch([reply(201, '{"status":"appended","fileId":"file"}')]);
  const capture = createCapture();
  await capture.start('chat / one', []);
  const request = requests[0];
  expect(request?.options?.method).toBe('POST');
  expect(new Headers(request?.options?.headers).get('x-opencrane-view')).toBe('1');
  expect(new Headers(request?.options?.headers).get('idempotency-key')).toMatch(/^[\w-]{1,200}$/u);
  expect(request?.options?.body).toBeUndefined();
  expect(request?.url).toBe('/api/conversations/chat%20%2F%20one/screenshots');
});

it('does not send another request while the capture is saving', async () => {
  let finish!: (response: Response) => void;
  const requests: RecordedFetch[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(function holdRequest(input, options) {
    requests.push({ url: requestUrl(input), options });
    return new Promise(resolve => { finish = resolve; });
  });
  const capture = createCapture();
  const pending = capture.start('chat', []);
  await capture.start('chat', []);
  await capture.repeat('chat', []);
  expect(requests).toHaveLength(1);
  finish(reply(503));
  await pending;
});

it('keeps the command reference on a lost reply and blocks a new capture until checked',
  async () => {
    const requests = stubFetch([new TypeError('Network lost')]);
    const capture = createCapture();
    await capture.start('chat', []);
    const unknown = capture.state();
    if (unknown.phase !== 'unknown') throw new Error('Expected an unknown capture');

    await capture.start('chat', []);
    expect(requests).toHaveLength(1);
    const view = captureView(unknown, []);
    expect(view?.detail).toContain(unknown.commandId);
    expect(view?.detail).toContain('Check its status before sending again');
  });

it('checks only the unknown command that the status read began for', async () => {
  stubFetch([new TypeError('Network lost')]);
  const capture = createCapture();
  await capture.start('chat', []);
  const original = capture.state();
  if (original.phase !== 'unknown') throw new Error('Expected an unknown capture');
  capture.state.set({ phase: 'unknown', commandId: 'new-command', startedAt: 'later' });

  capture.markChecked(original.startedAt);

  expect(capture.state()).toEqual({
    phase: 'unknown', commandId: 'new-command', startedAt: 'later',
  });
});

it('aborts on reset and ignores the late reply', async () => {
  let finish!: (response: Response) => void;
  const requests: RecordedFetch[] = [];
  let requestSignal: AbortSignal | null | undefined;
  vi.spyOn(globalThis, 'fetch').mockImplementation(function holdRequest(input, options) {
    requests.push({ url: requestUrl(input), options });
    requestSignal = options?.signal;
    return new Promise(resolve => { finish = resolve; });
  });
  const capture = createCapture();
  const pending = capture.start('chat', []);
  capture.reset();
  finish(reply(201, '{"status":"appended","fileId":"file"}'));
  await pending;
  expect(requestSignal?.aborted).toBe(true);
  expect(capture.state()).toEqual({ phase: 'idle' });
});

it('marks a file as repeated when it was already known when the request began', async () => {
  stubFetch([reply(201, '{"status":"appended","fileId":"file"}')]);
  const capture = createCapture();
  await capture.start('chat', ['file']);
  expect(capture.state()).toEqual({ phase: 'saved', fileId: 'file', repeated: true });
});

it('marks the unknown outcome checked only after a status read', async () => {
  stubFetch([new TypeError('Network lost')]);
  const capture = createCapture();
  await capture.start('chat', []);
  const before = capture.state();
  if (before.phase !== 'unknown') throw new Error('Expected an unknown capture');
  capture.markChecked(before.startedAt);
  const checked = capture.state();
  expect(checked.phase).toBe('unknown');
  if (before.phase !== 'unknown' || checked.phase !== 'unknown') {
    throw new Error('Expected an unknown capture state');
  }
  expect(checked.checkedAt).toBeDefined();
  capture.reset();
  capture.markChecked(before.startedAt);
  expect(capture.state()).toEqual({ phase: 'idle' });
});

const captureViews: {
  state: CaptureState;
  kind: string | undefined;
  retry: boolean | undefined;
  repeat: boolean | undefined;
}[] = [
  { state: { phase: 'idle' }, kind: undefined, retry: undefined, repeat: undefined },
  { state: { phase: 'saving', commandId: 'command' }, kind: 'applying', retry: false, repeat: false },
  { state: { phase: 'failed', commandId: 'command', answeredAt: 'now', sameKeyRetry: true },
    kind: 'failed', retry: true, repeat: false },
  { state: { phase: 'failed', commandId: 'command', answeredAt: 'now', sameKeyRetry: false },
    kind: 'failed', retry: false, repeat: false },
  { state: { phase: 'unknown', commandId: 'command', startedAt: 'now' },
    kind: 'unknown', retry: false, repeat: false },
];

it.each(captureViews)('builds a capture view for $state.phase', ({ state, kind, retry, repeat }) => {
  const model = captureView(state, []);
  expect(model?.kind).toBe(kind);
  expect(model?.safeToRetry).toBe(retry);
  expect(model?.repeatAvailable).toBe(repeat);
});

it('uses the screenshot event time as saved evidence', () => {
  const attachment: ChatAttachment = {
    conversationId: 'chat', fileId: 'file', name: 'screen.png', size: 421888,
    mime: 'image/png', uploadedBy: 'me', path: 'uploads/chat/file/screen.png',
    textPath: 'uploads/chat/file/screen.png', screenshot: {
      computerId: 'computer', generation: 4, capturedAt: '2026-10-02T10:42:00Z',
      width: 1440, height: 900,
    },
  };
  const model = captureView({ phase: 'saved', fileId: 'file', repeated: false }, [attachment]);
  expect(model?.evidenceAt).toBe('2026-10-02T10:42:00Z');
  expect(model?.message).toBe('Screenshot saved');
});
