import { request } from 'node:http';
import { createLogger } from '@opencrane/observability';

const logger = createLogger('web-upgrade');

export function forwardUpgrade(incoming, socket, head, target) {
  const upstream = request(target, { method: incoming.method, headers: incoming.headers });
  let upstreamSocket;

  function close() {
    upstream.destroy();
    upstreamSocket?.destroy();
    socket.destroy();
  }

  function failed(error) {
    logger.warn({ err: error }, 'WebSocket proxy connection failed');
    close();
  }

  function connected(response, remote, remoteHead) {
    upstreamSocket = remote;
    // Handle disconnects before writing headers or starting either direction of the stream.
    remote.on('error', failed);
    remote.on('close', close);
    const status = `HTTP/${response.httpVersion} ${response.statusCode} `
      + `${response.statusMessage}\r\n`;
    socket.write(status);
    for (const [name, value] of Object.entries(response.headers)) {
      if (value !== undefined) socket.write(`${name}: ${value}\r\n`);
    }
    socket.write('\r\n');
    if (remoteHead.length) socket.write(remoteHead);
    if (head.length) remote.write(head);
    remote.pipe(socket);
    socket.pipe(remote);
  }

  socket.on('error', failed);
  socket.on('close', close);
  upstream.on('upgrade', connected);
  upstream.on('response', close);
  upstream.on('error', failed);
  upstream.end();
}
