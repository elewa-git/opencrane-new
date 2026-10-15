import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { MemberDetailScreen } from './member-detail-screen';

const member = { memberId: 'alex', displayName: 'Alex Kim', role: 'member',
  permissions: { changeRole: true, remove: true, manageOwnership: true },
  email: 'alex@example.test', status: 'joined', joinedAt: '2026-03-12T10:00:00Z',
  groups: [], memberSequence: 2, ownershipSequence: 1,
  personalAssistant: { status: 'unavailable' }, rejoinedAt: { status: 'unavailable' } };
const access = { checkedAt: '2026-10-15T10:00:00Z', complete: true,
  unavailableSections: [], rows: [] };
const departure = { checkedAt: '2026-10-15T10:00:00Z', complete: true,
  unavailableSections: [], memberSequence: 2, ownershipSequence: 1,
  reviewRevision: 'a'.repeat(64), accessLost: [], ownedSharedWork: [],
  routines: { status: 'absent_on_version', message: 'No routines on this version' },
  personalConnections: { status: 'unsupported_history', message: 'Cannot check connections' },
  personalComputer: [], retainedHistory: { count: 1, firstAt: null, lastAt: null },
  permissions: { remove: true } };
const receipt = { status: 'recorded', removedAt: '2026-10-15T10:05:00Z',
  access: 'revoked', projection: { iam: 'applying', content: 'current' } };

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function url(input: RequestInfo | URL): string {
  if (input instanceof Request) return input.url;
  if (input instanceof URL) return input.href;
  return input;
}

function mount(fetcher: typeof fetch): ComponentFixture<MemberDetailScreen> {
  vi.stubGlobal('fetch', fetcher);
  TestBed.configureTestingModule({ imports: [MemberDetailScreen] });
  const fixture = TestBed.createComponent(MemberDetailScreen);
  fixture.componentRef.setInput('memberId', 'alex');
  fixture.detectChanges();
  return fixture;
}

function page(fixture: ComponentFixture<MemberDetailScreen>): HTMLElement {
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

function button(root: HTMLElement, label: string): HTMLButtonElement {
  const result = [...root.querySelectorAll('button')].find((item) =>
    item.textContent?.trim().includes(label));
  if (!result) throw new Error(`Missing button: ${label}`);
  return result;
}

function baseFetch(input: RequestInfo | URL): Promise<Response> {
  return Promise.resolve(response(url(input).endsWith('/access') ? access : member));
}

async function open(fixture: ComponentFixture<MemberDetailScreen>): Promise<void> {
  await vi.waitFor(() => expect(page(fixture).textContent).toContain('Alex Kim'));
  button(page(fixture), 'Remove').click();
}

afterEach(() => { vi.unstubAllGlobals(); });

it.each(['inventory_limits', 'inventory_index'])('blocks an incomplete %s review', async (code) => {
  const requests: string[] = [];
  function fetcher(input: RequestInfo | URL): Promise<Response> {
    const path = url(input);
    requests.push(path);
    if (path.endsWith('/departure')) {
      return Promise.resolve(response({ ...departure, complete: false,
        unavailableSections: [code] }));
    }
    return baseFetch(input);
  }
  const fixture = mount(fetcher);
  await open(fixture);
  await vi.waitFor(() => expect(page(fixture).textContent).toContain('Try again'));
  expect(button(page(fixture), 'Remove Alex').disabled).toBe(true);
  expect(page(fixture).textContent).not.toContain(code);
  button(page(fixture), 'Try again').click();
  await vi.waitFor(() => expect(requests.filter((path) => path.endsWith('/departure')))
    .toHaveLength(2));
  expect(requests.some((path) => path.endsWith('/remove'))).toBe(false);
});

it('shows routine and connection status messages from the reply', async () => {
  function fetcher(input: RequestInfo | URL): Promise<Response> {
    if (url(input).endsWith('/departure')) return Promise.resolve(response(departure));
    return baseFetch(input);
  }
  const fixture = mount(fetcher);
  await open(fixture);
  await vi.waitFor(() => expect(page(fixture).textContent).toContain('No routines on this version'));
  expect(page(fixture).textContent).toContain('Cannot check connections');
  expect(page(fixture).textContent).toContain('private chats stay private');
});

it('sends one reviewed removal and shows saved access with separate progress', async () => {
  const posts: Array<{ body: unknown }> = [];
  function fetcher(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const path = url(input);
    if (path.endsWith('/departure')) return Promise.resolve(response(departure));
    if (path.endsWith('/remove')) {
      posts.push({ body: JSON.parse(String(init?.body)) as unknown });
      return Promise.resolve(response(receipt));
    }
    if (path.includes('/changes/')) return Promise.resolve(response(receipt));
    return baseFetch(input);
  }
  const fixture = mount(fetcher);
  await open(fixture);
  await vi.waitFor(() => expect(button(page(fixture), 'Remove Alex').disabled).toBe(false));
  button(page(fixture), 'Remove Alex').click();
  button(page(fixture), 'Remove Alex').click();
  await vi.waitFor(() => expect(page(fixture).textContent).toContain('Removed ·'));
  expect(posts).toHaveLength(1);
  expect(posts[0]?.body).toMatchObject({ expectedSequence: 2,
    reviewRevision: departure.reviewRevision });
  expect(page(fixture).textContent).toContain('IAM is still applying');
  expect(page(fixture).textContent).toContain('Content is current');
  expect(page(fixture).textContent).toContain("Clean-up status isn't available yet");
});

it('checks an uncertain removal using the original id and never posts twice', async () => {
  const requests: string[] = [];
  function fetcher(input: RequestInfo | URL): Promise<Response> {
    const path = url(input);
    requests.push(path);
    if (path.endsWith('/departure')) return Promise.resolve(response(departure));
    if (path.endsWith('/remove')) return Promise.reject(new Error('reply lost'));
    if (path.includes('/changes/')) return Promise.resolve(response({}, 404));
    return baseFetch(input);
  }
  const fixture = mount(fetcher);
  await open(fixture);
  await vi.waitFor(() => expect(button(page(fixture), 'Remove Alex').disabled).toBe(false));
  button(page(fixture), 'Remove Alex').click();
  await vi.waitFor(() => expect(page(fixture).textContent).toContain('Check status'));
  button(page(fixture), 'Check status').click();
  await vi.waitFor(() => expect(page(fixture).textContent).toContain('may still arrive'));
  expect(requests.filter((path) => path.endsWith('/remove'))).toHaveLength(1);
  expect(requests.filter((path) => path.includes('/changes/'))).toHaveLength(1);
});
