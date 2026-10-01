// Deliberately sends input even for viewers: a UI viewOnly flag proves nothing.
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { once } from 'node:events';
import { until } from '../s0-3-warm-pool/lab.mjs';
export async function rfb(url, token, origin = 'http://opencrane.local', fragmented = false) {
  const socket = new WebSocket(url.replace('http:', 'ws:') + '/computers/c1/view', 'binary', {
    headers: { authorization: `Bearer ${token}`, origin },
  });
  let buffer = Buffer.alloc(0);
  socket.on('message', bytes => { buffer = Buffer.concat([buffer, bytes]); });
  await once(socket, 'open');
  const take = async count => { await until(() => buffer.length >= count, `RFB ${count} bytes`, 10000); const out = buffer.subarray(0, count); buffer = buffer.subarray(count); return out; };
  assert.equal((await take(12)).toString(), 'RFB 003.008\n');
  for (const byte of Buffer.from('RFB 003.008\n')) socket.send(Buffer.from([byte]));
  const count = (await take(1))[0]; assert.ok((await take(count)).includes(1)); socket.send(Buffer.from([1]));
  assert.equal((await take(4)).readUInt32BE(), 0); socket.send(Buffer.from([1]));
  const init = await take(24); const width = init.readUInt16BE(0); const height = init.readUInt16BE(2);
  await take(init.readUInt32BE(20)); assert.equal(width, 800); assert.equal(height, 600);
  // Raw encoding: decode a real framebuffer instead of counting opaque network bytes.
  const format = Buffer.alloc(20); init.copy(format, 4, 4, 20);
  const encodings = Buffer.from([2, 0, 0, 1, 0, 0, 0, 0]);
  const request = Buffer.alloc(10); request[0] = 3; request.writeUInt16BE(width, 6); request.writeUInt16BE(height, 8);
  const display = Buffer.concat([format, encodings, request]);
  socket.send(display.subarray(0, 3), { fin: !fragmented });
  socket.send(display.subarray(3, 22), { fin: true });
  socket.send(display.subarray(22));
  let type = (await take(1))[0];
  while (type === 253 || type === 254) { // Kasm session join/leave notifications.
    await take((await take(4)).readUInt32BE());
    type = (await take(1))[0];
  }
  assert.equal(type, 0); const update = await take(3); const rectangles = update.readUInt16BE(1); assert.ok(rectangles > 0);
  let pixels = 0;
  for (let i = 0; i < rectangles; i++) {
    const rect = await take(12); assert.equal(rect.readInt32BE(8), 0);
    const count = rect.readUInt16BE(4) * rect.readUInt16BE(6); await take(count * (init[4] / 8)); pixels += count;
  }
  const key = code => { for (const down of [1, 0]) { const b = Buffer.alloc(8); b[0] = 4; b[1] = down; b.writeUInt32BE(code, 4); socket.send(b); } };
  // Kasm extends pointer packets to 11 bytes (16-bit mask and scroll deltas).
  const pointer = (x, y) => { const b = Buffer.alloc(11); b[0] = 5; b.writeUInt16BE(x, 3); b.writeUInt16BE(y, 5); socket.send(b); };
  return { socket, key, pointer, pixels };
}

export function clipboard(text, declaredLength = Buffer.byteLength(text)) {
  const mime = Buffer.from('text/plain');
  const header = Buffer.alloc(3 + mime.length + 4);
  header[0] = 180; header[1] = 1; header[2] = mime.length;
  mime.copy(header, 3); header.writeUInt32BE(declaredLength, 3 + mime.length);
  return Buffer.concat([header, Buffer.from(text)]);
}
