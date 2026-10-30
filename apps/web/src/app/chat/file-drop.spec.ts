import { TestBed } from '@angular/core/testing';
import { SOCKET_FACTORY, type SocketLike } from '../core/socket-factory';
import { Workspace } from './workspace';

const requests: { request: XMLHttpRequest; file: unknown }[] = [];
const uploadKeys: string[] = [];
const conversation = {
  conversationId: 'chat', createdBy: 'me', assistantId: 'assistant',
  createdAt: '2026-10-04T10:00:00Z', mode: 'agent_session',
};

afterEach(function restoreBrowser() {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  requests.length = 0;
  uploadKeys.length = 0;
  history.replaceState({}, '', '/');
});

function fetchWorkspace(input: RequestInfo | URL) {
  const path = input instanceof Request ? input.url : String(input);
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
  function captureHeader(name: string, value: string) {
    if (name === 'Idempotency-Key') uploadKeys.push(value);
  }
  vi.spyOn(XMLHttpRequest.prototype, 'open').mockImplementation(ignoreRequest);
  vi.spyOn(XMLHttpRequest.prototype, 'send').mockImplementation(captureRequest);
  vi.spyOn(XMLHttpRequest.prototype, 'setRequestHeader').mockImplementation(captureHeader);
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

function drag(target: Element, type: string, files: File[] = [], nonFileType = 'text/plain') {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const types = files.length ? ['Files'] : [nonFileType];
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
  finishUpload(0, 503);
  function expectRefusal() {
    fixture.detectChanges();
    expect(root.textContent).toContain('Upload unavailable');
  }
  await vi.waitFor(expectRefusal);
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

async function uploadsInOrderWithErrors() {
  const { fixture, root } = await renderWorkspace();
  const oversized = new File([''], 'large.txt');
  Object.defineProperty(oversized, 'size', { value: 20 * 1024 * 1024 + 1 });
  const unsupported = new File([''], 'unsupported.txt');
  const valid = new File([''], 'valid.txt');
  drag(root.querySelector('.transcript')!, 'drop', [oversized, unsupported, valid]);
  function expectSecondFile() {
    expect(requests).toHaveLength(1);
    expect(requests[0]?.file).toBe(unsupported);
  }
  await vi.waitFor(expectSecondFile);
  finishUpload(0, 415);
  function expectThirdFile() {
    expect(requests).toHaveLength(2);
    expect(requests[1]?.file).toBe(valid);
  }
  await vi.waitFor(expectThirdFile);
  finishUpload(1);
  await fixture.whenStable();
  expect(root.textContent).toContain('File too large. Maximum size is 20 MiB.');
  expect(root.textContent).toContain('File type is unsupported or does not match its contents.');
  const retryButtons = root.querySelectorAll<HTMLButtonElement>('.upload-status button');
  expect(retryButtons).toHaveLength(2);
  function expectRetryAvailable() {
    fixture.detectChanges();
    expect(retryButtons[1]?.disabled).toBe(false);
  }
  await vi.waitFor(expectRetryAvailable);
  retryButtons[1]!.click();
  function expectRetry() {
    expect(requests).toHaveLength(3);
    expect(requests[2]?.file).toBe(unsupported);
  }
  await vi.waitFor(expectRetry);
  expect(uploadKeys[2]).toBe(uploadKeys[0]);
  finishUpload(2);
  await fixture.whenStable();
  expect(root.textContent).not.toContain('File type is unsupported');
  expect(root.textContent).toContain('File too large');
}
it('uploads every file in order and keeps each refused file available for retry',
  uploadsInOrderWithErrors);

async function ignoresOtherDrops() {
  const { fixture, root } = await renderWorkspace();
  const transcript = root.querySelector('.transcript')!;
  expect(drag(transcript, 'drop').defaultPrevented).toBe(false);
  expect(drag(transcript, 'drop', [], 'text/uri-list').defaultPrevented).toBe(false);
  const file = new File([''], 'notes.txt');
  const outside = root.querySelector('nav')!;
  expect(drag(outside, 'dragover', [file]).defaultPrevented).toBe(true);
  expect(drag(outside, 'drop', [file]).defaultPrevented).toBe(true);
  await fixture.whenStable();
  expect(requests).toHaveLength(0);
  expect(root.textContent).not.toContain('Drop files to add them');
}
it('ignores text drops and prevents files outside the chat from opening', ignoresOtherDrops);

async function highlightsFileDrag() {
  const { fixture, root } = await renderWorkspace();
  const transcript = root.querySelector('.transcript')!;
  const composer = root.querySelector('.composer')!;
  const file = new File([''], 'notes.txt');
  drag(transcript, 'dragenter', [file]);
  drag(transcript.querySelector('.transcript-inner')!, 'dragenter', [file]);
  drag(transcript, 'dragleave', [file]);
  await fixture.whenStable();
  expect(composer.classList.contains('file-drag')).toBe(true);
  const label = composer.querySelector('[aria-live="polite"]');
  expect(label?.textContent).toContain('Drop files to add them');
  drag(root.querySelector('nav')!, 'dragover', [file]);
  await fixture.whenStable();
  expect(composer.classList.contains('file-drag')).toBe(false);
  drag(composer, 'dragover', [file]);
  drag(composer, 'drop', [file]);
  function expectUpload() {
    expect(requests).toHaveLength(1);
  }
  await vi.waitFor(expectUpload);
  finishUpload(0);
  await fixture.whenStable();
  expect(composer.classList.contains('file-drag')).toBe(false);
}
it('announces file drags, keeps the highlight across children and accepts composer drops',
  highlightsFileDrag);

async function keepsPhoneAttachments() {
  const { fixture, root } = await renderWorkspace(390);
  const transcript = root.querySelector('.transcript')!;
  const file = new File([''], 'notes.txt');
  drag(transcript, 'dragenter', [file]);
  drag(transcript, 'drop', [file]);
  await fixture.whenStable();
  expect(requests).toHaveLength(0);
  expect(root.textContent).not.toContain('Drop files to add them');
  expect(root.querySelector('[aria-label="Attach"]')).not.toBeNull();
}
it('keeps Attach on phone layouts without accepting file drops', keepsPhoneAttachments);
