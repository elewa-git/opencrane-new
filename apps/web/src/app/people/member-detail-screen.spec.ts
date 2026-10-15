import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { MemberDetailScreen } from './member-detail-screen';

const member = { memberId: 'alex-kim', displayName: 'Alex Kim', role: 'member',
  permissions: { changeRole: false, remove: false, manageOwnership: false },
  email: 'alex@example.test', status: 'joined', joinedAt: '2026-03-12T10:00:00Z',
  groups: [{ groupId: 'sales', name: 'Sales team', membershipSource: 'local' }],
  memberSequence: 2, ownershipSequence: 1,
  personalAssistant: { status: 'unavailable' }, rejoinedAt: { status: 'unavailable' } };
const access = { checkedAt: '2026-10-15T10:00:00Z', complete: true,
  unavailableSections: [], rows: [{ resourceType: 'model', resourceId: 'model-a',
    label: 'Model A', relation: 'use', sources: [{ kind: 'direct', eventId: 'grant-a',
      sequence: 1 }], eligibility: { person: 'allowed', assistants: [],
      availability: 'unavailable' } }] };

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function mount(fetcher: typeof fetch): ComponentFixture<MemberDetailScreen> {
  vi.stubGlobal('fetch', fetcher);
  TestBed.configureTestingModule({ imports: [MemberDetailScreen] });
  const fixture = TestBed.createComponent(MemberDetailScreen);
  fixture.componentRef.setInput('memberId', 'alex-kim');
  fixture.detectChanges();
  return fixture;
}

function page(fixture: ComponentFixture<MemberDetailScreen>): HTMLElement {
  fixture.detectChanges();
  const element: unknown = fixture.nativeElement;
  if (!(element instanceof HTMLElement)) throw new Error('Expected a member detail page');
  return element;
}

function requestUrl(input: RequestInfo | URL): string {
  if (input instanceof Request) return input.url;
  if (input instanceof URL) return input.href;
  return input;
}

afterEach(() => vi.unstubAllGlobals());

it('shows the full header while its separate access read waits', async () => {
  const urls: string[] = [];
  function fetcher(input: RequestInfo | URL): Promise<Response> {
    urls.push(requestUrl(input));
    if (urls.length === 1) return Promise.resolve(reply(member));
    return new Promise<Response>(() => undefined);
  }
  const fixture = mount(fetcher);
  await vi.waitFor(() => expect(page(fixture).textContent).toContain('Alex Kim'));
  expect(page(fixture).textContent).toContain('Working out what Alex Kim can use…');
  expect(page(fixture).textContent).toContain('Sales team');
  expect(urls).toEqual(['/api/members/alex-kim', '/api/members/alex-kim/access']);
});

it('keeps a minimal header private and makes no access read', async () => {
  const urls: string[] = [];
  function fetcher(input: RequestInfo | URL): Promise<Response> {
    urls.push(requestUrl(input));
    return Promise.resolve(reply({ memberId: 'alex-kim', displayName: 'Alex Kim',
      role: 'member', permissions: member.permissions }));
  }
  const fixture = mount(fetcher);
  await vi.waitFor(() => expect(page(fixture).textContent).toContain('Alex Kim'));
  expect(page(fixture).textContent).not.toContain('alex@example.test');
  expect(urls).toHaveLength(1);
});

it('shows checked grants without claiming a tool works now', async () => {
  function fetcher(input: RequestInfo | URL): Promise<Response> {
    return Promise.resolve(reply(requestUrl(input).endsWith('/access') ? access : member));
  }
  const fixture = mount(fetcher);
  await vi.waitFor(() => expect(page(fixture).textContent).toContain('Direct grant'));
  expect(page(fixture).textContent).toContain('Allowed');
  expect(page(fixture).textContent).toContain('Works now: Not available yet');
  expect(page(fixture).textContent).not.toContain('Can use');
});

it('clears an older denied reply and ignores later successful data', async () => {
  let denyOld!: (value: Response) => void;
  let finishNew!: (value: Response) => void;
  let accessReads = 0;
  function fetcher(input: RequestInfo | URL): Promise<Response> {
    if (requestUrl(input).endsWith('/access')) {
      accessReads += 1;
      if (accessReads === 1) return new Promise<Response>((resolve) => { denyOld = resolve; });
      return new Promise<Response>((resolve) => { finishNew = resolve; });
    }
    return Promise.resolve(reply(member));
  }
  const fixture = mount(fetcher);
  await vi.waitFor(() => expect(page(fixture).textContent).toContain('Alex Kim'));
  page(fixture).querySelector('button')?.click();
  await vi.waitFor(() => expect(accessReads).toBe(2));
  denyOld(new Response(null, { status: 403 }));
  await vi.waitFor(() => expect(page(fixture).textContent)
    .toContain("You no longer have access to this person's details"));
  await vi.waitFor(() => expect(document.activeElement)
    .toBe(page(fixture).querySelector('h1')));
  finishNew(reply(access));
  await fixture.whenStable();
  expect(page(fixture).textContent).not.toContain('Alex Kim');
  expect(page(fixture).textContent).not.toContain('alex@example.test');
  expect(page(fixture).textContent).not.toContain('Direct grant');
  expect(page(fixture).querySelector('a[href="/org"]')).not.toBeNull();
});
