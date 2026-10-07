import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { createGroupCommandSchema } from '@opencrane/protocol';
import { PeopleScreen } from './people-screen';

const sampleGroup = {
  groupId: 'sales-team', name: 'Sales team', membershipSource: 'local', position: 0,
  payingGroupId: 'sales-team', members: [{ memberId: 'alex-kim', displayName: 'Alex Kim',
    membershipSource: 'local' }], access: { source: 'group_membership', conversationAccess: false,
    personalMemoryAccess: false, grants: [] },
};
Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
  configurable: true,
  writable: true,
  value: function showModal(this: HTMLDialogElement): void { this.setAttribute('open', ''); },
});
Object.defineProperty(HTMLDialogElement.prototype, 'close', {
  configurable: true,
  writable: true,
  value: function close(this: HTMLDialogElement): void { this.removeAttribute('open'); },
});
function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
async function mount(body: unknown): Promise<HTMLElement> {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(body)));
  TestBed.configureTestingModule({ imports: [PeopleScreen] });
  const fixture = TestBed.createComponent(PeopleScreen);
  fixture.componentRef.setInput('organisationName', 'Example organisation');
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(rootElement(fixture).textContent).not.toContain('Loading groups…');
  });
  return rootElement(fixture);
}
function rootElement(fixture: ComponentFixture<PeopleScreen>): HTMLElement {
  const element: unknown = fixture.nativeElement;
  if (!(element instanceof HTMLElement)) throw new Error('Expected a screen element');
  return element;
}
type SeenRequest = {
  url: string; method: string; body: string | undefined; signal: AbortSignal | null | undefined;
};
type RequestHandler = (request: SeenRequest) => Response | Promise<Response>;
function makeResponse(body: unknown, status = 200): Response {
  return reply(body, status);
}
async function mountWithFetch(
  handler: RequestHandler,
): Promise<ComponentFixture<PeopleScreen>> {
  vi.stubGlobal('fetch', (input: RequestInfo | URL, options?: RequestInit) => {
    const request: SeenRequest = {
      url: requestUrl(input),
      method: options?.method ?? 'GET',
      body: typeof options?.body === 'string' ? options.body : undefined,
      signal: options?.signal,
    };
    return Promise.resolve(handler(request));
  });
  TestBed.configureTestingModule({ imports: [PeopleScreen] });
  const fixture = TestBed.createComponent(PeopleScreen);
  fixture.componentRef.setInput('organisationName', 'Example organisation');
  fixture.detectChanges();
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(rootElement(fixture).textContent).not.toContain('Loading groups…');
  });
  return fixture;
}
function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof Request) return input.url;
  return input.toString();
}
function parseCreateCommand(body: string | undefined): {
  commandId: string; groupId: string; name: string;
} {
  const raw: unknown = JSON.parse(body ?? '{}');
  const result = createGroupCommandSchema.safeParse(raw);
  if (!result.success) throw new Error('Expected a valid create request');
  return result.data;
}
function button(root: HTMLElement, label: string): HTMLButtonElement {
  const found = [...root.querySelectorAll('button')].find((item) =>
    item.textContent?.trim() === label);
  if (!found) throw new Error(`Expected the ${label} button`);
  return found;
}
async function settle(fixture: ComponentFixture<PeopleScreen>): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    fixture.detectChanges();
    await fixture.whenStable();
  }
}
afterEach(() => vi.unstubAllGlobals());

it('shows typed rows with one link per group and one status region', async () => {
  const root = await mount({ rows: [sampleGroup] });
  const item = root.querySelector('[aria-label="Groups"] li');
  expect(item?.querySelectorAll('a')).toHaveLength(1);
  expect(item?.textContent).toContain('Sales team');
  expect(item?.textContent).toContain('1 member');
  expect(item?.textContent).toContain('Local · managed in OpenCrane');
  expect(root.querySelectorAll('[role="status"]')).toHaveLength(1);
  vi.unstubAllGlobals();
});

