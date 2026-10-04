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

describe('MCP register', () => {
  let fetchSpy: MockInstance<typeof fetch>;

  beforeEach(() => globalThis.history.replaceState({}, '', '/org/integrations'));
  afterEach(() => { fetchSpy?.mockRestore(); globalThis.history.replaceState({}, '', '/'); });

  function create(reply: Response = response(loaded)): ComponentFixture<App> {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply);
    const state = signal<'idle'>('idle');
    TestBed.configureTestingModule({ imports: [App], providers: [{ provide: NAVIGATE, useValue: vi.fn() }, { provide: WebSocketService, useValue: {
      state: state.asReadonly(), isConnected: computed(() => false), messages: signal([]).asReadonly(),
      lastMessage: signal(undefined).asReadonly(), connect: vi.fn(), disconnect: vi.fn(), send: vi.fn(),
    } }] });
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
    const found = [...rootElement.querySelectorAll('button')].find((item) => item.textContent?.trim() === label);
    if (!(found instanceof HTMLButtonElement)) throw new Error(`Missing button ${label}`);
    return found;
  }

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
  });

  it('distinguishes an empty filter from an empty register', async () => {
    const fixture = create(response({ rows: [row('odoo', 'ready', 'Published')], loadedAt: loaded.loadedAt } satisfies IntegrationsResponse));
    await vi.waitFor(() => expect(root(fixture).querySelectorAll('.register-row')).toHaveLength(1));
    button(root(fixture), 'Pending review · 0').click();
    await fixture.whenStable();
    expect(root(fixture).querySelector('.empty-filter')?.textContent).toContain('No servers are pending review');
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
    expect(notice?.getAttribute('role')).toBe('status');
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
    expect(notice?.getAttribute('aria-live')).toBe('polite');
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
    fetchSpy.mockResolvedValueOnce(response({ status: 'refused', reason: 'admin_required', requiredRole: 'Owner or Admin' }, 403));
    button(root(fixture), 'Refresh list').click();
    await vi.waitFor(() => expect(root(fixture).querySelector('.access-state')).not.toBeNull());
    expect(root(fixture).querySelectorAll('.register-row')).toHaveLength(0);

    fetchSpy.mockResolvedValueOnce(response({ status: 'unavailable' }, 503));
    button(root(fixture), 'Refresh list').click();
    await vi.waitFor(() => expect(root(fixture).textContent).toContain("Couldn't load the integrations list"));
    expect(root(fixture).querySelectorAll('.register-row')).toHaveLength(0);
    expect(root(fixture).textContent).not.toContain('Showing what we loaded');
  });

  it('keeps the existing sign-in shell outside /org routes', () => {
    globalThis.history.replaceState({}, '', '/');
    const fixture = create();
    expect(root(fixture).textContent).toContain('OpenCrane');
    expect(button(root(fixture), 'Continue with single sign-on')).toBeTruthy();
    expect(fetchSpy).toHaveBeenCalledExactlyOnceWith('/auth/me');
  });
});
