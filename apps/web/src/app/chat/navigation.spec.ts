import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { ChatSession } from './chat-session';
import { Workspace } from './workspace';
import { SOCKET_FACTORY, type SocketLike } from '../core/socket-factory';

function showModal(this: HTMLDialogElement): void {
  this.setAttribute('open', '');
}

function closeDialog(this: HTMLDialogElement): void {
  this.removeAttribute('open');
  this.dispatchEvent(new Event('close'));
}

function installDialogMethods(dialog: HTMLDialogElement): void {
  const methods = {
    showModal: { configurable: true, writable: true, value: showModal },
    close: { configurable: true, writable: true, value: closeDialog },
  };
  Object.defineProperties(dialog, methods);
}

const firstConversation = {
  conversationId: 'chat', assistantId: 'assistant', createdBy: 'me', mode: 'agent_session',
  createdAt: '2026-10-04T10:00:00Z', title: 'Original session', status: 'open',
};

function navigationReply(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const path = input instanceof Request ? input.url : String(input);
  let body: object;
  if (init?.method === 'POST') {
    return Promise.resolve(new Response('{}', { status: 503 }));
  }
  if (path === '/auth/me') {
    body = { authenticated: true, user: { name: 'Alex' } };
  } else if (path === '/api/chat') {
    body = { memberId: 'me', assistantId: 'assistant' };
  } else if (path === '/api/conversations') {
    body = { rows: [firstConversation] };
  } else {
    body = { rows: [], position: 0, generation: 1, computerState: 'ready' };
  }
  return Promise.resolve(new Response(JSON.stringify(body)));
}

function button(root: HTMLElement, selector: string): HTMLButtonElement {
  const element = root.querySelector<HTMLButtonElement>(selector);
  if (!element) throw new Error(`Missing button ${selector}`);
  return element;
}

async function phoneWorkspace(): Promise<ComponentFixture<Workspace>> {
  vi.stubGlobal('innerWidth', 390);
  history.replaceState({}, '', '/workspace?conversation=chat');
  vi.spyOn(globalThis, 'fetch').mockImplementation(navigationReply);
  const socket: SocketLike = {
    readyState: 1, onopen: null, onclose: null, onerror: null, onmessage: null,
    send: vi.fn(), close: vi.fn(),
  };
  const provider = { provide: SOCKET_FACTORY, useValue: createSocket };
  function createSocket(): SocketLike {
    return socket;
  }
  TestBed.configureTestingModule({ providers: [provider] });
  const fixture = TestBed.createComponent(Workspace);
  await fixture.whenStable();
  const chat = fixture.debugElement.injector.get(ChatSession);
  function loaded(): void {
    expect(chat.loading()).toBe(false);
    expect(chat.selected()).toBe('chat');
  }
  await vi.waitFor(loaded);
  await fixture.whenStable();
  const root = rootElement(fixture);
  for (const dialog of root.querySelectorAll('dialog')) {
    installDialogMethods(dialog);
  }
  return fixture;
}

function rootElement(fixture: ComponentFixture<Workspace>): HTMLElement {
  const root: unknown = fixture.nativeElement;
  if (!(root instanceof HTMLElement)) throw new Error('Missing workspace');
  return root;
}

function resetNavigation(): void {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  history.replaceState({}, '', '/');
}

afterEach(resetNavigation);

async function checkGuardedNavigation(condition: 'queued' | 'upload'): Promise<void> {
  const fixture = await phoneWorkspace();
  const root = rootElement(fixture);
  const chat = fixture.debugElement.injector.get(ChatSession);
  chat.conversations.set([
    {
      conversationId: 'other', assistantId: 'assistant', createdBy: 'me',
      mode: 'agent_session', createdAt: '2026-10-04T10:00:00Z', title: 'Other session', status: 'failed',
    },
  ]);
  const uploadRequests: XMLHttpRequest[] = [];
  let pendingUpload: Promise<void> | undefined;
  function recordUpload(this: XMLHttpRequest): void {
    uploadRequests.push(this);
  }
  function uploadStarted(): void {
    expect(uploadRequests).toHaveLength(1);
    expect(chat.uploading()).toBe(true);
  }
  if (condition === 'queued') {
    await chat.send('Keep this queued message');
    expect(chat.queued()).toBe(true);
  } else {
    vi.spyOn(XMLHttpRequest.prototype, 'open').mockImplementation(vi.fn());
    vi.spyOn(XMLHttpRequest.prototype, 'setRequestHeader').mockImplementation(vi.fn());
    vi.spyOn(XMLHttpRequest.prototype, 'send').mockImplementation(recordUpload);
    const file = new File(['Keep these bytes'], 'notes.txt', { type: 'text/plain' });
    pendingUpload = chat.upload(file);
    await vi.waitFor(uploadStarted);
  }
  button(root, '#navigation-toggle').click();
  await fixture.whenStable();
  const menu = root.querySelector('oc-navigation-menu');
  if (!(menu instanceof HTMLElement)) throw new Error('Missing menu');
  expect(menu.querySelectorAll('a')).toHaveLength(3);
  expect(menu.querySelector('a[href="/workspace/direct"]')?.textContent)
    .toContain('New direct chat');
  expect(menu.textContent).toContain('Failed');
  expect(menu.textContent).toContain('Projects');
  expect(menu.textContent).toContain('Archived');
  button(menu, '.session-row').click();
  await fixture.whenStable();
  expect(chat.selected()).toBe('chat');
  expect(location.search).toBe('?conversation=chat');
  button(root, '#navigation-toggle').click();
  await fixture.whenStable();
  button(menu, '.new-session').click();
  await fixture.whenStable();
  expect(chat.selected()).toBe('chat');
  if (condition === 'queued') expect(chat.queued()).toBe(true);
  else expect(chat.uploading()).toBe(true);
  expect(chat.error()).toContain('before changing sessions');
  if (pendingUpload) {
    expect(chat.uploadName()).toBe('notes.txt');
    const uploadRequest = uploadRequests[0];
    uploadRequest?.dispatchEvent(new Event('abort'));
    await pendingUpload;
  }
}

it.each(['queued', 'upload'] as const)(
  'phone session buttons preserve a %s operation', checkGuardedNavigation,
);

async function checkNewSession(): Promise<void> {
  const fixture = await phoneWorkspace();
  const root = rootElement(fixture);
  const chat = fixture.debugElement.injector.get(ChatSession);
  expect(chat.selected()).toBe('chat');
  expect(chat.conversations()[0]?.conversationId).toBe('chat');
  button(root, '#navigation-toggle').click();
  await fixture.whenStable();
  button(root, 'oc-navigation-menu .new-session').click();
  await fixture.whenStable();
  expect(chat.selected()).toBe('');
  expect(root.querySelector('h1')?.textContent).toBe('New session');
  expect(location.search).toBe('');
}

it('phone New session opens a draft instead of loading the first conversation', checkNewSession);
