import { computed, signal, type WritableSignal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import type { LogoutResponse } from '@opencrane/protocol';
import { App } from './app';
import { NAVIGATE } from './core/navigate';
import type { ConnectionState } from './core/websocket.service';
import { WebSocketService } from './core/websocket.service';

describe('App shell', () => {
  let stateSignal: WritableSignal<ConnectionState>;
  let connect: ReturnType<typeof vi.fn>;
  let navigate: ReturnType<typeof vi.fn>;

  function configure(initialState: ConnectionState = 'idle') {
    stateSignal = signal(initialState);
    connect = vi.fn();
    navigate = vi.fn();
    const fakeWs = {
      state: stateSignal.asReadonly(),
      isConnected: computed(() => stateSignal() === 'open'),
      messages: signal([]).asReadonly(),
      lastMessage: signal(undefined).asReadonly(),
      connect,
      disconnect: vi.fn(),
      send: vi.fn(() => false),
    };

    TestBed.configureTestingModule({
      imports: [App],
      providers: [
        { provide: WebSocketService, useValue: fakeWs },
        { provide: NAVIGATE, useValue: navigate },
      ],
    });
  }

  function rootOf(fixture: ComponentFixture<App>): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  function buttonLabelled(root: HTMLElement, label: string): HTMLButtonElement {
    const button = Array.from(root.querySelectorAll('button')).find((el) => el.textContent?.trim() === label);
    if (!button) {
      throw new Error(`no button labelled "${label}"`);
    }
    return button;
  }

  it('creates the shell and connects the socket once, on init', () => {
    configure();
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();

    expect(fixture.componentInstance).toBeTruthy();
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('shows the product name and the sign-in / sign-out buttons', () => {
    configure();
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    const root = rootOf(fixture);

    expect(root.querySelector('h1')?.textContent).toContain('OpenCrane');
    expect(() => buttonLabelled(root, 'Sign in')).not.toThrow();
    expect(() => buttonLabelled(root, 'Sign out')).not.toThrow();
  });

  it('reflects the websocket state in the connection indicator', () => {
    configure('open');
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    const indicator = rootOf(fixture).querySelector('.connection-indicator') as HTMLElement;

    expect(indicator.textContent).toContain('Connected');
    expect(indicator.getAttribute('data-state')).toBe('open');
    expect(indicator.getAttribute('role')).toBe('status'); // so a screen reader announces changes

    stateSignal.set('closed');
    fixture.detectChanges();
    expect(indicator.textContent).toContain('Disconnected');
    expect(indicator.getAttribute('data-state')).toBe('closed');
  });

  it('updates from a signal change alone, with no zone.js to trigger change detection', async () => {
    configure('open');
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();

    stateSignal.set('reconnecting'); // no detectChanges(): the signal alone must update the page
    await fixture.whenStable();

    expect(rootOf(fixture).querySelector('.connection-indicator')?.textContent).toContain('Reconnecting');
    expect((globalThis as { Zone?: unknown }).Zone).toBeUndefined();
  });

  it('navigates to /auth/login when Sign in is clicked', () => {
    configure();
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();

    buttonLabelled(rootOf(fixture), 'Sign in').click();

    expect(navigate).toHaveBeenCalledWith('/auth/login');
  });

  // The first two replies are built from the shared LogoutResponse type, the one the
  // server's POST /auth/logout is checked against, so a change to that contract breaks this file too.
  const withAddress: LogoutResponse = { endSessionUrl: 'https://idp.example/logout?id=1' };
  const withoutAddress: LogoutResponse = { endSessionUrl: null };

  it.each([
    ['follows the identity provider logout address', JSON.stringify(withAddress), 'https://idp.example/logout?id=1'],
    ['follows a local identity provider address (localhost is not a public domain name)', JSON.stringify({ endSessionUrl: 'http://localhost:8080/oidc/v1/end_session' } satisfies LogoutResponse), 'http://localhost:8080/oidc/v1/end_session'],
    ['goes home when the reply has no address', JSON.stringify(withoutAddress), '/'],
    ['goes home when the address is not http(s)', '{"endSessionUrl":"javascript:alert(1)"}', '/'],
    ['goes home when the reply is not JSON', '', '/'],
  ])('POSTs to /auth/logout when Sign out is clicked, then %s', async (_name, body, expected) => {
    configure();
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, { status: 200 }));

    buttonLabelled(rootOf(fixture), 'Sign out').click();
    await fixture.whenStable();

    expect(fetchSpy).toHaveBeenCalledWith('/auth/logout', { method: 'POST' });
    expect(navigate).toHaveBeenCalledExactlyOnceWith(expected);

    fetchSpy.mockRestore();
  });

  it('shows an error message when sign-out fails, instead of navigating', async () => {
    configure();
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 500 }));

    buttonLabelled(rootOf(fixture), 'Sign out').click();
    await fixture.whenStable();

    expect(navigate).not.toHaveBeenCalled();
    expect(rootOf(fixture).querySelector('.error-message')?.textContent).toContain('500');

    fetchSpy.mockRestore();
  });
});
