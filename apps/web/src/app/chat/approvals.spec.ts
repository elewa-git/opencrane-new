import { TestBed, type ComponentFixture } from '@angular/core/testing';
import type { ApprovalCard } from '@opencrane/protocol';
import { ApprovalCards } from './approvals';

const approvalId = 'a'.repeat(64);

function card(state: ApprovalCard['state'] = 'requested', canDecide = true): ApprovalCard {
  return {
    approvalId,
    conversationId: 'chat',
    requesterId: canDecide ? 'me' : 'someone-else',
    expiresAt: '2026-10-04T10:32:00Z',
    state,
    stepUp: false,
    canDecide: state === 'requested' && canDecide,
    review: {
      action: 'Change the note on SO-1042',
      tool: 'update_draft_order_note',
      target: 'Draft order SO-1042',
      data: '{"note":"Deliver after 10:00 on Tuesday"}',
      destination: 'https://erp.example.test',
      account: 'No account · profile: none',
      consequence: 'Changes the draft note immediately.',
    },
  };
}

function response(cards: ApprovalCard[], status = 200): Response {
  return new Response(JSON.stringify({ cards, csrf: 'csrf-token' }), { status });
}

async function mount(fetchImplementation: typeof fetch): Promise<ComponentFixture<ApprovalCards>> {
  vi.spyOn(globalThis, 'fetch').mockImplementation(fetchImplementation);
  const fixture = TestBed.createComponent(ApprovalCards);
  fixture.componentRef.setInput('conversationId', 'chat');
  fixture.componentRef.setInput('viewerId', 'me');
  fixture.detectChanges();
  await fixture.whenStable();
  await vi.waitFor(() => expect(rootOf(fixture).getAttribute('aria-busy')).toBe('false'));
  fixture.detectChanges();
  return fixture;
}

function rootOf(fixture: ComponentFixture<ApprovalCards>): HTMLElement {
  const root: unknown = fixture.nativeElement;
  if (!(root instanceof HTMLElement)) throw new Error('Approval cards have no host element');
  return root;
}

function requiredElement<ElementType extends Element>(root: ParentNode, selector: string): ElementType {
  const element = root.querySelector<ElementType>(selector);
  if (!element) throw new Error(`Expected an element matching ${selector}`);
  return element;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
  configurable: true,
  writable: true,
  value(this: HTMLDialogElement) { this.setAttribute('open', ''); },
});
Object.defineProperty(HTMLDialogElement.prototype, 'close', {
  configurable: true,
  writable: true,
  value(this: HTMLDialogElement) {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  },
});

it('shows requester fields in order and posts one named decision', async () => {
  let current = card();
  const fetchImplementation = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST') {
      if (typeof init.body !== 'string') throw new Error('Decision body must be JSON text');
      expect(JSON.parse(init.body)).toEqual({ approvalId, decision: 'approved' });
      expect(new Headers(init.headers).get('x-csrf-token')).toBe('csrf-token');
      current = card('approved', false);
      return Promise.resolve(new Response('{}'));
    }
    return Promise.resolve(response([current]));
  });
  const fixture = await mount(fetchImplementation);
  const root = rootOf(fixture);
  const ledger = root.querySelector<HTMLElement>('.approval-ledger');
  expect(ledger).not.toBeNull();
  if (!ledger) throw new Error('Requester ledger is missing');
  const labels = [...ledger.querySelectorAll('dt')].map(label => label.textContent?.trim());
  expect(labels).toEqual(['Tool', 'Target', 'Data sent', 'Where', 'Account', 'Requested by', 'Expires']);
  expect(root.textContent).toContain('What happens');
  expect(root.querySelector<HTMLButtonElement>('.approve')?.getAttribute('aria-label'))
    .toBe('Approve: Change the note on SO-1042');
  expect(root.querySelector<HTMLButtonElement>('[aria-label^="Deny:"]')).not.toBeNull();
  requiredElement<HTMLButtonElement>(root, '.approve').click();
  await vi.waitFor(() => expect(root.querySelector('.approval-terminal')).not.toBeNull());
  expect(fetchImplementation.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  fixture.destroy();
});

