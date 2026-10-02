import { TestBed } from '@angular/core/testing';
import { SignIn } from './sign-in';
import { NAVIGATE } from '../core/navigate';

describe('sign-in handoff', () => {
  const navigate = vi.fn();
  beforeEach(() => {
    vi.useFakeTimers();
    navigate.mockReset();
    globalThis.history.replaceState({}, '', '/signin/handoff');
    TestBed.configureTestingModule({ imports: [SignIn], providers: [{ provide: NAVIGATE, useValue: navigate }] });
  });
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.useRealTimers();
    globalThis.history.replaceState({}, '', '/');
  });
  function create() {
    const fixture = TestBed.createComponent(SignIn);
    fixture.detectChanges();
    const element: unknown = fixture.nativeElement;
    if (!(element instanceof HTMLElement)) throw new Error('Missing sign-in root');
    const cancel = element.querySelector('button');
    if (!cancel) throw new Error('Missing Cancel');
    return { fixture, element, cancel };
  }
  it('focuses Cancel and announces five seconds before redirecting', () => {
    const { fixture, element, cancel } = create();
    expect(document.activeElement).toBe(cancel);
    expect(element.querySelector('[aria-live=polite]')?.textContent).toContain('5 seconds');
    vi.advanceTimersByTime(4000);
    fixture.detectChanges();
    expect(navigate).not.toHaveBeenCalled();
    expect(element.querySelector('[aria-live=polite]')?.textContent).toContain('1 second…');
    vi.advanceTimersByTime(1000);
    expect(navigate).toHaveBeenCalledExactlyOnceWith('/auth/login?returnTo=/');
  });
  it('cancels from the focused native button and never redirects afterwards', () => {
    const { cancel } = create();
    vi.advanceTimersByTime(2500);
    // Native keyboard activation generates click; the live browser tests Enter and Space.
    cancel.click();
    vi.advanceTimersByTime(10_000);
    expect(navigate).toHaveBeenCalledExactlyOnceWith('/');
  });
  it('clears the redirect when the component is destroyed', () => {
    const { fixture } = create();
    fixture.destroy();
    vi.advanceTimersByTime(10_000);
    expect(navigate).not.toHaveBeenCalled();
  });
  it('uses the public organisation name for invitation copy', () => {
    globalThis.history.replaceState({}, '', '/?invitation=example');
    const meta = document.createElement('meta');
    meta.name = 'opencrane-org';
    meta.content = 'Example Group';
    document.head.append(meta);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"authenticated":false}'));
    try {
      const { element } = create();
      expect(element.querySelector('.eyebrow')?.textContent).toBe('Example Group');
      expect(element.textContent).toContain('You were invited by Example Group. Your work here stays private to you.');
      expect(element.querySelector('footer')?.textContent).toBe('self-hosted · data sovereign');
    } finally { meta.remove(); fetchSpy.mockRestore(); }
  });
  it('uses a native sign-out form without a JavaScript submit handler', async () => {
    globalThis.history.replaceState({}, '', '/');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"authenticated":true}'));
    try {
      const { fixture, element } = create();
      await vi.waitFor(() => {
        fixture.detectChanges();
        expect(element.querySelector('form')).not.toBeNull();
      });
      const form = element.querySelector('form');
      expect(form?.getAttribute('method')).toBe('post');
      expect(form?.getAttribute('action')).toBe('/auth/logout');
      expect(form?.querySelector('button[type=submit]')?.textContent).toBe('Sign out');
      const submit = new Event('submit', { bubbles: true, cancelable: true });
      form?.dispatchEvent(submit);
      expect(submit.defaultPrevented).toBe(false);
      expect(fetchSpy).toHaveBeenCalledExactlyOnceWith('/auth/me');
    } finally { fetchSpy.mockRestore(); }
  });
});
