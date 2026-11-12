import { TestBed } from '@angular/core/testing';
import { PersonalKey } from './personal-key';

function response(value: unknown): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify(value)));
}

describe('personal key entry', () => {
  afterEach(() => { vi.restoreAllMocks(); sessionStorage.clear(); });

  it('clears a submitted key and recovers a lost reply using only its reference', async () => {
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
    const element: unknown = fixture.nativeElement;
    if (!(element instanceof HTMLElement)) throw new Error('Missing key form');
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(element.querySelector('input[type=password]')).not.toBeNull();
    });
    const input = element.querySelector<HTMLInputElement>('input[type=password]')!;
    input.value = 'synthetic-only';
    element.querySelector<HTMLFormElement>('form')!.dispatchEvent(new Event('submit'));
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(element.textContent).toContain('Outcome unknown');
    });
    expect(input.value).toBe('');
    expect(sessionStorage.getItem('personal-key:fixture')).not.toContain('synthetic-only');
    expect(calls).toHaveLength(1);
    expect(element.textContent).toContain('Check status');
    fixture.destroy();
  });

  it('clears a refused selection and reloads its revision after another tab changes it', async () => {
    let revision = 0;
    let posts = 0;
    function request(_url: RequestInfo | URL, init?: RequestInit) {
      if (init?.method === 'POST') {
        posts += 1;
        if (posts === 1) {
          revision = 8;
          return Promise.resolve(new Response('{}', { status: 409 }));
        }
        const body = JSON.parse(String(init.body)) as { expectedSequence: number; changeRef: string };
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
    const element: unknown = fixture.nativeElement;
    if (!(element instanceof HTMLElement)) throw new Error('Missing key form');
    const root = element;
    function useButton() {
      fixture.detectChanges();
      const buttons = root.querySelectorAll<HTMLButtonElement>('button');
      for (const button of buttons) if (button.textContent?.trim() === 'Use this key') return button;
      throw new Error('Missing selection button');
    }
    await vi.waitFor(() => expect(useButton().disabled).toBe(false));
    useButton().click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(sessionStorage.getItem('personal-key:fixture')).toBeNull();
      expect(element.textContent).toContain('Selection changed');
    });
    useButton().click();
    await vi.waitFor(() => expect(posts).toBe(2));
    fixture.destroy();
  });

});
