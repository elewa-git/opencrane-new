import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { Duplex } from 'node:stream';
import { z } from 'zod';
import type { LiveViewOptions } from './view.ts';
import { timeStage } from './view-timing.ts';

// Runs inside the selected Pod. Passwords never cross the Kubernetes connection.
// Stderr is ignored because it may contain credentials or grow without line breaks.
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

function matchesPod(pod: z.infer<typeof podSchema>, computer: {
  computerId: string;
  podUid?: string | undefined;
}) {
  return pod.metadata.name === computer.computerId
    && pod.metadata.uid === computer.podUid
    && !pod.metadata.deletionTimestamp
    && pod.metadata.labels?.['app'] === 'computer';
}

function stageStarted(observe: Parameters<LiveViewOptions['open']>[1]) {
  observe?.('pod_lookup', 'started', 0);
}

function stageSucceeded(
  observe: Parameters<LiveViewOptions['open']>[1],
  durationMs: number,
) {
  observe?.('pod_lookup', 'ok', durationMs);
}

function stageFailed(
  observe: Parameters<LiveViewOptions['open']>[1],
  durationMs: number,
) {
  observe?.('pod_lookup', 'error', durationMs);
}

function destroyStream(stream: Duplex) {
  stream.destroy(new Error('Desktop transport unavailable'));
}

function stopChild(child: ReturnType<typeof spawn>) {
  child.kill();
}

function desktopStream(child: ReturnType<typeof spawn>) {
  if (!child.stdin || !child.stdout) {
    throw new Error('Desktop transport streams unavailable');
  }
  const streams = { readable: child.stdout, writable: child.stdin };
  const stream = Duplex.from(streams);
  stream.on('error', () => stopChild(child));
  child.stdin.on('error', () => stream.destroy());
  child.stdout.on('error', () => stream.destroy());
  child.once('error', () => destroyStream(stream));
  child.once('exit', () => stream.destroy());
  stream.once('close', () => stopChild(child));
  return stream;
}

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
    async function lookupPod() {
      const lookupArgs = [...args, 'get', 'pods', '-l', 'app=computer', '-o', 'json'];
      const limits = { timeout: 5000, maxBuffer: 2_000_000 };
      const result = await execute('kubectl', lookupArgs, limits);
      const value: unknown = JSON.parse(result.stdout);
      const pods = podsSchema.parse(value);
      function matchesCurrentPod(pod: z.infer<typeof podSchema>) {
        return matchesPod(pod, computer);
      }
      const podMatches = pods.items.some(matchesCurrentPod);
      if (!podMatches) throw new Error('Desktop generation changed');
    }
    function reportLookupStarted() {
      stageStarted(observe);
    }
    function reportLookupSucceeded(durationMs: number) {
      stageSucceeded(observe, durationMs);
    }
    function reportLookupFailed(_error: unknown, durationMs: number) {
      stageFailed(observe, durationMs);
    }
    await timeStage(lookupPod, reportLookupStarted, reportLookupSucceeded, reportLookupFailed);
    const script = `const expectedUid = ${JSON.stringify(computer.podUid)};\n${connect}`;
    const command = [...args, 'exec', '-i', computer.computerId, '-c', 'computer', '--',
      'node', '--input-type=module', '-e', script];
    const stdio = ['pipe', 'pipe', 'ignore'] as const;
    const processOptions = { stdio: [...stdio] };
    const child = spawn('kubectl', command, processOptions);
    return desktopStream(child);
  }
  return open;
}