it('shows that only the requester can decide without decision buttons', async () => {
  const fixture = await mount(() => Promise.resolve(response([card('requested', false)])));
  const root = rootOf(fixture);
  expect(root.textContent).toContain('Only the requester can decide.');
  expect(root.querySelector('[aria-label^="Approve:"]')).toBeNull();
  expect(root.querySelector('[aria-label^="Deny:"]')).toBeNull();
  fixture.destroy();
});

it('keeps both actions disabled when a poll arrives during a pending POST', async () => {
  vi.useFakeTimers();
  let releasePost: ((value: Response) => void) | undefined;
  let postCount = 0;
  const fetchImplementation = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST') {
      postCount += 1;
      return new Promise<Response>(resolve => { releasePost = resolve; });
    }
    return Promise.resolve(response([card()]));
  });
  const fixture = await mount(fetchImplementation);
  const root = rootOf(fixture);
  const approve = root.querySelector<HTMLButtonElement>('.approve')!;
  const deny = root.querySelector<HTMLButtonElement>('[aria-label^="Deny:"]')!;
  approve.click();
  approve.click();
  expect(postCount).toBe(1);
  await vi.advanceTimersByTimeAsync(3000);
  fixture.detectChanges();
  expect(approve.disabled).toBe(true);
  expect(deny.disabled).toBe(true);
  if (!releasePost) throw new Error('The approval POST did not start');
  releasePost(new Response('{}', { status: 503 }));
  await vi.waitFor(() => expect(root.textContent).toContain('Decision not confirmed'));
  fixture.destroy();
});

it('checks a 503 outcome with one GET and enables a still-open approval', async () => {
  let postCount = 0;
  let getCount = 0;
  const fixture = await mount((_url, init) => {
    if (init?.method === 'POST') {
      postCount += 1;
      return Promise.resolve(new Response('{}', { status: 503 }));
    }
    getCount += 1;
    return Promise.resolve(response([card()]));
  });
  const root = rootOf(fixture);
  root.querySelector<HTMLButtonElement>('.approve')!.click();
  await vi.waitFor(() => expect(root.textContent).toContain('Decision not confirmed'));
  const beforeCheck = getCount;
  root.querySelector<HTMLButtonElement>('.state-action')!.click();
  await vi.waitFor(() => expect(root.textContent).toContain('The server shows this approval still open'));
  expect(getCount - beforeCheck).toBe(1);
  expect(root.textContent).toContain('approval closes when its turn ends or at 4 Oct 2026, 10:32 UTC');
  expect(root.querySelector<HTMLButtonElement>('.approve')?.disabled).toBe(false);
  expect(postCount).toBe(1);
  fixture.destroy();
});

it('checks a second 503 without sending another decision and shows the expiry limit', async () => {
  let postCount = 0;
  let getCount = 0;
  const fixture = await mount((_url, init) => {
    if (init?.method === 'POST') {
      postCount += 1;
      return Promise.resolve(new Response('{}', { status: 503 }));
    }
    getCount += 1;
    return Promise.resolve(response([card()]));
  });
  const root = rootOf(fixture);
  const approve = () => root.querySelector<HTMLButtonElement>('.approve')!.click();
  const check = () => root.querySelector<HTMLButtonElement>('.state-action')!.click();
  approve();
  await vi.waitFor(() => expect(root.textContent).toContain('Decision not confirmed'));
  check();
  await vi.waitFor(() => expect(root.textContent).toContain('The server shows this approval still open'));
  approve();
  await vi.waitFor(() => expect(postCount).toBe(2));
  await vi.waitFor(() => expect(root.textContent).toContain('Decision not confirmed'));
  const postsBeforeCheck = postCount;
  const readsBeforeCheck = getCount;
  check();
  await vi.waitFor(() => expect(root.textContent).toContain('approval closes when its turn ends'));
  expect(postCount).toBe(postsBeforeCheck);
  expect(getCount - readsBeforeCheck).toBe(1);
  expect(root.textContent).toContain('4 Oct 2026, 10:32 UTC');
  fixture.destroy();
});

