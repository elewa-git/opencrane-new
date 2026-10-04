import { TestBed } from '@angular/core/testing';
import { Workspace } from './workspace';
import { SOCKET_FACTORY, type SocketLike } from '../core/socket-factory';

function openPanelDialog(this: HTMLDialogElement): void {
  this.setAttribute('open', '');
}

function closePanelDialog(this: HTMLDialogElement): void {
  this.removeAttribute('open');
  this.dispatchEvent(new Event('close'));
}

afterEach(() => { vi.restoreAllMocks(); history.replaceState({}, '', '/'); });
it('renders streamed replies, wake progress and durable Stop, then replays the stopped partial', async () => {
  history.replaceState({}, '', '/workspace?conversation=chat');
  const rows = [{ id: 'create', position: 1, type: 'conversation.created', time: '2026-10-02T10:00:00Z', data: {} },
    { id: 'message', position: 2, type: 'message.posted', time: '2026-10-02T10:00:00Z', data: { text: 'Hi', authorId: 'me' } }];
  vi.spyOn(globalThis, 'fetch').mockImplementation(input => {
    const path = input instanceof Request ? input.url : String(input);
    const body = path === '/auth/me' ? { authenticated: true, user: { name: 'Alex Morgan' } } : path === '/api/chat' ? { memberId: 'me', assistantId: 'assistant' } : path === '/api/conversations' ? { rows: [] }
      : { rows, position: 2, generation: 1, computerState: 'starting your computer' };
    return Promise.resolve(new Response(JSON.stringify(body)));
  });
  const socket: SocketLike = { readyState: 1, onopen: null, onclose: null, onerror: null, onmessage: null, send: vi.fn(), close: vi.fn() };
  TestBed.configureTestingModule({ providers: [{ provide: SOCKET_FACTORY, useValue: () => socket }] });
  const fixture = TestBed.createComponent(Workspace); await fixture.whenStable();
  const value: unknown = fixture.nativeElement;
  if (!(value instanceof HTMLElement)) throw new Error('No root');
  const root = value;
  await vi.waitFor(() => expect(root.textContent).toContain('Starting your computer'));
  socket.onopen?.(new Event('open')); await fixture.whenStable();
  const message = (type: string, position: number, data: object) => socket.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ type: 'event', version: 1, topic: 'conversation', conversationId: 'chat', generation: 1, position,
    row: { id: `r${position}`, type, position, time: '2026-10-02T10:00:00Z', data } }) }));
  message('agent.message_delta', 3, { turnId: 'message', messageId: 'reply', text: 'Hello ' });
  message('agent.message_delta', 4, { turnId: 'message', messageId: 'reply', text: 'there' });
  await fixture.whenStable(); expect(root.textContent).toContain('Hello there');
  message('decision.recorded', 5, { turnId: 'message', reason: 'budget_exhausted' });
  await fixture.whenStable(); expect(root.querySelector('.budget-refusal')?.textContent).toContain('Spending limit reached');
  expect(root.querySelector('.budget-refusal')?.textContent).toContain('Owner or Admin');
  message('agent.turn_stop_requested', 6, { turnId: 'message' });
  message('agent.message_completed', 7, { turnId: 'message', messageId: 'reply', text: 'Hello there and more' });
  await fixture.whenStable(); expect(root.textContent).toContain('Stopped'); expect(root.textContent).not.toContain('and more');
  expect(root.querySelector('[aria-live="polite"]')).not.toBeNull();
});