it('links from People & groups to the ownership screen', async () => {
  const root = await mount({ rows: [sampleGroup] });
  const ownersLink = root.querySelector<HTMLAnchorElement>('a[href="/org/people/owners"]');
  expect(ownersLink?.textContent?.trim()).toBe('Owners');
});

it('rejects a group that claims access to private conversations', async () => {
  const unsafe = { ...sampleGroup, access: { ...sampleGroup.access, conversationAccess: true } };
  const root = await mount({ rows: [unsafe] });
  expect(root.textContent).toContain('Groups are unavailable right now');
  expect(root.querySelector('[aria-label="Groups"]')).toBeNull();
  expect(button(root, 'Refresh list').disabled).toBe(false);
  vi.unstubAllGlobals();
});

it('shows the empty list and keeps New group available', async () => {
  const root = await mount({ rows: [] });
  expect(root.textContent).toContain('No groups yet');
  expect(root.querySelector('.page-actions .button.primary')?.textContent).toContain('New group');
  vi.unstubAllGlobals();
});

it('blocks a duplicate group name after trimming and ignoring case', async () => {
  const fixture = await mountWithFetch(() => makeResponse({ rows: [sampleGroup] }));
  const root = rootElement(fixture);
  button(root, 'New group').click();
  const field = root.querySelector<HTMLInputElement>('#group-name');
  if (!field) throw new Error('Expected the group name field');
  field.value = ' sales TEAM ';
  field.dispatchEvent(new Event('input', { bubbles: true }));
  fixture.detectChanges();
  expect(button(root, 'Create group').disabled).toBe(true);
  expect(field.getAttribute('aria-invalid')).toBe('true');
  expect(root.textContent).toContain('already exists');
});

it('disables the page actions and clears names after access is refused', async () => {
  const fixture = await mountWithFetch(() => makeResponse({ status: 'refused' }, 403));
  const root = rootElement(fixture);
  expect(root.textContent).toContain('Your access changed');
  expect(button(root, 'Refresh list').disabled).toBe(true);
  expect(button(root, 'New group').disabled).toBe(true);
  expect(root.textContent).not.toContain('Alex Kim');
  expect(root.querySelector('[aria-label="Groups"]')).toBeNull();
});

it('submits with Enter, trims the name and keeps the same command id through the current check',
  async () => {
  const requests: SeenRequest[] = [];
  const fixture = await mountWithFetch((request) => {
    requests.push(request);
    if (request.method === 'POST') {
      return makeResponse({ status: 'appended', groupId: 'finance-id', sequence: 1,
        changeId: 'create-command' });
    }
    if (request.url.includes('/changes/')) {
      return makeResponse({ status: 'appended', groupId: 'finance-id', sequence: 1,
        changeId: 'create-command', projection: { content: 'current', iam: 'current' } });
    }
    return makeResponse({ rows: [sampleGroup] });
  });
  const root = rootElement(fixture);
  button(root, 'New group').click();
  await settle(fixture);
  const field = root.querySelector<HTMLInputElement>('#group-name');
  if (!field) throw new Error('Expected the group name field');
  field.value = ' Finance ';
  field.dispatchEvent(new Event('input', { bubbles: true }));
  await settle(fixture);
  expect(button(root, 'Create group').disabled).toBe(false);
  field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(root.textContent).toContain('Group “Finance” created');
  });
  const post = requests.find((request) => request.method === 'POST');
  expect(post?.body).toBeTruthy();
  const command = parseCreateCommand(post?.body);
  expect(command.name).toBe('Finance');
  const statusRequest = requests.find(isStatusRequest);
  expect(statusRequest?.url.endsWith(`/changes/${command.commandId}`)).toBe(true);
  expect(root.textContent).toContain('Group “Finance” created');
});

