import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { afterEach, expect, it, vi } from 'vitest';
import { GroupDetailScreen } from './group-detail-screen';
import { GroupDetail } from './group-detail';

const group = {
  groupId: 'sales-team', name: 'Sales team', membershipSource: 'local', position: 0,
  payingGroupId: 'sales-team', members: [
    { memberId: 'alex-kim', displayName: 'Alex Kim', membershipSource: 'local' },
    { memberId: 'marieke-vos', displayName: 'Marieke Vos', membershipSource: 'identity_provider' },
  ], access: { source: 'group_membership', conversationAccess: false,
    personalMemoryAccess: false, grants: [
      { resourceType: 'model', resourceId: 'model-a', relation: 'use' },
      { resourceType: 'assistant', resourceId: 'assistant-a', relation: 'acts_for' },
    ] },
};
const suppliedGroup = { ...group, groupId: 'identity-provider-group',
  membershipSource: 'identity_provider' };
const dialogPrototype = globalThis.HTMLDialogElement.prototype;

function closeDialog(this: HTMLDialogElement): void {
  this.removeAttribute('open');
}
function showDialog(this: HTMLDialogElement): void {
  this.setAttribute('open', '');
}

Object.defineProperty(dialogPrototype, 'close', {
  configurable: true, writable: true, value: closeDialog,
});
Object.defineProperty(dialogPrototype, 'showModal', {
  configurable: true, writable: true, value: showDialog,
});
function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}
async function mount(reply: Response, groupId = 'sales-team'): Promise<HTMLElement> {
  const fixture = await mountWithFetch(replyOnce(reply), groupId);
  return rootElement(fixture);
}
type SeenRequest = {
  url: string; method: string | undefined; body: string | undefined;
  signal: AbortSignal | null | undefined;
};
function replyOnce(reply: Response): typeof fetch {
  return makeFetch([reply], []);
}
function makeFetch(responses: Response[], calls: SeenRequest[]): typeof fetch {
  return function returnResponse(input: RequestInfo | URL, options?: RequestInit): Promise<Response> {
    const url = requestUrl(input);
    const method = options?.method;
    const body = typeof options?.body === 'string' ? options.body : undefined;
    calls.push({ url, method, body, signal: options?.signal });
    const next = responses.shift();
    if (!next) return Promise.resolve(response({ status: 'unavailable' }, 503));
    return Promise.resolve(next);
  };
}
function requestUrl(input: RequestInfo | URL): string {
  if (input instanceof Request) return input.url;
  return String(input);
}
async function mountWithFetch(
  fetcher: typeof fetch, groupId = 'sales-team',
): Promise<ComponentFixture<GroupDetailScreen>> {
  vi.stubGlobal('fetch', fetcher);
  TestBed.configureTestingModule({ imports: [GroupDetailScreen] });
  const fixture = TestBed.createComponent(GroupDetailScreen);
  fixture.componentRef.setInput('groupId', groupId);
  fixture.detectChanges();
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(rootElement(fixture).textContent).not.toContain('Loading group…');
  });
  return fixture;
}
function rootElement(fixture: ComponentFixture<GroupDetailScreen>): HTMLElement {
  const element: unknown = fixture.nativeElement;
  if (!(element instanceof HTMLElement)) throw new Error('Expected a detail screen element');
  return element;
}
afterEach(() => vi.unstubAllGlobals());

it('opens member search from the local group header and keeps supplied groups locked', async () => {
  const local = await mount(response({ rows: [group] }));
  expect(local.querySelector('header.detail-heading .button.primary')?.textContent)
    .toContain('Add members');
  findButton(local, 'Add members').click();
  expect(local.textContent).toContain('Add people to Sales team');
  expect(local.textContent).toContain('Only active members of your organisation appear.');
  expect(globalThis.document.activeElement?.tagName).toBe('INPUT');
  const supplied = await mount(response({ rows: [suppliedGroup] }), suppliedGroup.groupId);
  expect(supplied.textContent).toContain('Membership comes from your identity provider');
  expect([...supplied.querySelectorAll('button')].some((button) =>
    button.textContent?.trim() === 'Add members')).toBe(false);
});

