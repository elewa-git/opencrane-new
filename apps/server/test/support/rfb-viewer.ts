import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { expect } from 'vitest';
import { until } from '@opencrane/authz/testing';
import { WebSocket } from 'ws';
import type { Duplex } from 'node:stream';

/** Decode real raw rectangles. A successful handshake alone is not framebuffer proof. */
export async function rfbViewer<T extends WebSocket | Duplex>(socket: T) {
  let buffer: Buffer = Buffer.alloc(0);
  const send = (bytes: Buffer) => { if (socket instanceof WebSocket) socket.send(bytes); else socket.write(bytes); };
  socket.on(socket instanceof WebSocket ? 'message' : 'data', (bytes: unknown) => { if (Buffer.isBuffer(bytes)) buffer = Buffer.concat([buffer, bytes]); });
  const take = async (count: number) => {
    await until(() => { if ((socket instanceof WebSocket ? socket.readyState === socket.CLOSED : socket.destroyed)) throw new Error('Viewer disconnected'); return buffer.length >= count; });
    const out = buffer.subarray(0, count); buffer = buffer.subarray(count); return out;
  };
  if (socket instanceof WebSocket) await once(socket, 'open');
  expect((await take(12)).toString()).toBe('RFB 003.008\n');
  for (const byte of Buffer.from('RFB 003.008\n')) send(Buffer.from([byte]));
  const count = (await take(1))[0]!; expect(await take(count)).toContain(1); send(Buffer.from([1]));
  expect((await take(4)).readUInt32BE()).toBe(0); send(Buffer.from([1]));
  const init = await take(24), width = init.readUInt16BE(), height = init.readUInt16BE(2); await take(init.readUInt32BE(20));
  expect([width, height]).toEqual([800, 600]);
  const format = Buffer.alloc(20); init.copy(format, 4, 4, 20);
  send(Buffer.concat([format, Buffer.from([2, 0, 0, 1, 0, 0, 0, 0])]));
  const request = Buffer.alloc(10); request[0] = 3; request.writeUInt16BE(width, 6); request.writeUInt16BE(height, 8);
  const refresh = async () => {
    send(request);
    let type = (await take(1))[0];
    while (type === 253 || type === 254) { await take((await take(4)).readUInt32BE()); type = (await take(1))[0]; }
    expect(type).toBe(0); const rectangles = (await take(3)).readUInt16BE(1), hash = createHash('sha256'); let pixels = 0;
    for (let i = 0; i < rectangles; i++) {
      const rectangle = await take(12); expect(rectangle.readInt32BE(8)).toBe(0);
      const count = rectangle.readUInt16BE(4)*rectangle.readUInt16BE(6); pixels += count; hash.update(await take(count*(init[4]!/8)));
    }
    return { pixels, hash: hash.digest('hex') };
  };
  return { socket, request, refresh, first: await refresh() };
}
