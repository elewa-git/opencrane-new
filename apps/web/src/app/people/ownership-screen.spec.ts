import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { OwnershipScreen } from './ownership-screen';

type SeenRequest = { url: string; method: string; body: string | undefined };
type RequestHandler = (request: SeenRequest) => Promise<Response>;

const owners = [owner('member-1', 'Marieke Vos')];
const grace = owner('member-2', 'Grace Achieng');
const twoOwners = [...owners, grace];
const dialogPrototype = globalThis.HTMLDialogElement.prototype;

Object.defineProperty(dialogPrototype, 'close', {
  configurable: true, writable: true, value: closeDialog,
});
Object.defineProperty(dialogPrototype, 'showModal', {
  configurable: true, writable: true, value: showDialog,
});

afterEach(() => vi.unstubAllGlobals());

it('shows the API owner list and does not invent a successor directory', async () => {
  const fixture = await mount([], singleOwnerHandler());
  const root = rootElement(fixture);
  expect(root.textContent).toContain('Marieke Vos');
  expect(root.textContent).toContain('Successor names and a list of eligible members');
  expect(root.textContent).toContain("You're the last owner");
});

it('moves to review on Enter without sending until the owner confirms', async () => {
    const requests: SeenRequest[] = [];
  const fixture = await mount(requests, ownerHandler(owners));
  clickButton(rootElement(fixture), 'Appoint an owner');
  fixture.detectChanges();
  const memberId = inputByLabel(rootElement(fixture), 'Successor member id');
    memberId.value = 'member-2';
    memberId.dispatchEvent(new Event('input', { bubbles: true }));
    memberId.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    fixture.detectChanges();
    expect(requests.filter(isPost)).toHaveLength(0);
    expect(rootElement(fixture).textContent).toContain('Review successor');
    expect(rootElement(fixture).textContent).toContain('Appoint member-2 as an owner?');
  });

it('keeps the proposed successor when the owner list refreshes', async () => {
  const requests: SeenRequest[] = [];
  const fixture = await mount(requests, ownerHandler(owners));
  clickButton(rootElement(fixture), 'Appoint an owner');
  fixture.detectChanges();
  const memberId = inputByLabel(rootElement(fixture), 'Successor member id');
  memberId.value = 'member-2';
  memberId.dispatchEvent(new Event('input', { bubbles: true }));
  fixture.detectChanges();
  expect(buttonByLabel(rootElement(fixture), 'Review appointment').disabled).toBe(false);

  clickButton(rootElement(fixture), 'Refresh owners');
  await vi.waitFor(() => expect(requests.filter(isOwnerGet)).toHaveLength(2));
  fixture.detectChanges();
  const refreshedMemberId = inputByLabel(rootElement(fixture), 'Successor member id');
  expect(refreshedMemberId.value).toBe('member-2');
  expect(buttonByLabel(rootElement(fixture), 'Review appointment').disabled).toBe(false);
  expect(requests.filter(isPost)).toHaveLength(0);
});

it('keeps an invalid successor id and does not save it', async () => {
  const requests: SeenRequest[] = [];
  const fixture = await mount(requests, ownerHandler(owners));
  clickButton(rootElement(fixture), 'Appoint an owner');
  fixture.detectChanges();
  const memberId = inputByLabel(rootElement(fixture), 'Successor member id');
  memberId.value = 'not valid';
  memberId.dispatchEvent(new Event('input', { bubbles: true }));
  fixture.detectChanges();

  const reviewButton = buttonByLabel(rootElement(fixture), 'Review appointment');
  expect(reviewButton.disabled).toBe(true);
  clickButton(rootElement(fixture), 'Review appointment');
  expect(inputByLabel(rootElement(fixture), 'Successor member id').value).toBe('not valid');
  expect(requests.filter(isPost)).toHaveLength(0);
});

