import { z } from 'zod';
import { TestBed } from '@angular/core/testing';
import { KeyAssistants } from './key-assistants';

async function managesConsent() {
  const writes: Record<string, unknown>[] = [];
  let allowedAssistantIds: string[] | undefined;
  function fetchReply(input: string | URL | Request, options?: RequestInit) {
    const path = input instanceof Request ? input.url : input.toString();
    let body: unknown;
    if (options?.method === 'POST') {
      if (typeof options.body !== 'string') throw new Error('Expected JSON');
      const command = z.object({ allowedAssistantIds: z.array(z.string()),
        changeRef: z.string() }).passthrough().parse(JSON.parse(options.body));
      writes.push(command);
      allowedAssistantIds = command.allowedAssistantIds;
      body = { status: 'selected', changeRef: command['changeRef'], sequence: 9 };
    } else if (path === '/api/chat') {
      body = { memberId: 'alice', assistantId: 'own' };
    } else if (path === '/api/assistants') {
      body = { rows: [
        { assistantId: 'shared', name: 'Shared helper', canStartSession: true },
        { assistantId: 'unavailable', name: 'Other helper', canStartSession: false },
      ] };
    } else {
      body = { serverId: 'fixture', connectionId: 'installed', identityTool: 'who_am_i',
        selectionRevision: 8, selectedProfileId: 'personal', ...(allowedAssistantIds ? { allowedAssistantIds } : {}) };
    }
    return Promise.resolve(new Response(JSON.stringify(body)));
  }
  vi.stubGlobal('fetch', fetchReply);
  TestBed.configureTestingModule({ imports: [KeyAssistants] });
  const fixture = TestBed.createComponent(KeyAssistants);
  fixture.componentRef.setInput('serverId', 'fixture');
  fixture.componentRef.setInput('profileId', 'personal');
  fixture.componentRef.setInput('profileRevision', 3);
  fixture.componentRef.setInput('selected', true);
  fixture.detectChanges();
  const rendered: unknown = fixture.nativeElement;
  if (!(rendered instanceof HTMLElement)) throw new Error('Missing assistant choices');
  const element = rendered;
  expect(element.textContent).toContain('Assistants that may use this key');
  function loaded() {
    fixture.detectChanges();
    expect(element.querySelectorAll('input')).toHaveLength(2);
  }
  await vi.waitFor(loaded);
  const own = element.querySelector<HTMLInputElement>('input');
  expect(own?.checked).toBe(true);
  const shared = element.querySelectorAll<HTMLInputElement>('input')[1];
  expect(shared?.checked).toBe(false);
  expect(element.textContent).not.toContain('Other helper');
  own?.click();
  function disabled() {
    fixture.detectChanges();
    expect(element.textContent).toContain('Assistant choices saved');
    expect(own?.disabled).toBe(false);
  }
  await vi.waitFor(disabled);
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({ action: 'select', expectedSequence: 8,
    profileId: 'personal', profileRevision: 3, allowedAssistantIds: [] });
  expect(own?.checked).toBe(false);
  own?.click();
  await vi.waitFor(disabled);
  expect(writes[1]).toMatchObject({ expectedSequence: 9, allowedAssistantIds: ['own'] });
  fixture.destroy();
  vi.unstubAllGlobals();
}
it('defaults to the own assistant and saves off and on with the latest revision', managesConsent);

async function staleSelectionCannotChooseAnotherAccount() {
  let selectionRevision = 10;
  let selectedProfileId = 'key-a';
  let writes = 0;
  function response(input: string | URL | Request, options?: RequestInit) {
    const path = input instanceof Request ? input.url : input.toString();
    let body: unknown = {};
    let status = 200;
    if (options?.method === 'POST') {
      writes += 1;
      selectionRevision = 11;
      selectedProfileId = 'key-b';
      status = 409;
    } else if (path === '/api/chat') {
      body = { memberId: 'alice', assistantId: 'own' };
    } else if (path === '/api/assistants') {
      body = { rows: [] };
    } else {
      body = { serverId: 'fixture', connectionId: 'installed', identityTool: 'who_am_i',
        selectionRevision, selectedProfileId };
    }
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  }
  vi.stubGlobal('fetch', response);
  const fixture = TestBed.createComponent(KeyAssistants);
  fixture.componentRef.setInput('serverId', 'fixture');
  fixture.componentRef.setInput('profileId', 'key-a');
  fixture.componentRef.setInput('profileRevision', 3);
  fixture.componentRef.setInput('selected', true);
  fixture.detectChanges();
  const rendered: unknown = fixture.nativeElement;
  if (!(rendered instanceof HTMLElement)) throw new Error('Missing assistant choices');
  const element = rendered;
  function loaded() {
    fixture.detectChanges();
    expect(element.querySelector('input')).not.toBeNull();
  }
  await vi.waitFor(loaded);
  const checkbox = element.querySelector<HTMLInputElement>('input')!;
  checkbox.click();
  function conflictResolved() {
    fixture.detectChanges();
    expect(element.textContent).toContain('changed elsewhere');
  }
  await vi.waitFor(conflictResolved);
  expect(checkbox.matches(':disabled')).toBe(true);
  checkbox.click();
  expect(writes).toBe(1);
  fixture.destroy();
  vi.unstubAllGlobals();
}
it('cannot reselect a stale key after another tab selects a different account',
  staleSelectionCannotChooseAnotherAccount);

async function definiteRejectionDoesNotStayPending() {
  function response(input: string | URL | Request, options?: RequestInit) {
    const path = input instanceof Request ? input.url : input.toString();
    let body: unknown = {};
    let status = 200;
    if (options?.method === 'POST') status = 413;
    else if (path === '/api/chat') body = { memberId: 'alice', assistantId: 'own' };
    else if (path === '/api/assistants') body = { rows: [] };
    else body = { serverId: 'fixture', connectionId: 'installed', identityTool: 'who_am_i',
      selectionRevision: 8, selectedProfileId: 'personal' };
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  }
  vi.stubGlobal('fetch', response);
  const fixture = TestBed.createComponent(KeyAssistants);
  fixture.componentRef.setInput('serverId', 'fixture');
  fixture.componentRef.setInput('profileId', 'personal');
  fixture.componentRef.setInput('profileRevision', 3);
  fixture.componentRef.setInput('selected', true);
  fixture.detectChanges();
  const rendered: unknown = fixture.nativeElement;
  if (!(rendered instanceof HTMLElement)) throw new Error('Missing assistant choices');
  const element = rendered;
  function loaded() {
    fixture.detectChanges();
    expect(element.querySelector('input')).not.toBeNull();
  }
  await vi.waitFor(loaded);
  element.querySelector<HTMLInputElement>('input')!.click();
  function rejected() {
    fixture.detectChanges();
    expect(element.textContent).toContain('refused');
  }
  await vi.waitFor(rejected);
  expect(sessionStorage.getItem('key-assistants:fixture')).toBeNull();
  expect(element.textContent).not.toContain('Check change status');
  fixture.destroy();
  vi.unstubAllGlobals();
}
it('keeps a definite HTTP rejection editable instead of waiting for an impossible receipt',
  definiteRejectionDoesNotStayPending);
