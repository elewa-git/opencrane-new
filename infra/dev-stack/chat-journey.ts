import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { chatMessageSchema } from '@opencrane/protocol';

/** Uses the joined member's real session, HTTP commands and the browser's existing realtime socket. */
export async function chatJourney(server: string, headers: { origin: string; cookie: string }, assistantId: string) {
  const conversationId = randomUUID();
  const post = async (path: string, body: unknown) => {
    const response = await fetch(`${server}${path}`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(response.status, 200, `Chat command ${path}`);
  };
  await post('/api/conversations', { id: randomUUID(), conversationId, assistantId });
  const rows: Array<ReturnType<typeof chatMessageSchema.parse>> = [];
  let socket: WebSocket;
  const connect = async (since: number, generation?: number) => {
    const ws = new WebSocket(`${server.replace('http:', 'ws:')}/ws`, { headers });
    ws.on('message', raw => rows.push(chatMessageSchema.parse(JSON.parse(String(raw)))));
    await once(ws, 'open'); ws.send(JSON.stringify({ type: 'subscribe', topic: 'conversation', conversationId, since, generation })); return ws;
  };
  const until = async (check: () => boolean | Promise<boolean>) => {
    const deadline = Date.now() + 60_000;
    while (!await check()) { assert(Date.now() < deadline, 'Chat journey timeout'); await delay(50); }
  };
  await until(async () => (await fetch(`${server}/api/conversations/${conversationId}/messages`, { headers })).ok);
  socket = await connect(0);
  const message = async () => {
    const start = performance.now(), id = randomUUID();
    await post(`/api/conversations/${conversationId}/messages`, { id, text: 'Say hello briefly.' });
    await until(() => rows.some(r => r.row?.type === 'agent.message_delta' && (r.row.data as { turnId: string }).turnId === id));
    const firstTokenMs = Math.round(performance.now() - start);
    await until(() => rows.some(r => r.row?.type === 'agent.turn_completed' && (r.row.data as { turnId: string }).turnId === id));
    assert(rows.some(r => r.row?.type === 'agent.message_delta'));
    const response = await fetch(`${server}/api/conversations/${conversationId}/messages`, { headers });
    assert.equal(response.status, 200); assert((await response.text()).includes('Hello from your computer.'));
    return { firstTokenMs, completeMs: Math.round(performance.now() - start) };
  };
  return {
    conversationId,
    message,
    async reconnect() {
      const last = rows.filter(r => r.type === 'event').at(-1)!; socket.terminate(); await once(socket, 'close');
      const before = rows.length; socket = await connect(last.position, last.generation);
      await until(() => rows.slice(before).some(r => r.type === 'ready'));
      assert(!rows.slice(before).some(r => r.type === 'event'), 'Reconnect has no duplicates');
      const positions = rows.filter(r => r.type === 'event').map(r => r.position);
      assert.equal(new Set(positions).size, positions.length);
    },
    starting: () => rows.some(r => r.computerState === 'starting'),
    close: () => socket.terminate(),
  };
}
