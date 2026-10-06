import { TestBed } from '@angular/core/testing';
import type { MockInstance } from 'vitest';
import { z } from 'zod';
import { SharedAssistantAdmin } from './shared-assistant-admin';

const group = {
  groupId: 'sales', name: 'Sales team', membershipSource: 'local', position: 1,
  payingGroupId: 'sales', members: [],
  access: { source: 'group_membership', conversationAccess: false,
    personalMemoryAccess: false,
    grants: [{ resourceType: 'model', resourceId: 'gpt-6-luna', relation: 'use' }] },
};
const otherGroup = {
  ...group, groupId: 'support', name: 'Support team', payingGroupId: 'support',
};

let fetchMock: MockInstance<typeof fetch>;

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

const createBodySchema = z.object({ assistantId: z.string(), commandId: z.string() });

function readCreateBody(init: RequestInit | undefined): z.infer<typeof createBodySchema> {
  if (typeof init?.body !== 'string') throw new Error('Expected a JSON create body');
  return createBodySchema.parse(JSON.parse(init.body));
}

function rows() {
  return response({ rows: [] });
}

function models() {
  return response({ models: [{ id: 'gpt-6-luna', retired: false }] });
}

function currentChange(assistantId: string, commandId: string) {
  return response({ status: 'appended', assistantId, sequence: 1, changeId: commandId,
    projection: { content: 'current', iam: 'current' } });
}

async function mount(): Promise<HTMLElement> {
  fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(fetchAdminRequest);
  const fixture = TestBed.createComponent(SharedAssistantAdmin);
  fixture.componentRef.setInput('groupId', 'sales');
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  const root = fixtureRoot(fixture.nativeElement);
  await vi.waitFor(() => {
    const input = root.querySelector('#assistant-name');
    if (input) return;
    throw new Error(`Assistant choices did not load: ${root.textContent}`);
  });
  return root;
}

function fetchAdminRequest(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url === '/api/groups/sales') return Promise.resolve(response({ rows: [group] }));
  if (url === '/api/groups') return Promise.resolve(response({ rows: [group, otherGroup] }));
  if (url === '/api/assistants' && init?.method !== 'POST') return Promise.resolve(rows());
  if (url === '/api/org/models') return Promise.resolve(models());
  if (url.includes('/changes/')) {
    const parts = url.split('/');
    const commandId = parts.at(-1) ?? '';
    const assistantId = parts.at(-3) ?? '';
    return Promise.resolve(currentChange(assistantId, commandId));
  }
  if (url === '/api/assistants' && init?.method === 'POST') {
    const body = readCreateBody(init);
    return Promise.resolve(response({ status: 'appended', assistantId: body.assistantId,
      sequence: 1, changeId: body.commandId }));
  }
  throw new Error(`Unexpected request: ${url}`);
}

function rootText(root: HTMLElement): string { return root.textContent ?? ''; }

function nameField(root: HTMLElement): HTMLInputElement {
  const input = root.querySelector<HTMLInputElement>('#assistant-name');
  if (!input) throw new Error('Expected the assistant name field');
  return input;
}

function buttonNamed(root: HTMLElement, label: string): HTMLButtonElement {
  const buttons = [...root.querySelectorAll('button')];
  const button = buttons.find(buttonHasLabel.bind(null, label));
  if (!button) throw new Error(`Expected button named ${label}`);
  return button;
}

function buttonHasLabel(label: string, button: HTMLButtonElement): boolean {
  return button.textContent?.trim() === label;
}

function selectFirstGrant(root: HTMLElement): void {
  const checkbox = root.querySelector<HTMLInputElement>('.grant-choice input');
  if (!checkbox) throw new Error('Expected a grant choice');
  checkbox.checked = true;
  checkbox.dispatchEvent(new Event('change', { bubbles: true }));
}

beforeEach(() => { vi.restoreAllMocks(); });

it('keeps a healthy list clean when refreshed', async () => {
  const root = await mount();
  const name = nameField(root);
  name.value = 'Typed before refresh';
  name.dispatchEvent(new Event('input', { bubbles: true }));
  selectFirstGrant(root);
  const payer = root.querySelector<HTMLSelectElement>('#assistant-payer');
  if (!payer) throw new Error('Expected the paying group field');
  payer.value = 'support';
  payer.dispatchEvent(new Event('change', { bubbles: true }));
  buttonNamed(root, 'Refresh').click();
  await vi.waitFor(() => expect(rootText(root)).toContain('Create a shared assistant'));
  expect(rootText(root)).not.toContain('Could not load');
  expect(rootText(root)).not.toContain('Nothing changed by this read');
  expect(nameField(root).value).toBe('Typed before refresh');
  expect(root.querySelector<HTMLInputElement>('.grant-choice input')?.checked).toBe(true);
  expect(root.querySelector<HTMLSelectElement>('#assistant-payer')?.value).toBe('support');
});

