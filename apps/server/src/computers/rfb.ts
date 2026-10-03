// S0.5's byte-stream allowlist. WebSocket messages are not RFB message boundaries.
export function viewerStream(forward: (bytes: Buffer) => void, refuse: () => void) {
  let pending: Buffer = Buffer.alloc(0), stage = 0, refused = false;
  return (bytes: Buffer) => {
    if (refused) return;
    const reject = () => { refused = true; pending = Buffer.alloc(0); refuse(); };
    if (pending.length + bytes.length > 8192) return reject();
    pending = Buffer.concat([pending, bytes]);
    while (pending.length) {
      const size = messageSize(pending, stage);
      if (size < 0) return reject();
      if (!size) return;
      if (pending.length < size) return;
      const message = pending.subarray(0, size);
      if (stage < 3 && !message.equals(stage === 0 ? Buffer.from('RFB 003.008\n') : Buffer.from([1]))) return reject();
      if (!validDisplayMessage(stage, message)) return reject();
      // Raw display only: do not negotiate clipboard, continuous updates or Kasm extensions.
      forward(stage === 3 && message[0] === 2 ? Buffer.from([2, 0, 0, 1, 0, 0, 0, 0]) : message);
      pending = pending.subarray(size);
      if (stage < 3) stage++;
    }
  };
}

function messageSize(bytes: Buffer, stage: number): number {
  if (stage < 3) return stage === 0 ? 12 : 1;
  if (bytes[0] === 0) return 20;
  if (bytes[0] === 3) return 10;
  if (bytes[0] !== 2) return -1;
  if (bytes.length < 4) return 0;
  const count = bytes.readUInt16BE(2);
  return count > 256 ? -1 : 4 + count * 4;
}

const frameLimit = 4 * 1024 * 1024;
/** Raw framebuffer framing also removes Kasm's private join/leave notices. */
export function desktopStream(forward: (bytes: Buffer) => void, refuse: () => void) {
  let pending: Buffer = Buffer.alloc(0), stage = 0, refused = false, width = 0, height = 0;
  return (bytes: Buffer) => {
    if (refused) return;
    const reject = () => { refused = true; pending = Buffer.alloc(0); refuse(); };
    if (pending.length + bytes.length > frameLimit) return reject();
    pending = Buffer.concat([pending, bytes]);
    while (pending.length) {
      const size = serverMessageSize(pending, stage, width, height);
      if (size < 0) return reject();
      if (!size || pending.length < size) return;
      const message = pending.subarray(0, size);
      if (stage === 3) {
        width = message.readUInt16BE(); height = message.readUInt16BE(2);
        if (!width || !height || width * height * 4 > frameLimit || message[4] !== 32) return reject();
      }
      if (stage < 4 || message[0] === 0) forward(message);
      pending = pending.subarray(size); if (stage < 4) stage++;
    }
  };
}
function serverMessageSize(bytes: Buffer, stage: number, width: number, height: number): number {
  if (stage === 0) return 12;
  if (stage === 1) return 1 + bytes[0]!;
  if (stage === 2) return 4;
  if (stage === 3) {
    if (bytes.length < 24) return 0;
    const name = bytes.readUInt32BE(20); return name > 1024 ? -1 : 24 + name;
  }
  if (bytes[0] === 253 || bytes[0] === 254) {
    if (bytes.length < 5) return 0;
    const count = bytes.readUInt32BE(1); return count > 65536 ? -1 : 5 + count;
  }
  if (bytes[0] === 2) return 1; // Bell has no display content.
  if (bytes[0] !== 0) return -1; // Never release server clipboard or unknown extensions.
  return framebufferSize(bytes, width, height);
}
function framebufferSize(bytes: Buffer, width: number, height: number): number {
  if (bytes.length < 4) return 0;
  const count = bytes.readUInt16BE(2); if (count > 1024) return -1;
  let size = 4;
  for (let i = 0; i < count; i++) {
    if (bytes.length < size + 12) return 0;
    const w = bytes.readUInt16BE(size + 4), h = bytes.readUInt16BE(size + 6);
    if (bytes.readInt32BE(size + 8) !== 0 || bytes.readUInt16BE(size) + w > width || bytes.readUInt16BE(size + 2) + h > height) return -1;
    size += 12 + w * h * 4; if (size > frameLimit) return -1;
  }
  return size;
}

function validPixelFormat(bytes: Buffer): boolean {
  return bytes[4] === 32 && bytes[5] === 24 && bytes[6] === 0 && bytes[7] === 1 &&
    bytes.readUInt16BE(8) === 255 && bytes.readUInt16BE(10) === 255 && bytes.readUInt16BE(12) === 255 &&
    [...bytes.subarray(14, 17)].sort((a, b) => a - b).join(',') === '0,8,16';
}

function validDisplayMessage(stage: number, message: Buffer): boolean {
  return stage !== 3 || message[0] !== 0 || validPixelFormat(message);
}