it('adds one person and waits for both records before showing Added', async () => {
  const directory = { rows: [{ memberId: 'bob', displayName: 'Bob', email: 'bob@example.test',
    role: 'member', status: 'joined', joinedAt: '2026-10-01T00:00:00.000Z', groups: [] }],
    next: null, counts: { members: { status: 'current', value: 1 },
      groups: { status: 'current', value: 1 },
      pendingInvitations: { status: 'current', value: 0 },
      acceptedInvitations: { status: 'current', value: 0 } },
    checkedAt: '2026-10-01T00:00:00.000Z', projection: { content: 'current' },
    permissions: { invite: true } };
  const replies = [response({ rows: [group] }), response(directory),
    response({ status: 'appended', groupId: group.groupId, sequence: 1, changeId: 'change' }),
    response({ status: 'appended', groupId: group.groupId, sequence: 1, changeId: 'change',
      projection: { content: 'current', iam: 'current' } }),
    response({ rows: [{ ...group, members: [...group.members,
      { memberId: 'bob', displayName: 'Bob', membershipSource: 'local' }] }] })];
  const calls: SeenRequest[] = [];
  const fixture = await mountWithFetch(makeFetch(replies, calls));
  const root = rootElement(fixture);
  findButton(root, 'Add members').click();
  fixture.detectChanges();
  const field = root.querySelector<HTMLInputElement>('input[placeholder="Search name or email"]');
  if (!field) throw new Error('Expected the member search field');
  field.value = 'Bob';
  field.dispatchEvent(new Event('input', { bubbles: true }));
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(root.textContent).toContain('No groups');
  });
  findButton(root, 'Add').click();
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(root.textContent).toContain('Added Bob to Sales team');
  });
  expect(calls.filter(isPostRequest)).toHaveLength(1);
  expect(calls.find(isPostRequest)?.body).toMatch(
    /^\{"action":"add","commandId":"[^"]+","memberId":"bob"\}$/u);
  expect(root.textContent).toContain('Already a member');
});

it('lets admins create a shared assistant for an identity-provider group', async () => {
  const root = await mount(response({ rows: [suppliedGroup] }), suppliedGroup.groupId);
  const link = root.querySelector<HTMLAnchorElement>('a.button.primary');
  expect(link?.textContent?.trim()).toBe('Create shared assistant');
  expect(link?.getAttribute('href')).toBe(
    '/org/people/groups/identity-provider-group/assistants/new');
});

it('shows one detail heading and one skeleton while the group is loading', async () => {
  let releaseGroup: ((reply: Response) => void) | undefined;
  vi.stubGlobal('fetch', () => new Promise((resolve) => { releaseGroup = resolve; }));
  TestBed.configureTestingModule({ imports: [GroupDetailScreen] });
  const fixture = TestBed.createComponent(GroupDetailScreen);
  fixture.componentRef.setInput('groupId', 'sales-team');
  fixture.detectChanges();
  const root = rootElement(fixture);

  expect(root.querySelectorAll('header.detail-heading')).toHaveLength(1);
  expect(root.querySelectorAll('.detail-skeleton')).toHaveLength(1);

  releaseGroup?.(response({ rows: [group] }));
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(root.textContent).not.toContain('Loading group…');
  });
});

it('shows separate shared-assistant and use-grant cards with a local Remove button', async () => {
  const root = await mount(response({ rows: [group] }));
  expect(root.textContent).toContain('assistant-a');
  expect(root.textContent).toContain('Works for this group');
  expect(root.textContent).toContain('Can use model model-a');
  expect(root.querySelectorAll('button[aria-label="Remove Alex Kim from Sales team"]'))
    .toHaveLength(1);
  expect(root.textContent?.indexOf('Alex Kim')).toBeLessThan(root.textContent?.indexOf('Marieke Vos'));
});

