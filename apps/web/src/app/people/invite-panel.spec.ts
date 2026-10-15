import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { invitationCommandSchema } from '@opencrane/protocol';
import { InvitePanel } from './invite-panel';

Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
  configurable: true, value: function showModal(this: HTMLDialogElement): void {
    this.setAttribute('open', '');
  },
});
Object.defineProperty(HTMLDialogElement.prototype, 'close', {
  configurable: true, value: function close(this: HTMLDialogElement): void {
    this.removeAttribute('open');
  },
});

const email = 'person@example.test';
const expiry = '2026-10-22T12:00:00Z';
const link = 'https://example.test/join/member-id/invitation-id';
const requests: { url: string; method: string; body?: unknown }[] = [];
let createStatus = 200;
let identityStatus = 200;
let changeStatus = 200;
let refusalReason = '';
let statusResult = true;
let networkFailure = false;

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status,
    headers: { 'content-type': 'application/json' } });
}

function responseWithStalledBody(status: number): Response {
  const body = new ReadableStream<Uint8Array>({
    start(): void {
      // Leave the body open to check that denial needs only the response status.
    },
  });
  return new Response(body, { status });
}

function fetchReply(input: RequestInfo | URL, options?: RequestInit): Promise<Response> {
  const url = requestUrl(input);
  const method = options?.method ?? 'GET';
  const body: unknown = typeof options?.body === 'string'
    ? JSON.parse(options.body) : undefined;
  requests.push({ url, method, body });
  if (url.endsWith('/identity')) {
    return Promise.resolve(response({ status: 'confirmation_on_acceptance', email,
      message: 'The person is confirmed when they accept the invitation.' }, identityStatus));
  }
  if (method === 'POST') {
    if (networkFailure) return Promise.reject(new Error('connection lost'));
    const body = createStatus === 409 ? { status: 'refused', reason: refusalReason }
      : { status: 'appended' };
    return Promise.resolve(response(body, createStatus));
  }
  const command = requests.find((request) => request.url === '/api/invitations')?.body;
  const ids = invitationCommandSchema.parse(command);
  const recorded = { status: 'recorded', commandId: ids.commandId,
    result: { status: 'appended', memberId: ids.memberId, invitationId: 'invitation-id',
      sequence: 1, createdAt: '2026-10-15T12:00:00Z', expiresAt: expiry,
      email, role: 'member', personalAssistant: 'provision', delivery: 'link_only', link } };
  if (!statusResult) return Promise.resolve(response({ status: 'recorded',
    commandId: ids.commandId }));
  return Promise.resolve(response(recorded, changeStatus));
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof Request) return input.url;
  return input.toString();
}

function mount(): { root: HTMLElement; fixture: ComponentFixture<InvitePanel> } {
  vi.stubGlobal('fetch', vi.fn(fetchReply));
  TestBed.configureTestingModule({ imports: [InvitePanel] });
  const fixture = TestBed.createComponent(InvitePanel);
  fixture.componentRef.setInput('allowed', true);
  fixture.componentRef.setInput('selectedTab', 'invitations');
  fixture.detectChanges();
  const element: unknown = fixture.nativeElement;
  if (!(element instanceof HTMLElement)) throw new Error('Expected a panel element');
  const root = element;
  return { root, fixture };
}

function open(fixture: ComponentFixture<InvitePanel>): void {
  const opener = document.createElement('button');
  opener.textContent = 'Invite people';
  opener.dataset['inviteTest'] = 'opener';
  document.body.append(opener);
  fixture.componentInstance.open(opener);
  fixture.detectChanges();
}

function button(root: HTMLElement, label: string): HTMLButtonElement {
  const found = [...root.querySelectorAll('button')].find((item) =>
    item.textContent?.trim() === label);
  if (!found) throw new Error(`Missing ${label}`);
  return found;
}