it('does not create when Enter is pressed in the name field', async () => {
  const root = await mount();
  const input = nameField(root);
  selectFirstGrant(root);
  input.value = 'Quarterly helper';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await Promise.resolve();
  expect(fetchMock).not.toHaveBeenCalledWith('/api/assistants', expect.objectContaining({ method: 'POST' }));
});

it('keeps typed values after a refused create', async () => {
  const root = await mount();
  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === '/api/assistants' && init?.method === 'POST') {
      return Promise.resolve(response({ status: 'refused' }, 400));
    }
    return fetchAdminRequest(input, init);
  });
  const input = nameField(root);
  selectFirstGrant(root);
  input.value = 'A deliberately long team helper name';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  buttonNamed(root, 'Review assistant').click();
  await Promise.resolve();
  buttonNamed(root, 'Create assistant').click();
  await vi.waitFor(() => expect(rootText(root)).toContain('server refused these details'));
  expect(nameField(root).value).toBe('A deliberately long team helper name');
});

it('keeps typed values and the command reference when the create reply is lost', async () => {
  const root = await mount();
  const input = nameField(root);
  selectFirstGrant(root);
  input.value = 'Typed assistant name';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === '/api/assistants' && init?.method === 'POST') {
      return Promise.reject(new Error('reply lost'));
    }
    return fetchAdminRequest(input, init);
  });
  buttonNamed(root, 'Review assistant').click();
  await Promise.resolve();
  buttonNamed(root, 'Create assistant').click();
  await vi.waitFor(() => expect(rootText(root)).toContain('We could not tell whether this was recorded'));
  expect(nameField(root).value).toBe('Typed assistant name');
  expect(rootText(root)).toContain('Check status');
  expect(rootText(root)).toContain('Reference:');
});

it('blocks another create while the first reply is still pending', async () => {
  let finishPost!: (reply: Response) => void;
  fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(
    (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === '/api/assistants' && init?.method === 'POST') {
      return new Promise<Response>(resolve => { finishPost = resolve; });
    }
    return fetchAdminRequest(input, init);
    });
  const fixture = TestBed.createComponent(SharedAssistantAdmin);
  fixture.componentRef.setInput('groupId', 'sales');
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  const root = fixtureRoot(fixture.nativeElement);
  await vi.waitFor(() => {
    if (root.querySelector('#assistant-name')) return;
    throw new Error(`Assistant choices did not load: ${root.textContent}`);
  });
  nameField(root).value = 'Pending helper';
  selectFirstGrant(root);
  nameField(root).dispatchEvent(new Event('input', { bubbles: true }));
  buttonNamed(root, 'Review assistant').click();
  await Promise.resolve();
  buttonNamed(root, 'Create assistant').click();
  await vi.waitFor(() => expect(buttonNamed(root, 'Creating…').disabled).toBe(true));
  expect(buttonNamed(root, 'Refresh').disabled).toBe(true);
  finishPost(response({ status: 'appended', assistantId: 'team-one', sequence: 1,
    changeId: 'command-one' }));
  await fixture.whenStable();
  fixture.destroy();
});

it('clears a confirmed create so the next create gets a new command id', async () => {
  const root = await mount();
  const input = nameField(root);
  input.value = 'Repeated helper';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  const commandIds: string[] = [];
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === '/api/assistants' && init?.method === 'POST') {
      const body = readCreateBody(init);
      commandIds.push(body.commandId);
      return Promise.resolve(response({ status: 'appended', assistantId: body.assistantId,
        sequence: 1, changeId: body.commandId }));
    }
    return fetchAdminRequest(input, init);
  });
  for (let createNumber = 0; createNumber < 2; createNumber += 1) {
    selectFirstGrant(root);
    buttonNamed(root, 'Review assistant').click();
    await Promise.resolve();
    buttonNamed(root, 'Create assistant').click();
    await vi.waitFor(() => expect(rootText(root)).toContain('The assistant record and access changes are current'));
  }
  expect(commandIds).toHaveLength(2);
  expect(commandIds[0]).not.toBe(commandIds[1]);
});