it('clears a protected group after access is refused', async () => {
  const root = await mount(response({ status: 'refused' }, 403));
  expect(root.querySelector('h1')?.textContent).toBe('Group details');
  expect(root.textContent).toContain('Your access changed');
  expect(root.textContent).not.toContain('Sales team');
  expect(root.textContent).not.toContain('Alex Kim');
});

it('shows an explicit empty state when a group has no members', async () => {
  const emptyGroup = { ...group, members: [], access: { ...group.access, grants: [] } };
  const root = await mount(response({ rows: [emptyGroup] }));
  expect(root.textContent).toContain('No members yet');
  expect(root.querySelector('ul.members')).toBeNull();
});

it('shows a safe retry action when the group read is unavailable', async () => {
  const root = await mount(response({ status: 'unavailable' }, 503));
  expect(root.textContent).toContain('Groups are unavailable right now');
  expect(root.textContent).toContain('Nothing changed. Reading again is safe.');
  expect(root.querySelector('[aria-label^="Remove "]')).toBeNull();
});

it('offers removal only for a local person in a local group', async () => {
  const root = await mount(response({ rows: [group] }));
  expect(root.querySelectorAll('button[aria-label^="Remove Alex Kim"]')).toHaveLength(1);
  expect(root.querySelectorAll('button[aria-label^="Remove Marieke Vos"]')).toHaveLength(0);
});

it('shows the review with the grants and private-data notes before sending', async () => {
  const fixture = await mountWithFetch(replyOnce(response({ rows: [group] })));
  const root = rootElement(fixture);
  const removeButton = root.querySelector<HTMLButtonElement>(
    'button[aria-label="Remove Alex Kim from Sales team"]');
  if (!removeButton) throw new Error('Expected the local member Remove button');
  const detailElement = fixture.debugElement.query(By.directive(GroupDetail));
  const detail = detailElement.injector.get(GroupDetail);
  const removeRequested = vi.spyOn(detail.removeRequested, 'emit');
  expect(removeButton.disabled).toBe(false);
  removeButton.click();
  fixture.detectChanges();
  expect(removeRequested).toHaveBeenCalled();
  await fixture.whenStable();
  fixture.detectChanges();
  expect(root.querySelector('dialog')?.open).toBe(true);
  expect(root.textContent).toContain('Remove Alex Kim from Sales team?');
  expect(root.textContent).toContain('Alex Kim loses use of model model-a, granted through Sales team.');
  expect(root.textContent).toContain('Alex Kim can no longer select assistant assistant-a.');
  expect(root.textContent).toContain('Access from other groups stays.');
  expect(root.textContent).toContain("Alex Kim's private conversations and memory aren't affected or revealed.");
});

it('sends the strict removal body and waits for both records before removing the row', async () => {
  const suppliedMember = group.members[1];
  if (!suppliedMember) throw new Error('Expected the supplied member fixture');
  const changedGroup = { ...group, members: [suppliedMember] };
  const replies = [
    response({ rows: [group] }),
    response({ status: 'appended', groupId: group.groupId, sequence: 1, changeId: 'change' }),
    response({ status: 'appended', groupId: group.groupId, sequence: 1, changeId: 'change',
      projection: { content: 'applying', iam: 'current' } }),
    response({ status: 'appended', groupId: group.groupId, sequence: 1, changeId: 'change',
      projection: { content: 'current', iam: 'current' } }),
    response({ rows: [changedGroup] }),
  ];
  const calls: SeenRequest[] = [];
  const fixture = await mountWithFetch(makeFetch(replies, calls));
  const root = rootElement(fixture);
  const removeButton = root.querySelector<HTMLButtonElement>(
    'button[aria-label="Remove Alex Kim from Sales team"]');
  if (!removeButton) throw new Error('Expected the local member Remove button');
  removeButton.click();
  fixture.detectChanges();
  await fixture.whenStable();
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect([...root.querySelectorAll('button')].some(isConfirmButton), root.textContent).toBe(true);
  });
  const confirm = [...root.querySelectorAll('button')].find(isConfirmButton);
  if (!confirm) throw new Error('Expected the removal confirmation button');
  confirm.click();
  fixture.detectChanges();
  await vi.waitFor(() => expect(calls.filter(isStatusRead)).toHaveLength(1));
  expect(root.textContent).toContain('Alex Kim');
  expect(root.textContent).not.toContain('Removed Alex Kim from Sales team');
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(root.textContent).toContain('Removed Alex Kim from Sales team');
  });
  expect(root.textContent).not.toContain('Alex Kimalex-kim');
  await vi.waitFor(() => expect(root.querySelector('h1') === globalThis.document.activeElement).toBe(true));
  const post = calls.find(isPostRequest);
  expect(post?.body).toMatch(/^\{"action":"remove","commandId":"[^"]+","memberId":"alex-kim"\}$/u);
  expect(post?.body).not.toContain('groupId');
});

