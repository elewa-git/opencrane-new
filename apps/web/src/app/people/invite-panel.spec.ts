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

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status,
    headers: { 'content-type': 'application/json' } });
}

function fetchReply(input: RequestInfo | URL, options?: RequestInit): Promise<Response> {
  const url = String(input);
  const method = options?.method ?? 'GET';
  const body: unknown = options?.body ? JSON.parse(String(options.body)) : undefined;
  requests.push({ url, method, body });
  if (url.endsWith('/identity')) {
    return Promise.resolve(response({ status: 'confirmation_on_acceptance', email,
      message: 'The person is confirmed when they accept the invitation.' }, identityStatus));
  }
  if (method === 'POST') {
    return Promise.resolve(response({ status: 'appended' }, createStatus));
  }
  const command = requests.find((request) => request.url === '/api/invitations')?.body;
  const ids = invitationCommandSchema.parse(command);
  return Promise.resolve(response({ status: 'recorded', commandId: ids.commandId,
    result: { status: 'appended', memberId: ids.memberId, invitationId: 'invitation-id',
      sequence: 1, createdAt: '2026-10-15T12:00:00Z', expiresAt: expiry,
      email, role: 'member', personalAssistant: 'provision', delivery: 'link_only', link } },
  changeStatus));
}

async function mount(): Promise<{ root: HTMLElement; fixture: ComponentFixture<InvitePanel> }> {
  vi.stubGlobal('fetch', vi.fn(fetchReply));
  TestBed.configureTestingModule({ imports: [InvitePanel] });
  const fixture = TestBed.createComponent(InvitePanel);
  fixture.componentRef.setInput('allowed', true);
  fixture.componentRef.setInput('selectedTab', 'invitations');
  fixture.detectChanges();
  const root = fixture.nativeElement as HTMLElement;
  return { root, fixture };
}

function button(root: HTMLElement, label: string): HTMLButtonElement {
  const found = [...root.querySelectorAll('button')].find((item) =>
    item.textContent?.trim() === label);
  if (!found) throw new Error(`Missing ${label}`);
  return found;
}

async function settle(fixture: ComponentFixture<InvitePanel>): Promise<void> {
  for (let index = 0; index < 3; index += 1) {
    fixture.detectChanges();
    await fixture.whenStable();
  }
}

async function enterEmail(root: HTMLElement, value: string): Promise<void> {
  const field = root.querySelector<HTMLInputElement>('#invite-email');
  if (!field) throw new Error('Missing email field');
  field.value = value;
  field.dispatchEvent(new Event('input'));
}

afterEach(() => {
  requests.length = 0;
  createStatus = 200;
  identityStatus = 200;
  changeStatus = 200;
  vi.unstubAllGlobals();
});

it('links bad email errors to the field and sends no invitation', async () => {
  const { root, fixture } = await mount();
  button(root, 'Invite people').click();
  await enterEmail(root, 'bad');
  button(root, 'Create').click();
  await settle(fixture);
  expect(root.querySelector('#invite-email')?.getAttribute('aria-describedby'))
    .toContain('invite-email-error');
  expect(root.querySelector('#invite-email-error')?.textContent).toBeTruthy();
  expect(requests.some((request) => request.url === '/api/invitations')).toBe(false);
  expect(root.textContent).not.toContain('not found');
  identityStatus = 400;
  await enterEmail(root, email);
  button(root, 'Create').click();
  await settle(fixture);
  expect(root.querySelector('#invite-email-error')?.textContent).toBeTruthy();
  expect(requests.some((request) => request.url === '/api/invitations')).toBe(false);
});

it('sends one exact command for two Create clicks and shows the link', async () => {
  const { root, fixture } = await mount();
  button(root, 'Invite people').click();
  await enterEmail(root, ' Person@Example.Test ');
  button(root, 'Create').click();
  button(root, 'Create').click();
  await settle(fixture);
  const posts = requests.filter((request) => request.url === '/api/invitations');
  expect(posts).toHaveLength(1);
  const command = invitationCommandSchema.parse(posts[0]?.body);
  expect(Object.keys(posts[0]?.body as object)).toEqual([
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
  const { root, fixture } = await mount();
  button(root, 'Invite people').click();
  await enterEmail(root, email);
  button(root, 'Create').click();
  await settle(fixture);
  expect(root.textContent).toContain('Check status');
  expect(button(root, 'Invite people').disabled).toBe(true);
  button(root, 'Check status').click();
  await settle(fixture);
  expect(requests.filter((request) => request.url === '/api/invitations')).toHaveLength(1);
  expect(requests.some((request) => request.method === 'GET' &&
    request.url.includes('/command-changes/'))).toBe(true);
  expect(root.querySelector<HTMLInputElement>('#invitation-link')?.value).toBe(link);
});