it.each([400, 403])('re-reads a %s refusal and re-enables a still-open decision', async status => {
  const fixture = await mount((_url, init) => {
    if (init?.method === 'POST') return Promise.resolve(new Response('{}', { status }));
    return Promise.resolve(response([card()]));
  });
  const root = rootOf(fixture);
  root.querySelector<HTMLButtonElement>('.approve')!.click();
  await vi.waitFor(() => expect(root.textContent)
    .toContain('Your decision was not recorded. You can decide again.'));
  expect(root.querySelector<HTMLButtonElement>('.approve')?.disabled).toBe(false);
  expect(root.querySelector<HTMLButtonElement>('[aria-label^="Deny:"]')?.disabled).toBe(false);
  fixture.destroy();
});

it('does not turn an outcome-unknown status check into a POST', async () => {
  let postCount = 0;
  let getCount = 0;
  const fixture = await mount((_url, init) => {
    if (init?.method === 'POST') postCount += 1;
    else getCount += 1;
    return Promise.resolve(response([card('outcome_unknown', false)]));
  });
  const root = rootOf(fixture);
  const beforeCheck = getCount;
  root.querySelector<HTMLButtonElement>('.state-action')!.click();
  await vi.waitFor(() => expect(getCount).toBe(beforeCheck + 1));
  expect(postCount).toBe(0);
  fixture.destroy();
});

it('moves focus to the collapsed card after a 409 and the follow-up read', async () => {
  let current = card();
  const fixture = await mount((_url, init) => {
    if (init?.method === 'POST') {
      current = card('approved', true);
      return Promise.resolve(new Response('{}', { status: 409 }));
    }
    return Promise.resolve(response([current]));
  });
  const root = rootOf(fixture);
  const approve = root.querySelector<HTMLButtonElement>('.approve')!;
  approve.focus();
  approve.click();
  await vi.waitFor(() => expect(root.querySelector('.approval-terminal')).not.toBeNull());
  expect(document.activeElement).toBe(root.querySelector('.approval-terminal'));
  fixture.destroy();
});

it('does not post when Enter is pressed on the card or drawer body', async () => {
  let postCount = 0;
  const fixture = await mount((_url, init) => {
    if (init?.method === 'POST') postCount += 1;
    return Promise.resolve(response([card()]));
  });
  const root = rootOf(fixture);
  const section = root.querySelector<HTMLElement>('.approval.pending')!;
  section.tabIndex = 0;
  section.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  root.querySelector<HTMLButtonElement>('.details')!.click();
  fixture.detectChanges();
  const body = root.querySelector<HTMLElement>('dialog .body')!;
  body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  expect(postCount).toBe(0);
  fixture.destroy();
});

it('shows a step-up link for this approval and keeps it through a poll', async () => {
  vi.useFakeTimers();
  const fetchImplementation = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST') return Promise.resolve(new Response('{}', { status: 428 }));
    const value = { ...card(), stepUp: true };
    return Promise.resolve(response([value]));
  });
  const fixture = await mount(fetchImplementation);
  const root = rootOf(fixture);
  root.querySelector<HTMLButtonElement>('.approve')!.click();
  await vi.waitFor(() => expect(root.querySelector('a.sign-in')).not.toBeNull());
  const link = root.querySelector<HTMLAnchorElement>('a.sign-in')!;
  expect(link.href).toContain(`approval=${approvalId}`);
  expect(link.href).toContain('returnTo=%2Fworkspace%3Fconversation%3Dchat');
  await vi.advanceTimersByTimeAsync(3000);
  fixture.detectChanges();
  expect(root.querySelector('a.sign-in')).not.toBeNull();
  expect(root.querySelector<HTMLButtonElement>('[aria-label^="Deny:"]')?.disabled).toBe(false);
  fixture.destroy();
});

it('clears cards on a 403 and restores them after a later 200', async () => {
  vi.useFakeTimers();
  let getCount = 0;
  const fixture = await mount(() => {
    getCount += 1;
    if (getCount === 1) return Promise.resolve(response([card()]));
    if (getCount === 2) return Promise.resolve(response([], 403));
    return Promise.resolve(response([card()]));
  });
  const root = rootOf(fixture);
  expect(root.querySelector('.approval.pending')).not.toBeNull();
  await vi.advanceTimersByTimeAsync(3000);
  fixture.detectChanges();
  expect(root.textContent).toContain('Checking access');
  expect(root.textContent).toContain('Approvals are hidden until your access is confirmed.');
  expect(root.querySelector('.approval.pending')).toBeNull();
  await vi.advanceTimersByTimeAsync(3000);
  fixture.detectChanges();
  expect(root.querySelector('.approval.pending')).not.toBeNull();
  fixture.destroy();
});