it('keeps the second ownership change disabled while the first reply is pending', async () => {
  const requests: SeenRequest[] = [];
  const heldReply: { release?: (reply: Response) => void } = {};
  const fixture = await mount(requests, pendingPostResponse(heldReply));
  await enterTransferReview(fixture, 'member-3');
  clickButton(rootElement(fixture), 'Appoint this owner');

  await vi.waitFor(() => expect(requests.filter(isPost)).toHaveLength(1));
  fixture.detectChanges();
  expect(buttonByLabel(rootElement(fixture), 'Appoint an owner').disabled).toBe(true);
  expect(rootElement(fixture).textContent).toContain('Sending the ownership change');
  expect(rootElement(fixture).textContent).toContain('Another ownership change cannot start');
  expect(rootElement(fixture).textContent).not.toContain('The change was recorded');

  heldReply.release?.(jsonResponse({ status: 'unavailable' }, 503));
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(rootElement(fixture).textContent).toContain('could not tell whether');
  });
});

it('shows an existing-owner error inside the open appointment dialog', async () => {
  const fixture = await mount([], ownerHandler(twoOwners));
  clickButton(rootElement(fixture), 'Appoint an owner');
  fixture.detectChanges();
  const field = inputByLabel(rootElement(fixture), 'Successor member id');
  field.value = 'member-2';
  field.dispatchEvent(new Event('input', { bubbles: true }));
  fixture.detectChanges();
  clickButton(rootElement(fixture), 'Review appointment');
  fixture.detectChanges();

  const dialog = rootElement(fixture).querySelector('dialog');
  expect(dialog?.textContent).toContain('This person is already an owner');
  expect(dialog?.querySelector('[aria-describedby]')).not.toBeNull();
});

it('keeps focus on the dialog title as the appointment steps change', async () => {
  const fixture = await mount([], ownerHandler(owners));
  clickButton(rootElement(fixture), 'Appoint an owner');
  fixture.detectChanges();
  const field = inputByLabel(rootElement(fixture), 'Successor member id');
  field.value = 'member-2';
  field.dispatchEvent(new Event('input', { bubbles: true }));
  fixture.detectChanges();
  clickButton(rootElement(fixture), 'Review appointment');
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(document.activeElement?.textContent).toBe('Review successor');
  });
  clickButton(rootElement(fixture), 'Back');
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(document.activeElement?.textContent).toBe('Appoint an owner');
  });
});

it('does not show an earlier receipt on an existing-owner conflict', async () => {
  const fixture = await mount([], successfulTransfer(twoOwners));
  await enterTransferReview(fixture, 'member-3');
  clickButton(rootElement(fixture), 'Appoint this owner');
  await waitForConfirmed(fixture, 'member-3 is now an owner');
  clickButton(rootElement(fixture), 'Appoint an owner');
  fixture.detectChanges();
  const field = inputByLabel(rootElement(fixture), 'Successor member id');
  field.value = 'member-2';
  field.dispatchEvent(new Event('input', { bubbles: true }));
  fixture.detectChanges();
  clickButton(rootElement(fixture), 'Review appointment');
  clickButton(rootElement(fixture), 'Cancel');
  fixture.detectChanges();
  expect(rootElement(fixture).textContent).toContain('This person is already an owner');
  expect(rootElement(fixture).textContent).not.toContain('event-');
  expect(rootElement(fixture).textContent).not.toContain('10:50 UTC');
});

it('does not confirm while either ownership projection is still applying', async () => {
  const requests: SeenRequest[] = [];
  const fixture = await mount(requests, applyingTransfer);
  await enterTransferReview(fixture, 'member-2');
  clickButton(rootElement(fixture), 'Appoint this owner');
  await vi.waitFor(() => expect(requests.some(isStatusGet)).toBe(true));
  fixture.detectChanges();
  expect(rootElement(fixture).textContent).toContain('Waiting for ownership records');
  expect(rootElement(fixture).textContent).not.toContain('member-2 is now an owner');
  expect(buttonByLabel(rootElement(fixture), 'Check status')).toBeDefined();
});

it('announces a failed first owner read', async () => {
  const fixture = await mount([], failedOwnerRead);
  fixture.detectChanges();
  expect(rootElement(fixture).querySelector('[role="status"]')?.textContent)
    .toContain('Owners are unavailable right now');
});

