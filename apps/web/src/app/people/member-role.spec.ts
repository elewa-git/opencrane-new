import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { MemberDetailScreen } from './member-detail-screen';

const member = { memberId: 'alex-kim', displayName: 'Alex Kim', role: 'member',
  permissions: { changeRole: true, remove: false, manageOwnership: false },
  email: 'alex@example.test', status: 'joined', joinedAt: '2026-03-12T10:00:00Z',
  groups: [{ groupId: 'sales', name: 'Sales team', membershipSource: 'local' }],
  memberSequence: 2, ownershipSequence: 1,
  personalAssistant: { status: 'unavailable' }, rejoinedAt: { status: 'unavailable' } };
const access = { checkedAt: '2026-10-15T10:00:00Z', complete: true,
  unavailableSections: [], rows: [] };
const receipt = { status: 'recorded', commandId: 'role-command', changeId: 'change-1',
  type: 'member.role_changed', sequence: 3, recordedAt: '2026-10-18T10:00:00Z',
  memberId: 'alex-kim', newRole: 'admin' };

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function path(input: RequestInfo | URL): string {
  if (input instanceof Request) return new URL(input.url).pathname;
  if (input instanceof URL) return input.pathname;
  return new URL(input, 'https://example.test').pathname;
}

function mount(fetcher: typeof fetch): ComponentFixture<MemberDetailScreen> {
  vi.stubGlobal('fetch', fetcher);
  vi.stubGlobal('crypto', { randomUUID: () => 'role-command' });
  TestBed.configureTestingModule({ imports: [MemberDetailScreen] });
  const fixture = TestBed.createComponent(MemberDetailScreen);
  fixture.componentRef.setInput('memberId', 'alex-kim');
  fixture.detectChanges();
  return fixture;
}

function page(fixture: ComponentFixture<MemberDetailScreen>): HTMLElement {
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

function click(fixture: ComponentFixture<MemberDetailScreen>, label: string): void {
  const buttons = [...page(fixture).querySelectorAll('button')];
  const button = buttons.find(candidate => candidate.textContent?.trim() === label);
  if (!button) throw new Error(`Missing button: ${label}`);
  button.click();
}

function selectAdmin(fixture: ComponentFixture<MemberDetailScreen>): void {
  const radio = page(fixture).querySelector<HTMLInputElement>('input[value="admin"]');
  if (!radio) throw new Error('Missing Admin radio');
  radio.click();
  fixture.detectChanges();
}

afterEach(() => { vi.unstubAllGlobals(); });

it('sends one exact role command on a double click, then reads status', async () => {
  const posts: unknown[] = [];
  const paths: string[] = [];
  function fetcher(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = path(input);
    paths.push(url);
    if (url.endsWith('/access')) return Promise.resolve(reply(access));
    if (init?.method === 'POST') {
      posts.push(JSON.parse(String(init.body)) as unknown);
      return Promise.resolve(reply(receipt));
    }
    if (url.endsWith('/changes/role-command')) {
      return Promise.resolve(reply({ ...receipt, effect: 'role_changed',
        projection: { content: 'applying', iam: 'current' } }));
    }
    return Promise.resolve(reply(member));
  }
  const fixture = mount(fetcher);
  await vi.waitFor(() => expect(page(fixture).textContent).toContain('Alex Kim'));
  click(fixture, 'Change role');
  selectAdmin(fixture);
  click(fixture, 'Make Alex Kim an Admin');
  click(fixture, 'Make Alex Kim an Admin');
  await vi.waitFor(() => expect(page(fixture).textContent)
    .toContain('Role change saved. Access is still updating.'));
  expect(posts).toEqual([{ commandId: 'role-command', expectedSequence: 2, newRole: 'admin' }]);
  expect(paths).toContain('/api/members/alex-kim/changes/role-command');
});

it('keeps an uncertain command on GET only, including after a missing status', async () => {
  const methods: string[] = [];
  let statusReads = 0;
  function fetcher(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = path(input);
    methods.push(`${init?.method ?? 'GET'} ${url}`);
    if (url.endsWith('/access')) return Promise.resolve(reply(access));
    if (init?.method === 'POST') return Promise.resolve(new Response(null, { status: 503 }));
    if (url.endsWith('/changes/role-command')) {
      statusReads += 1;
      if (statusReads === 1) return Promise.resolve(reply({ status: 'not_found' }, 404));
      return Promise.resolve(reply({ ...receipt, effect: 'role_changed',
        projection: { content: 'current', iam: 'current' } }));
    }
    return Promise.resolve(reply(statusReads > 1 ? { ...member, role: 'admin' } : member));
  }
  const fixture = mount(fetcher);
  await vi.waitFor(() => expect(page(fixture).textContent).toContain('Alex Kim'));
  click(fixture, 'Change role');
  selectAdmin(fixture);
  click(fixture, 'Make Alex Kim an Admin');
  await vi.waitFor(() => expect(page(fixture).textContent)
    .toContain("We couldn't tell whether the role change was saved"));
  click(fixture, 'Check status');
  await vi.waitFor(() => expect(page(fixture).textContent).toContain('may still arrive'));
  click(fixture, 'Check status');
  await vi.waitFor(() => expect(page(fixture).textContent).toContain('Alex Kim is now an Admin'));
  expect(methods.filter(method => method.startsWith('POST'))).toHaveLength(1);
  expect(statusReads).toBe(2);
});

it('shows a minimal read-only header without loading access', async () => {
  const paths: string[] = [];
  function fetcher(input: RequestInfo | URL): Promise<Response> {
    paths.push(path(input));
    return Promise.resolve(reply({ memberId: member.memberId, displayName: member.displayName,
      role: 'member', permissions: { changeRole: false, remove: false,
        manageOwnership: false } }));
  }
  const fixture = mount(fetcher);
  await vi.waitFor(() => expect(page(fixture).textContent).toContain('Alex Kim is a Member.'));
  expect(page(fixture).textContent).toContain('Changing roles needs the Admin role');
  expect(page(fixture).textContent).not.toContain('alex@example.test');
  expect(page(fixture).textContent).not.toContain('Change role');
  expect(paths).toEqual(['/api/members/alex-kim']);
});