async function settle(fixture: ComponentFixture<InvitePanel>): Promise<void> {
  for (let index = 0; index < 12; index += 1) {
    fixture.detectChanges();
    await fixture.whenStable();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  fixture.detectChanges();
}

function enterEmail(root: HTMLElement, value: string): void {
  const field = root.querySelector<HTMLInputElement>('#invite-email');
  if (!field) throw new Error('Missing email field');
  field.value = value;
  field.dispatchEvent(new Event('input'));
}

afterEach(() => {
  document.querySelectorAll('[data-invite-test="opener"]').forEach((opener) => opener.remove());
  requests.length = 0;
  createStatus = 200;
  identityStatus = 200;
  changeStatus = 200;
  refusalReason = '';
  statusResult = true;
  networkFailure = false;
  vi.unstubAllGlobals();
});

it('links bad email errors to the field and sends no invitation', async () => {
  const { root, fixture } = mount();
  open(fixture);
  enterEmail(root, 'bad');
  button(root, 'Create').click();
  await settle(fixture);
  expect(root.querySelector('#invite-email')?.getAttribute('aria-describedby'))
    .toContain('invite-email-error');
  expect(root.querySelector('#invite-email-error')?.textContent).toBeTruthy();
  expect(requests.some((request) => request.url === '/api/invitations')).toBe(false);
  expect(root.textContent).not.toContain('not found');
  identityStatus = 400;
  enterEmail(root, email);
  button(root, 'Create').click();
  await settle(fixture);
  expect(root.querySelector('#invite-email-error')?.textContent).toBeTruthy();
  expect(requests.some((request) => request.url === '/api/invitations')).toBe(false);
});

it('sends one exact command for two Create clicks and shows the link', async () => {
  const { root, fixture } = mount();
  open(fixture);
  enterEmail(root, ' Person@Example.Test ');
  button(root, 'Create').click();
  button(root, 'Create').click();
  await settle(fixture);
  const posts = requests.filter((request) => request.url === '/api/invitations');
  expect(posts).toHaveLength(1);
  const command = invitationCommandSchema.parse(posts[0]?.body);
  const raw = posts[0]?.body;
  if (typeof raw !== 'object' || raw === null) throw new Error('Missing command body');
  expect(Object.keys(raw)).toEqual([
    'commandId', 'memberId', 'email', 'expectedSequence', 'role', 'personalAssistant']);
  expect(command.memberId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  expect(command).toMatchObject({ email, expectedSequence: 0,
    role: 'member', personalAssistant: 'provision' });
  expect(root.querySelector<HTMLInputElement>('#invitation-link')?.value).toBe(link);
  expect(root.querySelector('#invitation-link')?.hasAttribute('readonly')).toBe(true);
  expect(root.textContent).toContain('No email was sent');
  expect(root.textContent).toContain('22 October 2026');
});

it('keeps an unknown command for GET-only status checks', async () => {
  createStatus = 503;
  const { root, fixture } = mount();
  open(fixture);
  enterEmail(root, email);
  button(root, 'Create').click();
  await settle(fixture);
  expect(root.textContent).toContain('Check status');
  expect(fixture.componentInstance.unavailable()).toBe(true);
  button(root, 'Check status').click();
  await settle(fixture);
  expect(requests.filter((request) => request.url === '/api/invitations')).toHaveLength(1);
  expect(requests.some((request) => request.method === 'GET' &&
    request.url.includes('/command-changes/'))).toBe(true);
  expect(root.querySelector<HTMLInputElement>('#invitation-link')?.value).toBe(link);
});

it('says a missing status may still arrive and retains the original ids', async () => {
  createStatus = 503;
  changeStatus = 404;
  const { root, fixture } = mount();
  open(fixture);
  enterEmail(root, email);
  button(root, 'Create').click();
  await settle(fixture);
  button(root, 'Check status').click();
  await settle(fixture);
  const command = invitationCommandSchema.parse(requests.find((request) =>
    request.url === '/api/invitations')?.body);
  expect(requests.at(-1)?.url).toBe(`/api/invitations/${command.memberId}`
    + `/command-changes/${command.commandId}`);
  expect(root.textContent).toContain('may still arrive');
  expect(requests.filter((request) => request.method === 'POST' &&
    request.url === '/api/invitations')).toHaveLength(1);
});

it.each(['already_member', 'access_removed', 'identity_mismatch', 'concurrent_change'])(
  'shows the %s refusal and creates fresh ids next time', async (reason) => {
    createStatus = 409;
    refusalReason = reason;
    const { root, fixture } = mount();
    open(fixture);
    enterEmail(root, email);
    button(root, 'Create').click();
    await settle(fixture);
    expect(root.textContent).toContain('Nothing was created');
    if (reason === 'identity_mismatch') {
      expect(root.textContent).toContain("Renewing it isn't available yet");
    }
    createStatus = 200;
    button(root, 'Create').click();
    await settle(fixture);
    const posts = requests.filter((request) => request.url === '/api/invitations');
    const first = invitationCommandSchema.parse(posts[0]?.body);
    const second = invitationCommandSchema.parse(posts[1]?.body);
    expect(second.commandId).not.toBe(first.commandId);
    expect(second.memberId).not.toBe(first.memberId);
  });

it('copies once, and a failed copy selects the full link', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  const { root, fixture } = mount();
  open(fixture);
  enterEmail(root, email);
  button(root, 'Create').click();
  await settle(fixture);
  button(root, 'Copy link').click();
  await settle(fixture);
  expect(writeText).toHaveBeenCalledExactlyOnceWith(link);
  expect(root.querySelectorAll('[role="status"]')).toHaveLength(1);
  expect(root.textContent).toContain('Link copied');
  writeText.mockRejectedValueOnce(new Error('denied'));
  button(root, 'Copy link').click();
  await settle(fixture);
  const field = root.querySelector<HTMLInputElement>('#invitation-link');
  expect(field?.selectionStart).toBe(0);
  expect(field?.selectionEnd).toBe(link.length);
  expect(root.textContent).toContain('copy it with your keyboard');
  button(root, 'Done').click();
  await settle(fixture);
  expect(root.querySelector('dialog')?.open).toBe(false);
});

it.each([401, 403])('clears private data on %i', async (status) => {
  createStatus = status;
  const { root, fixture } = mount();
  open(fixture);
  enterEmail(root, email);
  button(root, 'Create').click();
  await settle(fixture);
  expect(root.querySelector<HTMLInputElement>('#invite-email')?.value).toBe('');
  expect(fixture.componentInstance.unavailable()).toBe(true);
  expect(root.querySelector<HTMLInputElement>('#invitation-link')).toBeNull();
});

it.each([401, 403])('clears the open form before a %i body arrives', async (status) => {
  const { root, fixture } = mount();
  function heldDenial(input: RequestInfo | URL, options?: RequestInit): Promise<Response> {
    if (requestUrl(input).endsWith('/identity')) {
      return Promise.resolve(responseWithStalledBody(status));
    }
    return fetchReply(input, options);
  }
  vi.stubGlobal('fetch', vi.fn(heldDenial));
  open(fixture);
  enterEmail(root, email);
  expect(root.querySelector<HTMLInputElement>('#invite-email')?.value).toBe(email);
  button(root, 'Create').click();
  await settle(fixture);
  expect(root.querySelector<HTMLInputElement>('#invite-email')?.value).toBe('');
  expect(root.querySelector('dialog')?.open).toBe(false);
  expect(fixture.componentInstance.unavailable()).toBe(true);
  expect(requests.some((request) => request.url === '/api/invitations')).toBe(false);
});

it('treats a recorded status without result as access loss', async () => {
  statusResult = false;
  const { root, fixture } = mount();
  open(fixture);
  enterEmail(root, email);
  button(root, 'Create').click();
  await settle(fixture);
  expect(fixture.componentInstance.unavailable()).toBe(true);
  expect(root.querySelector<HTMLInputElement>('#invitation-link')).toBeNull();
  expect(root.querySelector<HTMLInputElement>('#invite-email')?.value).toBe('');
});

it('treats a network failure as unknown without resending', async () => {
  networkFailure = true;
  const { root, fixture } = mount();
  open(fixture);
  enterEmail(root, email);
  button(root, 'Create').click();
  await settle(fixture);
  expect(root.textContent).toContain('Check status');
  expect(requests.filter((request) => request.url === '/api/invitations')).toHaveLength(1);
});

it.each(['Cancel', 'access loss'])('ignores an identity reply after %s', async (reason) => {
  const { root, fixture } = mount();
  let release: ((result: Response) => void) | undefined;
  function heldFetch(input: RequestInfo | URL, options?: RequestInit): Promise<Response> {
    if (requestUrl(input).endsWith('/identity')) {
      return new Promise<Response>((resolve) => { release = resolve; });
    }
    return fetchReply(input, options);
  }
  vi.stubGlobal('fetch', vi.fn(heldFetch));
  open(fixture);
  enterEmail(root, email);
  button(root, 'Create').click();
  await settle(fixture);
  if (reason === 'Cancel') button(root, 'Cancel').click();
  else fixture.componentInstance.clearAccess();
  await settle(fixture);
  release?.(response({ status: 'confirmation_on_acceptance', email,
    message: 'The person is confirmed when they accept the invitation.' }));
  await settle(fixture);
  expect(root.querySelector('dialog')?.open).toBe(false);
  expect(requests.some((request) => request.url === '/api/invitations')).toBe(false);
  expect(root.querySelector<HTMLInputElement>('#invitation-link')).toBeNull();
});
