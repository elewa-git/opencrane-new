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
  it('focuses Cancel and opens single sign-on after 2.5 seconds', () => {
    const { element, cancel } = create();
    expect(document.activeElement).toBe(cancel);
    expect(element.querySelector('[aria-live=polite]')?.textContent).toContain('Opening single sign-on…');
    vi.advanceTimersByTime(2499);
    expect(navigate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(navigate).toHaveBeenCalledExactlyOnceWith('/auth/login?returnTo=/');
  });
  it('cancels from the focused native button and never redirects afterwards', () => {
    const { cancel } = create();
    vi.advanceTimersByTime(2400);
    // Browsers turn Enter and Space into clicks; live browser checks both keys.
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
      expect(element.querySelector('h1')?.textContent).toBe('Sign in to OpenCrane');
      expect(element.textContent).toContain('Example Group');
      expect(element.textContent).toContain('You were invited by Example Group. Your work here stays private to you.');
      expect(element.querySelector('footer, .brand')).toBeNull();
    } finally { meta.remove(); fetchSpy.mockRestore(); }
  });
  it('focuses SSO after a signed-out session read and explains the readonly email field', async () => {
    globalThis.history.replaceState({}, '', '/');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"authenticated":false}'));
    try {
      const { fixture, element } = create();
      await vi.waitFor(() => {
        fixture.detectChanges();
        const sso = [...element.querySelectorAll('button')]
          .find((button) => button.textContent?.includes('Continue with single sign-on'));
        expect(document.activeElement).toBe(sso);
      });
      const email = element.querySelector<HTMLInputElement>('input[type=email]');
      expect(email?.readOnly).toBe(true);
      expect(email?.getAttribute('aria-disabled')).toBe('true');
      const descriptionId = email?.getAttribute('aria-describedby');
      expect(descriptionId).toBeTruthy();
      expect(element.querySelector(`#${descriptionId}`)?.textContent).toContain('Disabled in this product');
      expect(element.textContent).toContain('Email sign-in is unavailable');
      expect(element.textContent).toContain('Use your organisation\'s single sign-on.');
      expect(element.querySelector('form')).toBeNull();
      expect(element.textContent).not.toMatch(/Microsoft|Zitadel|Email me a sign-in link/i);
      expect(fetchSpy).toHaveBeenCalledExactlyOnceWith('/auth/me');
    } finally { fetchSpy.mockRestore(); }
  });
  it('keeps the session-read failure available', async () => {
    globalThis.history.replaceState({}, '', '/');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    try {
      const { fixture, element } = create();
      await vi.waitFor(() => {
        fixture.detectChanges();
        expect(element.textContent).toContain('We could not check your session.');
      });
    } finally { fetchSpy.mockRestore(); }
  });
  it.each([
    ['organisation', 'Your account isn\'t part of Example Group'],
    ['unavailable', 'We could not reach your identity provider'],
    ['rejected', 'Your sign-in could not be completed'],
    ['unknown', 'Your sign-in could not be completed'],
    ['<script>alert(1)</script>', 'Your sign-in could not be completed'],
  ])('shows fixed rejection copy for %s without reading a session', (reason, message) => {
    globalThis.history.replaceState({}, '', `/signin/rejected?reason=${encodeURIComponent(reason)}`);
    const meta = document.createElement('meta');
    meta.name = 'opencrane-org';
    meta.content = 'Example Group';
    document.head.append(meta);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const { element } = create();
      const heading = element.querySelector('h1');
      expect(heading?.textContent).toBe('Sign in to OpenCrane');
      expect(document.activeElement).toBe(heading);
      expect(element.textContent).toContain(message);
      expect(element.textContent).toContain('Nothing was created.');
      expect(element.textContent).not.toContain(reason);
      expect(element.querySelectorAll('[role=status]')).toHaveLength(1);
      expect(element.querySelector('[role=alert]')).toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
      const retry = [...element.querySelectorAll('button')]
        .find((button) => button.textContent?.includes('Sign in again'));
      retry?.click();
      expect(navigate).toHaveBeenCalledExactlyOnceWith('/signin/handoff');
    } finally { meta.remove(); fetchSpy.mockRestore(); }
  });
  it('uses this organisation when no public name is configured', () => {
    globalThis.history.replaceState({}, '', '/signin/rejected?reason=organisation');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const { element } = create();
      expect(element.textContent).toContain('Your account isn\'t part of this organisation');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally { fetchSpy.mockRestore(); }
  });
  it('uses a native sign-out form without a JavaScript submit handler', async () => {
    globalThis.history.replaceState({}, '', '/');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"authenticated":true}'));
    try {
      const { fixture, element } = create();
      await vi.waitFor(() => {
        fixture.detectChanges();
        expect(element.querySelector('form')).not.toBeNull();
        const evidence = element.querySelector('oc-shared-state time');
        expect(evidence?.getAttribute('datetime')).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(evidence?.textContent).toContain('UTC');
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