it('creates a new group with new ids after the first group is current', async () => {
  const posts: string[] = [];
  const createdGroups = new Map<string, typeof sampleGroup>();
  const fixture = await mountWithFetch((request) => {
    if (request.method === 'POST') {
      const command = parseCreateCommand(request.body);
      posts.push(request.body ?? '');
      createdGroups.set(command.groupId, { ...sampleGroup, groupId: command.groupId,
        name: command.name, members: [] });
      return makeResponse({ status: 'appended', groupId: command.groupId, sequence: 1,
        changeId: command.commandId });
    }
    if (request.url.includes('/changes/')) {
      const command = parseCreateCommand(posts.at(-1));
      return makeResponse({ status: 'appended', groupId: command.groupId, sequence: 1,
        changeId: command.commandId, projection: { content: 'current', iam: 'current' } });
    }
    return makeResponse({ rows: [...createdGroups.values()] });
  });
  const root = rootElement(fixture);

  await createGroup(root, fixture, 'Field team');
  await createGroup(root, fixture, 'Finance');

  const firstCommand = parseCreateCommand(posts[0]);
  const secondCommand = parseCreateCommand(posts[1]);
  expect(secondCommand.name).toBe('Finance');
  expect(secondCommand.commandId).not.toBe(firstCommand.commandId);
  expect(secondCommand.groupId).not.toBe(firstCommand.groupId);
  expect(root.textContent).toContain('Group “Finance” created');
});

async function createGroup(
  root: HTMLElement, fixture: ComponentFixture<PeopleScreen>, name: string,
): Promise<void> {
  button(root, 'New group').click();
  await settle(fixture);
  const field = root.querySelector<HTMLInputElement>('#group-name');
  if (!field) throw new Error('Expected the group name field');
  field.value = name;
  field.dispatchEvent(new Event('input', { bubbles: true }));
  await settle(fixture);
  button(root, 'Create group').click();
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(root.textContent).toContain(`Group “${name}” created`);
  });
}

function isStatusRequest(request: SeenRequest): boolean {
  return request.url.includes('/changes/');
}

it('keeps an unknown create available after opening and cancelling the drawer', async () => {
  const requests: SeenRequest[] = [];
  const createBodies: string[] = [];
  const fixture = await mountWithFetch((request) => {
    requests.push(request);
    if (request.method === 'POST') {
      createBodies.push(request.body ?? '');
      if (createBodies.length === 1) return makeResponse({ status: 'unavailable' }, 503);
      const command = parseCreateCommand(request.body);
      return makeResponse({ status: 'appended', groupId: command.groupId, sequence: 1,
        changeId: command.commandId });
    }
    if (request.url.includes('/changes/')) {
      if (createBodies.length === 1) return makeResponse({ status: 'not_found' }, 404);
      const command = parseCreateCommand(createBodies[0]);
      return makeResponse({ status: 'appended', groupId: command.groupId, sequence: 1,
        changeId: command.commandId, projection: { content: 'current', iam: 'current' } });
    }
    return makeResponse({ rows: [sampleGroup] });
  });
  const root = rootElement(fixture);
  button(root, 'New group').click();
  await settle(fixture);
  const field = root.querySelector<HTMLInputElement>('#group-name');
  if (!field) throw new Error('Expected the group name field');
  field.value = 'Finance';
  field.dispatchEvent(new Event('input', { bubbles: true }));
  await settle(fixture);
  expect(button(root, 'Create group').disabled).toBe(false);
  button(root, 'Create group').click();
  await settle(fixture);
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(root.textContent).toContain('Couldn\'t confirm “Finance” was created');
  });
  expect(root.textContent).toContain('Check its status before sending the same request again.');
  const reference = root.querySelector('p code')?.textContent;
  expect(reference).toBeTruthy();
  expect(root.querySelector('[role="status"] code')?.getAttribute('aria-hidden')).toBe('true');
  const createRequest = requests.find((request) => request.method === 'POST');
  const commandId = parseCreateCommand(createRequest?.body).commandId;
  button(root, 'New group').click();
  await settle(fixture);
  button(root, 'Cancel').click();
  await settle(fixture);
  button(root, 'Check status').click();
  await settle(fixture);
  expect(requests.some((request) => request.url.endsWith(`/changes/${commandId}`))).toBe(true);
  expect(root.textContent).toContain('No record of this change yet. It may still arrive.');
  button(root, 'Send the same request again').click();
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(root.textContent).toContain('Group “Finance” created');
  });
  expect(createBodies[1]).toBe(createBodies[0]);
});

