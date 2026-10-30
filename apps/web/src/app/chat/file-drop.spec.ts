import { TestBed } from '@angular/core/testing';
import { SOCKET_FACTORY, type SocketLike } from '../core/socket-factory';
import { Workspace } from './workspace';

const requests: { request: XMLHttpRequest; file: unknown }[] = [];
const conversation = {
  conversationId: 'chat', createdBy: 'me', assistantId: 'assistant',
  createdAt: '2026-10-04T10:00:00Z', mode: 'agent_session',
};

afterEach(function restoreBrowser() {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  requests.length = 0;
  history.replaceState({}, '', '/');
});

function fetchWorkspace(input: RequestInfo | URL) {
  const path = String(input);
  let body: object = {};
  if (path === '/auth/me') body = { authenticated: true, user: { name: 'Alex' } };
  if (path === '/api/chat') body = { memberId: 'me', assistantId: 'assistant' };
  if (path === '/api/conversations') body = { rows: [conversation] };
  if (path.includes('/messages')) {
    body = { rows: [], position: 0, generation: 1, computerState: 'ready' };
  }
  return Promise.resolve(new Response(JSON.stringify(body)));
}

function createSocket(): SocketLike {
  return {
    readyState: 1, onopen: null, onclose: null, onerror: null, onmessage: null,
    send: vi.fn(), close: vi.fn(),
  };
}

async function renderWorkspace(width = 1280) {
  vi.stubGlobal('innerWidth', width);
  vi.spyOn(globalThis, 'fetch').mockImplementation(fetchWorkspace);
  function ignoreRequest() {}
  function captureRequest(this: XMLHttpRequest, file: unknown) {
    requests.push({ request: this, file });
  }
  vi.spyOn(XMLHttpRequest.prototype, 'open').mockImplementation(ignoreRequest);
  vi.spyOn(XMLHttpRequest.prototype, 'send').mockImplementation(captureRequest);
  vi.spyOn(XMLHttpRequest.prototype, 'setRequestHeader').mockImplementation(ignoreRequest);
  history.replaceState({}, '', '/workspace?conversation=chat');
  const provider = { provide: SOCKET_FACTORY, useValue: createSocket };
  TestBed.configureTestingModule({ providers: [provider] });
  const fixture = TestBed.createComponent(Workspace);
  await fixture.whenStable();
  const value: unknown = fixture.nativeElement;
  if (!(value instanceof HTMLElement)) throw new Error('Missing workspace');
  const root = value;
  function expectReady() {
    expect(root.querySelector('[aria-label="Attach"]')).not.toBeNull();
  }
  await vi.waitFor(expectReady);
  return { fixture, root };
}

function drag(target: Element, type: string, files: File[] = []) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const types = files.length ? ['Files'] : ['text/plain'];
  Object.defineProperty(event, 'dataTransfer', { value: { files, types } });
  target.dispatchEvent(event);
  return event;
}

function finishUpload(index: number, status = 201) {
  const request = requests[index]!.request;
  Object.defineProperty(request, 'status', { configurable: true, value: status });
  const responseText = JSON.stringify({ fileId: `file-${index}` });
  Object.defineProperty(request, 'responseText', { value: responseText });
  request.dispatchEvent(new Event('load'));
}

async function uploadsAttachedAndDroppedFiles() {
  const { fixture, root } = await renderWorkspace();
  const file = new File([''], 'notes.txt');
  const chooser = root.querySelector<HTMLInputElement>('input[type=file]')!;
  Object.defineProperty(chooser, 'files', { value: [file] });
  chooser.dispatchEvent(new Event('change'));
  function expectAttached() {
    expect(requests).toHaveLength(1);
    expect(requests[0]?.file).toBe(file);
  }
  await vi.waitFor(expectAttached);
  finishUpload(0);
  await fixture.whenStable();
  drag(root.querySelector('.transcript')!, 'drop', [file]);
  function expectDropped() {
    expect(requests).toHaveLength(2);
    expect(requests[1]?.file).toBe(file);
  }
  await vi.waitFor(expectDropped);
  finishUpload(1);
  await fixture.whenStable();
}
it('sends attached and dropped files through the same upload request', uploadsAttachedAndDroppedFiles);
