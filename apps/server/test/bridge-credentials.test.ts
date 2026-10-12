import { once } from 'node:events';
import { WebSocket } from 'ws';
import { expect, it } from 'vitest';
import { uploadComputer } from './support/upload-computer.ts';

async function ignoresError() {}

async function connect(url: string, value: string) {
  const options = { headers: { 'x-bridge-token': value } };
  const socket = new WebSocket(`${url.replace('http:', 'ws:')}/bridge`, options);
  socket.on('error', ignoresError);
  await once(socket, 'open');
  return socket;
}

async function refusesReplacement() {
  const computer = await uploadComputer();
  const live = await connect(computer.url, 'test-computer');
  try {
    const replacement = { value: 'forged-computer', id: 'forged', expiresAt: Date.now() + 60_000 };
    const body = JSON.stringify(replacement);
    const attempts = ['', 'wrong-computer', 'expired-computer', 'test-computer'];
    for (const proof of attempts) {
      const options = { method: 'POST', headers: { 'x-bridge-token': proof }, body };
      const response = await fetch(`${computer.url}/credentials`, options);
      expect(response.ok, 'public replacement must be refused').toBe(false);
      expect(await response.text()).not.toContain(replacement.value);
    }
    for (const uid of [1000, 1001, 1002, 1003]) {
      const code = `process.setgroups([]); process.setgid(${uid}); process.setuid(${uid});
        const response = await fetch('http://127.0.0.1:8081/credentials', {
          method: 'POST', body: ${JSON.stringify(body)} });
        console.log(response.status);`;
      const status = await computer.exec('node', '--input-type=module', '-e', code);
      expect(Number(status)).toBe(404);
    }
    const forged = new WebSocket(`${computer.url.replace('http:', 'ws:')}/bridge`, {
      headers: { 'x-bridge-token': replacement.value },
    });
    forged.on('error', ignoresError);
    try {
      const response = await once(forged, 'unexpected-response');
      expect(response).toHaveLength(2);
      live.ping();
      await once(live, 'pong');
      expect(live.readyState).toBe(WebSocket.OPEN);
    } finally {
      forged.terminate();
    }
    const next = await connect(computer.url, 'test-computer');
    next.terminate();
  } finally {
    live.terminate();
    await computer.close();
  }
}

it('refuses credential replacement by local users and keeps the live server connected',
  refusesReplacement, 60_000);
