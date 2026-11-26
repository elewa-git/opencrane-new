import { TestBed } from '@angular/core/testing';
import { MyTools } from './my-tools';

const personal = { serverId: 'personal-tool', name: 'Orders', status: 'needs_account',
  canManageConnection: true };
const ready = { serverId: 'shared-tool', name: 'Calendar', status: 'ready',
  canManageConnection: false };
const unavailable = { serverId: 'other-tool', name: 'Stock', status: 'unavailable',
  canManageConnection: false };

function response(body: unknown, status = 200): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify(body), { status }));
}

function view(serverId = '') {
  const fixture = TestBed.createComponent(MyTools);
  fixture.componentRef.setInput('serverId', serverId);
  fixture.detectChanges();
  const element: unknown = fixture.nativeElement;
  if (!(element instanceof HTMLElement)) throw new Error('Missing My tools screen');
  return { fixture, element };
}

describe('The My tools list', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    TestBed.resetTestingModule();
  });

  it('shows the empty state without asking for an ID', async () => {
    const fetchTools = vi.spyOn(globalThis, 'fetch').mockReturnValue(response({ rows: [] }));
    const { fixture, element } = view();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(element.textContent).toContain('No tools have been added yet.');
    });
    expect(fetchTools.mock.calls[0]?.[0]).toBe('/api/my/tools');
    expect(element.querySelector('input')).toBeNull();
  });

  it('names all tools, shows the three statuses and opens the existing key form', async () => {
    function read(url: RequestInfo | URL) {
      if (url === '/api/my/tools') return response({ rows: [personal, ready, unavailable] });
      if (url === '/api/my/tools/personal-tool/profiles?limit=20') {
        return response({ rows: [], next: null, complete: true });
      }
      if (url === '/api/my/tools/personal-tool/connection') {
        return response({ serverId: 'personal-tool', connectionId: 'registered',
          identityTool: 'who_am_i', selectionRevision: 0 });
      }
      return response({}, 404);
    }
    vi.spyOn(globalThis, 'fetch').mockImplementation(read);
    const { fixture, element } = view();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(element.textContent).toContain('Ready for you');
    });
    expect(element.textContent).toContain('Needs your account');
    expect(element.textContent).toContain('Not available to you');
    expect(element.textContent).toContain('owner or admin');
    const rows = element.querySelectorAll('li');
    expect(rows).toHaveLength(3);
    expect(rows[0]?.textContent).toContain('Orders');
    expect(rows[1]?.textContent).toContain('Calendar');
    expect(rows[2]?.textContent).toContain('Stock');
    expect(rows[1]?.querySelector('button')).toBeNull();
    expect(rows[2]?.querySelector('button')).toBeNull();
    const connect = rows[0]?.querySelector('button');
    expect(connect?.textContent?.trim()).toBe('Connect');
    connect?.click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(element.querySelector('input[type="password"]')).not.toBeNull();
    });
  });

  it('only opens chat links for tools the member can connect', async () => {
    const fetchTools = vi.spyOn(globalThis, 'fetch')
      .mockReturnValue(response({ rows: [personal, unavailable] }));
    const { fixture, element } = view('other-tool');
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(element.textContent).toContain('Not available to you');
    });
    expect(fetchTools.mock.calls.map(([url]) => url)).toEqual(['/api/my/tools']);
  });
});

it('refreshes the list when the member selects their verified key', async () => {
  let selected = false;
  function serve(url: RequestInfo | URL, request?: RequestInit) {
    if (url === '/api/my/tools') {
      const tool = { ...personal, status: selected ? 'ready' : 'needs_account' };
      return response({ rows: [tool] });
    }
    if (typeof url !== 'string') return response({}, 404);
    if (url.endsWith('/profiles?limit=20')) {
      return response({ rows: [], next: null, complete: true });
    }
    if (url.endsWith('/connection')) {
      return response({ serverId: 'personal-tool', connectionId: 'installed',
        identityTool: 'who_am_i', selectionRevision: selected ? 1 : 0 });
    }
    if (request?.method === 'POST' && typeof request.body === 'string') {
      const changeRef = /"changeRef":"([a-z0-9-]+)"/u.exec(request.body)?.[1];
      if (url.endsWith('/selection')) {
        selected = true;
        return response({ status: 'selected', changeRef });
      }
      if (url.endsWith('/key')) {
        return response({ status: 'verified', sequence: 1, changeRef });
      }
    }
    const profileId = url.split('/').at(-1);
    return response({ serverId: 'personal-tool', profileId, profileRevision: 1,
      status: 'verified', generation: 1, adminBlocked: false, serverAvailable: true,
      callsAvailable: false });
  }
  vi.spyOn(globalThis, 'fetch').mockImplementation(serve);
  try {
    const { fixture, element } = view('personal-tool');
    function keyInput() {
      fixture.detectChanges();
      const input = element.querySelector<HTMLInputElement>('input[type="password"]');
      if (!input) throw new Error('Missing key form');
      return input;
    }
    const input = await vi.waitFor(keyInput);
    input.value = 'synthetic-fixture-key';
    input.form?.dispatchEvent(new Event('submit', { cancelable: true }));
    function chooseKey() {
      fixture.detectChanges();
      expect(element.textContent).toContain('Needs your account');
      for (const button of element.querySelectorAll('button')) {
        if (button.textContent?.trim() === 'Use this key') return button;
      }
      throw new Error('Missing key choice');
    }
    const choice = await vi.waitFor(chooseKey);
    choice.click();
    function readyStatus() {
      fixture.detectChanges();
      expect(element.textContent).toContain('Ready for you');
      expect(element.textContent).not.toContain('Needs your account');
    }
    await vi.waitFor(readyStatus);
  } finally {
    vi.restoreAllMocks();
    TestBed.resetTestingModule();
  }
});