it('shows a refused resend in the status area after a not-found check', async () => {
  let postCount = 0;
  const fixture = await mountWithFetch((request) => {
    if (request.method === 'POST') {
      postCount += 1;
      if (postCount === 1) return makeResponse({ status: 'unavailable' }, 503);
      return makeResponse({ status: 'conflict' }, 409);
    }
    if (request.url.includes('/changes/')) {
      return makeResponse({ status: 'not_found' }, 404);
    }
    return makeResponse({ rows: [sampleGroup] });
  });
  const root = rootElement(fixture);
  button(root, 'New group').click();
  await settle(fixture);
  const field = root.querySelector<HTMLInputElement>('#group-name');
  if (!field) throw new Error('Expected the group name field');
  field.value = 'Finance';
  field.dispatchEvent(new Event('input', { bubbles: true }));
  await settle(fixture);
  button(root, 'Create group').click();
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(root.textContent).toContain('Couldn\'t confirm “Finance” was created');
  });
  button(root, 'Check status').click();
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(root.textContent).toContain('No record of this change yet. It may still arrive.');
  });

  button(root, 'Send the same request again').click();
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(root.textContent).toContain('This group changed or already exists. Nothing was created.');
  });

  expect(postCount).toBe(2);
  expect(root.querySelector('[role="status"] button')).toBeNull();
  expect(root.textContent).not.toContain('Check its status before sending');
});

it('keeps the current status while refreshing a healthy list', async () => {
  const requests: SeenRequest[] = [];
  let releaseRefresh: ((response: Response) => void) | undefined;
  const fixture = await mountWithFetch((request) => {
    requests.push(request);
    if (requests.length === 1) return Promise.resolve(makeResponse({ rows: [sampleGroup] }));
    return new Promise((resolve) => { releaseRefresh = resolve; });
  });
  const root = rootElement(fixture);
  button(root, 'Refresh list').click();
  fixture.detectChanges();
  expect(button(root, 'Refreshing…').disabled).toBe(true);
  expect(root.textContent).not.toContain("We couldn't refresh groups");
  expect(root.querySelector('#people-panel')?.getAttribute('aria-busy')).toBe('true');
  releaseRefresh?.(makeResponse({ rows: [sampleGroup] }));
  await settle(fixture);
  expect(root.textContent).not.toContain("We couldn't refresh groups");
  expect(root.textContent).toContain('Sales team');
});

it('shows neutral status after a failed list read succeeds on retry', async () => {
  let reads = 0;
  const fixture = await mountWithFetch(() => {
    reads += 1;
    if (reads === 1) return makeResponse({ status: 'unavailable' }, 503);
    return makeResponse({ rows: [sampleGroup] });
  });
  const root = rootElement(fixture);
  expect(root.textContent).toContain('Groups are unavailable right now');
  button(root, 'Try again').click();
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(root.textContent).toContain('Groups loaded');
  });
  expect(root.textContent).not.toContain('Groups are unavailable right now');
});

it('clears loaded rows when a later refresh shows that access has changed', async () => {
  let reads = 0;
  const fixture = await mountWithFetch(() => {
    reads += 1;
    if (reads === 1) return makeResponse({ rows: [sampleGroup] });
    return makeResponse({ status: 'refused' }, 403);
  });
  const root = rootElement(fixture);
  expect(root.textContent).toContain('Sales team');

  button(root, 'Refresh list').click();
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(root.textContent).toContain('Your access changed');
  });

  expect(root.textContent).not.toContain('Sales team');
  expect(root.querySelector('[aria-label="Groups"]')).toBeNull();
});

