import { TestBed } from '@angular/core/testing';
import { chatListSchema } from '@opencrane/protocol';
import { ChatSession } from './chat-session';
import { SOCKET_FACTORY, type SocketLike } from '../core/socket-factory';

function createSocket(): SocketLike {
  return { readyState: 1, onopen: null, onmessage: null, onclose: null, onerror: null,
    send: vi.fn(), close: vi.fn() };
}
function historyReply(): Promise<Response> {
  const feed = { rows: [], position: 0, generation: 1, computerState: 'ready' };
  return Promise.resolve(new Response(JSON.stringify(feed)));
}
function rejectsUnusedServerConfiguration() {
  const row = {
    conversationId: 'chat', assistantId: 'assistant', createdBy: 'me',
    createdAt: '2026-11-16T00:00:00Z', assistantKind: 'team',
    sessionConfiguration: { executionMode: 'memory_free' },
  };
  const result = chatListSchema.safeParse({ rows: [row] });
  expect(result.success).toBe(false);
}
it('rejects the unused server session configuration field', rejectsUnusedServerConfiguration);

async function selectsDefaultFromExistingFacts(assistantKind: 'personal' | 'team') {
  const rows = chatListSchema.parse({ rows: [{ conversationId: 'chat', assistantId: 'assistant',
    createdBy: 'me', createdAt: '2026-11-16T00:00:00Z', assistantKind }] }).rows;
  vi.spyOn(globalThis, 'fetch').mockImplementation(historyReply);
  const socketProvider = { provide: SOCKET_FACTORY, useValue: createSocket };
  TestBed.configureTestingModule({ providers: [ChatSession, socketProvider] });
  const chat = TestBed.inject(ChatSession);
  try {
    chat.conversations.set(rows);
    await chat.select('chat');
    const expectedMode = assistantKind === 'personal' ? 'memory_free' : 'restricted';
    expect(chat.executionMode()).toBe(expectedMode);
  } finally {
    chat.ngOnDestroy();
  }
}
it.each(['personal', 'team'] as const)(
  'selects the existing %s composer default without adding response fields',
  selectsDefaultFromExistingFacts);