it('checks an unknown removal with reads, then resends the same body after not found', async () => {
  const suppliedMember = group.members[1];
  if (!suppliedMember) throw new Error('Expected the supplied member fixture');
  const changedGroup = { ...group, members: [suppliedMember] };
  const replies = [
    response({ rows: [group] }), response({ status: 'unavailable' }, 503),
    response({ status: 'not_found' }, 404),
    response({ status: 'appended', groupId: group.groupId, sequence: 1, changeId: 'change' }),
    response({ status: 'appended', groupId: group.groupId, sequence: 1, changeId: 'change',
      projection: { content: 'current', iam: 'current' } }),
    response({ rows: [changedGroup] }),
  ];
  const calls: SeenRequest[] = [];
  const fixture = await mountWithFetch(makeFetch(replies, calls));
  const root = rootElement(fixture);
  await openAndConfirmRemoval(root, fixture);
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(root.textContent).toContain("Couldn't confirm the removal");
  });
  const statusRegions = root.querySelectorAll('[role="status"]');
  expect(statusRegions).toHaveLength(1);
  expect(statusRegions[0]?.textContent).toContain("Couldn't confirm the removal");
  const checkButton = findButton(root, 'Check status');
  checkButton.click();
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(root.textContent).toContain('No record of this change yet. It may still arrive.');
  });
  expect(calls.filter(isPostRequest)).toHaveLength(1);
  findButton(root, 'Send the same request again').click();
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(root.textContent).toContain('Removed Alex Kim from Sales team');
  });
  const posts = calls.filter(isPostRequest);
  expect(posts).toHaveLength(2);
  expect(posts[0]?.body).toBe(posts[1]?.body);
  expect(calls.filter(isGetRequest).length).toBeGreaterThan(0);
});

it('keeps a lost removal reply unknown when its status read is unavailable', async () => {
  const replies = [response({ rows: [group] }), response({ status: 'unavailable' }, 503),
    response({ status: 'unavailable' }, 503)];
  const fixture = await mountWithFetch(makeFetch(replies, []));
  const root = rootElement(fixture);
  await openAndConfirmRemoval(root, fixture);
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(root.textContent).toContain("Couldn't confirm the removal");
  });
  findButton(root, 'Check status').click();
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(root.textContent).toContain("Couldn't confirm the removal");
  });
  expect(root.textContent).not.toContain('Still applying the removal');
});

it('stops a removal status read when the detail screen is destroyed', async () => {
  let releaseStatus: ((reply: Response) => void) | undefined;
  let statusSignal: AbortSignal | null | undefined;
  let statusReads = 0;
  const fixture = await mountWithFetch((input, options) => {
    const url = requestUrl(input);
    const method = options?.method;
    if (url.includes('/changes/')) {
      statusReads += 1;
      statusSignal = options?.signal;
      return new Promise((resolve) => { releaseStatus = resolve; });
    }
    if (method === 'POST') {
      return Promise.resolve(response({ status: 'appended', groupId: group.groupId,
        sequence: 1, changeId: 'remove-command' }));
    }
    return Promise.resolve(response({ rows: [group] }));
  });
  const root = rootElement(fixture);

  await openAndConfirmRemoval(root, fixture);
  await vi.waitFor(() => expect(statusReads).toBe(1));
  expect(root.querySelectorAll('button').length).toBeGreaterThan(0);
  expect([...root.querySelectorAll<HTMLButtonElement>('button')]
    .some((button) => button.textContent?.trim() === 'Check status')).toBe(false);

  fixture.destroy();
  expect(statusSignal?.aborted).toBe(true);
  releaseStatus?.(response({ status: 'appended', groupId: group.groupId,
    sequence: 1, changeId: 'remove-command',
    projection: { content: 'applying', iam: 'applying' } }));
  await Promise.resolve();
  await Promise.resolve();

  expect(statusReads).toBe(1);
});

