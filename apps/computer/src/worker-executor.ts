import { Transform, type TransformCallback } from 'node:stream';
import { record } from './http.ts';
import { workerRequest } from './worker-request.ts';

function noRegistration() { return undefined; }
function refuseWorker(request: Record<string, unknown>, reply: (value: unknown) => void) {
  const id = request['id'];
  if (typeof id !== 'string' && !Number.isSafeInteger(id)) throw new Error();
  reply({ id, error: { code: -32000, message: 'worker_execution_disabled' } });
}
function isWorkerStart(request: Record<string, unknown>) {
  if (request['method'] !== 'process/start') return false;
  const argv = record(request['params'])['argv'];
  if (!Array.isArray(argv) || typeof argv[0] !== 'string') return false;
  const path = argv[0].split('/');
  const executable = path.at(-1);
  return (executable === 'npm' && (argv[1] === 'ci' || argv[1] === 'install')) ||
    (executable === 'git' && argv[1] === 'clone');
}

// Inspect exec-server input only. The native code-mode host keeps its own protocol.
export function workerExecutor(reply: (value: unknown) => void) {
  let pending = Buffer.alloc(0);
  function forward(this: Transform, frame: Buffer) {
    const request = record(JSON.parse(frame.toString('utf8')));
    if (!isWorkerStart(request)) {
      this.push(frame);
      return;
    }
    try {
      workerRequest(frame, noRegistration);
    } catch {
      // Return the same fixed refusal for invalid and unregistered operations.
      refuseWorker(request, reply);
      return;
    }
    refuseWorker(request, reply);
  }
  function transform(this: Transform, chunk: Buffer, _encoding: BufferEncoding,
    callback: TransformCallback) {
    try {
      pending = Buffer.concat([pending, chunk]);
      let newline = pending.indexOf(10);
      while (newline !== -1) {
        if (newline >= 1_048_576) throw new Error();
        const frame = pending.subarray(0, newline + 1);
        forward.call(this, frame);
        pending = pending.subarray(newline + 1);
        newline = pending.indexOf(10);
      }
      // Ordinary uploads use base64 chunks larger than 64 KiB. Worker frames have
      // their separate 64 KiB limit; keep the ordinary transport large enough.
      if (pending.length > 1_048_576) throw new Error();
      callback();
    } catch {
      callback(new Error('executor_frame_refused'));
    }
  }
  function flush(callback: TransformCallback) {
    if (pending.length) callback(new Error('executor_frame_refused'));
    else callback();
  }
  return new Transform({ transform, flush });
}
