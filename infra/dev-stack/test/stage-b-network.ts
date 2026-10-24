import { lstat } from 'node:fs/promises';
import { request } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RemoteNetwork } from '@opencrane/models';
import { demoRemoteFixture } from './demo-remote.ts';

export let network: RemoteNetwork;
export async function stageBNetwork(directory: string) {
  try {
    const socket = await lstat(`${directory}/stage-b-demo.sock`);
    if (!socket.isSocket()) throw new Error('Socket required');
  } catch {
    throw new Error('Local demo socket unavailable');
  }
  function forward(incoming: IncomingMessage, outgoing: ServerResponse) {
    const options = { socketPath: `${directory}/stage-b-demo.sock`, path: '/',
      method: incoming.method, headers: incoming.headers };
    function received(reply: IncomingMessage) {
      outgoing.writeHead(reply.statusCode ?? 502, reply.headers);
      reply.pipe(outgoing);
    }
    const upstream = request(options, received);
    function failed() {
      upstream.destroy();
      outgoing.destroy();
    }
    incoming.on('error', failed);
    upstream.on('error', failed);
    function closed() {
      upstream.destroy();
    }
    outgoing.once('close', closed);
    incoming.pipe(upstream);
  }
  const fixture = await demoRemoteFixture({ handler: forward });
  network = fixture.network;
  function stopped() {
    void close().catch(failedClose);
  }
  function failedClose() {
    process.exitCode = 1;
  }
  async function close() {
    process.removeListener('SIGTERM', stopped);
    process.removeListener('SIGINT', stopped);
    await fixture.close();
  }
  process.once('SIGTERM', stopped);
  process.once('SIGINT', stopped);
  return { network, close };
}