it('moves focus to Owners and announces success after retrying a failed read', async () => {
  const requests: SeenRequest[] = [];
  let ownerReads = 0;
  const fixture = await mount(requests, (request) => {
    if (request.url === '/api/ownership') {
      ownerReads += 1;
      if (ownerReads === 1) return Promise.resolve(jsonResponse({}, 503));
      return Promise.resolve(jsonResponse(ownershipResponse(owners)));
    }
    return Promise.resolve(jsonResponse({}, 503));
  });
  const retryButton = buttonByLabel(rootElement(fixture), 'Try again');
  makeVisible(retryButton);
  retryButton.focus();
  retryButton.click();
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(document.activeElement?.id).toBe('ownership-heading');
  });
  expect(rootElement(fixture).querySelector('[role="status"]')?.textContent)
    .toContain('Owners loaded');
});

it('keeps an applying message when the owner list cannot be read after a current receipt', async () => {
  const requests: SeenRequest[] = [];
  let ownerReads = 0;
  const fixture = await mount(requests, (request) => {
    if (request.method === 'POST') {
      return Promise.resolve(jsonResponse(changeReceipt(postCommandId(request))));
    }
    if (request.url.includes('/changes/')) {
      return Promise.resolve(jsonResponse(changeReceipt(commandFromUrl(request.url), true)));
    }
    ownerReads += 1;
    if (ownerReads === 1) return Promise.resolve(jsonResponse(ownershipResponse(owners)));
    return Promise.resolve(jsonResponse({}, 503));
  });
  await enterTransferReview(fixture, 'member-2');
  clickButton(rootElement(fixture), 'Appoint this owner');
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(rootElement(fixture).textContent).toContain('owner list is not available yet');
  });
  expect(rootElement(fixture).textContent).not.toContain('member-2 is now an owner');
  expect(buttonByLabel(rootElement(fixture), 'Check status')).toBeDefined();
});

it('clears the page when the send says the session has expired', async () => {
  const fixture = await mount([], (request) => {
    if (request.method === 'POST') return Promise.resolve(jsonResponse({}, 401));
    return Promise.resolve(jsonResponse(ownershipResponse(owners)));
  });
  await enterTransferReview(fixture, 'member-2');
  clickButton(rootElement(fixture), 'Appoint this owner');
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(rootElement(fixture).textContent).toContain('Your access changed');
  });
  expect(rootElement(fixture).textContent).not.toContain('may or may not');
  expect(rootElement(fixture).textContent).toContain('Sign in again');
  expect(rootElement(fixture).querySelector('#appoint-owner')).toBeNull();
});

it('reports a missing change record and lets the owner refresh the list', async () => {
  const fixture = await mount([], loseTransferThenNotFound);
  await enterTransferReview(fixture, 'member-2');
  clickButton(rootElement(fixture), 'Appoint this owner');
  await vi.waitFor(() => expect(rootElement(fixture).textContent).toContain('could not tell'));
  clickButton(rootElement(fixture), 'Check status');
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(rootElement(fixture).textContent).toContain('The server has no record of this change');
  });
  expect(buttonByLabel(rootElement(fixture), 'Refresh owners').disabled).toBe(false);
  clickButton(rootElement(fixture), 'Refresh owners');
  await vi.waitFor(() => expect(rootElement(fixture).textContent).toContain('Another ownership'));
});

it('checks a lost reply with GET and says it may or may not have been recorded', async () => {
  const requests: SeenRequest[] = [];
  const fixture = await mount(requests, loseTransferThenNotFound);
  await enterTransferReview(fixture, 'member-2');
  clickButton(rootElement(fixture), 'Appoint this owner');
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(rootElement(fixture).textContent).toContain('could not tell whether');
  });

  clickButton(rootElement(fixture), 'Check status');
  await vi.waitFor(() => expect(requests.some(isStatusGet)).toBe(true));
  expect(requests.filter(isPost)).toHaveLength(1);
  expect(requests.find(isStatusGet)?.method).toBe('GET');
  expect(rootElement(fixture).textContent).toContain('Reference:');
  expect(rootElement(fixture).textContent).toContain('member id member-2 may or may not');
});

