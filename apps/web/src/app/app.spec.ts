import { computed, signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import type { IntegrationRow, IntegrationsResponse } from '@opencrane/protocol';
import type { MockInstance } from 'vitest';
import { App } from './app';
import { NAVIGATE } from './core/navigate';
import { WebSocketService } from './core/websocket.service';

const row = (serverId: string, kind: IntegrationRow['status']['kind'], detail: string): IntegrationRow => ({
  serverId, name: serverId[0]!.toUpperCase() + serverId.slice(1),
  source: { kind: 'remote_url', label: 'Remote URL', detail: `${serverId}.example.test` },
  version: 'Version not provided', accountModel: 'Not provided', toolsAllowed: 2, toolsTotal: 3,
  status: { kind, label: kind === 'ready' ? 'Ready' : kind === 'needs_input' ? 'Needs input' : 'Failed', detail },
});
const loaded: IntegrationsResponse = { loadedAt: '2026-10-01T09:40:00.000Z', rows: [
  row('odoo', 'ready', 'Published'), row('pricing', 'needs_input', 'Pending review · tools changed'), row('broken', 'failed', 'Validation failed'),
] };

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

let fetchSpy: MockInstance<typeof fetch>;

function webSocketIsConnected(): boolean {
  return false;
}

function configureAppTestBed(): void {
  const state = signal<'idle'>('idle');
  const webSocketService = {
    state: state.asReadonly(),
    isConnected: computed(webSocketIsConnected),
    messages: signal([]).asReadonly(),
    lastMessage: signal(undefined).asReadonly(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    send: vi.fn(),
  };
  const providers = [
    { provide: NAVIGATE, useValue: vi.fn() },
    { provide: WebSocketService, useValue: webSocketService },
  ];
  const testModule = { imports: [App], providers };
  TestBed.configureTestingModule(testModule);
}

function create(reply: Response = response(loaded)): ComponentFixture<App> {
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply);
  configureAppTestBed();
  const fixture = TestBed.createComponent(App);
  fixture.detectChanges();
  return fixture;
}

function root(fixture: ComponentFixture<App>): HTMLElement {
  const element: unknown = fixture.nativeElement;
  if (!(element instanceof HTMLElement)) throw new Error('Expected HTML root');
  return element;
}

function button(rootElement: HTMLElement, label: string): HTMLButtonElement {
  const buttons = [...rootElement.querySelectorAll('button')];
  const found = buttons.find((item) => item.textContent?.trim() === label);
  if (!(found instanceof HTMLButtonElement)) throw new Error(`Missing button ${label}`);
  return found;
}

describe('MCP register', () => {
  beforeEach(() => globalThis.history.replaceState({}, '', '/org/integrations'));
  afterEach(() => { fetchSpy?.mockRestore(); globalThis.history.replaceState({}, '', '/'); });

  it('loads typed rows and filters the counted tabs', async () => {
    const fixture = create();
    await vi.waitFor(() => expect(root(fixture).querySelectorAll('.register-row')).toHaveLength(3));
    expect(root(fixture).querySelectorAll('.register-row')).toHaveLength(3);
    expect(root(fixture).textContent).toContain('All · 3');
    expect(root(fixture).textContent).toContain('Needs attention · 2');
    expect(root(fixture).textContent).toContain('Pending review · 1');
    button(root(fixture), 'Pending review · 1').click();
    await fixture.whenStable();
    expect(root(fixture).querySelectorAll('.register-row')).toHaveLength(1);
    expect(root(fixture).textContent).toContain('Pricing');
  });

  it('shows the specified empty state', async () => {
    const fixture = create(response({ rows: [], loadedAt: loaded.loadedAt } satisfies IntegrationsResponse));
    await vi.waitFor(() => expect(root(fixture).querySelector('.empty')).not.toBeNull());
    expect(root(fixture).querySelector('.empty')?.textContent).toContain('Not configured');
    expect(root(fixture).querySelector('.empty')?.textContent).toContain('Nothing set up yet');
    expect(root(fixture).querySelector('.empty [data-state]')?.getAttribute('data-state'))
      .toBe('not_configured');
    expect(root(fixture).querySelectorAll('.empty .message')).toHaveLength(1);
    expect(root(fixture).querySelector('.empty .message')?.textContent).toBe('Not configured');
  });

  it('distinguishes an empty filter from an empty register', async () => {
    const fixture = create(response({ rows: [row('odoo', 'ready', 'Published')], loadedAt: loaded.loadedAt } satisfies IntegrationsResponse));
    await vi.waitFor(() => expect(root(fixture).querySelectorAll('.register-row')).toHaveLength(1));
    button(root(fixture), 'Pending review · 0').click();
    await fixture.whenStable();
    expect(root(fixture).querySelector('.empty')?.textContent).toContain('No servers are pending review');
    expect(root(fixture).textContent).not.toContain('Nothing set up yet');
  });

  it('shows a failure, not an empty-organisation claim, when the first read is unavailable', async () => {
    const fixture = create(response({ status: 'unavailable' }, 503));
    await vi.waitFor(() => expect(root(fixture).textContent).toContain("Couldn't load the integrations list"));
    expect(root(fixture).textContent).toContain('The organisation register is unavailable');
    expect(root(fixture).textContent).not.toContain('Nothing set up yet');
  });

  it('keeps old rows after a read failure and names when they were loaded', async () => {
    const fixture = create();
    await vi.waitFor(() => expect(root(fixture).querySelectorAll('.register-row')).toHaveLength(3));
    fetchSpy.mockResolvedValueOnce(response({ status: 'unavailable' }, 503));
    button(root(fixture), 'Refresh list').click();
    await vi.waitFor(() => expect(root(fixture).querySelector('.refresh-notice')?.textContent).toContain('Showing what we loaded at 09:40'));
    const notice = root(fixture).querySelector('.refresh-notice');
    expect(root(fixture).querySelectorAll('.register-row')).toHaveLength(3);
    expect(notice?.querySelector('.notice-glyph')).not.toBeNull();
    expect(notice?.parentElement?.getAttribute('role')).toBe('status');
    expect(notice?.textContent).toContain('Showing what we loaded at 09:40');
    expect(button(root(fixture), 'Refresh list')).toBeTruthy();
  });

  it('replaces failure with readable announced retry progress', async () => {
    const fixture = create(response({ status: 'unavailable' }, 503));
    await vi.waitFor(() => expect(root(fixture).textContent).toContain("Couldn't load the integrations list"));
    let finish!: (value: Response) => void;
    fetchSpy.mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }));
    button(root(fixture), 'Refresh list').click();
    await fixture.whenStable();
    const notice = root(fixture).querySelector('.refresh-notice');
    const retry = button(root(fixture), 'Refreshing list…');
    expect(notice?.parentElement?.getAttribute('aria-live')).toBe('polite');
    expect(notice?.textContent).toContain('Refreshing the integrations list…');
    expect(root(fixture).textContent).not.toContain('Nothing set up yet');
    expect(retry.getAttribute('aria-disabled')).toBe('true');
    finish(response(loaded));
    await fixture.whenStable();
  });

  it('labels unsupported actions instead of rendering inert row controls', async () => {
    const fixture = create();
    await vi.waitFor(() => expect(root(fixture).querySelectorAll('.register-row')).toHaveLength(3));
    expect(root(fixture).querySelector<HTMLAnchorElement>('a[aria-label="Manage tools for Odoo"]')?.getAttribute('href')).toBe('/org/integrations/odoo/tools');
    expect(root(fixture).textContent).not.toContain('Set up again');
    expect(root(fixture).querySelector('a[href="/org/integrations/new"]')?.textContent).toBe('Add MCP server');
  });

  it('names the role needed when the server refuses a non-admin', async () => {
    const fixture = create(response({ status: 'refused', reason: 'admin_required', requiredRole: 'Owner or Admin' }, 403));
    await vi.waitFor(() => expect(root(fixture).querySelector('.access-state')).not.toBeNull());
    expect(root(fixture).querySelector('.access-state')?.textContent).toContain('Owner or Admin role');
    expect(root(fixture).querySelector('.access-state')?.textContent).toContain('Ask an Owner or Admin');
    // Guidance only: there is no request-access flow yet, so no button.
    expect(root(fixture).querySelector('.access-state button')).toBeNull();
    expect(root(fixture).querySelector('.register')).toBeNull();
  });

  it('clears protected rows after an authority refusal and does not restore them during an outage', async () => {
    const fixture = create();
    await vi.waitFor(() => expect(root(fixture).querySelectorAll('.register-row')).toHaveLength(3));
    // A refused response can have no JSON body; authority still clears the previous read.
    const refusedWithoutBody = new Response(null, { status: 403 });
    fetchSpy.mockResolvedValueOnce(refusedWithoutBody);
    button(root(fixture), 'Refresh list').click();
    await vi.waitFor(() => expect(root(fixture).querySelector('.access-state')).not.toBeNull());
    expect(root(fixture).querySelectorAll('.register-row')).toHaveLength(0);

    fetchSpy.mockResolvedValueOnce(response({ status: 'unavailable' }, 503));
    button(root(fixture), 'Refresh list').click();
    await vi.waitFor(() => expect(root(fixture).textContent).toContain("Couldn't load the integrations list"));
    expect(root(fixture).querySelectorAll('.register-row')).toHaveLength(0);
    expect(root(fixture).textContent).not.toContain('Showing what we loaded');
  });

  it('keeps the server retry fact in the status cell', async () => {
    const failedRow = row('safe-failure', 'failed', 'Validation stopped');
    failedRow.status.safeToRetry = true;
    const reply = { rows: [failedRow], loadedAt: loaded.loadedAt };
    const fixture = create(response(reply));
    function safeFailureIsVisible(): void {
      expect(root(fixture).querySelector('.register-row .message')?.textContent)
        .toBe('Failed — nothing changed');
    }
    await vi.waitFor(safeFailureIsVisible);
  });

  function checkUnavailablePage(pathname: string): void {
    globalThis.history.replaceState({}, '', pathname);
    const fixture = create();
    const element = root(fixture);
    if (pathname === '/org/missing') {
      expect(element.textContent).toContain('Page not found');
      expect(element.textContent).not.toContain('Not available yet');
      expect(element.textContent).not.toContain('not been built yet');
    } else {
      expect(element.textContent).toContain('Not available yet');
    }
    expect(element.querySelectorAll('.sidebar nav a')).toHaveLength(7);
    expect(element.querySelector('a[href="/workspace"]')).not.toBeNull();
    expect(element.textContent).not.toContain('Skills & workflows');
    expect(fetchSpy).not.toHaveBeenCalled();
    const selected = element.querySelector('.sidebar [aria-current="page"]');
    if (pathname !== '/org/missing') {
      expect(selected?.getAttribute('href')).toBe(pathname);
    } else {
      expect(selected).toBeNull();
    }
  }

  const unavailablePaths = ['/org/overview', '/org/routines', '/org/missing'];
  it.each(unavailablePaths)('shows truthful availability at %s', checkUnavailablePage);

  it.each(['/org/people', '/org/people/groups/sales-team'])(
    'mounts People & groups at %s', async (pathname) => {
      globalThis.history.replaceState({}, '', pathname);
      const fixture = create(response({ rows: [] }));
      await fixture.whenStable();
      const element = root(fixture);
      expect(element.querySelector('.sidebar [aria-current="page"]')?.getAttribute('href'))
        .toBe('/org/people');
      expect(element.querySelector('oc-people-screen, oc-group-detail-screen')).not.toBeNull();
      fixture.destroy();
    });

  it('keeps the existing sign-in shell outside /org routes', () => {
    globalThis.history.replaceState({}, '', '/');
    const fixture = create();
    expect(root(fixture).textContent).toContain('OpenCrane');
    expect(button(root(fixture), 'Continue with single sign-on')).toBeTruthy();
    expect(fetchSpy).toHaveBeenCalledExactlyOnceWith('/auth/me');
  });
});