it('uploads with progress, retries the same bytes and key, and replays attached files in both views', async () => {
  history.replaceState({}, '', '/workspace?conversation=chat');
  const rows = [{ id: 'create', position: 1, type: 'conversation.created', time: '2026-10-03T10:00:00Z', data: {} }];
  let postedText = '';
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const path = input instanceof Request ? input.url : String(input);
    if (init?.method === 'POST' && typeof init.body === 'string') {
      const body: unknown = JSON.parse(init.body);
      if (body && typeof body === 'object' && 'text' in body && typeof body.text === 'string') postedText = body.text;
    }
    return Promise.resolve(new Response(JSON.stringify(path === '/auth/me' ? { authenticated: true, user: { name: 'Alex' } }
      : path === '/api/chat' ? { memberId: 'me', assistantId: 'assistant' }
      : path === '/api/conversations' ? { rows: [] } : { rows, position: 1, generation: 1, computerState: 'ready' })));
  });
  const socket: SocketLike = { readyState: 1, onopen: null, onclose: null, onerror: null, onmessage: null, send: vi.fn(), close: vi.fn() };
  TestBed.configureTestingModule({ providers: [{ provide: SOCKET_FACTORY, useValue: () => socket }] });
  const requests: XMLHttpRequest[] = [], keys: string[] = [];
  vi.spyOn(XMLHttpRequest.prototype, 'open').mockImplementation(() => {});
  vi.spyOn(XMLHttpRequest.prototype, 'setRequestHeader').mockImplementation((name, value) => { if (name === 'Idempotency-Key') keys.push(value); });
  vi.spyOn(XMLHttpRequest.prototype, 'send').mockImplementation(function (this: XMLHttpRequest) { requests.push(this); });
  const fixture = TestBed.createComponent(Workspace); await fixture.whenStable();
  const root: unknown = fixture.nativeElement;
  if (!(root instanceof HTMLElement)) throw new Error('No root');
  await vi.waitFor(() => expect(root.querySelector('[aria-label="Attach"]')).not.toBeNull());
  const input = root.querySelector<HTMLInputElement>('input[type=file]');
  expect(input).not.toBeNull();
  Object.defineProperty(input, 'files', { value: [new File(['PDF'], 'project.pdf', { type: 'application/pdf' })] });
  input!.dispatchEvent(new Event('change')); await fixture.whenStable();
  await vi.waitFor(() => expect(requests.length).toBe(1));
  requests[0]!.upload.dispatchEvent(new ProgressEvent('progress', { lengthComputable: true, loaded: 1, total: 2 }));
  await fixture.whenStable(); expect(root.textContent).toContain('50%');
  Object.defineProperty(requests[0], 'status', { value: 503 }); requests[0]!.dispatchEvent(new Event('load'));
  await vi.waitFor(() => expect(root.textContent).toContain('Upload unavailable'));
  const retry = [...root.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Retry upload');
  expect(retry).toBeDefined(); retry!.click(); await vi.waitFor(() => expect(requests).toHaveLength(2));
  expect(keys).toHaveLength(2); expect(keys[1]).toBe(keys[0]);
  Object.defineProperty(requests[1], 'status', { value: 201 });
  Object.defineProperty(requests[1], 'responseText', { value: JSON.stringify({ fileId: 'file' }) });
  requests[1]!.dispatchEvent(new Event('load'));
  const composer = root.querySelector('textarea')!; composer.value = 'Read it'; composer.dispatchEvent(new Event('input'));
  await new Promise(resolve => setTimeout(resolve, 0)); await fixture.whenStable();
  expect(root.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.disabled).toBe(true);

  socket.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ type: 'event', version: 1, topic: 'conversation', conversationId: 'chat', generation: 1, position: 2,
    row: { id: 'upload', position: 2, type: 'file.uploaded', time: '2026-10-03T10:00:01Z', data: { conversationId: 'chat', fileId: 'file', uploadedBy: 'me', name: 'project.pdf', mime: 'application/pdf' } } }) }));
  await fixture.whenStable();
  expect(root.querySelector('.transcript .file-card')?.textContent).toContain('project.pdf');
  const drawer = root.querySelector('oc-hinge-drawer dialog');
  if (!drawer) throw new Error('Missing panel drawer');
  const dialogMethods = { showModal: openPanelDialog, close: closePanelDialog };
  Object.assign(drawer, dialogMethods);
  root.querySelector<HTMLButtonElement>('#panel-toggle')!.click();
  await fixture.whenStable();
  expect(root.querySelector('.panel-section')?.textContent).toContain('Attached by you');
  expect(root.querySelector('.panel-section')?.textContent).toContain('project.pdf');
  drawer.querySelector<HTMLButtonElement>('.back')!.click();
  await fixture.whenStable();
  socket.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ type: 'event', version: 1, topic: 'conversation', conversationId: 'chat', generation: 1, position: 3,
    row: { id: 'delivered', position: 3, type: 'file.delivered', time: '2026-10-03T10:00:02Z', data: { fileId: 'file' } } }) }));
  composer.value = 'a'.repeat(32000); composer.dispatchEvent(new Event('input')); await fixture.whenStable();
  root.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.click();
  await vi.waitFor(() => expect(postedText).toBe('a'.repeat(32000)));
  await vi.waitFor(() => expect(root.querySelector('h1')?.textContent).toContain('a'.repeat(24)));

});

