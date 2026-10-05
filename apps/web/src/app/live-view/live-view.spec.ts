import { TestBed } from '@angular/core/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { LIVE_VIEWER, LiveView } from './live-view';
import type { RawChannel } from '@novnc/novnc/lib/rfb.js';

afterEach(function restoreGlobals() { vi.useRealTimers(); vi.unstubAllGlobals(); });
it('clears the desktop and explains a refused view without offering control', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 403 })));
  const fixture = TestBed.createComponent(LiveView);
  fixture.componentRef.setInput('conversationId', 'chat');
  await fixture.whenStable();
  const element: unknown = fixture.nativeElement;
  if (!(element instanceof HTMLElement)) throw new Error('Missing viewer');
  // jsdom has no native dialog methods; Chromium covers focus and Escape.
  Object.assign(element.querySelector('dialog')!, { showModal: vi.fn(), close: vi.fn() });
  element.querySelector<HTMLButtonElement>('button')!.click();
  await fixture.whenStable();
  expect(element.textContent).toContain('Unavailable');
  expect(element.querySelector('[data-state=refused]')).not.toBeNull();
  expect(element.textContent).toContain('Read-only');
  expect(element.querySelector('canvas')).toBeNull();
  expect(element.textContent).not.toMatch(/Take control|Clipboard/u);
});

it('cancels an old conversation view when the session panel switches conversation', async () => {
  let finish!: (response: Response) => void;
  const request = vi.fn(() => new Promise<Response>(resolve => {
    finish = resolve;
  }));
  vi.stubGlobal('fetch', request);
  const fixture = TestBed.createComponent(LiveView);
  fixture.componentRef.setInput('conversationId', 'old');
  await fixture.whenStable();
  const element: unknown = fixture.nativeElement;
  if (!(element instanceof HTMLElement)) throw new Error('Missing viewer');
  // jsdom has no native dialog methods; Chromium covers focus and Escape.
  Object.assign(element.querySelector('dialog')!, { showModal: vi.fn(), close: vi.fn() });
  element.querySelector<HTMLButtonElement>('button')!.click();
  await fixture.whenStable();
  expect(element.textContent).toContain('Connecting');
  fixture.componentRef.setInput('conversationId', 'new');
  await fixture.whenStable();
  expect(element.textContent).toContain('Disconnected');
  finish(new Response('{"ticket":"old-ticket"}'));
  await fixture.whenStable();
  expect(element.textContent).toContain('Watch your computer');
  expect(element.querySelector('canvas')).toBeNull();
  element.querySelector<HTMLButtonElement>('button')!.click();
  await fixture.whenStable();
  expect(request).toHaveBeenLastCalledWith('/api/conversations/new/view', expect.objectContaining({ method: 'POST' }));
  finish(new Response('{}', { status: 403 }));
  await fixture.whenStable();
});


