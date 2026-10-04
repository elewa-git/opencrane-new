import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { Duplex } from 'node:stream';
import { z } from 'zod';
import type { LiveViewOptions } from './view.ts';

// Runs inside the selected Pod. Passwords never cross the Kubernetes connection.
// Stderr contains fixed timing markers; stdout remains the unmodified RFB stream.
const connect = `import { readFileSync } from 'node:fs';
import WebSocket, { createWebSocketStream } from '/app/node_modules/ws/wrapper.mjs';
if (process.env['POD_UID'] !== expectedUid) process.exit(1);
process.setgroups([]); process.setgid(1002); process.setuid(1002);
const { viewer } = JSON.parse(readFileSync('/home/desktop/credentials.json', 'utf8'));
const ws = new WebSocket('ws://127.0.0.1:6901/websockify', 'binary', {
  origin: 'http://opencrane.local',
  headers: { authorization: 'Basic '+Buffer.from('viewer:'+viewer).toString('base64') },
  perMessageDeflate: false, maxPayload: 4194304, handshakeTimeout: 5000,
});
function connected() {
  process.stderr.write('desktop-connected\\n');
}
ws.once('open', connected);
const stream = createWebSocketStream(ws);
stream.on('error', () => process.exit(1)); ws.on('close', () => process.exit(0));
process.stdin.pipe(stream).pipe(process.stdout);
process.stdin.on('end', () => ws.terminate());
setTimeout(() => process.exit(0), 120000).unref();`;

const podSchema = z.object({
  metadata: z.object({
    name: z.string(),
    uid: z.string(),
    deletionTimestamp: z.string().optional(),
    labels: z.record(z.string(), z.string()).optional(),
  }),
});
const podsSchema = z.object({ items: z.array(podSchema) });
const execute = promisify(execFile);

/** Authenticated Kubernetes stream; no Kasm port-forward, Service or browser credential. */
export function desktopConnection(kubeconfig: string, namespace: string): LiveViewOptions['open'] {
  if (!kubeconfig || !/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/u.test(namespace)) {
    throw new Error('Invalid desktop configuration');
  }
  const args = ['--kubeconfig', kubeconfig, '--namespace', namespace];
  async function open(
    computer: Parameters<LiveViewOptions['open']>[0],
    observe?: Parameters<LiveViewOptions['open']>[1],
  ) {
    if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/u.test(computer.computerId) || !computer.podUid) {
      throw new Error('Unbound desktop');
    }
    const lookupAt = performance.now();
    observe?.('pod_lookup', 'started', 0);
    try {
      const lookupArgs = [...args, 'get', 'pods', '-l', 'app=computer', '-o', 'json'];
      const limits = { timeout: 5000, maxBuffer: 2_000_000 };
      const result = await execute('kubectl', lookupArgs, limits);
      const value: unknown = JSON.parse(result.stdout);
      const pods = podsSchema.parse(value);
      function matches(pod: z.infer<typeof podSchema>) {
        return pod.metadata.name === computer.computerId
          && pod.metadata.uid === computer.podUid
          && !pod.metadata.deletionTimestamp
          && pod.metadata.labels?.['app'] === 'computer';
      }
      if (!pods.items.some(matches)) throw new Error('Desktop generation changed');
      observe?.('pod_lookup', 'ok', performance.now() - lookupAt);
    } catch (error) {
      observe?.('pod_lookup', 'error', performance.now() - lookupAt);
      throw error;
    }
    const connectAt = performance.now();
    observe?.('desktop_connect', 'started', 0);
    const script = `const expectedUid = ${JSON.stringify(computer.podUid)};\n${connect}`;
    const command = [...args, 'exec', '-i', computer.computerId, '-c', 'computer', '--',
      'node', '--input-type=module', '-e', script];
    const processOptions = { stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'] };
    const child = spawn('kubectl', command, processOptions);
    const streams = { readable: child.stdout, writable: child.stdin };
    const stream = Duplex.from(streams);
    const messageOptions = { input: child.stderr };
    const messages = createInterface(messageOptions);
    let connected = false;
    function marker(line: string) {
      // Discard all other stderr, which may contain credentials or command arguments.
      if (line !== 'desktop-connected' || connected) return;
      connected = true;
      observe?.('desktop_connect', 'ok', performance.now() - connectAt);
    }
    function kill() {
      child.kill();
      messages.close();
    }
    function destroy() {
      stream.destroy();
    }
    function failed() {
      stream.destroy(new Error('Desktop transport unavailable'));
    }
    function exited() {
      if (!connected) observe?.('desktop_connect', 'error', performance.now() - connectAt);
      destroy();
    }
    messages.on('line', marker);
    stream.on('error', kill);
    child.stdin.on('error', destroy);
    child.stdout.on('error', destroy);
    child.once('error', failed);
    child.once('exit', exited);
    stream.once('close', kill);
    return stream;
  }
  return open;
}