it('keeps an upload retry in the same draft conversation after creation catch-up fails and a message is sent', async () => {
  history.replaceState({}, '', '/workspace');
  const created: string[] = []; let failedList = false, messageConversation = '';
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const path = input instanceof Request ? input.url : String(input);
    if (path === '/api/conversations' && init?.method === 'POST' && typeof init.body === 'string') {
      const body: unknown = JSON.parse(init.body);
      if (body && typeof body === 'object' && 'conversationId' in body && typeof body.conversationId === 'string') created.push(body.conversationId);
      return Promise.resolve(new Response('{}'));
    }
    if (path === '/api/conversations' && created.length && !failedList) { failedList = true; return Promise.resolve(new Response('{}', { status: 503 })); }
    if (init?.method === 'POST' && path.endsWith('/messages')) messageConversation = path.split('/')[3]!;
    const rows = created.length ? [{ conversationId: created[0], assistantId: 'assistant', createdBy: 'me', createdAt: '2026-10-03T10:00:00Z' }] : [];
    return Promise.resolve(new Response(JSON.stringify(path === '/auth/me' ? { authenticated: true, user: { name: 'Alex' } }
      : path === '/api/chat' ? { memberId: 'me', assistantId: 'assistant' } : path === '/api/conversations' ? { rows }
      : { rows: [], position: 0, generation: 1, computerState: 'ready' })));
  });
  const socket: SocketLike = { readyState: 1, onopen: null, onclose: null, onerror: null, onmessage: null, send: vi.fn(), close: vi.fn() };
  TestBed.configureTestingModule({ providers: [{ provide: SOCKET_FACTORY, useValue: () => socket }] });
  const opened = vi.spyOn(XMLHttpRequest.prototype, 'open').mockImplementation(() => {});
  vi.spyOn(XMLHttpRequest.prototype, 'setRequestHeader').mockImplementation(() => {});
  vi.spyOn(XMLHttpRequest.prototype, 'send').mockImplementation(() => {});
  const fixture = TestBed.createComponent(Workspace); await fixture.whenStable();
  const root: unknown = fixture.nativeElement; if (!(root instanceof HTMLElement)) throw new Error('No root');
  await vi.waitFor(() => expect(root.querySelector('[aria-label="Attach"]')).not.toBeNull());
  const input = root.querySelector<HTMLInputElement>('input[type=file]')!;
  Object.defineProperty(input, 'files', { value: [new File(['notes'], 'notes.txt')] }); input.dispatchEvent(new Event('change'));
  await vi.waitFor(() => expect(root.textContent).toContain('Retry upload'));
  const field = root.querySelector('textarea')!; field.value = 'Hello'; field.dispatchEvent(new Event('input')); await fixture.whenStable();
  root.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.click();
  await vi.waitFor(() => expect(messageConversation).not.toBe(''));
  expect(messageConversation).toBe(created[0]); expect(new Set(created).size).toBe(1);
  await fixture.whenStable();
  [...root.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Retry upload')!.click();
  await vi.waitFor(() => expect(opened).toHaveBeenCalledWith('POST', `/api/conversations/${created[0]}/files`));
});
