import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { MemberDetailScreen } from './member-detail-screen';

function showDialog(this: HTMLDialogElement): void { this.setAttribute('open', ''); }
function closeDialog(this: HTMLDialogElement): void { this.removeAttribute('open'); }
Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
  configurable: true, value: showDialog,
});
Object.defineProperty(HTMLDialogElement.prototype, 'close', {
  configurable: true, value: closeDialog,
});

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
const departure = { checkedAt: '2026-10-18T10:00:00Z', complete: true,
  unavailableSections: [], memberSequence: 2, ownershipSequence: 1,
  reviewRevision: 'a'.repeat(64), accessLost: [], ownedSharedWork: [],
  routines: { status: 'absent_on_version', message: 'No routines' },
  personalConnections: { status: 'unsupported_history', message: 'Not available' },
  personalComputer: [], retainedHistory: { count: 1, firstAt: null, lastAt: null },
  permissions: { remove: true } };

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function path(input: RequestInfo | URL): string {
  if (input instanceof Request) return new URL(input.url).pathname;
  if (input instanceof URL) return input.pathname;
  return new URL(input, 'https://example.test').pathname;
}

function mount(fetcher: typeof fetch, ids = ['role-command']): ComponentFixture<MemberDetailScreen> {
  vi.stubGlobal('fetch', fetcher);
  let nextId = 0;
  vi.stubGlobal('crypto', { randomUUID: () => ids[nextId++] });
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

function click(fixture: ComponentFixture<MemberDetailScreen>, label: string): void {
  const buttons = [...page(fixture).querySelectorAll('button')];
  const button = buttons.find(candidate => {
    const dialog = candidate.closest('dialog');
    const visible = !dialog || dialog.hasAttribute('open');
    return visible && candidate.textContent?.trim() === label;
  });
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

function pendingReply(): { promise: Promise<Response>; finish: (response: Response) => void } {
  let finish!: (response: Response) => void;
  const promise = new Promise<Response>((resolve) => { finish = resolve; });
  return { promise, finish };
}

function expectProtectedDetailsCleared(fixture: ComponentFixture<MemberDetailScreen>): void {
  const content = page(fixture).textContent ?? '';
  expect(content).toContain("You no longer have access to this person's details");
  expect(content).not.toContain('Alex Kim');
  expect(content).not.toContain('alex@example.test');
  expect(content).not.toContain('Sales team');
}

it.each([401, 403])('clears detail when a cancelled role POST returns %i', async (status) => {
  const post = pendingReply();
  function fetcher(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    if (init?.method === 'POST') return post.promise;
    return Promise.resolve(reply(path(input).endsWith('/access') ? access : member));
  }
  const fixture = mount(fetcher);
  await vi.waitFor(() => expect(page(fixture).textContent).toContain('Sales team'));
  click(fixture, 'Change role');
  selectAdmin(fixture);
  click(fixture, 'Make Alex Kim an Admin');
  click(fixture, 'Cancel');
  await vi.waitFor(() => expect(page(fixture).textContent)
    .toContain("We couldn't tell whether the role change was saved."));
  post.finish(new Response(null, { status }));
  await vi.waitFor(() => expectProtectedDetailsCleared(fixture));
});

it.each([401, 403])('clears detail when a cancelled role status GET returns %i',
  async (status) => {
    const statusReply = pendingReply();
    function fetcher(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      if (init?.method === 'POST') return Promise.resolve(new Response(null, { status: 503 }));
      if (path(input).includes('/changes/')) return statusReply.promise;
      return Promise.resolve(reply(path(input).endsWith('/access') ? access : member));
    }
    const fixture = mount(fetcher);
    await vi.waitFor(() => expect(page(fixture).textContent).toContain('Sales team'));
    click(fixture, 'Change role');
    selectAdmin(fixture);
    click(fixture, 'Make Alex Kim an Admin');
    await vi.waitFor(() => expect(page(fixture).textContent).toContain('Check status'));
    click(fixture, 'Check status');
    click(fixture, 'Cancel');
    await vi.waitFor(() => expect(page(fixture).querySelector('dialog[open]')).toBeNull());
    statusReply.finish(new Response(null, { status }));
    await vi.waitFor(() => expectProtectedDetailsCleared(fixture));
  });

it('promotes and then demotes the same member with a fresh id and sequence', async () => {
  const posts: Record<string, unknown>[] = [];
  function fetcher(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = path(input);
    if (url.endsWith('/access')) return Promise.resolve(reply(access));
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      posts.push(body);
      return Promise.resolve(reply({ ...receipt, commandId: body['commandId'],
        newRole: body['newRole'], sequence: posts.length + 2 }));
    }
    if (url.includes('/changes/')) {
      const body = posts.at(-1);
      return Promise.resolve(reply({ ...receipt, commandId: body?.['commandId'],
        newRole: body?.['newRole'], effect: 'role_changed',
        projection: { content: 'current', iam: 'current' } }));
    }
    if (posts.length === 1) return Promise.resolve(reply({ ...member, role: 'admin',
      memberSequence: 3 }));
    if (posts.length === 2) return Promise.resolve(reply({ ...member, memberSequence: 4 }));
    return Promise.resolve(reply(member));
  }
  const fixture = mount(fetcher, ['promote-id', 'demote-id']);
  await vi.waitFor(() => expect(page(fixture).textContent).toContain('Sales team'));
  click(fixture, 'Change role');
  selectAdmin(fixture);
  click(fixture, 'Make Alex Kim an Admin');
  await vi.waitFor(() => expect(page(fixture).textContent).toContain('Alex Kim is now an Admin'));
  click(fixture, 'Change role');
  page(fixture).querySelector<HTMLInputElement>('input[value="member"]')?.click();
  click(fixture, 'Make Alex Kim a Member');
  await vi.waitFor(() => expect(posts).toHaveLength(2));
  expect(posts).toEqual([
    { commandId: 'promote-id', expectedSequence: 2, newRole: 'admin' },
    { commandId: 'demote-id', expectedSequence: 3, newRole: 'member' },
  ]);
});

it('blocks removal while a role outcome is unknown', async () => {
  const writes: string[] = [];
  const removableMember = { ...member, permissions: { ...member.permissions, remove: true } };
  function fetcher(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = path(input);
    if (init?.method === 'POST') {
      writes.push(url);
      return Promise.resolve(new Response(null, { status: 503 }));
    }
    if (url.endsWith('/access')) return Promise.resolve(reply(access));
    return Promise.resolve(reply(removableMember));
  }
  const fixture = mount(fetcher);
  await vi.waitFor(() => expect(page(fixture).textContent).toContain('Sales team'));
  click(fixture, 'Change role');
  selectAdmin(fixture);
  click(fixture, 'Make Alex Kim an Admin');
  await vi.waitFor(() => expect(page(fixture).textContent).toContain('Check status'));
  click(fixture, 'Cancel');
  expect(page(fixture).textContent).toContain('Check status');
  const remove = [...page(fixture).querySelectorAll('button')]
    .find(button => button.textContent?.includes('Remove from'));
  expect(remove?.disabled).toBe(true);
  expect(writes).toEqual(['/api/members/alex-kim/role']);
});

it('blocks changing role while a removal outcome is unknown', async () => {
  const writes: string[] = [];
  const removableMember = { ...member, permissions: { ...member.permissions, remove: true } };
  function fetcher(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = path(input);
    if (init?.method === 'POST') {
      writes.push(url);
      return Promise.resolve(new Response(null, { status: 503 }));
    }
    if (url.endsWith('/access')) return Promise.resolve(reply(access));
    if (url.endsWith('/departure')) return Promise.resolve(reply(departure));
    return Promise.resolve(reply(removableMember));
  }
  const fixture = mount(fetcher);
  await vi.waitFor(() => expect(page(fixture).textContent).toContain('Sales team'));
  click(fixture, 'Remove from the organisation');
  await vi.waitFor(() => expect(page(fixture).textContent).toContain('No shared work'));
  click(fixture, 'Remove Alex Kim');
  await vi.waitFor(() => expect(page(fixture).textContent).toContain('Check status'));
  click(fixture, 'Cancel');
  const changeRole = [...page(fixture).querySelectorAll('button')]
    .find(button => button.textContent?.trim() === 'Change role');
  expect(changeRole?.disabled).toBe(true);
  expect(writes).toEqual(['/api/members/alex-kim/remove']);
});

it('sends one exact role command on a double click, then reads status', async () => {
  const posts: unknown[] = [];
  const paths: string[] = [];
  function fetcher(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = path(input);
    paths.push(url);
    if (url.endsWith('/access')) return Promise.resolve(reply(access));
    if (init?.method === 'POST') {
      if (typeof init.body !== 'string') throw new Error('Expected JSON command body');
      posts.push(JSON.parse(init.body) as unknown);
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

it('keeps the outcome but clears protected rows after a self-demotion reread', async () => {
  const paths: string[] = [];
  let memberReads = 0;
  function fetcher(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = path(input);
    paths.push(url);
    if (url.endsWith('/access')) return Promise.resolve(reply(access));
    if (init?.method === 'POST') return Promise.resolve(reply({ ...receipt, newRole: 'member' }));
    if (url.endsWith('/changes/role-command')) {
      return Promise.resolve(reply({ ...receipt, newRole: 'member', effect: 'role_changed',
        projection: { content: 'current', iam: 'current' } }));
    }
    memberReads += 1;
    if (memberReads > 1) {
      return Promise.resolve(reply({ memberId: member.memberId,
        displayName: member.displayName, role: 'member',
        permissions: { changeRole: false, remove: false, manageOwnership: false } }));
    }
    return Promise.resolve(reply({ ...member, role: 'admin' }));
  }
  const fixture = mount(fetcher);
  await vi.waitFor(() => expect(page(fixture).textContent).toContain('Sales team'));
  click(fixture, 'Change role');
  page(fixture).querySelector<HTMLInputElement>('input[value="member"]')?.click();
  click(fixture, 'Make Alex Kim a Member');
  await vi.waitFor(() => expect(page(fixture).textContent).toContain('Alex Kim is now a Member'));
  await vi.waitFor(() => expect(page(fixture).textContent).not.toContain('alex@example.test'));
  expect(page(fixture).textContent).not.toContain('alex@example.test');
  expect(page(fixture).textContent).not.toContain('Sales team');
  expect(paths.filter(url => url.endsWith('/access'))).toHaveLength(1);
});