it('keeps a pending removal and rejects another review when its request was accepted', async () => {
  await keepPendingRemovalSeparateFromReviewDraft(200);
});

it('keeps a removal after opening and cancelling another review when its reply was lost', async () => {
  await keepPendingRemovalSeparateFromReviewDraft(503);
});

async function keepPendingRemovalSeparateFromReviewDraft(postStatus: number): Promise<void> {
  const secondLocalMember = { memberId: 'bob-kim', displayName: 'Bob Kim',
    membershipSource: 'local' as const };
  const reviewGroup = { ...group, members: [...group.members, secondLocalMember] };
  const changedGroup = { ...reviewGroup, members: [group.members[1], secondLocalMember] };
  function acceptedReceipt(): Response {
    return response({ status: 'appended', groupId: group.groupId,
      sequence: 1, changeId: 'change-a' });
  }
  const replies = [response({ rows: [reviewGroup] })];
  if (postStatus === 200) {
    replies.push(acceptedReceipt(), response({ status: 'unavailable' }, 503));
  } else {
    replies.push(response({ status: 'unavailable' }, 503));
  }
  replies.push(response({ status: 'not_found' }, 404), acceptedReceipt(),
    response({ status: 'appended', groupId: group.groupId, sequence: 1,
      changeId: 'change-a', projection: { content: 'current', iam: 'current' } }),
    response({ rows: [changedGroup] }));
  const calls: SeenRequest[] = [];
  const fixture = await mountWithFetch(makeFetch(replies, calls));
  const root = rootElement(fixture);
  await openAndConfirmRemoval(root, fixture);
  const pendingStatus = postStatus === 200 ? 'Still applying the removal for Alex Kim'
    : "Couldn't confirm the removal";
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(root.textContent).toContain(pendingStatus);
  });
  for (const button of root.querySelectorAll<HTMLButtonElement>(
    'button[aria-label^="Remove "]')) {
    expect(button.disabled).toBe(true);
  }
  expect(root.textContent).toContain(
    'A removal is in progress. Check its status before starting another one.',
  );

  const detailElement = fixture.debugElement.query(By.directive(GroupDetail));
  const detail = detailElement.injector.get(GroupDetail);
  const opener = root.querySelector<HTMLButtonElement>(
    'button[aria-label="Remove Alex Kim from Sales team"]');
  if (!opener) throw new Error('Expected a removal button in the review fixture');
  detail.removeRequested.emit({ member: secondLocalMember, opener });
  fixture.detectChanges();
  expect(root.textContent).toContain(pendingStatus);
  expect(root.querySelector('[role="dialog"]')).toBeNull();
  findButton(root, 'Check status').click();
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(root.textContent).toContain('No record of this change yet. It may still arrive.');
  });
  const statusRead = calls.find(isStatusRead);
  const firstPost = calls.find(isPostRequest);
  const commandId = /"commandId":"([^"]+)"/u.exec(firstPost?.body ?? '')?.[1];
  expect(commandId).toBeDefined();
  expect(statusRead?.url).toContain(`/changes/${commandId}`);
  findButton(root, 'Send the same request again').click();
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(root.textContent).toContain('Removed Alex Kim from Sales team');
  });
  const posts = calls.filter(isPostRequest);
  expect(posts).toHaveLength(2);
  expect(posts.every((post) => post.body?.includes('"memberId":"alex-kim"'))).toBe(true);
  expect(posts[1]?.body).toBe(posts[0]?.body);
  expect(calls.some((call) => call.url.includes('change-b'))).toBe(false);
}