it('keeps loaded cards disabled after a read failure and lets one status read recover them', async () => {
  vi.useFakeTimers();
  let getCount = 0;
  const fixture = await mount(() => {
    getCount += 1;
    if (getCount === 2) return Promise.resolve(new Response('{}', { status: 500 }));
    return Promise.resolve(response([card()]));
  });
  const root = rootOf(fixture);
  await vi.advanceTimersByTimeAsync(3000);
  fixture.detectChanges();
  expect(root.textContent).toContain('Approval status unavailable');
  expect(root.querySelector('.approval.pending')).not.toBeNull();
  expect(root.querySelector<HTMLButtonElement>('.approve')?.disabled).toBe(true);
  const checkStatus = root.querySelector<HTMLButtonElement>('.state-action')!;
  checkStatus.click();
  checkStatus.click();
  await vi.waitFor(() => expect(getCount).toBe(3));
  await vi.waitFor(() => expect(root.querySelector<HTMLButtonElement>('.approve')?.disabled)
    .toBe(false));
  fixture.destroy();
});

it('ignores an approval read that finishes after the conversation changes', async () => {
  let resolveFirstRead: ((value: Response) => void) | undefined;
  let getCount = 0;
  const fetchImplementation = vi.fn((_url: RequestInfo | URL) => {
    getCount += 1;
    if (getCount === 1) {
      return new Promise<Response>(resolve => { resolveFirstRead = resolve; });
    }
    return Promise.resolve(response([]));
  });
  vi.spyOn(globalThis, 'fetch').mockImplementation(fetchImplementation);
  const fixture = TestBed.createComponent(ApprovalCards);
  fixture.componentRef.setInput('conversationId', 'chat');
  fixture.componentRef.setInput('viewerId', 'me');
  fixture.detectChanges();
  await vi.waitFor(() => expect(getCount).toBe(1));
  fixture.componentRef.setInput('conversationId', 'other');
  fixture.detectChanges();
  await fixture.whenStable();
  await vi.waitFor(() => expect(getCount).toBe(2));
  if (!resolveFirstRead) throw new Error('The initial approval read did not start');
  resolveFirstRead(response([card()]));
  await vi.waitFor(() => expect(rootOf(fixture).getAttribute('aria-busy')).toBe('false'));
  fixture.detectChanges();
  expect(rootOf(fixture).querySelector('.approval.pending')).toBeNull();
  fixture.destroy();
});

it('moves focus to the terminal card when a poll folds the focused request', async () => {
  vi.useFakeTimers();
  let state: ApprovalCard['state'] = 'requested';
  let getCount = 0;
  const fixture = await mount(() => {
    getCount += 1;
    if (getCount > 1) state = 'approved';
    return Promise.resolve(response([card(state, true)]));
  });
  const root = rootOf(fixture);
  const approve = root.querySelector<HTMLButtonElement>('.approve')!;
  approve.focus();
  await vi.advanceTimersByTimeAsync(3000);
  fixture.detectChanges();
  await vi.waitFor(() => expect(root.querySelector('.approval-terminal')).not.toBeNull());
  expect(document.activeElement).toBe(root.querySelector('.approval-terminal'));
  fixture.destroy();
});

