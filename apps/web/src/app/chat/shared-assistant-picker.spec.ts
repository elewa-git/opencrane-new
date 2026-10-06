import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import type { MockInstance } from 'vitest';
import { SharedAssistantPicker } from './shared-assistant-picker';

const assistant = {
  assistantId: 'team-sales', ownerId: 'sales', kind: 'team', computerId: null,
  generation: 0, status: 'ready', changedAt: '2026-10-06T12:00:00Z',
  name: 'Sales assistant', grants: [{ resourceType: 'model', resourceId: 'gpt-6-luna' }],
  payingGroupId: 'sales', canStartSession: true, busy: false,
};

let fetchMock: MockInstance<typeof fetch>;
let sessionCreateBodies: string[] = [];
let statusReadCount = 0;

function showModal(this: HTMLDialogElement): void { this.setAttribute('open', ''); }
function closeDialog(this: HTMLDialogElement): void {
  this.removeAttribute('open');
  this.dispatchEvent(new Event('close'));
}

Object.assign(HTMLDialogElement.prototype, { showModal, close: closeDialog });

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  });
}

function fixtureRoot(value: unknown): HTMLElement {
  if (!(value instanceof HTMLElement)) throw new Error('Expected a component root element');
  return value;
}

async function mount(): Promise<{ root: HTMLElement; fixture: ComponentFixture<SharedAssistantPicker> }> {
  fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSharedRequest);
  const fixture = TestBed.createComponent(SharedAssistantPicker);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  const root = fixtureRoot(fixture.nativeElement);
  await vi.waitFor(() => {
    if (root.querySelector('.assistant-choice')) return;
    throw new Error(`Shared assistants did not load: ${root.textContent}`);
  });
  return { root, fixture };
}

function fetchSharedRequest(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url === '/api/assistants') return Promise.resolve(response({ rows: [assistant] }));
  if (url.includes('/changes/')) {
    const parts = url.split('/');
    const commandId = parts.at(-1) ?? '';
    const conversationId = parts.at(-3) ?? '';
    return Promise.resolve(response({ status: 'appended', conversationId,
      commandId, type: 'conversation.created', sequence: 1,
      projection: { content: 'applying', iam: 'applying' } }));
  }
  if (url === '/api/conversations' && init?.method === 'POST') {
    return Promise.resolve(response({ status: 'appended', sequence: 1 }));
  }
  throw new Error(`Unexpected request: ${url}`);
}

function fetchLostCreateThenForbiddenStatus(
  input: RequestInfo | URL, init?: RequestInit,
): Promise<Response> {
  const url = urlOf(input);
  if (url === '/api/assistants') return Promise.resolve(response({ rows: [assistant] }));
  if (url === '/api/conversations' && init?.method === 'POST') {
    const body = typeof init.body === 'string' ? init.body : '';
    sessionCreateBodies.push(body);
    if (sessionCreateBodies.length === 1) return Promise.reject(new Error('reply lost'));
    return Promise.resolve(response({ status: 'appended', sequence: 1 }));
  }
  if (url.includes('/changes/')) {
    statusReadCount += 1;
    if (statusReadCount === 1) return Promise.resolve(response({}, 403));
    const path = url.split('/');
    return Promise.resolve(response({ status: 'appended', conversationId: path.at(-3),
      commandId: path.at(-1), type: 'conversation.created', sequence: 1,
      projection: { content: 'applying', iam: 'applying' } }));
  }
  throw new Error(`Unexpected request: ${url}`);
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function text(root: HTMLElement): string { return root.textContent ?? ''; }

function button(root: HTMLElement, label: string): HTMLButtonElement {
  const buttons = [...root.querySelectorAll('button')];
  const match = buttons.find(buttonHasLabel.bind(null, label));
  if (!match) throw new Error(`Expected button ${label}`);
  return match;
}

function buttonHasLabel(label: string, candidate: HTMLButtonElement): boolean {
  return candidate.textContent?.trim() === label;
}

function isPostCall(call: Parameters<typeof fetch>): boolean {
  const init = call[1];
  return init?.method === 'POST';
}

beforeEach(() => {
  vi.restoreAllMocks();
  sessionCreateBodies = [];
  statusReadCount = 0;
});

it('shows one full-row choice and confirms its fixed payer', async () => {
  const { root, fixture } = await mount();
  const row = root.querySelector<HTMLButtonElement>('.assistant-choice');
  expect(row?.textContent).toContain('Sales assistant');
  expect(row?.textContent).toContain('paying group sales (fixed)');
  row?.click();
  fixture.detectChanges();
  expect(text(root)).toContain('The payer stays sales for this session’s work.');
  fixture.destroy();
});

it('keeps one pending session reference after a lost reply and status checks only read', async () => {
  const { root, fixture } = await mount();
  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === '/api/conversations' && init?.method === 'POST') {
      return Promise.reject(new Error('lost reply'));
    }
    return fetchSharedRequest(input, init);
  });
  root.querySelector<HTMLButtonElement>('.assistant-choice')?.click();
  fixture.detectChanges();
  button(root, 'Start session').click();
  await vi.waitFor(() => expect(text(root)).toContain('We could not tell whether the session was recorded'));
  const callsBeforeCheck = fetchMock.mock.calls;
  const postsBeforeCheck = callsBeforeCheck.filter(isPostCall).length;
  button(root, 'Check status').click();
  await vi.waitFor(() => expect(text(root)).toContain('still being applied'));
  const callsAfterCheck = fetchMock.mock.calls;
  const postsAfterCheck = callsAfterCheck.filter(isPostCall).length;
  expect(postsAfterCheck).toBe(postsBeforeCheck);
  expect(text(root)).toContain('Change reference:');
  fixture.destroy();
});

