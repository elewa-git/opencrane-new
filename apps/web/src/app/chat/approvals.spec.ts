import { TestBed, type ComponentFixture } from '@angular/core/testing';
import type { ApprovalCard } from '@opencrane/protocol';
import { ApprovalCards } from './approvals';

const approvalId = 'a'.repeat(64);

function card(
  state: ApprovalCard['state'] = 'requested',
  canDecide = true,
  id = approvalId,
  requesterId = canDecide ? 'me' : 'someone-else',
): ApprovalCard {
  return {
    approvalId: id,
    conversationId: 'chat',
    requesterId,
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

function requestUrl(input: RequestInfo | URL): string {
  if (input instanceof Request) return input.url;
  if (input instanceof URL) return input.href;
  return input;
}

function decisionBody(body: string): { approvalId: string; decision: string } {
  const parsed: unknown = JSON.parse(body);
  if (typeof parsed !== 'object' || parsed === null || !('approvalId' in parsed)
    || !('decision' in parsed) || typeof parsed.approvalId !== 'string'
    || typeof parsed.decision !== 'string') {
    throw new Error('Decision body has an unexpected shape');
  }
  return { approvalId: parsed.approvalId, decision: parsed.decision };
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

const changedApprovalCards: [string, ApprovalCard, 'approved' | 'rejected'][] = [
  ['denied before approval', card('denied', false), 'approved'],
  ['denied before denial', card('denied', false), 'rejected'],
  ['cancelled before approval', card('cancelled', false), 'approved'],
  ['cancelled before denial', card('cancelled', false), 'rejected'],
  ['approval disabled', { ...card(), canApprove: false, canDeny: true }, 'approved'],
  ['denial disabled', { ...card(), canApprove: true, canDeny: false }, 'rejected'],
  ['missing review fields', { ...card(), missingFields: ['orderId'] }, 'approved'],
  ['another requester', { ...card(), requesterId: 'someone-else' }, 'approved'],
];

it.each(changedApprovalCards)(
  'rejects an old handler after a poll changes %s',
  async (_, currentCard, decision) => {
    const originalCard = card();
    let latestCard: ApprovalCard = originalCard;
    const posts: string[] = [];
    function captureFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      if (init?.method === 'POST') posts.push(requestUrl(input));
      return Promise.resolve(response([latestCard]));
    }
    const fetchImplementation = vi.fn(captureFetch);
    const fixture = await mount(fetchImplementation);
    latestCard = currentCard;
    await fixture.componentInstance['read']('chat');
    await fixture.componentInstance['decide'](originalCard, decision);
    expect(posts).toEqual([]);
    fixture.destroy();
  },
);

it('keeps a requested card readable but removes decisions for a stopped turn', async () => {
  const stoppedCard = { ...card(), turnId: 'message' };
  const fetchImplementation = vi.fn(() => Promise.resolve(response([stoppedCard])));
  const fixture = await mount(fetchImplementation);
  fixture.componentRef.setInput('stoppedTurnIds', ['message']);
  fixture.detectChanges();
  const root = rootOf(fixture);
  expect(root.textContent).toContain("Can't continue");
  expect(root.textContent).toContain("This work stopped at the limit. Approving now wouldn't restart it.");
  expect(root.querySelector('oc-approval-ledger')).not.toBeNull();
  expect(root.querySelector('button.approve')).toBeNull();
  expect(root.querySelector('button[aria-label^="Deny:"]')).toBeNull();
  root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  expect(fetchImplementation).toHaveBeenCalledTimes(1);
});

it('shows a cancelled approval stopped by its turn with its ledger and no decisions', async () => {
  const stoppedCard = { ...card('cancelled', false), turnId: 'message' };
  const fetchImplementation = vi.fn(() => Promise.resolve(response([stoppedCard])));
  const fixture = await mount(fetchImplementation);
  fixture.componentRef.setInput('stoppedTurnIds', ['message']);
  fixture.detectChanges();
  const root = rootOf(fixture);
  expect(root.textContent).toContain("Can't continue");
  expect(root.textContent).toContain("This work stopped at the limit. Approving now wouldn't restart it.");
  expect(root.querySelector('.approval-ledger')?.textContent).toContain('Draft order SO-1042');
  expect(root.querySelector('[aria-label^="Approve:"]')).toBeNull();
  expect(root.querySelector('[aria-label^="Deny:"]')).toBeNull();
  expect(root.querySelector('.approval-terminal')).toBeNull();
  expect(fetchImplementation).toHaveBeenCalledTimes(1);
  fixture.destroy();
});

it('keeps a separately recorded approval outcome when its turn has a budget stop', async () => {
  const approvedCard = { ...card('approved', false), turnId: 'message' };
  const fixture = await mount(() => Promise.resolve(response([approvedCard])));
  fixture.componentRef.setInput('stoppedTurnIds', ['message']);
  fixture.detectChanges();
  const root = rootOf(fixture);
  expect(root.querySelector('.approval-terminal')?.textContent).toContain('Approved by the requester');
  expect(root.querySelector('.approval-ledger')).toBeNull();
  expect(root.querySelector('[aria-label^="Approve:"]')).toBeNull();
  fixture.destroy();
});

const decisionTime = '2026-10-04T10:16:00Z';
const firstUseTime = '2026-10-04T10:17:00Z';
const secondUseTime = '2026-10-04T10:18:00Z';
const endTime = '2026-10-04T10:19:00Z';

function usedCard(): ApprovalCard {
  return {
    ...card('outcome_unknown'), requestedAt: '2026-10-04T10:14:00Z',
    decidedAt: decisionTime, usedAt: firstUseTime,
    uses: [{ permitId: 'permit-1', usedAt: firstUseTime }],
  };
}

function openTerminalDetails(fixture: ComponentFixture<ApprovalCards>): HTMLElement {
  const root = rootOf(fixture);
  requiredElement<HTMLButtonElement>(root, '.approval-terminal').click();
  fixture.detectChanges();
  return requiredElement<HTMLElement>(root, 'oc-hinge-drawer dialog');
}

it('keeps a used approval on one line after another poll and moves its status check into details',
  async () => {
    const saved = usedCard();
    const fixture = await mount(() => Promise.resolve(response([saved])));
    const root = rootOf(fixture);
    expect(root.querySelectorAll('.approval-terminal')).toHaveLength(1);
    expect(root.querySelector('.terminal-wrap article')).toBeNull();
    expect(root.querySelector('.unknown-notice')).toBeNull();
    expect(root.querySelector('.approval-terminal')?.textContent).toContain('used once');
    expect(root.querySelector('.approval-terminal')?.textContent).toContain('can’t be reused');
    expect(root.querySelector('.approval-terminal')?.textContent).toContain('4 Oct 2026, 10:17 UTC');
    await fixture.componentInstance['read']('chat');
    fixture.detectChanges();
    expect(root.querySelectorAll('.approval-terminal')).toHaveLength(1);
    expect(root.querySelector('.unknown-notice')).toBeNull();
    const drawer = openTerminalDetails(fixture);
    expect(drawer.textContent).toContain('Result not confirmed');
    expect(drawer.textContent).toContain('Check status');
    fixture.destroy();
  });

it('counts separate uses and gives each saved use its own drawer row', async () => {
  const first = usedCard();
  const saved = { ...first, uses: [
    { permitId: 'permit-1', usedAt: firstUseTime },
    { permitId: 'permit-2', usedAt: secondUseTime },
  ] };
  const fixture = await mount(() => Promise.resolve(response([saved])));
  const root = rootOf(fixture);
  const line = requiredElement<HTMLElement>(root, '.approval-terminal');
  expect(line.textContent).toContain('used 2 times');
  expect(line.textContent).not.toContain('once');
  const drawer = openTerminalDetails(fixture);
  const uses = [...drawer.querySelectorAll('.approval-time-row')]
    .filter(row => row.textContent?.includes('Used'));
  expect(uses).toHaveLength(2);
  expect(uses[0]?.textContent).toContain('10:17 UTC');
  expect(uses[1]?.textContent).toContain('10:18 UTC');
  fixture.destroy();
});

it.each(['cancelled', 'expired'] as const)(
  'does not say nothing was sent when a %s approval has a saved use', async state => {
    const saved = { ...usedCard(), state, endedAt: endTime };
    const fixture = await mount(() => Promise.resolve(response([saved])));
    const root = rootOf(fixture);
    expect(root.textContent).not.toContain('nothing was sent');
    expect(root.textContent).toContain('used');
    expect(root.textContent).toContain('no confirmed result');
    fixture.destroy();
  },
);

it('treats a saved first use as use even when the uses list is empty', async () => {
  const saved = { ...usedCard(), state: 'cancelled' as const, uses: [] };
  const fixture = await mount(() => Promise.resolve(response([saved])));
  const line = requiredElement<HTMLElement>(rootOf(fixture), '.approval-terminal');
  expect(line.textContent).toContain('used once');
  expect(line.textContent).toContain('no confirmed result');
  expect(line.textContent).not.toContain('nothing was sent');
  fixture.destroy();
});

it('does not invent a time when the saved record has none', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2031-01-01T12:00:00Z'));
  const fixture = await mount(() => Promise.resolve(response([card('denied')])));
  const root = rootOf(fixture);
  const drawer = openTerminalDetails(fixture);
  expect(root.textContent).not.toContain('2031');
  expect(root.textContent).not.toContain('Invalid');
  expect(drawer.querySelectorAll('.approval-time-row')).toHaveLength(0);
  fixture.destroy();
});

it('shows a denial decision time and the recorded expiry time', async () => {
  const denied = { ...card('denied'), decidedAt: decisionTime };
  const expired = { ...card('expired', true, 'b'.repeat(64)), endedAt: endTime };
  const fixture = await mount(() => Promise.resolve(response([denied, expired])));
  const root = rootOf(fixture);
  const denial = requiredElement<HTMLElement>(root, `[data-approval="${approvalId}"]`);
  expect(denial.textContent).toContain('4 Oct 2026, 10:16 UTC');
  expect(root.textContent).toContain('4 Oct 2026, 10:32 UTC');
  requiredElement<HTMLButtonElement>(denial, '.approval-terminal').click();
  fixture.detectChanges();
  expect(root.textContent).toContain('Decided');
  fixture.destroy();
});

it('shows expiry and its recorded end as distinct drawer times', async () => {
  const saved = { ...card('expired'), requestedAt: decisionTime, endedAt: endTime };
  const fixture = await mount(() => Promise.resolve(response([saved])));
  const drawer = openTerminalDetails(fixture);
  expect(drawer.textContent).toContain('Expiry recorded');
  expect(drawer.textContent).toContain('10:19 UTC');
  fixture.destroy();
});

const reasonCases: [NonNullable<ApprovalCard['cancelReason']>, string, string][] = [
  ['turn_ended', 'Cancelled: turn ended', 'dash'],
  ['turn_stopped', 'Cancelled: turn stopped', 'dash'],
  ['new_message', 'Cancelled: new message', 'dash'],
  ['new_turn', 'Cancelled: new turn', 'dash'],
  ['conversation_closed', 'Cancelled: conversation closed', 'dash'],
  ['unpublished', 'No longer valid: tool unpublished', 'failed'],
  ['connection_changed', 'No longer valid: connection changed', 'failed'],
  ['policy_changed', 'No longer valid: policy changed', 'failed'],
  ['grant_revoked', 'No longer valid: a tool grant was revoked', 'closed'],
  ['schema_changed', 'No longer valid: tool schema changed', 'failed'],
  ['profile_changed', 'No longer valid: profile changed', 'failed'],
];

it.each(reasonCases)('shows the saved reason %s with its glyph', async (reason, words, glyph) => {
  const saved = { ...card('cancelled'), cancelReason: reason, endedAt: endTime };
  const fixture = await mount(() => Promise.resolve(response([saved])));
  const root = rootOf(fixture);
  const line = requiredElement<HTMLElement>(root, '.approval-terminal');
  expect(line.textContent).toContain(words);
  expect(line.querySelector('.terminal-glyph')?.getAttribute('data-glyph')).toBe(glyph);
  expect(line.textContent).not.toContain('your grant');
  const drawer = openTerminalDetails(fixture);
  expect(drawer.textContent).toContain(words);
  fixture.destroy();
});

it('shows plain Cancelled and an honest missing reason for an older record', async () => {
  const fixture = await mount(() => Promise.resolve(response([card('cancelled')])));
  const root = rootOf(fixture);
  const line = requiredElement<HTMLElement>(root, '.approval-terminal');
  expect(line.querySelector('strong')?.textContent).toBe('Cancelled');
  const drawer = openTerminalDetails(fixture);
  expect(drawer.textContent).toContain('The saved record does not say why');
  expect(root.textContent).not.toContain('Exact reason: Not available yet');
  fixture.destroy();
});

it('never puts requesterId in a finished card or its drawer', async () => {
  const saved = { ...usedCard(), requesterId: 'private-member-id-729' };
  const fixture = await mount(() => Promise.resolve(response([saved])));
  const root = rootOf(fixture);
  openTerminalDetails(fixture);
  expect(root.innerHTML).not.toContain('private-member-id-729');
  fixture.destroy();
});

it.each([401, 403])('clears an open drawer on %s and ignores a late older reply',
  async deniedStatus => {
    let releaseOlderRead: ((value: Response) => void) | undefined;
    let readCount = 0;
    const initial = usedCard();
    const fixture = await mount(() => {
      readCount += 1;
      if (readCount === 1) return Promise.resolve(response([initial]));
      if (readCount === 2) {
        return new Promise<Response>(resolve => { releaseOlderRead = resolve; });
      }
      return Promise.resolve(response([], deniedStatus));
    });
    const root = rootOf(fixture);
    openTerminalDetails(fixture);
    const olderRead = fixture.componentInstance['read']('chat', undefined, 'check');
    await vi.waitFor(() => expect(readCount).toBe(2));
    await fixture.componentInstance['read']('chat', undefined, 'check');
    fixture.detectChanges();
    expect(root.querySelector('.approval-terminal')).toBeNull();
    expect(root.querySelector('oc-hinge-drawer')).toBeNull();
    if (!releaseOlderRead) throw new Error('The older read did not start');
    releaseOlderRead(response([initial]));
    await olderRead;
    fixture.detectChanges();
    expect(root.querySelector('.approval-terminal')).toBeNull();
    expect(root.querySelector('oc-hinge-drawer')).toBeNull();
    fixture.destroy();
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

it('shows the WRK-12 waiting card without decision buttons', async () => {
  const fixture = await mount(() => Promise.resolve(response([card('requested', false)])));
  const root = rootOf(fixture);
  expect(root.textContent).toContain('Only the requester can decide.');
  expect(root.querySelector('.approval-ledger')?.textContent).toContain('Draft order SO-1042');
  expect(root.textContent).toContain('Changes the draft note immediately.');
  expect(root.querySelector('[aria-label^="Approve:"]')).toBeNull();
  expect(root.querySelector('[aria-label^="Deny:"]')).toBeNull();
  fixture.destroy();
});

it('names missing review fields and permits only the requester to deny', async () => {
  const requested = card();
  const incomplete = {
    ...requested, review: { ...requested.review, target: '' },
    missingFields: ['orderId'], canApprove: false, canDeny: true,
  };
  const fetchImplementation = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST') return Promise.resolve(response([], 200));
    return Promise.resolve(response([incomplete]));
  });
  const fixture = await mount(fetchImplementation);
  const root = rootOf(fixture);
  expect(root.textContent).toContain('orderId');
  expect(root.textContent).toContain('Not provided');
  expect(root.textContent).toContain('Approve is unavailable');
  const approve = requiredElement<HTMLButtonElement>(root, '.approval.pending .approve');
  expect(approve.disabled).toBe(true);
  approve.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  expect(fetchImplementation.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
  const deny = requiredElement<HTMLButtonElement>(root, '.approval.pending [aria-label^="Deny:"]');
  expect(deny.disabled).toBe(false);
  deny.click();
  await vi.waitFor(() => expect(fetchImplementation.mock.calls.filter(([, init]) =>
    init?.method === 'POST')).toHaveLength(1));
  fixture.destroy();
});

it('keeps complete requester controls and hides participant decisions for incomplete reviews', async () => {
  const complete = { ...card(), missingFields: [], canApprove: true, canDeny: true };
  const waiting = card('requested', false);
  const participant = {
    ...waiting, review: { ...waiting.review, target: '' }, missingFields: ['orderId'],
    canApprove: false, canDeny: false,
  };
  const completeFixture = await mount(() => Promise.resolve(response([complete])));
  const completeRoot = rootOf(completeFixture);
  expect(requiredElement<HTMLButtonElement>(completeRoot, '.approve').disabled).toBe(false);
  expect(requiredElement<HTMLButtonElement>(completeRoot, '[aria-label^="Deny:"]').disabled)
    .toBe(false);
  completeFixture.destroy();
  const participantFixture = await mount(() => Promise.resolve(response([participant])));
  const participantRoot = rootOf(participantFixture);
  expect(participantRoot.textContent).toContain('orderId');
  expect(participantRoot.querySelector('[aria-label^="Approve:"]')).toBeNull();
  expect(participantRoot.querySelector('[aria-label^="Deny:"]')).toBeNull();
  participantFixture.destroy();
});

it('keeps one pending decision with its own approval when another card is chosen', async () => {
  const secondApprovalId = 'b'.repeat(64);
  let currentCards = [card(), card('requested', true, secondApprovalId)];
  const postIds: string[] = [];
  let releaseFirstPost: ((value: Response) => void) | undefined;
  const fixture = await mount((_url, init) => {
    if (init?.method !== 'POST') return Promise.resolve(response(currentCards));
    if (typeof init.body !== 'string') throw new Error('Decision body must be JSON text');
    const body = decisionBody(init.body);
    postIds.push(body.approvalId);
    if (body.approvalId === approvalId) {
      return new Promise<Response>(resolve => { releaseFirstPost = resolve; });
    }
    currentCards = [card(), card('approved', false, secondApprovalId)];
    return Promise.resolve(new Response('{}'));
  });
  const root = rootOf(fixture);
  const firstCard = requiredElement<HTMLElement>(root, `[data-approval="${approvalId}"]`);
  const secondCard = requiredElement<HTMLElement>(root, `[data-approval="${secondApprovalId}"]`);

  firstCard.querySelector<HTMLButtonElement>('.approve')!.click();
  fixture.detectChanges();
  const updatedFirstCard = requiredElement<HTMLElement>(root, `[data-approval="${approvalId}"]`);
  expect(updatedFirstCard.querySelector<HTMLButtonElement>('.approve')?.getAttribute('aria-disabled'))
    .toBe('true');
  expect(secondCard.querySelector<HTMLButtonElement>('.approve')?.getAttribute('aria-disabled'))
    .toBe('false');
  secondCard.querySelector<HTMLButtonElement>('.approve')!.click();

  await vi.waitFor(() => expect(root.querySelector(
    `oc-approval-terminal-line [data-approval="${secondApprovalId}"]`,
  )).not.toBeNull());
  expect(postIds).toEqual([approvalId, secondApprovalId]);
  if (!releaseFirstPost) throw new Error('The first decision did not start');
  releaseFirstPost(new Response('{}', { status: 503 }));
  await vi.waitFor(() => expect(firstCard.textContent).toContain('Decision not confirmed'));
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
  expect(approve.getAttribute('aria-disabled')).toBe('true');
  expect(deny.getAttribute('aria-disabled')).toBe('true');
  if (!releasePost) throw new Error('The approval POST did not start');
  releasePost(new Response('{}', { status: 503 }));
  await vi.waitFor(() => expect(root.textContent).toContain('Decision not confirmed'));
  fixture.destroy();
});

it('stops showing Waiting on you while the decision is being sent', async () => {
  let releasePost: ((value: Response) => void) | undefined;
  vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
    if (init?.method === 'POST') {
      return new Promise<Response>(resolve => { releasePost = resolve; });
    }
    return Promise.resolve(response([card()]));
  });
  const fixture = TestBed.createComponent(ApprovalCards);
  const emissions: boolean[] = [];
  fixture.componentInstance.waitingOnViewer.subscribe(value => emissions.push(value));
  fixture.componentRef.setInput('conversationId', 'chat');
  fixture.componentRef.setInput('viewerId', 'me');
  fixture.detectChanges();
  await vi.waitFor(() => expect(emissions.at(-1)).toBe(true));
  rootOf(fixture).querySelector<HTMLButtonElement>('.approve')!.click();
  await vi.waitFor(() => expect(emissions.at(-1)).toBe(false));
  if (!releasePost) throw new Error('The decision request did not start');
  releasePost(new Response('{}', { status: 503 }));
  fixture.destroy();
});

