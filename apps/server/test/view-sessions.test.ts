import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ViewSessions } from '../src/computers/view-sessions.ts';
import { LiveViewSession } from '../src/computers/view-session.ts';

function useFakeClock() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] });
  vi.setSystemTime(0);
}

beforeEach(useFakeClock);
afterEach(function restoreClock() { vi.useRealTimers(); });

function ticketIdentity(index: number) {
  return {
    cookie: 'session-cookie',
    memberId: 'member',
    conversationId: 'conversation',
    sessionId: `session-${index}`,
  };
}

it('refuses a ticket after retaining 1,024 unused tickets', () => {
  const sessions = new ViewSessions();
  for (let index = 0; index < 1024; index++) {
    sessions.issueTicket(ticketIdentity(index), 600_000);
  }

  expect(() => sessions.issueTicket(ticketIdentity(1024), 600_000))
    .toThrow('View capacity');
});

it('prunes expired unused tickets before admitting another ticket', () => {
  const sessions = new ViewSessions();
  for (let index = 0; index < 1024; index++) {
    sessions.issueTicket(ticketIdentity(index), 600_000);
  }

  vi.setSystemTime(15_000);

  expect(() => sessions.issueTicket(ticketIdentity(1024), 600_000)).not.toThrow();
});

it('caps viewing at two minutes when sign-in lasts longer', async () => {
  const sessions = new ViewSessions();
  const key = sessions.issueTicket(ticketIdentity(0), 600_000);
  const ticket = sessions.takeTicket(key);
  if (!ticket) throw new Error('Missing issued ticket');

  const stopped = vi.fn();
  const timing = vi.fn();
  const computer = { assistantId: 'assistant', computerId: 'desktop', generation: 1 };
  const steps = {
    check: function check() { return Promise.resolve(computer); },
    openDesktop: function openDesktop() {},
    stop: stopped,
  };
  const session = new LiveViewSession(computer, ticket.expires, timing, steps);

  session.start();
  await vi.advanceTimersByTimeAsync(119_999);
  expect(stopped).not.toHaveBeenCalled();

  await vi.advanceTimersByTimeAsync(1);

  expect(stopped).toHaveBeenCalledExactlyOnceWith('expired');
});
