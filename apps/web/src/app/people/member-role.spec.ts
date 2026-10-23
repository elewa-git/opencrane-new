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
  unavailableSections: [], rows: [{ resourceType: 'model', resourceId: 'model-a',
    label: 'Model A', relation: 'use', sources: [{ kind: 'direct', eventId: 'grant-a',
      sequence: 1 }], eligibility: { person: 'allowed', assistants: [],
      availability: 'unavailable' } }] };
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

function findButton(fixture: ComponentFixture<MemberDetailScreen>, label: string):
  HTMLButtonElement | undefined {
  const buttons = [...page(fixture).querySelectorAll('button')];
  for (const button of buttons) {
    const dialog = button.closest('dialog');
    const visible = !dialog || dialog.hasAttribute('open');
    if (visible && button.textContent?.trim() === label) return button;
  }
  return undefined;
}

function click(fixture: ComponentFixture<MemberDetailScreen>, label: string): void {
  const button = findButton(fixture, label);
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

function postedRoleBody(init?: RequestInit): Record<string, unknown> {
  const body = init?.body;
  if (typeof body !== 'string') throw new Error('Expected a JSON request body');
  const parsed: unknown = JSON.parse(body);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || !('commandId' in parsed) || !('expectedSequence' in parsed)
    || !('newRole' in parsed)) throw new Error('Expected a role command');
  return { commandId: parsed.commandId, expectedSequence: parsed.expectedSequence,
    newRole: parsed.newRole };
}

function expectProtectedDetailsCleared(fixture: ComponentFixture<MemberDetailScreen>): void {
  const content = page(fixture).textContent ?? '';
  expect(content).toContain("You no longer have access to this person's details");
  expect(content).not.toContain('Alex Kim');
  expect(content).not.toContain('alex@example.test');
  expect(content).not.toContain('Sales team');
  expect(content).not.toContain('Model A');
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
      const body = postedRoleBody(init);
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
  const remove = findButton(fixture, 'Remove from the organisation');
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
  const changeRole = findButton(fixture, 'Change role');
  expect(changeRole?.disabled).toBe(true);
  click(fixture, 'Remove from the organisation');
  expect(page(fixture).querySelector('dialog[open]')?.textContent).toContain('Check status');
  expect(writes).toEqual(['/api/members/alex-kim/remove']);
});

it.each([400, 409])('uses a fresh id and current sequence after %i', async (status) => {
  const posts: Record<string, unknown>[] = [];
  let memberReads = 0;
  function fetcher(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = path(input);
    if (url.endsWith('/access')) return Promise.resolve(reply(access));
    if (init?.method === 'POST') {
      posts.push(postedRoleBody(init));
      if (posts.length === 1) return Promise.resolve(reply({ reason: 'concurrent_change' }, status));
      return Promise.resolve(reply({ ...receipt, commandId: 'retry-id' }));
    }
    if (url.includes('/changes/')) return Promise.resolve(reply({ ...receipt,
      commandId: 'retry-id', effect: 'role_changed',
      projection: { content: 'applying', iam: 'current' } }));
    memberReads += 1;
    const memberSequence = memberReads > 1 && status === 409 ? 3 : 2;
    return Promise.resolve(reply({ ...member, memberSequence }));
  }
  const fixture = mount(fetcher, ['first-id', 'retry-id']);
  await vi.waitFor(() => expect(page(fixture).textContent).toContain('Sales team'));
  click(fixture, 'Change role');
  selectAdmin(fixture);
  click(fixture, 'Make Alex Kim an Admin');
  const notice = status === 400 ? 'The role change was not sent'
    : 'Nothing was saved. Review the latest member role.';
  await vi.waitFor(() => expect(page(fixture).textContent).toContain(notice));
  click(fixture, 'Change role');
  selectAdmin(fixture);
  click(fixture, 'Make Alex Kim an Admin');
  await vi.waitFor(() => expect(posts).toHaveLength(2));
  expect(posts).toEqual([
    { commandId: 'first-id', expectedSequence: 2, newRole: 'admin' },
    { commandId: 'retry-id', expectedSequence: status === 409 ? 3 : 2,
      newRole: 'admin' },
  ]);
});

