import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PeopleScreen } from './people-screen';

const alice = { memberId: 'alice', displayName: 'Alice', email: 'alice@example.test',
  role: 'admin', status: 'joined', joinedAt: '2026-10-01T00:00:00Z', groups: [] };
const bob = { ...alice, memberId: 'bob', displayName: 'Bob', email: 'bob@example.test',
  role: 'member' };
function page(rows: unknown[], next: string | null, status = 'current') {
  return { rows, next, counts: { members: { status, value: status === 'current' ? 2 : null },
    groups: { status, value: null }, pendingInvitations: { status, value: null },
    acceptedInvitations: { status, value: null } }, checkedAt: '2026-10-14T10:00:00Z',
  projection: { content: 'current' }, permissions: { invite: true } };
}
function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status,
    headers: { 'content-type': 'application/json' } });
}
function root(fixture: ComponentFixture<PeopleScreen>): HTMLElement {
  const element: unknown = fixture.nativeElement;
  if (element instanceof HTMLElement) return element;
  throw new Error('Expected a screen element');
}
async function settle(fixture: ComponentFixture<PeopleScreen>): Promise<void> {
  for (let index = 0; index < 4; index += 1) {
    fixture.detectChanges();
    await fixture.whenStable();
  }
}
async function mount(handler: (url: string) => Promise<Response> | Response) {
  vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve(handler(url))));
  TestBed.configureTestingModule({ imports: [PeopleScreen] });
  const fixture = TestBed.createComponent(PeopleScreen);
  fixture.componentRef.setInput('organisationName', 'Example organisation');
  fixture.detectChanges();
  await settle(fixture);
  return fixture;
}
beforeEach(() => history.replaceState(null, '', '/org/people'));
afterEach(() => {
  vi.unstubAllGlobals();
  history.replaceState(null, '', '/org/people');
});

it('starts with a bounded member page and appends distinct rows once', async () => {
  const urls: string[] = [];
  let release: ((value: Response) => void) | undefined;
  const fixture = await mount((url) => {
    urls.push(url);
    if (url.includes('after=alice')) return new Promise((resolve) => { release = resolve; });
    return response(page([alice], 'alice'));
  });
  expect(urls[0]).toBe('/api/members?q=&after=&limit=20');
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(root(fixture).textContent).toContain('Alice');
  });
  const loadMore = root(fixture).querySelector<HTMLButtonElement>('button[data-load-more]');
  expect(loadMore).not.toBeNull();
  expect(root(fixture).textContent).toContain('2 members');
  loadMore?.click();
  loadMore?.click();
  expect(urls).toHaveLength(2);
  release?.(response(page([alice, bob], null)));
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(root(fixture).querySelectorAll('[data-member-row]')).toHaveLength(2);
  });
  expect(root(fixture).textContent).toContain('Not available yet');
});

it('keeps loaded rows and focus after a failed Refresh', async () => {
  let reads = 0;
  const fixture = await mount(() => {
    reads += 1;
    if (reads === 1) return response(page([alice], null, 'applying'));
    return response({ status: 'unavailable' }, 503);
  });
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(root(fixture).querySelector('.member-toolbar button')).not.toBeNull();
  });
  const refresh = root(fixture).querySelector<HTMLButtonElement>('.member-toolbar button');
  expect(refresh).not.toBeNull();
  refresh?.focus();
  refresh?.click();
  expect(reads).toBe(2);
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(root(fixture).textContent).toContain('Showing what we loaded at');
  });
  expect(root(fixture).textContent).toContain('Alice');
  expect(root(fixture).querySelector('.member-count')).toBeNull();
  expect(document.activeElement).toBe(refresh);
  expect(reads).toBe(2);
});

it('drops an old search reply and clears all protected values after a denied read', async () => {
  let release: ((value: Response) => void) | undefined;
  const fixture = await mount((url) => {
    if (url.includes('q=old')) return new Promise((resolve) => { release = resolve; });
    if (url.includes('q=new')) return response({ status: 'refused' }, 403);
    return response(page([alice], null));
  });
  const search = root(fixture).querySelector<HTMLInputElement>('#member-search');
  expect(search).not.toBeNull();
  if (!search) return;
  search.value = 'old';
  search.dispatchEvent(new Event('input', { bubbles: true }));
  await settle(fixture);
  search.value = 'new';
  search.dispatchEvent(new Event('input', { bubbles: true }));
  await settle(fixture);
  release?.(response(page([bob], null)));
  await settle(fixture);
  expect(root(fixture).textContent).not.toContain('Alice');
  expect(root(fixture).textContent).not.toContain('Bob');
  expect(root(fixture).textContent).not.toContain('example.test');
});
