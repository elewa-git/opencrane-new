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
  TestBed.configureTestingModule({ imports: [MyTools] });
  const fixture = TestBed.createComponent(MyTools);
  fixture.componentRef.setInput('serverId', 'odoo');
  fixture.detectChanges();
  const element: unknown = fixture.nativeElement;
  if (!(element instanceof HTMLElement)) throw new Error('Missing tools root');
  return { fixture, element };
}

describe('My tools', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    TestBed.resetTestingModule();
  });

  it('shows loading, then an empty list', async () => {
    let finish!: (value: Response) => void;
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(finish));
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
      if (reads === 2) return response(page([{ ...saved, profileId: 'second', selected: false }]));
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
});
