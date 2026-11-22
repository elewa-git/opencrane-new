export const nativeOutputProbe = `
import assert from 'node:assert/strict';
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
import { createInterface } from 'node:readline';

const nativeConnect = net.connect;
const delayReader = process.argv[1] === 'delayed';
let emptyReads = 0;
let delayed = false;

function connectObservedExecutor(...args) {
  const socket = nativeConnect(...args);
  const nativeWrite = socket.write.bind(socket);
  const lineOptions = { input: socket };
  const lines = createInterface(lineOptions);
  let heldRead;
  let readId;

  function send(request) {
    const encoded = JSON.stringify(request);
    nativeWrite(\`\${encoded}\\n\`);
  }

  function releaseOutput() {
    const input = Buffer.from('!');
    const chunk = input.toString('base64');
    const params = { processId: 'upload', writeId: 'release', chunk };
    const request = { id: -2, method: 'process/write', params };
    send(request);
  }

  function observeResponse(line) {
    const response = JSON.parse(line);
    if (typeof response.id !== 'number') return;
    if (response.id !== -1 && response.id !== readId) return;
    assert.deepEqual(response.result.chunks, []);
    assert.equal(response.result.exited, false);
    emptyReads += 1;
    if (response.id === -1) {
      delayed = true;
      send(heldRead);
      return;
    }
    readId = undefined;
    releaseOutput();
  }

  function writeObservedRequest(line) {
    const encodedRequest = line.toString();
    const request = JSON.parse(encodedRequest);
    if (request.method === 'process/read' && emptyReads === 0) {
      readId = request.id;
      if (delayReader) {
        // Hold the reader until a separate real native poll has finished.
        heldRead = request;
        const probe = { ...request, id: -1 };
        send(probe);
        return true;
      }
    }
    return nativeWrite(line);
  }

  lines.on('line', observeResponse);
  socket.write = writeObservedRequest;
  return socket;
}

net.connect = connectObservedExecutor;
syncBuiltinESMExports();
const { workspaceProcess } = await import('/app/src/files.ts');
process.setgroups([]);
process.setgid(1000);
process.setuid(1000);
// Keep stdout unavailable until the observer releases stdin after an empty native read.
const program = 'import sys; sys.stdin.buffer.read(1); print("Willow-47")';
const argv = ['/opt/python/bin/python', '-c', program];
const input = Buffer.alloc(0);
const result = await workspaceProcess(argv, input);
assert.equal(emptyReads, delayReader ? 2 : 1);
assert.equal(delayed, delayReader);
const text = result.output.toString();
const report = { exitCode: result.exitCode, text };
process.stdout.write(JSON.stringify(report));
`;
