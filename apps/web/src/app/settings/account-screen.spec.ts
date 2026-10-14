import { TestBed } from '@angular/core/testing';
import { AccountScreen } from './account-screen';

function reply(value: unknown, status = 200): Promise<Response> {
  const response = new Response(JSON.stringify(value), { status });
  return Promise.resolve(response);
}

describe('account welcome link', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    TestBed.resetTestingModule();
  });

  for (const state of ['not_started', 'survey', 'review', 'complete', 'failed']) {
    it(`shows a survey link only for eligible ${state} progress`, async () => {
      vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
        if (url === '/auth/me') {
          return reply({ authenticated: true, user: { name: 'Alex' } });
        }
        if (state === 'failed') return reply({ status: 'unavailable' }, 503);
        return reply({ state });
      });
      TestBed.configureTestingModule({ imports: [AccountScreen] });
      const fixture = TestBed.createComponent(AccountScreen);
      fixture.detectChanges();
      const element: unknown = fixture.nativeElement;
      if (!(element instanceof HTMLElement)) throw new Error('Missing account root');
      await vi.waitFor(() => {
        fixture.detectChanges();
        expect(element.textContent).toContain('Alex');
        expect(globalThis.fetch).toHaveBeenCalledWith('/api/onboarding', expect.anything());
      });
      await vi.waitFor(() => {
        fixture.detectChanges();
        const link = element.querySelector('a[href="/welcome/survey"]');
        expect(Boolean(link)).toBe(state === 'not_started' || state === 'survey');
      });
    });
  }
});