it('keeps a rejected network POST on its original id for status only', async () => {
  const writes: string[] = [];
  const paths: string[] = [];
  function fetcher(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = path(input);
    paths.push(url);
    if (url.endsWith('/access')) return Promise.resolve(reply(access));
    if (init?.method === 'POST') {
      writes.push(url);
      return Promise.reject(new Error('network'));
    }
    if (url.includes('/changes/')) return Promise.resolve(reply({ ...receipt,
      effect: 'role_changed', projection: { content: 'applying', iam: 'current' } }));
    return Promise.resolve(reply(member));
  }
  const fixture = mount(fetcher);
  await vi.waitFor(() => expect(page(fixture).textContent).toContain('Sales team'));
  click(fixture, 'Change role');
  selectAdmin(fixture);
  click(fixture, 'Make Alex Kim an Admin');
  await vi.waitFor(() => expect(page(fixture).textContent).toContain('Check status'));
  click(fixture, 'Check status');
  await vi.waitFor(() => expect(paths).toContain('/api/members/alex-kim/changes/role-command'));
  expect(writes).toEqual(['/api/members/alex-kim/role']);
});

it('shows an unchanged outcome and Owners link when the target became an Owner', async () => {
  let memberReads = 0;
  function fetcher(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = path(input);
    if (url.endsWith('/access')) return Promise.resolve(reply(access));
    if (init?.method === 'POST') return Promise.resolve(reply(receipt));
    if (url.includes('/changes/')) return Promise.resolve(reply({ ...receipt,
      effect: 'none_target_became_owner', projection: { content: 'current', iam: 'current' } }));
    memberReads += 1;
    if (memberReads > 1) return Promise.resolve(reply({ ...member, role: 'owner',
      permissions: { ...member.permissions, changeRole: false } }));
    return Promise.resolve(reply(member));
  }
  const fixture = mount(fetcher);
  await vi.waitFor(() => expect(page(fixture).textContent).toContain('Sales team'));
  click(fixture, 'Change role');
  selectAdmin(fixture);
  click(fixture, 'Make Alex Kim an Admin');
  await vi.waitFor(() => expect(page(fixture).textContent).toContain('became an Owner'));
  expect(page(fixture).querySelector('a[href="/org/people/owners"]')).not.toBeNull();
  expect(page(fixture).textContent).not.toContain('is now an Admin');
});

it.each([401, 403])('clears protected detail when the final reread returns %i',
  async (status) => {
    let memberReads = 0;
    function fetcher(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const url = path(input);
      if (url.endsWith('/access')) return Promise.resolve(reply(access));
      if (init?.method === 'POST') return Promise.resolve(reply(receipt));
      if (url.includes('/changes/')) return Promise.resolve(reply({ ...receipt,
        effect: 'role_changed', projection: { content: 'current', iam: 'current' } }));
      memberReads += 1;
      if (memberReads > 1) return Promise.resolve(new Response(null, { status }));
      return Promise.resolve(reply(member));
    }
    const fixture = mount(fetcher);
    await vi.waitFor(() => expect(page(fixture).textContent).toContain('Sales team'));
    click(fixture, 'Change role');
    selectAdmin(fixture);
    click(fixture, 'Make Alex Kim an Admin');
    await vi.waitFor(() => expectProtectedDetailsCleared(fixture));
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

function replacesAndRestoresDialogMethod(method: 'showModal' | 'close'): void {
  const dialogPrototype = HTMLDialogElement.prototype;
  const originalMethod = dialogPrototype[method];
  const replacement = vi.fn();
  const replacementMethods = { [method]: replacement };
  const originalMethods = { [method]: originalMethod };
  const originalDescriptor = { value: originalMethod };
  try {
    Object.assign(dialogPrototype, replacementMethods);
    const dialog = document.createElement('dialog');
    dialog[method]();
    expect(replacement).toHaveBeenCalledOnce();
    Object.assign(dialogPrototype, originalMethods);
    expect(dialogPrototype[method]).toBe(originalMethod);
  } finally {
    Object.defineProperty(dialogPrototype, method, originalDescriptor);
  }
}

it.each(['showModal', 'close'] as const)(
  'lets another spec replace and restore dialog %s', replacesAndRestoresDialogMethod);