class FakeSocket extends EventTarget {
  static last: FakeSocket;
  binaryType = 'arraybuffer';
  readyState = 0;
  protocol = 'binary';
  send = vi.fn();
  message(data: string | ArrayBuffer) {
    this.dispatchEvent(new MessageEvent('message', { data }));
  }
  constructor(_url: string | URL, _protocols: string[]) {
    super();
    FakeSocket.last = this;
  }
  close = vi.fn();
}
class FakeRfb extends EventTarget {
  static instances: FakeRfb[] = [];
  readonly frames: unknown[] = [];
  viewOnly = false;
  scaleViewport = false;
  resizeSession = false;
  focusOnClick = false;
  disconnect = vi.fn();
  constructor(target: HTMLElement, socket: WebSocket | RawChannel) {
    super();
    FakeRfb.instances.push(this);
    target.append(document.createElement('canvas'));
    const frames = this.frames;
    socket.onmessage = function received(event: MessageEvent<unknown>) {
      frames.push(event.data);
    };
  }
}
function loadFakeViewer() {
  return Promise.resolve(FakeRfb);
}
async function watchFakeView(status: number) {
  const request = vi.fn<() => Promise<Response>>();
  const response = new Response('{"ticket":"test"}', { status });
  request.mockResolvedValue(response);
  vi.stubGlobal('fetch', request);
  vi.stubGlobal('WebSocket', FakeSocket);
  const provider = { provide: LIVE_VIEWER, useValue: loadFakeViewer };
  TestBed.configureTestingModule({ providers: [provider] });
  const fixture = TestBed.createComponent(LiveView);
  fixture.componentRef.setInput('conversationId', 'chat');
  await fixture.whenStable();
  const element: unknown = fixture.nativeElement;
  if (!(element instanceof HTMLElement)) throw new Error('Missing viewer');
  Object.assign(element.querySelector('dialog')!, { showModal: vi.fn(), close: vi.fn() });
  element.querySelector<HTMLButtonElement>('button')!.click();
  await fixture.whenStable();
  return { fixture, element, request };
}
async function unconfirmedBrowserAdmission() {
  const { fixture, element, request } = await watchFakeView(503);
  expect(element.textContent).toContain('Failed');
  expect(element.querySelector('oc-shared-state [data-state="failed"]')).not.toBeNull();
  expect(element.textContent).toContain("Access checks didn't answer in time");
  const retry = element.querySelector<HTMLButtonElement>('.retry');
  expect(retry?.textContent).toContain('Try again');
  retry!.click();
  await fixture.whenStable();
  expect(request).toHaveBeenCalledTimes(2);
  expect(element.querySelector('canvas')).toBeNull();
}
it('shows Failed and retries admission when POST returns 503', unconfirmedBrowserAdmission);
async function browserCloseState(scenario: { code: number; state: string }) {
  const { fixture, element } = await watchFakeView(200);
  expect(element.querySelector('canvas')).not.toBeNull();
  const closed = new CloseEvent('close', { code: scenario.code });
  FakeSocket.last.dispatchEvent(closed);
  await fixture.whenStable();
  expect(element.textContent).toContain(scenario.state);
  expect(element.querySelector('canvas')).toBeNull();
}
it.each([
  { code: 4503, state: 'Failed' }, { code: 4003, state: 'Access changed' },
])('clears the canvas and shows $state for close $code', browserCloseState);

it('hides expired pixels, clears paused pixels and rebuilds the viewer without another POST',
  async function pauseResume() {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    FakeRfb.instances = [];
    const { fixture, element, request } = await watchFakeView(200);
    expect(element.textContent).toContain('Connecting');
    expect(element.textContent).toContain('Checking your access…');
    expect(element.querySelector('oc-modal-sheet')).not.toBeNull();
    expect(element.querySelector('oc-shared-state [data-state="checking"]')).not.toBeNull();
    const socket = FakeSocket.last;
    socket.readyState = 1;
    socket.dispatchEvent(new Event('open'));
    socket.message('{"lease":"valid","at":0,"until":1500}');
    await fixture.whenStable();
    expect(element.textContent).toContain('Access confirmed. Starting the desktop…');
    expect(element.textContent).not.toContain("Checking that you're in this computer's audience");
    for (let index = 0; index < 4; index++) socket.message(new ArrayBuffer(1));
    const first = FakeRfb.instances[0]!;
    first.dispatchEvent(new Event('connect'));
    await fixture.whenStable();
    expect(element.textContent).toContain('Viewing');
    expect(element.querySelector('oc-shared-state [data-state="ready"]')).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1500);
    await fixture.whenStable();
    expect(element.textContent).toContain('Paused');
    expect(element.querySelector<HTMLElement>('.display')!.hidden).toBe(true);
    expect(element.querySelector('canvas')).not.toBeNull();
    expect(element.textContent).not.toContain('Screenshot');
    socket.message('{"lease":"paused"}');
    await fixture.whenStable();
    expect(first.disconnect).toHaveBeenCalledOnce();
    expect(element.querySelector('canvas')).toBeNull();
    expect(element.textContent).toContain('Paused — checking your access');
    expect(element.querySelector('oc-shared-state [data-state="paused"]')).not.toBeNull();
    socket.message('{"lease":"valid","at":1500,"until":3000}');
    await fixture.whenStable();
    expect(FakeRfb.instances).toHaveLength(2);
    expect(FakeRfb.instances[1]!.frames).toHaveLength(4);
    expect(element.textContent).toContain('Paused');
    FakeRfb.instances[1]!.dispatchEvent(new Event('connect'));
    await fixture.whenStable();
    expect(element.textContent).toContain('Viewing');
    expect(element.querySelector('oc-shared-state [data-state="ready"]')).not.toBeNull();
    expect(request).toHaveBeenCalledOnce();
    fixture.destroy();
  });
