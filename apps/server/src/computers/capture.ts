import type { Duplex } from 'node:stream';
import { crc32, deflateSync } from 'node:zlib';

const frameLimit = 4 * 1024 * 1024;

/** Read one complete framebuffer from the existing authenticated, read-only desktop transport. */
export async function captureDesktop(stream: Duplex) {
  let buffer: Buffer = Buffer.alloc(0), failure: Error | undefined, wake: (() => void) | undefined;
  const fail = () => { failure = new Error('Desktop capture unavailable'); wake?.(); };
  const data = (bytes: Buffer) => {
    if (buffer.length + bytes.length > frameLimit + 65536) { fail(); stream.destroy(); return; }
    buffer = Buffer.concat([buffer, bytes]); wake?.();
  };
  stream.on('data', data); stream.on('error', fail); stream.on('close', fail); stream.on('end', fail);
  const timer = setTimeout(() => { fail(); stream.destroy(); }, 10_000);
  const take = async (count: number) => {
    if (count > frameLimit || count < 0) throw new Error('Desktop capture limit');
    while (buffer.length < count) {
      if (failure) throw failure;
      await new Promise<void>(resolve => { wake = resolve; }); wake = undefined;
    }
    const bytes = buffer.subarray(0, count); buffer = buffer.subarray(count); return bytes;
  };
  try {
    if ((await take(12)).toString() !== 'RFB 003.008\n') throw new Error('Desktop protocol');
    stream.write(Buffer.from('RFB 003.008\n'));
    const securityCount = (await take(1))[0]!;
    if (!securityCount || !(await take(securityCount)).includes(1)) throw new Error('Desktop authentication');
    stream.write(Buffer.from([1]));
    if ((await take(4)).readUInt32BE() !== 0) throw new Error('Desktop authentication');
    stream.write(Buffer.from([1]));
    const init = await take(24), width = init.readUInt16BE(), height = init.readUInt16BE(2);
    if (!width || !height || width > 4096 || height > 4096 || width * height * 4 > frameLimit || init.readUInt32BE(20) > 1024) throw new Error('Desktop capture limit');
    await take(init.readUInt32BE(20));
    // Fixed true-colour RGB bytes, little-endian, no clipboard, input or extension encodings.
    const format = Buffer.from([0, 0, 0, 0, 32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 0, 8, 16, 0, 0, 0]);
    stream.write(format); stream.write(Buffer.from([2, 0, 0, 1, 0, 0, 0, 0]));
    const request = Buffer.alloc(10); request[0] = 3; request.writeUInt16BE(width, 6); request.writeUInt16BE(height, 8); stream.write(request);
    const pixels = await framebuffer(take, width, height);
    return { bytes: png(width, height, pixels), width, height, capturedAt: new Date().toISOString() };
  } finally {
    clearTimeout(timer); stream.off('data', data); stream.destroy();
  }
}

async function framebuffer(take: (count: number) => Promise<Buffer>, width: number, height: number) {
  let type = (await take(1))[0]!;
  for (let extensions = 0; type !== 0; extensions++) {
    if (extensions >= 64 || ![2, 253, 254].includes(type)) throw new Error('Desktop protocol');
    if (type !== 2) {
      const size = (await take(4)).readUInt32BE(); if (size > 65536) throw new Error('Desktop capture limit');
      await take(size);
    }
    type = (await take(1))[0]!;
  }
  const rectangles = (await take(3)).readUInt16BE(1);
  if (!rectangles || rectangles > 1024) throw new Error('Desktop capture limit');
  const pixels = Buffer.alloc(width * height * 3), covered = new Uint8Array(width * height);
  let total = 0;
  for (let index = 0; index < rectangles; index++) {
    const rectangle = await take(12), x = rectangle.readUInt16BE(), y = rectangle.readUInt16BE(2), w = rectangle.readUInt16BE(4), h = rectangle.readUInt16BE(6);
    total += w * h * 4;
    checkRectangle(rectangle, width, height, total);
    const raw = await take(w * h * 4);
    for (let row = 0; row < h; row++) for (let column = 0; column < w; column++) {
      const target = (y + row) * width + x + column, source = (row * w + column) * 4;
      raw.copy(pixels, target * 3, source, source + 3); covered[target] = 1;
    }
  }
  if (covered.includes(0)) throw new Error('Incomplete desktop capture');
  return pixels;
}
function checkRectangle(rectangle: Buffer, width: number, height: number, total: number) {
  const w = rectangle.readUInt16BE(4), h = rectangle.readUInt16BE(6);
  if (!w || !h || rectangle.readUInt16BE() + w > width || rectangle.readUInt16BE(2) + h > height || rectangle.readInt32BE(8) !== 0 || total > frameLimit) throw new Error('Desktop capture limit');
}
function chunk(type: string, bytes: Buffer) {
  const name = Buffer.from(type), size = Buffer.alloc(4), checksum = Buffer.alloc(4);
  size.writeUInt32BE(bytes.length); checksum.writeUInt32BE(crc32(Buffer.concat([name, bytes])));
  return Buffer.concat([size, name, bytes, checksum]);
}
function png(width: number, height: number, pixels: Buffer) {
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const rows = Buffer.alloc(height * (width * 3 + 1));
  for (let row = 0; row < height; row++) pixels.copy(rows, row * (width * 3 + 1) + 1, row * width * 3, (row + 1) * width * 3);
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
