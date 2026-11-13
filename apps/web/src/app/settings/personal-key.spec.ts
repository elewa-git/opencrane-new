import { TestBed } from '@angular/core/testing';
import { PersonalKey } from './personal-key';

function response(value: unknown): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify(value)));
}

function cleanup() {
  vi.restoreAllMocks();
  sessionStorage.clear();
}
afterEach(cleanup);

function personalKeyEntry() {


  async function recoverLostReply() {
    const settings = { serverId: 'fixture', connectionId: 'installed', identityTool: 'who_am_i',
      selectionRevision: 0 };
    const calls: RequestInit[] = [];
    function request(_url: RequestInfo | URL, init?: RequestInit) {
      if (init?.method === 'POST') {
        calls.push(init);
        return Promise.reject(new Error('Lost reply'));
      }
      return response(settings);
    }
    vi.spyOn(globalThis, 'fetch').mockImplementation(request);
    const fixture = TestBed.createComponent(PersonalKey);
    fixture.componentRef.setInput('serverId', 'fixture');
    fixture.detectChanges();
    const nativeElement: unknown = fixture.nativeElement;
    if (!(nativeElement instanceof HTMLElement)) throw new Error('Missing key form');
    const element = nativeElement;
    function formReady() {
      fixture.detectChanges();
      expect(element.querySelector('input[type=password]')).not.toBeNull();
    }
    await vi.waitFor(formReady);
    const input = element.querySelector<HTMLInputElement>('input[type=password]')!;
    input.value = 'synthetic-only';
    element.querySelector<HTMLFormElement>('form')!.dispatchEvent(new Event('submit'));
    function lostReplyShown() {
      fixture.detectChanges();
      expect(element.textContent).toContain('Outcome unknown');
    }
    await vi.waitFor(lostReplyShown);
    expect(input.value).toBe('');
    expect(sessionStorage.getItem('personal-key:fixture')).not.toContain('synthetic-only');
    expect(calls).toHaveLength(1);
    expect(element.textContent).toContain('Check status');
    fixture.destroy();
  }
  it('clears a submitted key and recovers a lost reply using only its reference', recoverLostReply);

  async function recoverSelectionConflict() {
    let revision = 0;
    let posts = 0;
    function request(_url: RequestInfo | URL, init?: RequestInit) {
      if (init?.method === 'POST') {
        posts += 1;
        if (posts === 1) {
          revision = 8;
          return Promise.resolve(new Response('{}', { status: 409 }));
        }
        if (typeof init.body !== 'string') throw new Error('Expected a JSON body');
        const body: unknown = JSON.parse(init.body);
        if (typeof body !== 'object' || body === null ||
            !('expectedSequence' in body) || !('changeRef' in body)) {
          throw new Error('Missing selection reference');
        }
        expect(body.expectedSequence).toBe(8);
        return response({ status: 'selected', changeRef: body.changeRef });
      }
      return response({ serverId: 'fixture', connectionId: 'installed', identityTool: 'who_am_i',
        selectionRevision: revision });
    }
    vi.spyOn(globalThis, 'fetch').mockImplementation(request);
    const fixture = TestBed.createComponent(PersonalKey);
    fixture.componentRef.setInput('serverId', 'fixture');
    fixture.componentRef.setInput('profile', { serverId: 'fixture', profileId: 'mine',
      status: 'verified', adminBlocked: false, profileRevision: 4, ownerKind: 'personal' });
    fixture.detectChanges();
    const nativeElement: unknown = fixture.nativeElement;
    if (!(nativeElement instanceof HTMLElement)) throw new Error('Missing key form');
    const element = nativeElement;
    const root = element;
    function useButton() {
      fixture.detectChanges();
      const buttons = root.querySelectorAll<HTMLButtonElement>('button');
      for (const button of buttons) if (button.textContent?.trim() === 'Use this key') return button;
      throw new Error('Missing selection button');
    }
    function selectionReady() { expect(useButton().disabled).toBe(false); }
    await vi.waitFor(selectionReady);
    useButton().click();
    function conflictShown() {
      fixture.detectChanges();
      expect(sessionStorage.getItem('personal-key:fixture')).toBeNull();
      expect(element.textContent).toContain('Selection changed');
    }
    await vi.waitFor(conflictShown);
    useButton().click();
    function selectionRetried() { expect(posts).toBe(2); }
    await vi.waitFor(selectionRetried);
    fixture.destroy();
  }
  it('clears a refused selection and reloads its revision after another tab changes it',
    recoverSelectionConflict);
}
describe('personal key entry', personalKeyEntry);


async function clearsSecretAtBoundary(boundary: 'pending' | 'destroy' | 'access') {
  let complete!: (reply: Response) => void;
  function holdPost(resolve: (reply: Response) => void) { complete = resolve; }
  const posted = new Promise<Response>(holdPost);
  let postSignal: AbortSignal | null | undefined;
  function request(_url: RequestInfo | URL, init?: RequestInit) {
    if (init?.method === 'POST') {
      postSignal = init.signal;
      return posted;
    }
    return response({ serverId: 'fixture', connectionId: 'installed', identityTool: 'who_am_i',
      selectionRevision: 0 });
  }
  vi.spyOn(globalThis, 'fetch').mockImplementation(request);
  const fixture = TestBed.createComponent(PersonalKey);
  fixture.componentRef.setInput('serverId', 'fixture');
  fixture.detectChanges();
  const nativeElement: unknown = fixture.nativeElement;
  if (!(nativeElement instanceof HTMLElement)) throw new Error('Missing key form');
    const element = nativeElement;
  function formReady() {
    fixture.detectChanges();
    expect(element.querySelector('input[type=password]')).not.toBeNull();
  }
  await vi.waitFor(formReady);
  const input = element.querySelector<HTMLInputElement>('input[type=password]')!;
  input.value = 'synthetic-only';
  if (boundary === 'destroy') {
    fixture.destroy();
    expect(input.value).toBe('');
    return;
  }
  element.querySelector<HTMLFormElement>('form')!.dispatchEvent(new Event('submit'));
  expect(postSignal).toBeDefined();
  if (boundary === 'pending') {
    expect(input.value).toBe('');
    expect(sessionStorage.getItem('personal-key:fixture')).not.toContain('synthetic-only');
    complete(new Response('{}', { status: 503 }));
  } else {
    // Simulate another typed value before the pending request reports access loss.
    input.value = 'second-synthetic-key';
    complete(new Response('{}', { status: 403 }));
    function accessCleared() {
      expect(input.value).toBe('');
      expect(postSignal?.aborted).toBe(true);
      expect(sessionStorage.getItem('personal-key:fixture')).toBeNull();
    }
    await vi.waitFor(accessCleared);
  }
  fixture.destroy();
}
it.each(['pending', 'destroy', 'access'] as const)(
  'clears the secret input at the %s boundary', clearsSecretAtBoundary);
