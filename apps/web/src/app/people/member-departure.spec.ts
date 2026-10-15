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

function showDialog(this: HTMLDialogElement): void {
  this.setAttribute('open', '');
}

function closeDialog(this: HTMLDialogElement): void {
  this.removeAttribute('open');
  this.dispatchEvent(new Event('close'));
}

function mount(fetcher: typeof fetch): ComponentFixture<MemberDetailScreen> {
  vi.stubGlobal('fetch', fetcher);
  TestBed.configureTestingModule({ imports: [MemberDetailScreen] });
  const fixture = TestBed.createComponent(MemberDetailScreen);
  const element: unknown = fixture.nativeElement;
  if (!(element instanceof HTMLElement)) throw new Error('Expected a member detail page');
  const dialog = element.querySelector('dialog');
  if (!dialog) throw new Error('Expected a departure drawer');
  Object.defineProperty(dialog, 'showModal', { configurable: true, value: showDialog });
  Object.defineProperty(dialog, 'close', { configurable: true, value: closeDialog });
  fixture.componentRef.setInput('memberId', 'alex');
  fixture.detectChanges();
  return fixture;
}

function page(fixture: ComponentFixture<MemberDetailScreen>): HTMLElement {
  fixture.detectChanges();
  const element: unknown = fixture.nativeElement;
  if (!(element instanceof HTMLElement)) throw new Error('Expected a member detail page');
  return element;
}

