import { TestBed } from '@angular/core/testing';
import { MyTools } from './my-tools';

const saved = {
  serverId: 'odoo', profileId: 'alex', profileRevision: 3,
  controlRevision: 0, status: 'saved_unverified', generation: 1,
  adminBlocked: false, serverAvailable: true, callsAvailable: false,
  ownerKind: 'personal', selected: true,
};

function response(value: unknown, status = 200): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify(value), { status }));
}

function page(rows: unknown[], next: string | null = null) {
  return { rows, next, generation: 1, sequence: 4, complete: next === null };
}

function view(): { fixture: ReturnType<typeof TestBed.createComponent<MyTools>>;
  element: HTMLElement } {
  const fixture = TestBed.createComponent(MyTools);
  fixture.componentRef.setInput('serverId', 'odoo');
  fixture.detectChanges();
  const element: unknown = fixture.nativeElement;
  if (!(element instanceof HTMLElement)) throw new Error('Missing tools root');
  return { fixture, element };
}

describe('My tools', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [MyTools] });
    sessionStorage.clear();
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
      configurable: true,
      value(this: HTMLDialogElement) { this.setAttribute('open', ''); },
    });
    Object.defineProperty(HTMLDialogElement.prototype, 'close', {
      configurable: true,
      value(this: HTMLDialogElement) { this.removeAttribute('open'); },
    });
  });

  afterEach(() => {
    sessionStorage.clear();
    vi.restoreAllMocks();
    TestBed.resetTestingModule();
  });

  it('shows loading, then an empty list', async () => {
    let finish!: (value: Response) => void;
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>((resolve) => {
      finish = resolve;
    }));
    const { fixture, element } = view();
    expect(element.textContent).toContain('Loading');
    finish(new Response(JSON.stringify(page([]))));
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(element.textContent).toContain('No saved connections');
    });
  });

  it('loads page two and keeps loaded rows when refresh fails', async () => {
    let reads = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      reads += 1;
      if (reads === 1) return response(page([saved], 'next'));
      if (reads === 2) {
        return response(page([{ ...saved, profileId: 'second', selected: false,
          adminBlocked: true }]));
      }
      return response({ status: 'unavailable' }, 503);
    });
    const { fixture, element } = view();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(element.textContent).toContain('alex');
    });
    element.querySelector<HTMLButtonElement>('[data-action="more"]')?.click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(element.textContent).toContain('second');
      expect(element.textContent).toContain('Disabled by an administrator');
    });
    element.querySelector<HTMLButtonElement>('[data-action="refresh"]')?.click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(element.textContent).toContain('last loaded');
      expect(element.textContent).toContain('alex');
      expect(element.textContent).toContain('second');
    });
    expect(element.textContent).toContain('Selection does not grant access');
  });

  it('shows no matches and clears protected rows after a refused read', async () => {
    let reads = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      reads += 1;
      return reads === 1 ? response(page([saved])) : response({ status: 'refused' }, 403);
    });
    const { fixture, element } = view();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(element.textContent).toContain('alex');
    });
    const search = element.querySelector<HTMLInputElement>('input[type="search"]');
    if (!search) throw new Error('Missing search');
    search.value = 'missing';
    search.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(element.textContent).toContain('No matches');
    element.querySelector<HTMLButtonElement>('[data-action="refresh"]')?.click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(element.textContent).toContain('Access changed');
      expect(element.textContent).not.toContain('alex');
    });
  });

  it('checks one revoke reference after an unknown reply and keeps 404 unknown', async () => {
    const requests: Array<{ url: string; body?: string }> = [];
    function serve(url: string | URL | Request, init?: RequestInit): Promise<Response> {
      const address = url instanceof Request ? url.url : url.toString();
      const body = typeof init?.body === 'string' ? init.body : '';
      requests.push({ url: address, body });
      if (address.endsWith('/revoke')) return response({}, 503);
      if (address.endsWith('/changes/')) throw new Error('Missing reference');
      if (address.includes('/changes/')) return response({}, 404);
      if (address.endsWith('/alex')) return response(saved);
      return response(page([saved]));
    }
    vi.spyOn(globalThis, 'fetch').mockImplementation(serve);
    const { fixture, element } = view();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(element.textContent).toContain('alex');
    });
    element.querySelector<HTMLButtonElement>('.profile')?.click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(element.textContent).toContain('Saved version');
    });
    element.querySelector<HTMLButtonElement>('.danger-outline')?.click();
    element.querySelector<HTMLButtonElement>('.danger')?.click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(element.textContent).toContain('Outcome unknown');
    });
    element.querySelector<HTMLButtonElement>('.notice button')?.click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(element.textContent).toContain('Still unknown');
    });
    const posts = requests.filter((request) => request.url.endsWith('/revoke'));
    expect(posts).toHaveLength(1);
    const changeRef = /"changeRef":"([\w-]+)"/u.exec(posts[0]!.body ?? '')?.[1];
    expect(changeRef).toBeTruthy();
    expect(requests.some((request) => request.url.endsWith(`/changes/${changeRef}`)))
      .toBe(true);
    expect(element.querySelector('.danger-outline')).toBeNull();
  });

  it('keeps the last chosen profile when detail replies arrive in reverse order', async () => {
    const second = { ...saved, profileId: 'bea', selected: false };
    let finishAlex!: (value: Response) => void;
    let finishBea!: (value: Response) => void;
    let postedUrl = '';
    function serve(url: string | URL | Request): Promise<Response> {
      const address = url instanceof Request ? url.url : url.toString();
      if (address.endsWith('/alex')) {
        return new Promise<Response>((resolve) => { finishAlex = resolve; });
      }
      if (address.endsWith('/bea')) {
        return new Promise<Response>((resolve) => { finishBea = resolve; });
      }
      if (address.endsWith('/revoke')) {
        postedUrl = address;
        return response({}, 503);
      }
      return response(page([saved, second]));
    }
    vi.spyOn(globalThis, 'fetch').mockImplementation(serve);
    const { fixture, element } = view();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(element.querySelectorAll('.profile')).toHaveLength(2);
    });
    const profiles = element.querySelectorAll<HTMLButtonElement>('.profile');
    profiles[0]?.click();
    profiles[1]?.click();
    finishBea(new Response(JSON.stringify(second)));
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(element.querySelector('.detail h2')?.textContent).toContain('bea');
    });
    finishAlex(new Response(JSON.stringify(saved)));
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    fixture.detectChanges();
    expect(element.querySelector('.detail h2')?.textContent).toContain('bea');
    element.querySelector<HTMLButtonElement>('.danger-outline')?.click();
    element.querySelector<HTMLButtonElement>('.danger')?.click();
    expect(postedUrl).toContain('/bea/revoke');
  });

  it('keeps an unknown revoke reference across navigation for a status check', async () => {
    const requests: string[] = [];
    function serve(url: string | URL | Request): Promise<Response> {
      const address = url instanceof Request ? url.url : url.toString();
      requests.push(address);
      if (address.endsWith('/revoke')) return response({}, 503);
      if (address.includes('/changes/')) return response({}, 404);
      if (address.endsWith('/alex')) return response(saved);
      return response(page([saved]));
    }
    vi.spyOn(globalThis, 'fetch').mockImplementation(serve);
    const first = view();
    await vi.waitFor(() => {
      first.fixture.detectChanges();
      expect(first.element.querySelector('.profile')).not.toBeNull();
    });
    first.element.querySelector<HTMLButtonElement>('.profile')?.click();
    await vi.waitFor(() => {
      first.fixture.detectChanges();
      expect(first.element.querySelector('.danger-outline')).not.toBeNull();
    });
    first.element.querySelector<HTMLButtonElement>('.danger-outline')?.click();
    first.element.querySelector<HTMLButtonElement>('.danger')?.click();
    await vi.waitFor(() => {
      first.fixture.detectChanges();
      expect(first.element.textContent).toContain('Outcome unknown');
    });
    const originalReference = first.element.querySelector('.notice code')?.textContent?.trim();
    expect(originalReference).toBeTruthy();
    expect(sessionStorage.getItem('my-tools-revoke:odoo')).toContain(originalReference);
    first.fixture.destroy();
    const second = view();
    await vi.waitFor(() => {
      second.fixture.detectChanges();
      expect(second.element.querySelector('.profile')).not.toBeNull();
    });
    expect(second.element.textContent).toContain(originalReference);
    second.element.querySelector<HTMLButtonElement>('.notice button')?.click();
    await vi.waitFor(() => {
      second.fixture.detectChanges();
      expect(second.element.textContent).toContain('Still unknown');
    });
    expect(requests.some((address) =>
      address.endsWith(`/alex/changes/${originalReference}`))).toBe(true);
    expect(requests.filter((address) => address.endsWith('/revoke'))).toHaveLength(1);
    expect(sessionStorage.getItem('my-tools-revoke:odoo')).toContain(originalReference);
  });

  it('names the safe integration and profile identifiers in the revoke review', async () => {
    function serve(url: string | URL | Request): Promise<Response> {
      const address = url instanceof Request ? url.url : url.toString();
      if (address.endsWith('/alex')) return response(saved);
      return response(page([saved]));
    }
    vi.spyOn(globalThis, 'fetch').mockImplementation(serve);
    const { fixture, element } = view();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(element.querySelector('.profile')).not.toBeNull();
    });
    element.querySelector<HTMLButtonElement>('.profile')?.click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(element.querySelector('.danger-outline')).not.toBeNull();
    });
    element.querySelector<HTMLButtonElement>('.danger-outline')?.click();
    const review = element.querySelector('dialog');
    expect(review?.textContent).toContain('odoo');
    expect(review?.textContent).toContain('alex');
  });

  it('accepts a matching revoke receipt and refreshes the safe detail', async () => {
    let revoked = false;
    function serve(url: string | URL | Request, init?: RequestInit): Promise<Response> {
      const address = url instanceof Request ? url.url : url.toString();
      if (address.endsWith('/revoke')) {
        revoked = true;
        const body = typeof init?.body === 'string' ? init.body : '';
        const changeRef = /"changeRef":"([\w-]+)"/u.exec(body)?.[1];
        return response({ status: 'revoked', changeRef, sequence: 4 });
      }
      const current = revoked ? { ...saved, status: 'unavailable', profileRevision: 4,
        generation: null } : saved;
      if (address.endsWith('/alex')) return response(current);
      return response(page([current]));
    }
    vi.spyOn(globalThis, 'fetch').mockImplementation(serve);
    const { fixture, element } = view();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(element.textContent).toContain('alex');
    });
    element.querySelector<HTMLButtonElement>('.profile')?.click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(element.textContent).toContain('Saved version');
    });
    element.querySelector<HTMLButtonElement>('.danger-outline')?.click();
    element.querySelector<HTMLButtonElement>('.danger')?.click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(element.textContent).toContain('Connection revoked here');
      expect(element.textContent).toContain('Revoked or unavailable');
    });
    expect(element.querySelector('.danger-outline')).toBeNull();
  });

  it('ignores a late profile detail after membership is refused', async () => {
    let finishDetail!: (value: Response) => void;
    let listReads = 0;
    function serve(url: string | URL | Request): Promise<Response> {
      const address = url instanceof Request ? url.url : url.toString();
      if (address.endsWith('/alex')) {
        return new Promise<Response>((resolve) => { finishDetail = resolve; });
      }
      listReads += 1;
      if (listReads === 1) return response(page([saved]));
      return response({ status: 'refused' }, 403);
    }
    vi.spyOn(globalThis, 'fetch').mockImplementation(serve);
    const { fixture, element } = view();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(element.textContent).toContain('alex');
    });
    element.querySelector<HTMLButtonElement>('.profile')?.click();
    element.querySelector<HTMLButtonElement>('[data-action="refresh"]')?.click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(element.textContent).toContain('Access changed');
    });
    finishDetail(new Response(JSON.stringify(saved)));
    await Promise.resolve();
    fixture.detectChanges();
    expect(element.textContent).not.toContain('alex');
    expect(element.textContent).not.toContain('Saved version');
  });

  it('ignores a late list page after a detail read refuses membership', async () => {
    let finishPage!: (value: Response) => void;
    function serve(url: string | URL | Request): Promise<Response> {
      const address = url instanceof Request ? url.url : url.toString();
      if (address.includes('cursor=')) {
        return new Promise<Response>((resolve) => { finishPage = resolve; });
      }
      if (address.endsWith('/alex')) return response({ status: 'refused' }, 403);
      return response(page([saved], 'next'));
    }
    vi.spyOn(globalThis, 'fetch').mockImplementation(serve);
    const { fixture, element } = view();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(element.textContent).toContain('alex');
    });
    element.querySelector<HTMLButtonElement>('[data-action="more"]')?.click();
    element.querySelector<HTMLButtonElement>('.profile')?.click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(element.textContent).toContain('Access changed');
    });
    finishPage(new Response(JSON.stringify(page([{ ...saved, profileId: 'late' }]))));
    await Promise.resolve();
    fixture.detectChanges();
    expect(element.textContent).not.toContain('late');
    expect(element.textContent).not.toContain('alex');
  });

  it('ignores a late revoke reply after membership is refused', async () => {
    let finishRevoke!: (value: Response) => void;
    let listReads = 0;
    function serve(url: string | URL | Request): Promise<Response> {
      const address = url instanceof Request ? url.url : url.toString();
      if (address.endsWith('/revoke')) {
        return new Promise<Response>((resolve) => { finishRevoke = resolve; });
      }
      if (address.endsWith('/alex')) return response(saved);
      listReads += 1;
      if (listReads === 1) return response(page([saved]));
      return response({ status: 'refused' }, 403);
    }
    vi.spyOn(globalThis, 'fetch').mockImplementation(serve);
    const { fixture, element } = view();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(element.textContent).toContain('alex');
    });
    element.querySelector<HTMLButtonElement>('.profile')?.click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(element.textContent).toContain('Saved version');
    });
    element.querySelector<HTMLButtonElement>('.danger-outline')?.click();
    element.querySelector<HTMLButtonElement>('.danger')?.click();
    element.querySelector<HTMLButtonElement>('[data-action="refresh"]')?.click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(element.textContent).toContain('Access changed');
    });
    finishRevoke(new Response(JSON.stringify({ status: 'revoked' })));
    await Promise.resolve();
    fixture.detectChanges();
    expect(element.textContent).not.toContain('alex');
    expect(element.textContent).not.toContain('Connection revoked here');
  });
});