it('keeps the healthy approval list quiet during a refresh', async () => {
  vi.useFakeTimers();
  let getCount = 0;
  const fixture = await mount(() => {
    getCount += 1;
    return Promise.resolve(response([card()]));
  });
  const root = rootOf(fixture);
  await vi.advanceTimersByTimeAsync(3000);
  fixture.detectChanges();
  expect(getCount).toBe(2);
  expect(root.querySelector('.approval-announcement')?.textContent).toBe('');
  expect(root.textContent).not.toContain('Approval status unavailable');
  fixture.destroy();
});

it('ends a stuck approval read so the next poll can refresh the list', async () => {
  vi.useFakeTimers();
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);
    return controller.signal;
  });
  let getCount = 0;
  const fixture = TestBed.createComponent(ApprovalCards);
  fixture.componentRef.setInput('conversationId', 'chat');
  fixture.componentRef.setInput('viewerId', 'me');
  vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
    getCount += 1;
    if (getCount > 1) return Promise.resolve(response([card()]));
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('Timed out')));
    });
  });
  fixture.detectChanges();
  await vi.waitFor(() => expect(getCount).toBe(1));
  await vi.advanceTimersByTimeAsync(10);
  await vi.waitFor(() => expect(rootOf(fixture).textContent)
    .toContain('Approval status unavailable'));
  await vi.advanceTimersByTimeAsync(3000);
  await vi.waitFor(() => expect(getCount).toBe(2));
  await vi.waitFor(() => expect(rootOf(fixture).textContent)
    .not.toContain('Approval status unavailable'));
  fixture.destroy();
});

