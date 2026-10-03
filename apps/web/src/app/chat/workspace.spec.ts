import { TestBed } from '@angular/core/testing';
import { Workspace } from './workspace';
import { SOCKET_FACTORY, type SocketLike } from '../core/socket-factory';

afterEach(() => { vi.restoreAllMocks(); history.replaceState({}, '', '/'); });
it('renders streamed replies, wake progress and durable Stop, then replays the stopped partial', async () => {
  history.replaceState({}, '', '/workspace?conversation=chat');
  const rows = [{ id: 'create', position: 1, type: 'conversation.created', time: '2026-10-02T10:00:00Z', data: {} },
    { id: 'message', position: 2, type: 'message.posted', time: '2026-10-02T10:00:00Z', data: { text: 'Hi', authorId: 'me' } }];
  vi.spyOn(globalThis, 'fetch').mockImplementation(input => {
    const path = input instanceof Request ? input.url : String(input);
    const body = path === '/auth/me' ? { authenticated: true, user: { name: 'Alex Morgan' } } : path === '/api/chat' ? { memberId: 'me', assistantId: 'assistant' } : path === '/api/conversations' ? { rows: [] }
      : { rows, position: 2, generation: 1, computerState: 'starting your computer' };
    return Promise.resolve(new Response(JSON.stringify(body)));
  });
  const socket: SocketLike = { readyState: 1, onopen: null, onclose: null, onerror: null, onmessage: null, send: vi.fn(), close: vi.fn() };
  TestBed.configureTestingModule({ providers: [{ provide: SOCKET_FACTORY, useValue: () => socket }] });
  const fixture = TestBed.createComponent(Workspace); await fixture.whenStable();
  const value: unknown = fixture.nativeElement;
  if (!(value instanceof HTMLElement)) throw new Error('No root');
  const root = value;
  await vi.waitFor(() => expect(root.textContent).toContain('Starting your computer'));
  socket.onopen?.(new Event('open')); await fixture.whenStable();
  const message = (type: string, position: number, data: object) => socket.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ type: 'event', version: 1, topic: 'conversation', conversationId: 'chat', generation: 1, position,
    row: { id: `r${position}`, type, position, time: '2026-10-02T10:00:00Z', data } }) }));
  message('agent.message_delta', 3, { turnId: 'message', messageId: 'reply', text: 'Hello ' });
  message('agent.message_delta', 4, { turnId: 'message', messageId: 'reply', text: 'there' });
  await fixture.whenStable(); expect(root.textContent).toContain('Hello there');
  message('decision.recorded', 5, { turnId: 'message', reason: 'budget_exhausted' });
  await fixture.whenStable(); expect(root.querySelector('.budget-refusal')?.textContent).toContain('Spending limit reached');
  expect(root.querySelector('.budget-refusal')?.textContent).toContain('Owner or Admin');
  message('agent.turn_stop_requested', 6, { turnId: 'message' });
  message('agent.message_completed', 7, { turnId: 'message', messageId: 'reply', text: 'Hello there and more' });
  await fixture.whenStable(); expect(root.textContent).toContain('Stopped'); expect(root.textContent).not.toContain('and more');
  expect(root.querySelector('[aria-live="polite"]')).not.toBeNull();
});
