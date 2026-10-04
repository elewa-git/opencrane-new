import type { LeaseNotice } from '../../src/computers/view-lease.ts';
import { z } from 'zod';
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
  function receive(bytes: unknown, binary = true) {
    if (binary && Buffer.isBuffer(bytes)) buffer = Buffer.concat([buffer, bytes]);
  }
  socket.on(socket instanceof WebSocket ? 'message' : 'data', receive);
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

export function nextBinaryMessage(socket: WebSocket): Promise<Buffer> {
  function wait(resolve: (bytes: Buffer) => void, reject: (error: Error) => void) {
    function cleanup() {
      socket.off('message', receive);
      socket.off('close', closed);
      socket.off('error', failed);
    }
    function receive(bytes: unknown, binary: boolean) {
      if (!binary || !Buffer.isBuffer(bytes)) return;
      cleanup();
      resolve(bytes);
    }
    function closed() { cleanup(); reject(new Error('Viewer disconnected')); }
    function failed(error: Error) { cleanup(); reject(error); }
    socket.on('message', receive);
    socket.once('close', closed);
    socket.once('error', failed);
  }
  return new Promise(wait);
}
export function recordLeaseNotices(socket: WebSocket) {
  const notices: { notice: LeaseNotice; at: number }[] = [];
  function receive(bytes: unknown, binary: boolean) {
    if (binary) return;
    const schema = z.discriminatedUnion('lease', [
      z.object({ lease: z.literal('paused') }),
      z.object({ lease: z.literal('valid'), at: z.number(), until: z.number() }),
    ]);
    const notice = schema.parse(JSON.parse(String(bytes)));
    notices.push({ notice, at: performance.now() });
  }
  socket.on('message', receive);
  return notices;
}
export async function expectUnavailablePause(socket: WebSocket, failedAt: number,
  notices: ReturnType<typeof recordLeaseNotices>) {
  const closed = once(socket, 'close');
  let binaryAfterPause = false;
  function receive(_bytes: unknown, binary: boolean) {
    if (binary && notices.some(isPaused)) binaryAfterPause = true;
  }
  function isPaused(entry: (typeof notices)[number]) { return entry.notice.lease === 'paused'; }
  function paused() { return notices.some(isPaused); }
  socket.on('message', receive);
  await until(paused, 2000);
  const pause = notices.find(isPaused)!;
  expect(pause.at - failedAt).toBeLessThan(2000);
  expect((await closed)[0]).toBe(4503);
  expect(performance.now() - pause.at).toBeGreaterThanOrEqual(9500);
  expect(performance.now() - pause.at).toBeLessThan(12_500);
  expect(binaryAfterPause).toBe(false);
  socket.off('message', receive);
}
