import { createHash } from 'node:crypto';
import { connect } from 'node:net';
import { createInterface } from 'node:readline';
import { isSafeFileName, isSafeId, MAX_UPLOAD_BYTES } from './file-rules.ts';
import { record } from './http.ts';

export interface WorkspaceFile {
  conversationId: string;
  fileId: string;
  name: string;
  size: number;
  sha256: string;
}

function metadata(value: Record<string, unknown>): WorkspaceFile {
  const conversationId = value['conversationId'];
  const fileId = value['fileId'];
  const name = value['name'];
  const size = value['size'];
  const sha256 = value['sha256'];

  if (typeof conversationId !== 'string' || !isSafeId(conversationId)
    || typeof fileId !== 'string' || !isSafeId(fileId)
    || typeof name !== 'string' || !isSafeFileName(name)
    || typeof size !== 'number' || !Number.isSafeInteger(size)
    || size < 1 || size > MAX_UPLOAD_BYTES
    || typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(sha256)) {
    throw new Error('Invalid file');
  }
  return { conversationId, fileId, name, size, sha256 };
}

export function filePackets(
  receive: (file: WorkspaceFile, bytes: Buffer) => Promise<void | 'kept_existing'>,
) {
  let file: WorkspaceFile | undefined;
  let parts: Buffer[] = [];
  let size = 0;
  let busy = false;

  function beginFile(input: Record<string, unknown>) {
    file = metadata(input);
    parts = [];
    size = 0;
  }

  function appendChunk(input: Record<string, unknown>, currentFile: WorkspaceFile) {
    if (input['offset'] !== size || typeof input['bytes'] !== 'string'
      || input['bytes'].length > 88_000) {
      throw new Error('Invalid chunk');
    }
    const bytes = Buffer.from(input['bytes'], 'base64');
    if (!bytes.length || size + bytes.length > currentFile.size) {
      throw new Error('File size mismatch');
    }
    parts.push(bytes);
    size += bytes.length;
  }

  async function finishFile(currentFile: WorkspaceFile) {
    if (size !== currentFile.size) throw new Error('Incomplete file');
    const bytes = Buffer.concat(parts);
    file = undefined;
    parts = [];
    busy = true;
    try {
      const digest = createHash('sha256').update(bytes).digest('hex');
      if (digest !== currentFile.sha256) throw new Error('File digest mismatch');
      const outcome = await receive(currentFile, bytes) ?? 'saved';
      return {
        type: 'file_received',
        fileId: currentFile.fileId,
        sha256: currentFile.sha256,
        outcome,
      };
    } finally {
      busy = false;
    }
  }

  return async function receivePacket(input: Record<string, unknown>) {
    if (busy) throw new Error('File delivery busy');
    if (input['type'] === 'file_begin') {
      beginFile(input);
      return undefined;
    }
    const currentFile = file;
    if (!currentFile) throw new Error('No file');
    if (input['type'] === 'file_chunk') {
      appendChunk(input, currentFile);
      return undefined;
    }
    if (input['type'] !== 'file_end') throw new Error('Incomplete file');
    return finishFile(currentFile);
  };
}

/** Use the socket-denied tools executor: the Codex UID cannot write workspace files. */
export async function receiveFile(file: WorkspaceFile, bytes: Buffer) {
  const result = await workspaceProcess(
    ['/opt/python/bin/python', '/app/src/receive-file.py', JSON.stringify(file)],
    bytes,
  );
  if (result.exitCode === 10) return 'kept_existing' as const;
  if (result.exitCode !== 0) throw new Error('Workspace conversion failed');
  return;
}

interface PendingCall {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

function rejectPendingCalls(pending: Map<number, PendingCall>) {
  for (const call of pending.values()) {
    call.reject(new Error('Workspace executor unavailable'));
  }
}

function createResponseHandler(pending: Map<number, PendingCall>) {
  return function handleResponseLine(line: string) {
    const message = record(JSON.parse(line) as unknown);
    const id = message['id'];
    if (typeof id !== 'number') return;
    const call = pending.get(id);
    if (!call) return;
    pending.delete(id);
    if (message['error']) call.reject(new Error('Workspace executor refused'));
    else call.resolve(message['result']);
  };
}

function createRpc(socket: ReturnType<typeof connect>, pending: Map<number, PendingCall>) {
  let nextId = 0;
  return function rpc(method: string, params: Record<string, unknown>) {
    const id = ++nextId;
    function sendRequest(resolve: (value: unknown) => void, reject: (error: Error) => void) {
      pending.set(id, { resolve, reject });
      const request = { id, method, params };
      socket.write(`${JSON.stringify(request)}\n`);
    }
    return new Promise<unknown>(sendRequest);
  };
}

function writeChunk(rpc: ReturnType<typeof createRpc>, processId: string,
  offset: number, bytes: Buffer) {
  return rpc('process/write', {
    processId,
    writeId: String(offset),
    chunk: bytes.subarray(offset, offset + 64 * 1024).toString('base64'),
  });
}

async function sendInput(rpc: ReturnType<typeof createRpc>, processId: string, bytes: Buffer) {
  for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
    const response = record(await writeChunk(rpc, processId, offset, bytes));
    if (response['status'] !== 'accepted') throw new Error('Workspace write refused');
  }
}

async function readOutput(rpc: ReturnType<typeof createRpc>, processId: string) {
  let afterSeq: number | null = null;
  let length = 0;
  const output: Buffer[] = [];
  while (true) {
    const result = record(await rpc('process/read', {
      processId,
      afterSeq,
      maxBytes: 64 * 1024,
      waitMs: 1000,
    }));
    if (!Array.isArray(result['chunks']) || typeof result['nextSeq'] !== 'number') {
      throw new Error('Invalid workspace output');
    }
    for (const rawChunk of result['chunks']) {
      const chunk = record(rawChunk);
      const data = chunk['chunk'];
      if (typeof data !== 'string') throw new Error('Invalid workspace chunk');
      const decoded = Buffer.from(data, 'base64');
      length += decoded.length;
      if (length > 64 * 1024) throw new Error('Workspace output too large');
      if (chunk['stream'] === 'stdout') output.push(decoded);
    }
    afterSeq = result['nextSeq'];
    if (result['exited'] && result['closed']) {
      return { exitCode: result['exitCode'], output: Buffer.concat(output) };
    }
  }
}

export async function workspaceProcess(argv: string[], bytes: Buffer) {
  const socket = connect('/run/executor/exec.sock');
  const lines = createInterface({ input: socket });
  const pending = new Map<number, PendingCall>();
  const handleResponseLine = createResponseHandler(pending);
  const rpc = createRpc(socket, pending);
  const timeout = setTimeout(destroySocketForTimeout, 80_000);

  function destroySocketForTimeout() {
    socket.destroy(new Error('Workspace delivery timed out'));
  }

  function rejectCalls() {
    rejectPendingCalls(pending);
  }

  socket.on('error', rejectCalls);
  lines.on('line', handleResponseLine);

  try {
    await rpc('initialize', { clientName: 'opencrane-upload' });
    socket.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
    const processId = 'upload';
    await rpc('process/start', {
      processId,
      argv,
      cwd: 'file:///workspace',
      env: {},
      tty: false,
      pipeStdin: true,
      arg0: null,
    });
    await sendInput(rpc, processId, bytes);
    return await readOutput(rpc, processId);
  } finally {
    clearTimeout(timeout);
    lines.close();
    socket.destroy();
  }
}