function isStatusRead(request: SeenRequest): boolean {
  return request.method !== 'POST' && request.url.includes('/changes/');
}

it('refreshes the group after a removal conflict and moves focus to the heading', async () => {
  const replies = [response({ rows: [group] }), response({ status: 'refused' }, 409),
    response({ rows: [group] })];
  const fixture = await mountWithFetch(makeFetch(replies, []));
  const root = rootElement(fixture);
  await openAndConfirmRemoval(root, fixture);
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(root.textContent).toContain('Membership changed while you were looking');
  });
  findButton(root, 'Refresh').click();
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(root.textContent).toContain('Group loaded');
  });
  await vi.waitFor(() => expect(root.querySelector('h1') === globalThis.document.activeElement).toBe(true));
});

it('clears the group when a refused POST is followed by a refused read', async () => {
  const replies = [response({ rows: [group] }), response({ status: 'refused' }, 403),
    response({ status: 'refused' }, 403)];
  const fixture = await mountWithFetch(makeFetch(replies, []));
  const root = rootElement(fixture);
  await openAndConfirmRemoval(root, fixture);
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(root.textContent).toContain('Your access changed');
  });
  expect(root.querySelector('h1')?.textContent).toBe('Group details');
  expect(root.textContent).not.toContain('Alex Kim');
  expect(root.textContent).not.toContain('Sales team');
});

it('uses a successful reread after a refused removal', async () => {
  const changedGroup = { ...group, members: [group.members[1]] };
  const replies = [response({ rows: [group] }), response({ status: 'refused' }, 403),
    response({ rows: [changedGroup] })];
  const fixture = await mountWithFetch(makeFetch(replies, []));
  const root = rootElement(fixture);
  await openAndConfirmRemoval(root, fixture);
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(root.textContent).toContain('This removal was refused. Nothing changed.');
  });
  expect(root.textContent).not.toContain('Alex Kim');
  expect(root.textContent).toContain('Marieke Vos');
  expect(root.querySelectorAll('button[aria-label^="Remove "]')).toHaveLength(0);
});

it('shows the not-found state after refreshing a removal notice', async () => {
  const replies = [response({ rows: [group] }), response({ status: 'refused' }, 409),
    response({ rows: [] })];
  const fixture = await mountWithFetch(makeFetch(replies, []));
  const root = rootElement(fixture);
  await openAndConfirmRemoval(root, fixture);
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(root.textContent).toContain('Membership changed while you were looking');
  });
  findButton(root, 'Refresh').click();
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(root.querySelector('h1')?.textContent).toBe('Group not found');
  });
  expect(root.textContent).not.toContain('Group loaded');
});

function isConfirmButton(button: HTMLButtonElement): boolean {
  return button.textContent?.includes('Remove Alex Kim from Sales team') ?? false;
}
function isPostRequest(request: SeenRequest): boolean { return request.method === 'POST'; }
function isGetRequest(request: SeenRequest): boolean { return request.method !== 'POST'; }
async function openAndConfirmRemoval(root: HTMLElement, fixture: ComponentFixture<GroupDetailScreen>): Promise<void> {
  const removeButton = root.querySelector<HTMLButtonElement>(
    'button[aria-label="Remove Alex Kim from Sales team"]');
  if (!removeButton) throw new Error('Expected the local member Remove button');
  removeButton.click();
  fixture.detectChanges();
  await fixture.whenStable();
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect([...root.querySelectorAll('button')].some(isConfirmButton)).toBe(true);
  });
  const confirm = [...root.querySelectorAll('button')].find(isConfirmButton);
  if (!confirm) throw new Error('Expected the removal confirmation button');
  confirm.click();
  fixture.detectChanges();
}
function findButton(root: HTMLElement, label: string): HTMLButtonElement {
  const buttons = [...root.querySelectorAll('button')];
  for (const button of buttons) {
    if (button.textContent?.trim() === label) return button;
  }
  throw new Error(`Expected the ${label} button`);
}