it('updates an open drawer with a poll and closes it when its card disappears', async () => {
  vi.useFakeTimers();
  let current: ApprovalCard | undefined = card();
  let getCount = 0;
  const fixture = await mount(() => {
    getCount += 1;
    if (getCount === 2) current = card('cancelled', false);
    return Promise.resolve(response(current ? [current] : []));
  });
  const root = rootOf(fixture);
  const transcript = document.createElement('section');
  transcript.className = 'transcript';
  transcript.tabIndex = 0;
  root.parentElement?.replaceChild(transcript, root);
  transcript.append(root);
  root.querySelector<HTMLButtonElement>('.details')!.click();
  fixture.detectChanges();
  expect(root.querySelector('dialog[open]')).not.toBeNull();
  await vi.advanceTimersByTimeAsync(3000);
  fixture.detectChanges();
  expect(root.querySelector('dialog[open]')?.textContent).toContain('Cancelled');
  expect(root.querySelector('dialog[open] .drawer-actions')).toBeNull();
  current = undefined;
  await vi.advanceTimersByTimeAsync(3000);
  fixture.detectChanges();
  await vi.waitFor(() => expect(root.querySelector('dialog[open]')).toBeNull());
  expect(document.activeElement).toBe(transcript);
  fixture.destroy();
});

it('closes a drawer decision on the terminal card and returns focus there', async () => {
  let current = card();
  const fixture = await mount((_url, init) => {
    if (init?.method === 'POST') current = card('approved', true);
    return Promise.resolve(response([current]));
  });
  const root = rootOf(fixture);
  root.querySelector<HTMLButtonElement>('.details')!.click();
  fixture.detectChanges();
  const drawerApprove = root.querySelector<HTMLButtonElement>('dialog .approve')!;
  drawerApprove.click();
  await vi.waitFor(() => expect(root.querySelector('dialog[open]')).toBeNull());
  const terminal = root.querySelector('.approval-terminal');
  expect(document.activeElement).toBe(terminal);
  fixture.destroy();
});

it.each([
  ['approved', 'Approved by the requester', 'not used yet'],
  ['outcome_unknown', 'Approved by the requester', 'used once'],
  ['denied', 'Denied by the requester', 'nothing was sent'],
  ['expired', 'Expired', 'nothing was sent'],
  ['cancelled', 'Cancelled', 'nothing was sent'],
] as const)('shows %s as a terminal button and opens a read-only drawer', async (state, words, detail) => {
  const fixture = await mount(() => Promise.resolve(response([card(state, false)])));
  const root = rootOf(fixture);
  const button = root.querySelector<HTMLButtonElement>('.approval-terminal');
  expect(button).not.toBeNull();
  if (!button) throw new Error('Terminal approval button is missing');
  expect(button.textContent).toContain(words);
  expect(button.textContent).toContain(detail);
  expect(root.querySelector('[aria-label^="Approve:"]')).toBeNull();
  expect(root.querySelector('[aria-label^="Deny:"]')).toBeNull();
  expect(root.textContent).not.toMatch(/try again|retry/i);
  button.click();
  fixture.detectChanges();
  const dialog = root.querySelector<HTMLDialogElement>('dialog[open]');
  expect(dialog).not.toBeNull();
  await fixture.whenStable();
  if (!dialog) throw new Error('Terminal approval drawer is missing');
  expect(document.activeElement).toBe(dialog.querySelector('h2'));
  expect(dialog.querySelector('[aria-label^="Approve:"]')).toBeNull();
  dialog.dispatchEvent(new Event('cancel', { cancelable: true }));
  await fixture.whenStable();
  expect(document.activeElement).toBe(button);
  fixture.destroy();
});

it('emits waitingOnViewer when a decision opens and when the card folds', async () => {
  let current = card();
  const fetchImplementation = (_url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST') current = card('denied', false);
    return Promise.resolve(response([current]));
  };
  vi.spyOn(globalThis, 'fetch').mockImplementation(fetchImplementation);
  const fixture = TestBed.createComponent(ApprovalCards);
  const emissions: boolean[] = [];
  fixture.componentInstance.waitingOnViewer.subscribe(value => emissions.push(value));
  fixture.componentRef.setInput('conversationId', 'chat');
  fixture.componentRef.setInput('viewerId', 'me');
  fixture.detectChanges();
  await fixture.whenStable();
  await vi.waitFor(() => expect(rootOf(fixture).getAttribute('aria-busy')).toBe('false'));
  const root = rootOf(fixture);
  expect(emissions).toContain(true);
  root.querySelector<HTMLButtonElement>('.approve')!.click();
  await vi.waitFor(() => expect(root.querySelector('.approval-terminal')).not.toBeNull());
  expect(emissions).toContain(false);
  fixture.destroy();
});
