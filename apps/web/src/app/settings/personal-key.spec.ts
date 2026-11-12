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
    const element: HTMLElement = fixture.nativeElement as HTMLElement;
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
});
