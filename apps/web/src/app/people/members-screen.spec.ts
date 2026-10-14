import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, expect, it, vi } from 'vitest';
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
  return fixture.nativeElement as HTMLElement;
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
afterEach(() => vi.unstubAllGlobals());

it('starts with a bounded member page and appends distinct rows once', async () => {
  const urls: string[] = [];
  let release: ((value: Response) => void) | undefined;
  const fixture = await mount((url) => {
    urls.push(url);
    if (url.includes('after=alice')) return new Promise((resolve) => { release = resolve; });
    return response(page([alice], 'alice'));
  });
  expect(urls[0]).toBe('/api/members?q=&after=&limit=20');
  const loadMore = root(fixture).querySelector<HTMLButtonElement>('button[data-load-more]');
  expect(loadMore).not.toBeNull();
  loadMore?.click();
  loadMore?.click();
  expect(urls).toHaveLength(2);
  release?.(response(page([alice, bob], null)));
  await settle(fixture);
  expect(root(fixture).querySelectorAll('[data-member-row]')).toHaveLength(2);
  expect(root(fixture).textContent).toContain('Not available yet');
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