it('keeps its reference when Check status gets 403 for a missing session', async () => {
  const { root, fixture } = await mount();
  fetchMock.mockImplementation(fetchLostCreateThenForbiddenStatus);
  root.querySelector<HTMLButtonElement>('.assistant-choice')?.click();
  fixture.detectChanges();
  button(root, 'Start session').click();
  await vi.waitFor(() =>
    expect(text(root)).toContain('We could not tell whether the session was recorded'));
  button(root, 'Check status').click();
  await vi.waitFor(() => expect(text(root)).toContain('The session change was not recorded'));
  expect(text(root)).not.toContain('Your access changed');
  expect(text(root)).toContain('Change reference:');
  expect(text(root)).toContain('Send the same request again');
  button(root, 'Send the same request again').click();
  await vi.waitFor(() => expect(sessionCreateBodies).toHaveLength(2));
  expect(sessionCreateBodies[1]).toBe(sessionCreateBodies[0]);
  fixture.destroy();
});

it('blocks selecting a second assistant while the first session is unresolved', async () => {
  const secondAssistant = { ...assistant, assistantId: 'team-support', name: 'Support assistant' };
  fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url === '/api/assistants') return response({ rows: [assistant, secondAssistant] });
      if (url === '/api/conversations' && init?.method === 'POST') {
        return new Promise<Response>(() => {});
      }
      return fetchSharedRequest(input, init);
    });
  const fixture = TestBed.createComponent(SharedAssistantPicker);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  const root = fixtureRoot(fixture.nativeElement);
  await vi.waitFor(() => {
    if (root.querySelectorAll('.assistant-choice').length === 2) return;
    throw new Error(`Two assistants did not load: ${root.textContent}`);
  });
  const choices = [...root.querySelectorAll<HTMLButtonElement>('.assistant-choice')];
  expect(choices).toHaveLength(2);
  choices[0]?.click();
  fixture.detectChanges();
  button(root, 'Start session').click();
  await vi.waitFor(() =>
    expect(root.textContent).toContain('Starting your private session'));
  expect(root.textContent).not.toContain('Check status');
  fixture.detectChanges();
  const refreshedChoices = [...root.querySelectorAll<HTMLButtonElement>('.assistant-choice')];
  expect(refreshedChoices.every(choice => choice.disabled)).toBe(true);
  expect(fetchMock.mock.calls.filter(isPostCall)).toHaveLength(1);
  fixture.destroy();
});

it('does not announce a failed refresh while the shared assistant list is healthy', async () => {
  const { root, fixture } = await mount();
  button(root, 'Refresh list').click();
  await vi.waitFor(() => expect(text(root)).toContain('Sales assistant'));
  expect(text(root)).not.toContain('Could not refresh');
  expect(text(root)).not.toContain('Could not load');
  fixture.destroy();
});
