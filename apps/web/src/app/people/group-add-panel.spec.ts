import { TestBed } from '@angular/core/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { GroupAddPanel } from './group-add-panel';

const group = { groupId: 'sales', name: 'Sales team', membershipSource: 'local',
  position: 0, payingGroupId: 'sales', members: [], access: {
    source: 'group_membership', conversationAccess: false,
    personalMemoryAccess: false, grants: [] } };
const bob = { memberId: 'bob', displayName: 'Bob', email: 'bob@example.test',
  role: 'member', status: 'joined', joinedAt: '2026-10-01T00:00:00.000Z', groups: [] };

function directory(rows: unknown[], next: string | null = null): Response {
  const count = { status: 'current', value: 1 };
  const body = { rows, next, counts: { members: count, groups: count,
    pendingInvitations: count, acceptedInvitations: count },
  checkedAt: '2026-10-01T00:00:00.000Z', projection: { content: 'current' },
  permissions: { invite: true } };
  return new Response(JSON.stringify(body));
}

function mount(): { root: HTMLElement; detect: () => void } {
  TestBed.configureTestingModule({ imports: [GroupAddPanel] });
  const fixture = TestBed.createComponent(GroupAddPanel);
  fixture.componentRef.setInput('group', group);
  fixture.detectChanges();
  const root: unknown = fixture.nativeElement;
  if (!(root instanceof HTMLElement)) throw new Error('Expected an add panel element');
  return { root, detect: fixture.detectChanges.bind(fixture) };
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof Request) return input.url;
  return input.href;
}

function type(root: HTMLElement, value: string): void {
  const field = root.querySelector<HTMLInputElement>('input');
  if (!field) throw new Error('Expected search field');
  field.value = value;
  field.dispatchEvent(new Event('input', { bubbles: true }));
}

afterEach(() => vi.unstubAllGlobals());

it('does not read an empty field and drops an older search reply', async () => {
  let releaseFirst: ((value: Response) => void) | undefined;
  const calls: string[] = [];
  function fetcher(input: RequestInfo | URL): Promise<Response> {
    calls.push(requestUrl(input));
    if (calls.length === 1) {
      return new Promise((resolve) => { releaseFirst = resolve; });
    }
    return Promise.resolve(directory([bob]));
  }
  vi.stubGlobal('fetch', fetcher);
  const panel = mount();
  type(panel.root, '');
  await new Promise((resolve) => globalThis.setTimeout(resolve, 270));
  expect(calls).toHaveLength(0);
  type(panel.root, 'Alice');
  await vi.waitFor(() => expect(calls).toHaveLength(1));
  type(panel.root, 'Bob');
  await vi.waitFor(() => expect(calls).toHaveLength(2));
  releaseFirst?.(directory([{ ...bob, memberId: 'alice', displayName: 'Alice' }]));
  await vi.waitFor(() => {
    panel.detect();
    expect(panel.root.textContent).toContain('Bob');
    expect(panel.root.textContent).not.toContain('Alice');
  });
  const url = new URL(calls[1] ?? '', 'https://example.test');
  expect(url.searchParams.get('q')).toBe('Bob');
  expect(url.searchParams.get('after')).toBe('');
  expect(url.searchParams.get('limit')).toBe('20');
});

it('keeps an incomplete page open and removes repeated people on Show more', async () => {
  const calls: string[] = [];
  function fetcher(input: RequestInfo | URL): Promise<Response> {
    calls.push(requestUrl(input));
    if (calls.length === 1) return Promise.resolve(directory([], 'bob'));
    return Promise.resolve(directory([bob, bob]));
  }
  vi.stubGlobal('fetch', fetcher);
  const panel = mount();
  type(panel.root, 'Bob');
  await vi.waitFor(() => {
    panel.detect();
    expect(panel.root.textContent).toContain('Show more');
  });
  expect(panel.root.textContent).not.toContain('No matching members');
  const more = [...panel.root.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === 'Show more');
  more?.click();
  await vi.waitFor(() => {
    panel.detect();
    expect(panel.root.querySelectorAll('.group-add-row')).toHaveLength(1);
  });
  expect(new URL(calls[1] ?? '', 'https://example.test').searchParams.get('after'))
    .toBe('bob');
});

it('keeps search text after Escape and offers retry after a temporary failure', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(new Response('{}', { status: 503 }))
    .mockResolvedValue(directory([bob]));
  vi.stubGlobal('fetch', fetcher);
  const panel = mount();
  type(panel.root, 'Bob');
  await vi.waitFor(() => {
    panel.detect();
    expect(panel.root.textContent).toContain('Try again');
  });
  const retry = [...panel.root.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === 'Try again');
  retry?.click();
  await vi.waitFor(() => {
    panel.detect();
    expect(panel.root.textContent).toContain('bob@example.test');
  });
  const field = panel.root.querySelector<HTMLInputElement>('input');
  field?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  panel.detect();
  expect(panel.root.querySelectorAll('.group-add-row')).toHaveLength(0);
  expect(field?.value).toBe('Bob');
  expect(globalThis.document.activeElement).toBe(field);
});