it('refreshes a healthy owner list without announcing a failure', async () => {
  const requests: SeenRequest[] = [];
  const fixture = await mount(requests, ownerHandler(owners));
  const status = rootElement(fixture).querySelector('[role="status"]');
  expect(status?.textContent?.trim()).toBe('');

  clickButton(rootElement(fixture), 'Refresh owners');
  await vi.waitFor(() => expect(requests.filter(isOwnerGet)).toHaveLength(2));
  fixture.detectChanges();
  expect(status?.textContent?.trim()).toBe('');
  expect(rootElement(fixture).textContent).not.toContain("couldn't refresh");
});

it('shows two owners only after the recorded transfer and current owner read', async () => {
  const requests: SeenRequest[] = [];
  const fixture = await mount(requests, successfulTransfer(twoOwners));
  const opener = buttonByLabel(rootElement(fixture), 'Appoint an owner');
  makeVisible(opener);
  opener.focus();
  await enterTransferReview(fixture, 'member-2');
  const confirmButton = buttonByLabel(rootElement(fixture), 'Appoint this owner');
  confirmButton.focus();
  expect(document.activeElement).toBe(confirmButton);
  confirmButton.click();

  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(rootElement(fixture).textContent).toContain('member-2 is now an owner');
    expect(document.activeElement?.id).toBe('appoint-owner');
  });
  expect(rootElement(fixture).textContent).toContain('Marieke Vos');
  expect(rootElement(fixture).textContent).toContain('Grace Achieng');
  expect(requests.filter(isPost)).toHaveLength(1);
});

it('clears a confirmed transfer so the next command gets a new id', async () => {
  const requests: SeenRequest[] = [];
  currentOwnerRows = [...owners];
  const fixture = await mount(requests, sequentialTransfers(saveOwners, currentOwnerList));
  await enterTransferReview(fixture, 'member-2');
  clickButton(rootElement(fixture), 'Appoint this owner');
  await waitForConfirmed(fixture, 'member-2 is now an owner');

  clickButton(rootElement(fixture), 'Appoint an owner');
  await enterTransferReview(fixture, 'member-3');
  clickButton(rootElement(fixture), 'Appoint this owner');
  await waitForConfirmed(fixture, 'member-3 is now an owner');

  const commands = requests.filter(isPost).map(postCommandId);
  expect(commands).toHaveLength(2);
  expect(commands[0]).not.toBe(commands[1]);
});

function owner(memberId: string, displayName: string) {
  return { memberId, displayName, role: 'owner' as const };
}

function ownerHandler(rows: ReturnType<typeof owner>[]) {
  return (request: SeenRequest): Promise<Response> => {
    if (request.url === '/api/ownership' && request.method === 'GET') {
      return Promise.resolve(jsonResponse(ownershipResponse(rows)));
    }
    return Promise.resolve(jsonResponse({ status: 'unavailable' }, 503));
  };
}

function failedOwnerRead(): Promise<Response> {
  return Promise.resolve(jsonResponse({ status: 'unavailable' }, 503));
}

function singleOwnerHandler() {
  return ownerHandler(owners);
}

function requestHandler(requests: SeenRequest[], handler: RequestHandler): typeof fetch {
  return function captureRequest(input: RequestInfo | URL, options?: RequestInit) {
    const request = seenRequest(input, options);
    requests.push(request);
    return handler(request);
  };
}

function pendingPostResponse(heldReply: { release?: (reply: Response) => void }) {
  let postStarted = false;
  return async (request: SeenRequest): Promise<Response> => {
    if (request.method === 'POST' && !postStarted) {
      postStarted = true;
      return new Promise<Response>((resolve) => { heldReply.release = resolve; });
    }
    return jsonResponse(ownershipResponse(twoOwners));
  };
}

