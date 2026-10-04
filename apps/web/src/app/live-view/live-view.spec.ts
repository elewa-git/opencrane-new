import { TestBed } from '@angular/core/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { LIVE_VIEWER, LiveView } from './live-view';

afterEach(() => vi.unstubAllGlobals());
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
  constructor(_url: string | URL, _protocols: string[]) {
    super();
    FakeSocket.last = this;
  }
  close = vi.fn();
}
class FakeRfb extends EventTarget {
  viewOnly = false;
  scaleViewport = false;
  resizeSession = false;
  focusOnClick = false;
  disconnect = vi.fn();
  constructor(target: HTMLElement, _socket: WebSocket) {
    super();
    target.append(document.createElement('canvas'));
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
