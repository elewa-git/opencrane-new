import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import * as net from 'node:net';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import { expect, it, vi } from 'vitest';
import { workspaceProcess } from '../src/files.ts';
import { record } from '../src/http.ts';

vi.mock('node:net', { spy: true });

interface OutputChunk {
  seq: number;
  stream: string;
  chunk: string;
}

interface ReadBatch {
  chunks: OutputChunk[];
  nextSeq: number;
  exited: boolean;
  closed: boolean;
  exitCode: number | null;
}

function chunk(seq: number, stream: string, text: string): OutputChunk {
  const bytes = Buffer.from(text);
  return { seq, stream, chunk: bytes.toString('base64') };
}

async function executor(batches: ReadBatch[]) {
  const directory = await mkdtemp(`${tmpdir()}/workspace-output-`);
  const socketPath = `${directory}/executor.sock`;
  const sockets = new Set<net.Socket>();
  let readIndex = 0;
  function connected(socket: net.Socket) {
    sockets.add(socket);
    const lines = createInterface({ input: socket });
    function receive(line: string) {
      const request = record(JSON.parse(line));
      if (request['id'] === undefined) return;
      let result: object = {};
      if (request['method'] === 'process/read') {
        const batch = batches[readIndex++]!;
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
  const connection = vi.spyOn(net, 'connect').mockImplementation(connectExecutor);
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

async function keepsOutputAfterEmptyRead() {
  // Match the native executor: nextSeq names the next unread record; afterSeq is exclusive.
  const batches: ReadBatch[] = [
    { chunks: [], nextSeq: 1, exited: false, closed: false, exitCode: null },
    { chunks: [chunk(1, 'stdout', '{}\n')], nextSeq: 4,
      exited: true, closed: true, exitCode: 0 },
  ];
  const fixture = await executor(batches);
  try {
    const result = await workspaceProcess(['snapshot'], Buffer.alloc(0));
    expect(result.exitCode).toBe(0);
    expect(result.output.toString()).toBe('{}\n');
  } finally {
    await fixture.close();
  }
}

it('keeps workspace output that arrives after an empty process read', keepsOutputAfterEmptyRead);

async function keepsConsecutiveChunks() {
  const batches: ReadBatch[] = [
    { chunks: [chunk(1, 'stdout', 'Willow-')], nextSeq: 2,
      exited: false, closed: false, exitCode: null },
    { chunks: [chunk(2, 'stderr', 'diagnostic')], nextSeq: 3,
      exited: false, closed: false, exitCode: null },
    { chunks: [chunk(3, 'stdout', '47')], nextSeq: 4,
      exited: false, closed: false, exitCode: null },
    { chunks: [], nextSeq: 6, exited: true, closed: true, exitCode: 0 },
  ];
  const fixture = await executor(batches);
  try {
    const result = await workspaceProcess(['read-attachment'], Buffer.alloc(0));
    expect(result.exitCode).toBe(0);
    expect(result.output.toString()).toBe('Willow-47');
  } finally {
    await fixture.close();
  }
}

it('keeps every stdout chunk across workspace reads and excludes stderr', keepsConsecutiveChunks);
