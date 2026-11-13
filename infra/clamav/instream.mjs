import { connect } from 'node:net';

function frames(bytes) {
  const parts = [Buffer.from('zINSTREAM\0')];
  for (let offset = 0; offset < bytes.length; offset += 65536) {
    const chunk = bytes.subarray(offset, offset + 65536);
    const size = Buffer.alloc(4);
    size.writeUInt32BE(chunk.length);
    parts.push(size, chunk);
  }
  parts.push(Buffer.alloc(4));
  return Buffer.concat(parts);
}

export function scanClamd(bytes, connection, signal) {
  function exchange(resolve, reject) {
    const socket = connect(connection);
    const chunks = [];
    let length = 0;
    let settled = false;
    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      socket.destroy();
      if (error) reject(new Error('Scanner transport refused', { cause: error }));
      else resolve(value);
    }
    function cancel() {
      finish(new Error('Scanner transport cancelled'));
    }
    function send() {
      socket.end(frames(bytes));
    }
    function read(chunk) {
      length += chunk.length;
      if (length > 4096) cancel();
      else chunks.push(chunk);
    }
    function complete() {
      const reply = Buffer.concat(chunks).toString('utf8');
      if (reply === 'stream: OK\0') finish(undefined, 'clean');
      else if (/^stream: [\x20-\x7e]+ FOUND\0$/u.test(reply)) finish(undefined, 'infected');
      else cancel();
    }
    const timer = setTimeout(cancel, 60000);
    socket.on('connect', send);
    socket.on('data', read);
    socket.on('end', complete);
    socket.on('error', finish);
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
  }
  return new Promise(exchange);
}
