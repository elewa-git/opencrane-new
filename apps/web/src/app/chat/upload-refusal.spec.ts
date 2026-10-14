import { TestBed } from '@angular/core/testing';
import { SOCKET_FACTORY, type SocketLike } from '../core/socket-factory';
import { Workspace } from './workspace';

const workspaceRows = [{
  id: 'create',
  position: 1,
  type: 'conversation.created',
  time: '2026-10-04T10:00:00Z',
  data: { conversationId: 'chat', createdBy: 'me', assistantId: 'assistant' },
}];
const sizeRefusalCases = [
  { reason: 'a file over 20 MiB', size: 20 * 1024 * 1024 + 1, status: null },
  { reason: 'an HTTP 413 response', size: 3, status: 413 },
];

afterEach(function restoreBrowserState() {
  vi.restoreAllMocks();
  history.replaceState({}, '', '/');
});

function fetchWorkspace(input: RequestInfo | URL) {
  const path = input instanceof Request ? input.url : String(input);
  let body: object;
  if (path === '/auth/me') {
    body = { authenticated: true, user: { name: 'Alex' } };
  } else if (path === '/api/chat') {
    body = { memberId: 'me', assistantId: 'assistant' };
  } else if (path === '/api/conversations') {
    body = { rows: [{ conversationId: 'chat', createdBy: 'me', assistantId: 'assistant',
      createdAt: '2026-10-04T10:00:00Z', mode: 'agent_session' }] };
  } else {
    body = { rows: workspaceRows, position: 1, generation: 1, computerState: 'ready' };
  }
  const response = new Response(JSON.stringify(body));
  return Promise.resolve(response);
}

function createSocket(): SocketLike {
  return {
    readyState: 1,
    onopen: null,
    onclose: null,
    onerror: null,
    onmessage: null,
    send: vi.fn(),
    close: vi.fn(),
  };
}

function configureWorkspace() {
  const fetch = vi.spyOn(globalThis, 'fetch');
  fetch.mockImplementation(fetchWorkspace);
  const provider = { provide: SOCKET_FACTORY, useValue: createSocket };
  const configuration = { providers: [provider] };
  TestBed.configureTestingModule(configuration);
}

function captureUploadRequests() {
  const requests: XMLHttpRequest[] = [];
  function ignoreRequest() {}
  function sendFile(this: XMLHttpRequest) {
    requests.push(this);
  }
  const opened = vi.spyOn(XMLHttpRequest.prototype, 'open');
  opened.mockImplementation(ignoreRequest);
  const headers = vi.spyOn(XMLHttpRequest.prototype, 'setRequestHeader');
  headers.mockImplementation(ignoreRequest);
  const sent = vi.spyOn(XMLHttpRequest.prototype, 'send');
  sent.mockImplementation(sendFile);
  return requests;
}

async function renderWorkspace() {
  const fixture = TestBed.createComponent(Workspace);
  await fixture.whenStable();
  const element: unknown = fixture.nativeElement;
  if (!(element instanceof HTMLElement)) {
    throw new Error('No workspace root');
  }
  return element;
}

async function verifySizeRefusal(testCase: (typeof sizeRefusalCases)[number]) {
  history.replaceState({}, '', '/workspace?conversation=chat');
  configureWorkspace();
  const requests = captureUploadRequests();
  const root = await renderWorkspace();
  function expectAttachButton() {
    expect(root.querySelector('[aria-label="Attach"]')).not.toBeNull();
  }
  await vi.waitFor(expectAttachButton);
  const input = root.querySelector<HTMLInputElement>('input[type=file]');
  if (!input) {
    throw new Error('No file chooser');
  }
  const file = new File([new Uint8Array(testCase.size)], 'notes.txt');
  const selectedFiles = { value: [file] };
  Object.defineProperty(input, 'files', selectedFiles);
  input.dispatchEvent(new Event('change'));

  function expectUploadRequest() {
    expect(requests).toHaveLength(1);
  }
  if (testCase.status !== null) {
    await vi.waitFor(expectUploadRequest);
    const request = requests[0]!;
    const refusedStatus = { value: testCase.status };
    Object.defineProperty(request, 'status', refusedStatus);
    request.dispatchEvent(new Event('load'));
  }

  function expectSizeMessage() {
    expect(root.textContent).toContain('File too large. Maximum size is 20 MiB.');
    expect(root.textContent).not.toContain('Upload unavailable');
  }
  await vi.waitFor(expectSizeMessage);
  if (testCase.status === null) {
    expect(requests).toHaveLength(0);
  }
}

it.each(sizeRefusalCases)('shows File too large for $reason', verifySizeRefusal);