function postedCommandId(init?: RequestInit): string {
  if (typeof init?.body !== 'string') throw new Error('Expected JSON request body');
  const body: unknown = JSON.parse(init.body);
  if (typeof body !== 'object' || body === null || !('commandId' in body)
      || typeof body.commandId !== 'string') throw new Error('Expected command id');
  return body.commandId;
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

it('sends owners to step-down without a Remove control', async () => {
  function fetcher(input: RequestInfo | URL): Promise<Response> {
    if (url(input).endsWith('/access')) return Promise.resolve(response(access));
    return Promise.resolve(response({ ...member, role: 'owner' }));
  }
  const fixture = mount(fetcher);
  await vi.waitFor(() => expect(page(fixture).textContent).toContain('Alex Kim'));
  expect(page(fixture).querySelector('a[href="/org/people/owners"]')).not.toBeNull();
  expect(page(fixture).querySelector('button.destructive')).toBeNull();
});

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

it.each(['absent_on_version', 'unsupported_history', 'unavailable'] as const)(
  'shows routine and connection status messages for %s', async (status) => {
  const review = { ...departure,
    routines: { status, message: 'Routine check result' },
    personalConnections: { status, message: 'Connection check result' } };
  function fetcher(input: RequestInfo | URL): Promise<Response> {
    if (url(input).endsWith('/departure')) return Promise.resolve(response(review));
    return baseFetch(input);
  }
  const fixture = mount(fetcher);
  await open(fixture);
  await vi.waitFor(() => expect(page(fixture).textContent).toContain('Routine check result'));
  expect(page(fixture).textContent).toContain('Connection check result');
  expect(page(fixture).textContent).not.toContain('absent_on_version');
  expect(page(fixture).textContent).not.toContain('unsupported_history');
  expect(page(fixture).textContent).toContain('private chats stay private');
  });

it('names organisation and group membership even when no resources are listed', async () => {
  const group = { groupId: 'design', name: 'Design', membershipSource: 'local' };
  function fetcher(input: RequestInfo | URL): Promise<Response> {
    const path = url(input);
    if (path.endsWith('/departure')) return Promise.resolve(response(departure));
    if (path.endsWith('/access')) return Promise.resolve(response(access));
    return Promise.resolve(response({ ...member, groups: [group] }));
  }
  const fixture = mount(fetcher);
  await open(fixture);
  await vi.waitFor(() => expect(page(fixture).textContent).toContain('No shared work'));
  const drawer = page(fixture).querySelector('dialog');
  expect(drawer?.textContent).toContain('Organisation membership ends');
  expect(drawer?.textContent).toContain('Design');
  expect(drawer?.textContent).toContain('No tools or shared assistants to hand over');
  expect(drawer?.textContent).not.toContain('No recorded access to lose');
});

it('shows a recorded personal computer before removal and its unreported clean-up after',
  async () => {
    const computer = { assistantId: 'assistant-a', computerId: 'computer-a',
      status: 'running' };
    const review = { ...departure, personalComputer: [computer] };
    function fetcher(input: RequestInfo | URL): Promise<Response> {
      const path = url(input);
      if (path.endsWith('/departure')) return Promise.resolve(response(review));
      if (path.endsWith('/remove')) return Promise.resolve(response(receipt));
      return baseFetch(input);
    }
    const fixture = mount(fetcher);
    await open(fixture);
    await vi.waitFor(() => expect(page(fixture).textContent).toContain('No shared work'));
    const drawer = page(fixture).querySelector('dialog');
    expect(drawer?.textContent).toContain('computer-a');
    expect(drawer?.textContent).toContain('running');
    button(page(fixture), 'Remove Alex').click();
    await vi.waitFor(() => expect(page(fixture).textContent).toContain('Removed ·'));
    const outcome = page(fixture).querySelector('.member-detail-page');
    expect(outcome?.textContent).toContain('computer-a');
    expect(outcome?.textContent).toContain('Clean-up status not yet reported');
    expect(outcome?.textContent).not.toContain('suspended');
  });

it('sends one reviewed removal and shows saved access with separate progress', async () => {
  const posts: Array<{ body: unknown }> = [];
  function fetcher(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const path = url(input);
    if (path.endsWith('/departure')) return Promise.resolve(response(departure));
    if (path.endsWith('/remove')) {
      if (typeof init?.body !== 'string') throw new Error('Expected JSON request body');
      const body: unknown = JSON.parse(init.body);
      posts.push({ body });
      return Promise.resolve(response(receipt));
    }
    if (path.includes('/changes/')) return Promise.resolve(response(receipt));
    return baseFetch(input);
  }
  const fixture = mount(fetcher);
  await open(fixture);
  await vi.waitFor(() => expect(button(page(fixture), 'Remove Alex').disabled).toBe(false));
  const remove = button(page(fixture), 'Remove Alex');
  remove.click();
  remove.click();
  await vi.waitFor(() => expect(page(fixture).textContent).toContain('Removed ·'));
  expect(posts).toHaveLength(1);
  expect(posts[0]?.body).toMatchObject({ expectedSequence: 2,
    reviewRevision: departure.reviewRevision });
  expect(page(fixture).textContent).toContain('IAM is still applying');
  expect(page(fixture).textContent).toContain('Content is current');
  const screen = page(fixture).querySelector('.member-detail-page');
  expect(screen?.textContent).toContain('Removed ·');
  expect(screen?.textContent).toContain('Clean-up status not yet reported');
  expect(screen?.querySelector('.member-summary')).toBeNull();
  expect(screen?.textContent).not.toContain('Groups');
  expect(screen?.textContent).not.toContain('Remove from');
  expect(page(fixture).querySelector('dialog[open]')).toBeNull();
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

it.each([503, 0])('keeps Remove disabled after an unavailable departure read (%s)',
  async (status) => {
    const requests: string[] = [];
    function fetcher(input: RequestInfo | URL): Promise<Response> {
      const path = url(input);
      requests.push(path);
      if (path.endsWith('/departure')) {
        if (status === 0) return Promise.reject(new Error('network'));
        return Promise.resolve(response({}, status));
      }
      return baseFetch(input);
    }
    const fixture = mount(fetcher);
    await open(fixture);
    await vi.waitFor(() => expect(page(fixture).textContent).toContain('Try again'));
    expect(button(page(fixture), 'Remove Alex').disabled).toBe(true);
    button(page(fixture), 'Try again').click();
    await vi.waitFor(() => expect(requests.filter((path) => path.endsWith('/departure')))
      .toHaveLength(2));
    expect(requests.some((path) => path.endsWith('/remove'))).toBe(false);
  });

it.each(['stale_review', 'incomplete_review', 'concurrent_change'])(
  'refreshes a conflicting review and uses a new command id for the next POST', async (reason) => {
  const commands: string[] = [];
  let reviews = 0;
  function fetcher(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const path = url(input);
    if (path.endsWith('/departure')) {
      reviews += 1;
      return Promise.resolve(response({ ...departure, reviewRevision: String(reviews).repeat(64) }));
    }
    if (path.endsWith('/remove')) {
      commands.push(postedCommandId(init));
      if (commands.length === 1) return Promise.resolve(response({ reason }, 409));
      return Promise.resolve(response(receipt));
    }
    return baseFetch(input);
  }
  const fixture = mount(fetcher);
  await open(fixture);
  await vi.waitFor(() => expect(button(page(fixture), 'Remove Alex').disabled).toBe(false));
  button(page(fixture), 'Remove Alex').click();
  await vi.waitFor(() => expect(reviews).toBe(2));
  await vi.waitFor(() => expect(button(page(fixture), 'Remove Alex').disabled).toBe(false));
  button(page(fixture), 'Remove Alex').click();
  await vi.waitFor(() => expect(commands).toHaveLength(2));
  expect(commands[0]).not.toBe(commands[1]);
  });

it('shows the owners link when removal requires a step-down', async () => {
  function fetcher(input: RequestInfo | URL): Promise<Response> {
    const path = url(input);
    if (path.endsWith('/departure')) return Promise.resolve(response(departure));
    if (path.endsWith('/remove')) {
      return Promise.resolve(response({ reason: 'ownership_stream_required' }, 409));
    }
    return baseFetch(input);
  }
  const fixture = mount(fetcher);
  await open(fixture);
  await vi.waitFor(() => expect(button(page(fixture), 'Remove Alex').disabled).toBe(false));
  button(page(fixture), 'Remove Alex').click();
  await vi.waitFor(() => expect(page(fixture).querySelector('a[href="/org/people/owners"]'))
    .not.toBeNull());
});

it.each([401, 403])('clears protected details after a removal refusal (%s)',
  async (status) => {
    function fetcher(input: RequestInfo | URL): Promise<Response> {
      const path = url(input);
      if (path.endsWith('/departure')) return Promise.resolve(response(departure));
      if (path.endsWith('/remove')) return Promise.resolve(response({}, status));
      return baseFetch(input);
    }
    const fixture = mount(fetcher);
    await open(fixture);
    await vi.waitFor(() => expect(button(page(fixture), 'Remove Alex').disabled).toBe(false));
    button(page(fixture), 'Remove Alex').click();
    await vi.waitFor(() => expect(page(fixture).textContent).toContain('If you removed yourself'));
    expect(page(fixture).textContent).not.toContain('Alex Kim');
    expect(page(fixture).textContent).not.toContain('alex@example.test');
  });

it('ignores a departure reply after Cancel', async () => {
  let finish!: (value: Response) => void;
  function fetcher(input: RequestInfo | URL): Promise<Response> {
    if (url(input).endsWith('/departure')) {
      return new Promise<Response>((resolve) => { finish = resolve; });
    }
    return baseFetch(input);
  }
  const fixture = mount(fetcher);
  await open(fixture);
  const cancel = page(fixture).querySelector<HTMLButtonElement>('dialog footer button.secondary');
  if (!cancel) throw new Error('Expected Cancel button');
  cancel.click();
  finish(response(departure));
  await vi.waitFor(() => expect(page(fixture).querySelector('dialog[open]')).toBeNull());
});