it('keeps a confirmed create message when the list reread fails', async () => {
  let reads = 0;
  let createdCommand: ReturnType<typeof parseCreateCommand> | undefined;
  const fixture = await mountWithFetch((request) => {
    if (request.method === 'POST') {
      createdCommand = parseCreateCommand(request.body);
      return makeResponse({ status: 'appended', groupId: createdCommand.groupId, sequence: 1,
        changeId: createdCommand.commandId });
    }
    if (request.url.includes('/changes/')) {
      const command = createdCommand;
      if (!command) throw new Error('Expected the create command before its status read');
      return makeResponse({ status: 'appended', groupId: command.groupId, sequence: 1,
        changeId: command.commandId, projection: { content: 'current', iam: 'current' } });
    }
    reads += 1;
    if (reads === 1) return makeResponse({ rows: [sampleGroup] });
    return makeResponse({ status: 'unavailable' }, 503);
  });
  const root = rootElement(fixture);

  await createGroup(root, fixture, 'Finance');

  expect(root.textContent).toContain('Group “Finance” created');
  expect(root.textContent).toContain("We couldn't refresh groups");
});

it('ignores a late current status reply after access is refused', async () => {
  let releaseStatus: ((response: Response) => void) | undefined;
  let listReads = 0;
  const fixture = await mountWithFetch((request) => {
    if (request.method === 'POST') {
      const command = parseCreateCommand(request.body);
      return makeResponse({ status: 'appended', groupId: command.groupId, sequence: 1,
        changeId: command.commandId });
    }
    if (request.url.includes('/changes/')) {
      return new Promise((resolve) => { releaseStatus = resolve; });
    }
    if (request.url === '/api/groups') {
      listReads += 1;
      if (listReads === 1) return makeResponse({ rows: [sampleGroup] });
    }
    return makeResponse({ status: 'refused' }, 401);
  });
  const root = rootElement(fixture);
  button(root, 'New group').click();
  await settle(fixture);
  const field = root.querySelector<HTMLInputElement>('#group-name');
  if (!field) throw new Error('Expected the group name field');
  field.value = 'Finance';
  field.dispatchEvent(new Event('input', { bubbles: true }));
  await settle(fixture);
  button(root, 'Create group').click();
  await vi.waitFor(() => expect(releaseStatus).toBeDefined());

  button(root, 'Refresh list').click();
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(root.textContent).toContain('Your access changed');
  });
  releaseStatus?.(makeResponse({ status: 'appended', groupId: 'finance-id', sequence: 1,
    changeId: 'late-command', projection: { content: 'current', iam: 'current' } }));
  await settle(fixture);

  expect(root.textContent).toContain('Your access changed');
  expect(root.textContent).not.toContain('Finance');
  expect(root.querySelector('[aria-label="Groups"]')).toBeNull();
});

it('aborts an in-progress create poll when the screen is destroyed', async () => {
  let releaseStatus: ((response: Response) => void) | undefined;
  let statusSignal: AbortSignal | null | undefined;
  const statusReads: string[] = [];
  const fixture = await mountWithFetch((request) => {
    if (request.method === 'POST') {
      const command = parseCreateCommand(request.body);
      return makeResponse({ status: 'appended', groupId: command.groupId, sequence: 1,
        changeId: command.commandId });
    }
    if (request.url.includes('/changes/')) {
      statusReads.push(request.url);
      statusSignal = request.signal;
      return new Promise((resolve) => { releaseStatus = resolve; });
    }
    return makeResponse({ rows: [sampleGroup] });
  });
  const root = rootElement(fixture);
  button(root, 'New group').click();
  await settle(fixture);
  const field = root.querySelector<HTMLInputElement>('#group-name');
  if (!field) throw new Error('Expected the group name field');
  field.value = 'Finance';
  field.dispatchEvent(new Event('input', { bubbles: true }));
  await settle(fixture);
  button(root, 'Create group').click();
  await vi.waitFor(() => expect(releaseStatus).toBeDefined());

  fixture.destroy();
  expect(statusSignal?.aborted).toBe(true);
  releaseStatus?.(makeResponse({ status: 'appended', groupId: 'finance-id', sequence: 1,
    changeId: 'late-command', projection: { content: 'applying', iam: 'applying' } }));
  await Promise.resolve();
  await Promise.resolve();

  expect(statusReads).toHaveLength(1);
});
