import { createHash } from 'node:crypto';
import { connect } from 'node:net';
import { createInterface } from 'node:readline';
import { record } from './http.ts';

export interface WorkspaceFile { conversationId: string; fileId: string; name: string; size: number; sha256: string }
function metadata(value: Record<string, unknown>): WorkspaceFile {
  const { conversationId, fileId, name, size, sha256 } = value;
  if (typeof conversationId !== 'string' || !/^[\w-]{1,200}$/u.test(conversationId) || typeof fileId !== 'string' || !/^[\w-]{1,200}$/u.test(fileId) ||
      typeof name !== 'string' || !/^[\w][\w .()-]{0,119}$/u.test(name) || typeof size !== 'number' || !Number.isSafeInteger(size) || size < 1 || size > 20 * 1024 * 1024 ||
      typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(sha256)) throw new Error('Invalid file');
  return { conversationId, fileId, name, size, sha256 };
}
export function filePackets(receive: (file: WorkspaceFile, bytes: Buffer) => Promise<void>) {
  let file: WorkspaceFile | undefined, parts: Buffer[] = [], size = 0, busy = false;
  return async (input: Record<string, unknown>) => {
    if (busy) throw new Error('File delivery busy');
    if (input['type'] === 'file_begin') { file = metadata(input); parts = []; size = 0; return undefined; }
    if (!file) throw new Error('No file');
    if (input['type'] === 'file_chunk') {
      if (input['offset'] !== size || typeof input['bytes'] !== 'string' || input['bytes'].length > 88_000) throw new Error('Invalid chunk');
      const bytes = Buffer.from(input['bytes'], 'base64');
      if (!bytes.length || size + bytes.length > file.size) throw new Error('File size mismatch');
      parts.push(bytes); size += bytes.length; return undefined;
    }
    if (input['type'] !== 'file_end' || size !== file.size) throw new Error('Incomplete file');
    const bytes = Buffer.concat(parts), done = file; file = undefined; parts = []; busy = true;
    try {
      if (createHash('sha256').update(bytes).digest('hex') !== done.sha256) throw new Error('File digest mismatch');
      await receive(done, bytes); return { type: 'file_received', fileId: done.fileId, sha256: done.sha256 };
    } finally { busy = false; }
  };
}

/** Use the existing socket-denied tools executor: the Codex UID cannot write workspace files. */
export async function receiveFile(file: WorkspaceFile, bytes: Buffer) {
  const socket = connect('/run/executor/exec.sock'), lines = createInterface({ input: socket });
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  let nextId = 0;
  const timeout = setTimeout(() => socket.destroy(new Error('Workspace delivery timed out')), 80_000);
  socket.on('error', () => { for (const call of pending.values()) call.reject(new Error('Workspace executor unavailable')); });
  lines.on('line', line => {
    const message = record(JSON.parse(line) as unknown), call = typeof message['id'] === 'number' ? pending.get(message['id']) : undefined;
    if (!call) return;
    pending.delete(Number(message['id']));
    if (message['error']) call.reject(new Error('Workspace executor refused')); else call.resolve(message['result']);
  });
  const rpc = (method: string, params: Record<string, unknown>) => new Promise<unknown>((resolve, reject) => {
    const id = ++nextId; pending.set(id, { resolve, reject }); socket.write(JSON.stringify({ id, method, params }) + '\n');
  });
  try {
    await rpc('initialize', { clientName: 'opencrane-upload' }); socket.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
    const processId = 'upload';
    await rpc('process/start', { processId, argv: ['/opt/python/bin/python', '/app/src/receive-file.py', JSON.stringify(file)],
      cwd: 'file:///workspace', env: {}, tty: false, pipeStdin: true, arg0: null });
    for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
      const response = record(await rpc('process/write', { processId, writeId: String(offset), chunk: bytes.subarray(offset, offset + 64 * 1024).toString('base64') }));
      if (response['status'] !== 'accepted') throw new Error('Workspace write refused');
    }
    while (true) {
      const result = record(await rpc('process/read', { processId, afterSeq: null, maxBytes: 1024, waitMs: 1000 }));
      if (!result['exited']) continue;
      if (result['exitCode'] !== 0) throw new Error('Workspace conversion failed');
      return;
    }
  } finally { clearTimeout(timeout); lines.close(); socket.destroy(); }
}
