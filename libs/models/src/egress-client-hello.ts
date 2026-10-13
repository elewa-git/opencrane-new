import type { Socket } from 'node:net';

function refuse() {
  return new Error('egress_tls_refused');
}

class TlsFields {
  private offset = 0;
  private readonly bytes: Buffer;
  constructor(bytes: Buffer) {
    this.bytes = bytes;
  }
  get remaining() {
    return this.bytes.length - this.offset;
  }
  take(size: number): Buffer {
    if (size > this.remaining) {
      throw refuse();
    }
    const field = this.bytes.subarray(this.offset, this.offset + size);
    this.offset += size;
    return field;
  }
  number(width: number) {
    const field = this.take(width);
    return field.readUIntBE(0, width);
  }
  vector(width = 2) {
    const length = this.number(width);
    return this.take(length);
  }
}

function checkNames(bytes: Buffer, host: string) {
  const extension = new TlsFields(bytes);
  const names = new TlsFields(extension.vector());
  if (extension.remaining !== 0 || names.number(1) !== 0) {
    throw refuse();
  }
  const name = names.vector();
  if (names.remaining !== 0 || !name.equals(Buffer.from(host, 'ascii'))) {
    throw refuse();
  }
}

function checkExtensions(bytes: Buffer, host: string) {
  const extensions = new TlsFields(bytes);
  const seen = new Set<number>();
  while (extensions.remaining > 0) {
    const type = extensions.number(2);
    const value = extensions.vector();
    // Refuse hidden names and duplicate extensions instead of choosing one interpretation.
    if (type === 0xfe0d || seen.has(type)) {
      throw refuse();
    }
    seen.add(type);
    if (type === 0) {
      checkNames(value, host);
    }
  }
  if (!seen.has(0)) {
    throw refuse();
  }
}

function checkHello(record: Buffer, host: string) {
  const handshake = new TlsFields(record);
  if (handshake.number(1) !== 1) {
    throw refuse();
  }
  const hello = new TlsFields(handshake.vector(3));
  if (handshake.remaining !== 0 || hello.number(2) !== 0x0303) {
    throw refuse();
  }
  hello.take(32);
  const session = hello.vector(1);
  const ciphers = hello.vector();
  const compression = hello.vector(1);
  if (session.length > 32 || ciphers.length === 0 || ciphers.length % 2 !== 0 ||
      !compression.equals(Buffer.from([0]))) {
    throw refuse();
  }
  checkExtensions(hello.vector(), host);
  if (hello.remaining !== 0) {
    throw refuse();
  }
}

export function readEgressHello(socket: Socket, host: string, signal: AbortSignal) {
  function read(resolve: (bytes: Buffer) => void, reject: (error: Error) => void) {
    let bytes = Buffer.alloc(0);
    function cleanup() {
      socket.pause();
      socket.off('data', received);
      signal.removeEventListener('abort', failed);
    }
    function failed() {
      cleanup();
      reject(refuse());
    }
    function received(chunk: Buffer) {
      if (bytes.length + chunk.length > 16_384) {
        return failed();
      }
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length < 5) {
        return;
      }
      const length = bytes.readUInt16BE(3);
      if (bytes[0] !== 22 || bytes[1] !== 3 || ![1, 2, 3].includes(bytes[2]!) ||
          length > 16_379) {
        return failed();
      }
      if (bytes.length < length + 5) {
        return;
      }
      try {
        checkHello(bytes.subarray(5, length + 5), host);
      } catch {
        return failed();
      }
      cleanup();
      resolve(bytes);
    }
    signal.addEventListener('abort', failed, { once: true });
    socket.on('data', received);
    if (signal.aborted) {
      failed();
    } else {
      socket.resume();
    }
  }
  return new Promise<Buffer>(read);
}