function loseTransferThenNotFound(request: SeenRequest): Promise<Response> {
  if (request.method === 'POST') return Promise.reject(new Error('Reply lost'));
  if (request.url.includes('/changes/')) return Promise.resolve(jsonResponse({}, 404));
  return Promise.resolve(jsonResponse(ownershipResponse(owners)));
}

function successfulTransfer(nextOwners: ReturnType<typeof owner>[]): RequestHandler {
  let ownerReads = 0;
  return (request) => {
    if (request.url === '/api/ownership' && request.method === 'POST') {
      return Promise.resolve(jsonResponse(changeReceipt(postCommandId(request))));
    }
    if (request.url.includes('/changes/')) {
      return Promise.resolve(jsonResponse(changeReceipt(commandFromUrl(request.url), true)));
    }
    ownerReads += 1;
    if (ownerReads === 1) return Promise.resolve(jsonResponse(ownershipResponse(owners)));
    return Promise.resolve(jsonResponse(ownershipResponse(nextOwners)));
  };
}

function applyingTransfer(request: SeenRequest): Promise<Response> {
  if (request.method === 'POST') {
    return Promise.resolve(jsonResponse(changeReceipt(postCommandId(request))));
  }
  if (request.url.includes('/changes/')) {
    const receipt = changeReceipt(commandFromUrl(request.url));
    return Promise.resolve(jsonResponse({ ...receipt,
      projection: { content: 'applying', iam: 'current' } }));
  }
  return Promise.resolve(jsonResponse(ownershipResponse(owners)));
}

function sequentialTransfers(
  saveOwners: (nextOwners: ReturnType<typeof owner>[]) => void,
  currentOwners: () => ReturnType<typeof owner>[],
): RequestHandler {
  let counter = 2;
  const commandById = new Map<string, string>();
  return (request) => {
    if (request.url === '/api/ownership' && request.method === 'GET') {
      return Promise.resolve(jsonResponse(ownershipResponse(currentOwners())));
    }
    if (request.url === '/api/ownership' && request.method === 'POST') {
      const commandId = postCommandId(request);
      const successorId = postSuccessorId(request);
      commandById.set(commandId, successorId);
      const nextOwners = [...currentOwners(), owner(successorId, `Member ${counter}`)];
      counter += 1;
      saveOwners(nextOwners);
      return Promise.resolve(jsonResponse(changeReceipt(commandId)));
    }
    if (request.url.includes('/changes/')) {
      const commandId = commandFromUrl(request.url);
      return Promise.resolve(jsonResponse(changeReceipt(commandId, true,
        commandById.get(commandId) ?? 'unknown-member')));
    }
    return Promise.resolve(jsonResponse({ status: 'unavailable' }, 503));
  };
}

let currentOwnerRows: ReturnType<typeof owner>[] = [...owners];

function saveOwners(nextOwners: ReturnType<typeof owner>[]): void {
  currentOwnerRows = nextOwners;
}

function currentOwnerList(): ReturnType<typeof owner>[] {
  return currentOwnerRows;
}

async function mount(requests: SeenRequest[], handler: RequestHandler)
  : Promise<ComponentFixture<OwnershipScreen>> {
  vi.stubGlobal('fetch', requestHandler(requests, handler));
  TestBed.configureTestingModule({ imports: [OwnershipScreen] });
  const fixture = TestBed.createComponent(OwnershipScreen);
  fixture.componentRef.setInput('organisationName', 'Kijani Supplies');
  fixture.detectChanges();
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(rootElement(fixture).textContent).not.toContain('Loading owners…');
  });
  return fixture;
}

function enterTransferReview(
  fixture: ComponentFixture<OwnershipScreen>, memberId: string,
): Promise<void> {
  const root = rootElement(fixture);
  clickButton(root, 'Appoint an owner');
  fixture.detectChanges();
  const field = inputByLabel(root, 'Successor member id');
  field.value = memberId;
  field.dispatchEvent(new Event('input', { bubbles: true }));
  fixture.detectChanges();
  clickButton(root, 'Review appointment');
  fixture.detectChanges();
  expect(root.textContent).toContain(`Appoint ${memberId} as an owner?`);
  return Promise.resolve();
}