describe('personal settings shell', () => {
  beforeEach(() => globalThis.history.replaceState({}, '', '/account'));
  afterEach(() => {
    fetchSpy?.mockRestore();
    globalThis.history.replaceState({}, '', '/');
  });

  it('loads only the identity name and marks unavailable profile fields', async () => {
    const fixture = create(response({ authenticated: true, user: { name: 'Taylor Example' } }));
    await vi.waitFor(() => expect(root(fixture).textContent).toContain('Taylor Example'));
    expect(root(fixture).querySelectorAll('.sidebar nav a')).toHaveLength(4);
    expect(root(fixture).querySelector('[aria-current="page"]')?.getAttribute('href')).toBe('/account');
    expect(root(fixture).textContent).toContain('Profile details not available yet');
    expect(root(fixture).textContent).toContain('Email, organisation, role and groups');
    expect(root(fixture).querySelector('.identity')?.hasAttribute('aria-labelledby')).toBe(false);
    expect(root(fixture).textContent).not.toContain('alex@');
    const status = root(fixture).querySelector('[role="status"][aria-live="polite"]');
    expect(status?.textContent).toContain('Identity loaded from your current session');
    expect(status?.textContent).not.toContain('Taylor Example');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const request = fetchSpy.mock.calls[0];
    if (!request) throw new Error('Expected an identity request');
    expect(request[0]).toBe('/auth/me');
    const requestOptions = request[1];
    expect(requestOptions?.cache).toBe('no-store');
    expect(requestOptions?.signal).toBeInstanceOf(AbortSignal);
  });

  it('shows no invented identity name when the provider omitted it', async () => {
    const fixture = create(response({ authenticated: true, user: { name: '  ' } }));
    await vi.waitFor(() => expect(root(fixture).textContent).toContain('Name not provided'));
    expect(root(fixture).textContent).not.toContain('Taylor Example');
  });

  it('keeps the unavailable destinations in the settings shell without making reads', () => {
    globalThis.history.replaceState({}, '', '/account/tools');
    const fixture = create(response({}));
    const element = root(fixture);
    expect(element.querySelector('h1')?.textContent).toBe('My tools');
    expect(element.textContent).toContain('Your personal tool connections are not available yet.');
    expect(element.querySelectorAll('.sidebar nav a')).toHaveLength(4);
    expect(element.querySelector('.sidebar a.back[href="/workspace"]')?.textContent)
      .toContain('Back to workspace');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  function checkSettingsDestination(pathname: string, expectedHeading: string): void {
    globalThis.history.replaceState({}, '', pathname);
    const fixture = create(response({}));
    const element = root(fixture);
    expect(element.querySelector('h1')?.textContent).toBe(expectedHeading);
    expect(element.querySelectorAll('.sidebar nav a')).toHaveLength(4);
    expect(element.querySelector('.sidebar nav a[aria-current="page"]')?.getAttribute('href'))
      .toBe(pathname);
    expect(element.querySelector('.sidebar .back')?.getAttribute('href')).toBe('/workspace');
    expect(element.querySelector('oc-composer')).toBeNull();
  }

  it.each([
    ['/account', 'Account'],
    ['/account/preferences', 'Preferences'],
    ['/account/assistant', 'Assistant'],
    ['/account/tools', 'My tools'],
  ])('opens settings destination %s', checkSettingsDestination);

  function checkUnknownAccountRoute(pathname: string): void {
    globalThis.history.replaceState({}, '', pathname);
    const fixture = create(response({}));
    const element = root(fixture);
    expect(element.textContent).toContain('Page not found');
    expect(element.textContent)
      .toContain('This address does not match a personal settings page.');
    expect(element.querySelector('.sidebar nav')).not.toBeNull();
    expect(element.querySelector('oc-sign-in')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  }

  const unknownSettingsPaths = ['/account/unknown', '/account/tools/extra'];
  it.each(unknownSettingsPaths)(
    'shows an unknown settings route inside its shell at %s', checkUnknownAccountRoute,
  );

  async function checkSignedOutIdentity(): Promise<void> {
    const fixture = create(response({ authenticated: false, user: null }));
    await vi.waitFor(() => expect(root(fixture).textContent).toContain('Your session expired'));
    const state = root(fixture).querySelector('oc-shared-state .state');
    expect(state?.getAttribute('data-state')).toBe('access_changed');
    expect(state?.getAttribute('data-glyph-name')).toBe('access_changed');
    expect(root(fixture).querySelector('a[href="/"]')?.textContent).toBe('Sign in again');
    expect(root(fixture).textContent).not.toContain('Identity unavailable');
    expect(root(fixture).querySelector('.sr-only')?.textContent?.trim())
      .toBe('Your session expired.');
  }

  it('shows a lock state and sign-in link when the identity says the session expired',
    checkSignedOutIdentity);

  async function checkServerErrorCanBeRetried(): Promise<void> {
    const fixture = create(response({ error: 'unavailable' }, 500));
    await vi.waitFor(() => expect(root(fixture).textContent).toContain("Couldn't load your identity"));
    expect(root(fixture).querySelector('oc-shared-state .state')?.getAttribute('data-state'))
      .toBe('failed');
    expect(button(root(fixture), 'Try again')).toBeTruthy();
    expect(root(fixture).textContent).not.toContain('Sign in again');
    const identity = { authenticated: true, user: { name: 'Taylor Example' } };
    fetchSpy.mockResolvedValueOnce(response(identity));
    button(root(fixture), 'Try again').click();
    await vi.waitFor(() => expect(root(fixture).textContent).toContain('Taylor Example'));
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(globalThis.document.activeElement).toBe(root(fixture).querySelector('h1'));
    expect(root(fixture).querySelector('.sr-only')?.textContent?.trim())
      .toContain('Identity loaded from your current session.');
  }

  it('offers a retry after a server error and repeats the identity read',
    checkServerErrorCanBeRetried);

  async function checkInvalidJsonUsesFailedState(): Promise<void> {
    const invalidJson = new Response('{not json', { status: 200 });
    const fixture = create(invalidJson);
    await vi.waitFor(() => expect(root(fixture).textContent).toContain("Couldn't load your identity"));
    expect(button(root(fixture), 'Try again')).toBeTruthy();
    expect(root(fixture).textContent).not.toContain('Sign in again');
    expect(root(fixture).querySelector('.sr-only')?.textContent?.trim())
      .toBe("Couldn't load your identity.");
  }

  it('uses the failed state when the identity response is not valid JSON',
    checkInvalidJsonUsesFailedState);
});
