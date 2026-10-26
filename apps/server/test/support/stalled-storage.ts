import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { storageClient } from '../../src/files/storage.ts';

export async function stalledStorage(fault: string) {
  let requestCount = 0;
  let responseClosed = false;
  function handle(request: IncomingMessage, response: ServerResponse) {
    requestCount++;
    const regionRequest = request.url?.includes('?location');
    if (regionRequest && !fault.startsWith('region')) {
      response.end('<LocationConstraint>us-east-1</LocationConstraint>');
      return;
    }
    function closed() {
      responseClosed = true;
    }
    request.socket.once('close', closed);
    if (fault === 'headers') return;
    let status = 403;
    if (fault.startsWith('region')) status = 200;
    if (fault.startsWith('put-created')) status = 201;
    response.writeHead(status);
    response.flushHeaders();
    let chunkSize = 128;
    if (fault.endsWith('large')) chunkSize = 16 * 1024;
    // Keep unfinished bodies below the byte limit until well after the deadline.
    const chunk = Buffer.alloc(chunkSize, 65);
    let sent = 0;
    function send() {
      // Keep the response open so only cancellation can close the connection.
      if (fault.endsWith('large') && sent >= 2 * 1024 * 1024) return;
      response.write(chunk);
      sent += chunk.length;
    }
    let intervalMs = 100;
    if (fault.endsWith('large')) intervalMs = 1;
    const interval = setInterval(send, intervalMs);
    function stop() {
      clearInterval(interval);
    }
    response.on('close', stop);
  }
  const server = createServer(handle);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture port');
  const directory = await mkdtemp(`${tmpdir()}/stalled-storage-`);
  const leaseFile = `${directory}/lease`;
  const lease = { accessKey: 'fixture', secretKey: 'fixture', sessionToken: 'fixture',
    expiresAt: Date.now() + 60_000 };
  await writeFile(leaseFile, JSON.stringify(lease), { mode: 0o600 });
  const client = storageClient(`http://127.0.0.1:${address.port}`, leaseFile);
  async function close() {
    server.closeAllConnections();
    server.close();
    await once(server, 'close');
    await rm(directory, { recursive: true, force: true });
  }
  function closed() { return responseClosed; }
  function requests() { return requestCount; }
  return { client, close, closed, requests };
}
