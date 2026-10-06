// Adapted from OpenCrane 1 commit 10abd0ef6 (AGPL-3.0-or-later).
// See infra/clamav/upstream for the unchanged scanner and licence.
import { connect, type Socket } from 'node:net';
import { FileUnavailable, isDependencyOutage } from './refusals.ts';

type ScanVerdict = 'clean' | 'infected';

export function scanFile(host: string, port: number, bytes: Buffer): Promise<ScanVerdict> {
  function startScan(resolve: (verdict: ScanVerdict) => void, reject: (error: Error) => void) {
    const connection = { host, port };
    const socket = connect(connection);
    let response = '';

    function timeOutScan() {
      socket.destroy(new FileUnavailable('scanner'));
    }
    const timeout = setTimeout(timeOutScan, 60_000);

    function clearScanTimeout() {
      clearTimeout(timeout);
    }

    function failScan(error: Error) {
      if (isDependencyOutage(error) && !(error instanceof FileUnavailable)) {
        const cause = { cause: error };
        reject(new FileUnavailable('scanner', cause));
        return;
      }
      reject(error);
    }

    function readScanResponse(chunk: Buffer) {
      response += chunk.toString();
      if (response.length > 4096) {
        socket.destroy(new Error('Invalid scanner response'));
        return;
      }
      if (!response.includes('\0')) {
        return;
      }
      socket.destroy();
      if (response === 'stream: OK\0') {
        resolve('clean');
      } else if (/^stream: .+ FOUND\0$/u.test(response)) {
        resolve('infected');
      } else {
        reject(new Error('Invalid scanner response'));
      }
    }

    function finishScanResponse() {
      if (!response.includes('\0')) {
        reject(new Error('Scanner disconnected'));
      }
    }

    function sendScanRequest() {
      writeScanRequest(socket, bytes);
    }

    socket.once('close', clearScanTimeout);
    socket.on('error', failScan);
    socket.on('data', readScanResponse);
    socket.on('end', finishScanResponse);
    socket.once('connect', sendScanRequest);
  }
  return new Promise(startScan);
}

function writeScanRequest(socket: Socket, bytes: Buffer) {
  socket.write('zINSTREAM\0');
  // The HTTP limit bounds memory; clamd receives the complete body in fixed-size chunks.
  for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
    const chunk = bytes.subarray(offset, offset + 64 * 1024);
    const size = Buffer.alloc(4);
    size.writeUInt32BE(chunk.length);
    socket.write(size);
    socket.write(chunk);
  }
  socket.write(Buffer.alloc(4));
}