it('keeps an accepted decision honest when its status read fails', async () => {
  vi.useFakeTimers();
  let postCount = 0;
  let getCount = 0;
  const fixture = await mount((_url, init) => {
    if (init?.method === 'POST') {
      postCount += 1;
      return Promise.resolve(new Response('{}'));
    }
    getCount += 1;
    if (getCount === 1) return Promise.resolve(response([card()]));
    if (getCount === 2) return Promise.resolve(new Response('{}', { status: 503 }));
    return Promise.resolve(response([card('approved', false)]));
  });
  const root = rootOf(fixture);
  root.querySelector<HTMLButtonElement>('.approve')!.click();
  await vi.waitFor(() => expect(root.textContent).toContain('Your decision was recorded'));
  expect(root.textContent).not.toContain('Sending your approval');
  expect(root.querySelector<HTMLButtonElement>('.approve')?.getAttribute('aria-disabled'))
    .toBe('true');
  await vi.advanceTimersByTimeAsync(3000);
  await vi.waitFor(() => expect(root.querySelector('.approval-terminal')).not.toBeNull());
  expect(postCount).toBe(1);
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
  expect(root.querySelector<HTMLButtonElement>('.approve')?.getAttribute('aria-disabled'))
    .toBe('false');
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

it('checks a lost reply with one GET and does not resend the decision', async () => {
  let postCount = 0;
  let getCount = 0;
  const fixture = await mount((_url, init) => {
    if (init?.method === 'POST') {
      postCount += 1;
      return Promise.reject(new TypeError('Connection closed'));
    }
    getCount += 1;
    return Promise.resolve(response([card()]));
  });
  const root = rootOf(fixture);
  root.querySelector<HTMLButtonElement>('.approve')!.click();
  await vi.waitFor(() => expect(root.textContent).toContain('Decision not confirmed'));
  expect(root.textContent).toContain(approvalId);
  const readsBeforeCheck = getCount;
  root.querySelector<HTMLButtonElement>('.state-action')!.click();
  await vi.waitFor(() => expect(getCount).toBe(readsBeforeCheck + 1));
  expect(postCount).toBe(1);
  fixture.destroy();
});

it.each([503, 403, 428])('shows a %s outcome inside the approval drawer', async status => {
  const fixture = await mount((_url, init) => {
    if (init?.method === 'POST') return Promise.resolve(new Response('{}', { status }));
    return Promise.resolve(response([card()]));
  });
  const root = rootOf(fixture);
  root.querySelector<HTMLButtonElement>('.details')!.click();
  fixture.detectChanges();
  root.querySelector<HTMLButtonElement>('dialog .approve')!.click();

  await vi.waitFor(() => {
    const dialog = root.querySelector('dialog[open]');
    expect(dialog).not.toBeNull();
    if (status === 503) expect(dialog?.textContent).toContain('Decision not confirmed');
    if (status === 403) expect(dialog?.textContent).toContain('Your decision was not recorded');
    if (status === 428) expect(dialog?.querySelector('a.sign-in')).not.toBeNull();
  });
  if (status === 503) {
    expect(root.querySelector('dialog[open] .state-action')).not.toBeNull();
  }
  fixture.destroy();
});

it.each([400, 403])('re-reads a %s refusal and re-enables a still-open decision', async status => {
  const fixture = await mount((_url, init) => {
    if (init?.method === 'POST') return Promise.resolve(new Response('{}', { status }));
    return Promise.resolve(response([card()]));
  });
  const root = rootOf(fixture);
  const approve = root.querySelector<HTMLButtonElement>('.approve')!;
  approve.focus();
  approve.click();
  await vi.waitFor(() => expect(root.textContent)
    .toContain('Your decision was not recorded. You can decide again.'));
  expect(root.querySelector<HTMLButtonElement>('.approve')?.getAttribute('aria-disabled'))
    .toBe('false');
  expect(root.querySelector<HTMLButtonElement>('[aria-label^="Deny:"]')?.getAttribute('aria-disabled'))
    .toBe('false');
  expect(document.activeElement).toBe(approve);
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
  const drawer = openTerminalDetails(fixture);
  const beforeCheck = getCount;
  const checkStatus = requiredElement<HTMLButtonElement>(drawer, '.state-action');
  checkStatus.click();
  checkStatus.click();
  await vi.waitFor(() => expect(getCount).toBe(beforeCheck + 1));
  expect(getCount).toBe(beforeCheck + 1);
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

it('says a 409 left the approval open when the follow-up read shows it is still open', async () => {
  const fixture = await mount((_url, init) => {
    if (init?.method === 'POST') return Promise.resolve(new Response('{}', { status: 409 }));
    return Promise.resolve(response([card()]));
  });
  const root = rootOf(fixture);
  root.querySelector<HTMLButtonElement>('.approve')!.click();
  await vi.waitFor(() => expect(root.textContent).toContain(
    'The server did not record your decision. The approval is still open.',
  ));
  expect(root.querySelector<HTMLButtonElement>('.approve')?.getAttribute('aria-disabled'))
    .toBe('false');
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
  expect(root.querySelector<HTMLButtonElement>('[aria-label^="Deny:"]')?.getAttribute('aria-disabled'))
    .toBe('false');
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

it('does not announce the same request again after access is restored', async () => {
  vi.useFakeTimers();
  let getCount = 0;
  const fixture = await mount(() => {
    getCount += 1;
    if (getCount === 2) return Promise.resolve(response([], 403));
    return Promise.resolve(response([card()]));
  });
  const root = rootOf(fixture);
  await vi.advanceTimersByTimeAsync(3000);
  expect(root.textContent).toContain('Checking access');
  await vi.advanceTimersByTimeAsync(3000);
  await vi.waitFor(() => expect(root.querySelector('.approval.pending')).not.toBeNull());
  expect(root.querySelector('.approval-announcement')?.textContent).toBe('');
  fixture.destroy();
});

it('keeps an open decision locked while access is checked and restored', async () => {
  vi.useFakeTimers();
  let getCount = 0;
  let postCount = 0;
  let releasePost: ((value: Response) => void) | undefined;
  const fixture = await mount((_url, init) => {
    if (init?.method === 'POST') {
      postCount += 1;
      return new Promise<Response>(resolve => { releasePost = resolve; });
    }
    getCount += 1;
    if (getCount === 2) return Promise.resolve(response([], 403));
    return Promise.resolve(response([card()]));
  });
  const root = rootOf(fixture);
  root.querySelector<HTMLButtonElement>('.approve')!.click();
  await vi.advanceTimersByTimeAsync(3000);
  expect(root.textContent).toContain('Checking access');
  await vi.advanceTimersByTimeAsync(3000);
  await vi.waitFor(() => expect(root.querySelector('.approval.pending')).not.toBeNull());
  const approve = root.querySelector<HTMLButtonElement>('.approve')!;
  expect(approve.getAttribute('aria-disabled')).toBe('true');
  approve.click();
  expect(postCount).toBe(1);
  if (!releasePost) throw new Error('The decision request did not start');
  releasePost(new Response('{}', { status: 503 }));
  fixture.destroy();
});

it('moves focus out of a pending card when access changes', async () => {
  vi.useFakeTimers();
  let getCount = 0;
  const fixture = await mount(() => {
    getCount += 1;
    if (getCount === 2) return Promise.resolve(response([], 403));
    return Promise.resolve(response([card()]));
  });
  const root = rootOf(fixture);
  const transcript = document.createElement('section');
  transcript.className = 'transcript';
  transcript.tabIndex = 0;
  root.parentElement?.replaceChild(transcript, root);
  transcript.append(root);
  const approve = root.querySelector<HTMLButtonElement>('.approve')!;
  approve.focus();
  await vi.advanceTimersByTimeAsync(3000);
  fixture.detectChanges();
  expect(document.activeElement).toBe(transcript);
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
  expect(root.querySelector<HTMLButtonElement>('.approve')?.getAttribute('aria-disabled'))
    .toBe('true');
  const checkStatus = root.querySelector<HTMLButtonElement>('.state-action')!;
  checkStatus.click();
  checkStatus.click();
  await vi.waitFor(() => expect(getCount).toBe(3));
  await vi.waitFor(() => expect(
    root.querySelector<HTMLButtonElement>('.approve')?.getAttribute('aria-disabled'),
  ).toBe('false'));
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

it('moves focus to the transcript when the focused approval disappears', async () => {
  vi.useFakeTimers();
  let getCount = 0;
  const fixture = await mount(() => {
    getCount += 1;
    return Promise.resolve(response(getCount === 1 ? [card()] : []));
  });
  const root = rootOf(fixture);
  const transcript = document.createElement('section');
  transcript.className = 'transcript';
  transcript.tabIndex = 0;
  root.parentElement?.replaceChild(transcript, root);
  transcript.append(root);
  root.querySelector<HTMLButtonElement>('.approve')!.focus();
  await vi.advanceTimersByTimeAsync(3000);
  fixture.detectChanges();
  expect(document.activeElement).toBe(transcript);
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

it('returns focus to the folded card after its drawer closes', async () => {
  vi.useFakeTimers();
  let getCount = 0;
  const fixture = await mount(() => {
    getCount += 1;
    const state: ApprovalCard['state'] = getCount === 1 ? 'requested' : 'approved';
    return Promise.resolve(response([card(state, state === 'requested')]));
  });
  const root = rootOf(fixture);
  root.querySelector<HTMLButtonElement>('.details')!.click();
  fixture.detectChanges();
  const drawer = root.querySelector<HTMLDialogElement>('dialog[open]');
  expect(drawer).not.toBeNull();
  await vi.advanceTimersByTimeAsync(3000);
  fixture.detectChanges();
  drawer?.dispatchEvent(new Event('cancel', { cancelable: true }));
  fixture.detectChanges();
  expect(document.activeElement).toBe(root.querySelector('.approval-terminal'));
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
  expect(button.textContent?.toLowerCase()).toContain(detail.toLowerCase());
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

it('uses the viewer wording for their own folded approval', async () => {
  const fixture = await mount(() => Promise.resolve(response([
    card('denied', false, approvalId, 'me'),
  ])));
  expect(rootOf(fixture).querySelector('.approval-terminal')?.textContent)
    .toContain('Denied by you');
  fixture.destroy();
});

it('keeps a folded card read-only after remount and hides sign-in for a non-requester', async () => {
  const folded = { ...card('approved', false), stepUp: true };
  const firstFixture = await mount(() => Promise.resolve(response([folded])));
  const firstRoot = rootOf(firstFixture);
  expect(firstRoot.querySelector('.approval-ledger')).toBeNull();
  expect(firstRoot.querySelector('a.sign-in')).toBeNull();
  expect(firstRoot.querySelector('[aria-label^="Approve:"]')).toBeNull();
  firstFixture.destroy();

  const secondFixture = await mount(() => Promise.resolve(response([folded])));
  const secondRoot = rootOf(secondFixture);
  expect(secondRoot.querySelector('.approval-ledger')).toBeNull();
  expect(secondRoot.querySelector('a.sign-in')).toBeNull();
  expect(secondRoot.querySelector('[aria-label^="Approve:"]')).toBeNull();
  secondFixture.destroy();
});

it('keeps a non-requester pending drawer read-only', async () => {
  vi.useFakeTimers();
  let current = card();
  let readCount = 0;
  const fixture = await mount(() => {
    readCount += 1;
    if (readCount === 2) current = card('requested', false, approvalId, 'another-member');
    return Promise.resolve(response([current]));
  });
  const root = rootOf(fixture);
  root.querySelector<HTMLButtonElement>('.details')!.click();
  fixture.detectChanges();
  expect(root.querySelector('dialog[open]')).not.toBeNull();
  await vi.advanceTimersByTimeAsync(3000);
  fixture.detectChanges();

  const drawer = root.querySelector('dialog[open]');
  expect(drawer).not.toBeNull();
  expect(drawer?.querySelector('.drawer-actions')).toBeNull();
  expect(drawer?.querySelector('oc-approval-decision-status')).toBeNull();
  expect(drawer?.querySelector('.approve')).toBeNull();
  expect(drawer?.querySelector('a.sign-in')).toBeNull();
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

it('clears waitingOnViewer when the component is destroyed', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(response([card()])));
  const fixture = TestBed.createComponent(ApprovalCards);
  const emissions: boolean[] = [];
  fixture.componentInstance.waitingOnViewer.subscribe(value => emissions.push(value));
  fixture.componentRef.setInput('conversationId', 'chat');
  fixture.componentRef.setInput('viewerId', 'me');
  fixture.detectChanges();
  await vi.waitFor(() => expect(emissions).toContain(true));
  fixture.destroy();
  expect(emissions.at(-1)).toBe(false);
});
