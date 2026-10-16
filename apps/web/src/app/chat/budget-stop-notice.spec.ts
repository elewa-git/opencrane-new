import { TestBed } from '@angular/core/testing';
import { BudgetStopNotice } from './budget-stop-notice';
import type { BudgetStopStatus } from '@opencrane/protocol';

const scopes = ['global', 'paying_group', 'assistant'] as const;
const periods = ['daily', 'monthly'] as const;
const remedies = ['ask_admin', 'ask_admin_or_wait'] as const;

function stopped(
  scope: typeof scopes[number],
  period: typeof periods[number],
  remedy: typeof remedies[number],
  limitCents?: number,
): Extract<BudgetStopStatus, { status: 'stopped' }> {
  return {
    status: 'stopped', stopId: 'stop',
    reasons: [{ scope, period, cause: 'bound_refused',
      resetAt: '2026-11-01T00:00:00Z', remedy,
      ...(limitCents === undefined ? {} : { limitCents }) }],
    work: [{ turnId: 'message', execution: 'ended' }],
    positions: { stop: 2, turn: 3, conversation: 4, computer: 5, budget: 6 },
  };
}

function rootOf(fixture: ReturnType<typeof TestBed.createComponent<BudgetStopNotice>>): HTMLElement {
  const root: unknown = fixture.nativeElement;
  if (!(root instanceof HTMLElement)) throw new Error('No budget stop notice');
  return root;
}

async function mount(reply: unknown, status = 200) {
  const requests: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    requests.push(String(input));
    return Promise.resolve(new Response(JSON.stringify(reply), { status }));
  });
  const fixture = TestBed.createComponent(BudgetStopNotice);
  fixture.componentRef.setInput('conversationId', 'chat');
  fixture.componentRef.setInput('turnId', 'message');
  fixture.componentRef.setInput('reconnectedAt', '');
  fixture.componentRef.setInput('endedAt', '');
  fixture.componentRef.setInput('denied', false);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  return { fixture, requests };
}

afterEach(() => vi.restoreAllMocks());

it.each(scopes)('shows the %s scope with a daily and monthly amount', async scope => {
  for (const period of periods) {
    const { fixture, requests } = await mount(stopped(scope, period, 'ask_admin_or_wait', 20000));
    const label = { global: 'Organisation', paying_group: 'Group', assistant: 'Assistant' }[scope];
    expect(rootOf(fixture).textContent).toContain(`${label} ${period} limit reached: €200.00.`);
    expect(rootOf(fixture).textContent).toContain('Resets 1 Nov 2026, 00:00 UTC. Ask an admin to review the limit.');
    expect(requests).toEqual(['/api/conversations/chat/budget-stops?turnId=message']);
    fixture.destroy();
    vi.restoreAllMocks();
  }
});

it('shows both reasons in reply order and the admin-only remedy', async () => {
  const reply = stopped('assistant', 'daily', 'ask_admin', 20000);
  reply.reasons.push(stopped('global', 'monthly', 'ask_admin_or_wait', 10000).reasons[0]!);
  const { fixture } = await mount(reply);
  const content = rootOf(fixture).textContent ?? '';
  expect(content.indexOf('Assistant daily')).toBeLessThan(content.indexOf('Organisation monthly'));
  expect(content).toContain("Waiting for the reset won't help. Ask an admin to review the limit.");
});

it('shows no money to another participant and keeps the old stop after reset', async () => {
  const reply = stopped('paying_group', 'monthly', 'ask_admin_or_wait');
  const { fixture } = await mount(reply);
  expect(rootOf(fixture).textContent).not.toContain('€');
  expect(rootOf(fixture).textContent).not.toContain('new monthly limit');
  fixture.componentRef.setInput('now', '2026-11-01T00:00:01Z');
  fixture.detectChanges();
  expect(rootOf(fixture).textContent).toContain('new monthly limit. The stopped work was not repeated.');
  expect(rootOf(fixture).querySelector('button')).toBeNull();
});

it('shows each matching execution word and leaves out unmatched work', async () => {
  for (const [execution, words] of [
    ['not_started', 'Stopped before it started'],
    ['stopping', 'Stopping'],
    ['ended', 'Stopped'],
  ] as const) {
    const reply = stopped('global', 'monthly', 'ask_admin');
    reply.work[0]!.execution = execution;
    const { fixture } = await mount(reply);
    expect(rootOf(fixture).textContent).toContain(`${words} — spending limit`);
    fixture.destroy();
    vi.restoreAllMocks();
  }
  const reply = stopped('global', 'monthly', 'ask_admin');
  reply.work = [];
  const { fixture } = await mount(reply);
  expect(rootOf(fixture).textContent).not.toContain('— spending limit');
});

it('reads once on first render, reconnection and the end row, without polling', async () => {
  const { fixture, requests } = await mount(stopped('global', 'monthly', 'ask_admin'));
  expect(requests).toHaveLength(1);
  fixture.detectChanges();
  expect(requests).toHaveLength(1);
  fixture.componentRef.setInput('reconnectedAt', '2026-10-16T12:00:00Z');
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.componentRef.setInput('endedAt', '2026-10-16T12:00:01Z');
  fixture.detectChanges();
  await fixture.whenStable();
  expect(requests).toHaveLength(3);
});

it('keeps the stop visible on unavailable and Check again only reads once', async () => {
  const { fixture, requests } = await mount({}, 503);
  expect(rootOf(fixture).textContent).toContain('Stop details unavailable');
  expect(rootOf(fixture).textContent).toContain('This work is still stopped.');
  const button = rootOf(fixture).querySelector('button');
  if (!button) throw new Error('Missing Check again');
  button.click();
  button.click();
  expect(requests).toHaveLength(2);
});

it.each([401, 403])('clears protected details after %s', async status => {
  const { fixture } = await mount(stopped('global', 'monthly', 'ask_admin', 20000));
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status }));
  fixture.componentRef.setInput('reconnectedAt', '2026-10-16T12:00:00Z');
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  const root = rootOf(fixture);
  expect(root.textContent).toContain('Access changed');
  expect(root.textContent).not.toContain('€');
  expect(root.textContent).not.toContain('Organisation');
  expect(root.querySelector('button')).toBeNull();
});

it('tells the reader who can help and when the limit resets', () => {
  const fixture = TestBed.createComponent(BudgetStopNotice);
  fixture.detectChanges();

  const root: unknown = fixture.nativeElement;
  if (!(root instanceof HTMLElement)) throw new Error('No budget stop notice');
  expect(root.textContent).toContain('Spending limit reached');
  expect(root.textContent).toContain('An Owner or Admin can review the limit');
  expect(root.textContent).toContain('next monthly budget period (UTC)');
  expect(root.querySelector('[role="alert"]')).toBeNull();
});
