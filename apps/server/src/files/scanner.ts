// Verdict handling adapted from OpenCrane 1's clamscan.ts at 10abd0ef6 (AGPL-3.0-or-later).
// See infra/clamav/upstream for the unchanged scanner and licence.
import { connect } from 'node:net';

export function scanFile(host: string, port: number, bytes: Buffer): Promise<'clean' | 'infected'> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port });
    let response = '';
    const timeout = setTimeout(() => socket.destroy(new Error('Scan timed out')), 60_000);
    socket.once('close', () => clearTimeout(timeout));
    socket.on('error', () => reject(new Error('Scanner unavailable')));
    socket.on('data', (chunk: Buffer) => {
      response += chunk.toString();
      if (response.length > 4096) socket.destroy(new Error('Invalid scanner response'));
      if (!response.includes('\0')) return;
      socket.destroy();
      if (response === 'stream: OK\0') resolve('clean');
      else if (/^stream: .+ FOUND\0$/u.test(response)) resolve('infected');
      else reject(new Error('Scanner refused the file'));
    });
    socket.on('end', () => { if (!response.includes('\0')) reject(new Error('Scanner disconnected')); });
    socket.once('connect', () => {
      socket.write('zINSTREAM\0');
      // The HTTP limit bounds memory; clamd receives the complete body in fixed-size chunks.
      for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
        const chunk = bytes.subarray(offset, offset + 64 * 1024), size = Buffer.alloc(4); size.writeUInt32BE(chunk.length);
        socket.write(size); socket.write(chunk);
      }
      socket.write(Buffer.alloc(4));
    });
  });
}