async function waitForConfirmed(
  fixture: ComponentFixture<OwnershipScreen>, message: string,
): Promise<void> {
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(rootElement(fixture).textContent).toContain(message);
  });
}

function clickButton(root: HTMLElement, text: string): void {
  const button = buttonByLabel(root, text);
  button.click();
}

function buttonByLabel(root: HTMLElement, text: string): HTMLButtonElement {
  const buttons = root.querySelectorAll('button');
  for (let index = buttons.length - 1; index >= 0; index -= 1) {
    const button = buttons[index];
    if (button?.textContent?.trim() === text) return button;
  }
  throw new Error(`Button not found: ${text}`);
}

function inputByLabel(root: HTMLElement, text: string): HTMLInputElement {
  const label = [...root.querySelectorAll('label')].find(matchesLabel(text));
  if (!label?.htmlFor) throw new Error(`Input label not found: ${text}`);
  const input = root.querySelector<HTMLInputElement>(`#${label.htmlFor}`);
  if (!input) throw new Error(`Input not found: ${label.htmlFor}`);
  return input;
}

function makeVisible(element: HTMLElement): void {
  Object.defineProperty(element, 'getClientRects', { value: visibleClientRects });
}

function visibleClientRects(): DOMRect[] {
  return [new DOMRect(0, 0, 120, 44)];
}

function matchesLabel(text: string): (label: HTMLLabelElement) => boolean {
  return (label) => label.textContent?.trim() === text;
}

function rootElement(fixture: ComponentFixture<OwnershipScreen>): HTMLElement {
  const element: unknown = fixture.nativeElement;
  if (!(element instanceof HTMLElement)) throw new Error('Expected the owners screen element');
  return element;
}

function ownershipResponse(rows: ReturnType<typeof owner>[], role: 'owner' | 'admin' = 'owner') {
  return { status: 'current', owners: rows, sequence: 7,
    viewer: { memberId: 'member-1', role }, ready: true };
}

function changeReceipt(
  commandId: string,
  current = false,
  successorId = 'member-2',
) {
  return {
    status: 'appended', commandId, changeId: `event-${commandId}`, sequence: 8,
    recordedAt: '2026-10-06T10:50:00.000Z', actorId: 'member-1',
    type: 'ownership.transferred',
    data: { memberId: successorId, transferredBy: 'member-1' },
    ...(current ? { projection: { content: 'current', iam: 'current' } } : {}),
  };
}

function seenRequest(input: RequestInfo | URL, options?: RequestInit): SeenRequest {
  return {
    url: input instanceof Request ? input.url : String(input),
    method: options?.method ?? 'GET',
    body: typeof options?.body === 'string' ? options.body : undefined,
  };
}

function isPost(request: SeenRequest): boolean {
  return request.method === 'POST';
}

function isOwnerGet(request: SeenRequest): boolean {
  return request.url === '/api/ownership' && request.method === 'GET';
}

function isStatusGet(request: SeenRequest): boolean {
  return request.url.includes('/changes/') && request.method === 'GET';
}

function postCommandId(request: SeenRequest): string {
  const body: unknown = JSON.parse(request.body ?? '{}');
  if (typeof body !== 'object' || body === null || !('commandId' in body) ||
      typeof body.commandId !== 'string') throw new Error('Command id is missing');
  return body.commandId;
}

function postSuccessorId(request: SeenRequest): string {
  const body: unknown = JSON.parse(request.body ?? '{}');
  if (typeof body !== 'object' || body === null || !('successorId' in body) ||
      typeof body.successorId !== 'string') throw new Error('Successor id is missing');
  return body.successorId;
}

function commandFromUrl(url: string): string {
  return decodeURIComponent(url.split('/').at(-1) ?? '');
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function closeDialog(this: HTMLDialogElement): void {
  this.removeAttribute('open');
}

function showDialog(this: HTMLDialogElement): void {
  this.setAttribute('open', '');
}
