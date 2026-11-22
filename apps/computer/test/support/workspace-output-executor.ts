import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import * as net from 'node:net';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import { vi } from 'vitest';
import { record } from '../../src/http.ts';

interface OutputChunk {
  seq: number;
  stream: string;
  chunk: string;
}

export interface WorkspaceReadBatch {
  chunks: OutputChunk[];
  nextSeq: number;
  exited: boolean;
  closed: boolean;
  exitCode: number | null;
}

export async function workspaceOutputExecutor(batches: WorkspaceReadBatch[]) {
  const directory = await mkdtemp(`${tmpdir()}/workspace-output-`);
  const socketPath = `${directory}/executor.sock`;
  const sockets = new Set<net.Socket>();
  let readIndex = 0;
  function connected(socket: net.Socket) {
    sockets.add(socket);
    const lines = createInterface({ input: socket });
    function receive(line: string) {
      const decodedRequest: unknown = JSON.parse(line);
      const request = record(decodedRequest);
      if (request['id'] === undefined) return;
      let result: object = {};
      if (request['method'] === 'process/read') {
        const batch = batches[readIndex++];
        if (!batch) {
          throw new Error('Unexpected executor read');
        }
        const params = record(request['params']);
        const afterSeq = params['afterSeq'] ?? 0;
        function unread(output: OutputChunk) {
          return typeof afterSeq === 'number' && output.seq > afterSeq;
        }
        const chunks = batch.chunks.filter(unread);
        result = { ...batch, chunks };
      }
      const response = { id: request['id'], result };
      socket.write(`${JSON.stringify(response)}\n`);
    }
    lines.on('line', receive);
  }
  const server = net.createServer(connected);
  server.listen(socketPath);
  await once(server, 'listening');
  const nativeNet = await vi.importActual<typeof net>('node:net');
  function connectExecutor() {
    return nativeNet.connect(socketPath);
  }
  const connection = vi.spyOn(net, 'connect');
  connection.mockImplementation(connectExecutor);
  async function close() {
    connection.mockRestore();
    for (const socket of sockets) socket.destroy();
    const stopped = once(server, 'close');
    server.close();
    await stopped;
    await rm(directory, { recursive: true, force: true });
  }
  return { close };
}
