import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { Duplex } from 'node:stream';
import { z } from 'zod';
import type { LiveViewOptions } from './view.ts';

// Runs inside the selected Pod. Passwords never cross the Kubernetes connection.
const connect = `import { readFileSync } from 'node:fs';
import WebSocket, { createWebSocketStream } from '/app/node_modules/ws/wrapper.mjs';
if (process.env['POD_UID'] !== expectedUid) process.exit(1);
process.setgroups([]); process.setgid(1002); process.setuid(1002);
const credentials = JSON.parse(readFileSync('/home/desktop/credentials.json', 'utf8'));
const account = writer ? 'requester' : 'viewer';
const ws = new WebSocket('ws://127.0.0.1:6901/websockify', 'binary', {
  origin: 'http://opencrane.local', headers: { authorization: 'Basic '+Buffer.from(account+':'+credentials[account]).toString('base64') },
  perMessageDeflate: false, maxPayload: 4194304, handshakeTimeout: 5000,
});
const stream = createWebSocketStream(ws);
stream.on('error', () => process.exit(1)); ws.on('close', () => process.exit(0));
process.stdin.pipe(stream).pipe(process.stdout);
process.stdin.on('end', () => ws.terminate());
if (!writer) setTimeout(() => process.exit(0), 120000).unref();`;

/** Authenticated Kubernetes stream; no Kasm port-forward, Service or browser credential. */
export function desktopConnection(kubeconfig: string, namespace: string): LiveViewOptions['open'] {
  if (!kubeconfig || !/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/u.test(namespace)) throw new Error('Invalid desktop configuration');
  const args = ['--kubeconfig', kubeconfig, '--namespace', namespace];
  return async (computer, writer = false) => {
    if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/u.test(computer.computerId) || !computer.podUid) throw new Error('Unbound desktop');
    const result = await promisify(execFile)('kubectl', [...args, 'get', 'pods', '-l', 'app=computer', '-o', 'json'], { timeout: 5000, maxBuffer: 2_000_000 });
    const pods = z.object({ items: z.array(z.object({ metadata: z.object({ name: z.string(), uid: z.string(), deletionTimestamp: z.string().optional(), labels: z.record(z.string(), z.string()).optional() }) })) }).parse(JSON.parse(result.stdout) as unknown);
    const pod = pods.items.find(p => p.metadata.name === computer.computerId && p.metadata.uid === computer.podUid && !p.metadata.deletionTimestamp && p.metadata.labels?.['app'] === 'computer');
    if (!pod) throw new Error('Desktop generation changed');
    const child = spawn('kubectl', [...args, 'exec', '-i', computer.computerId, '-c', 'computer', '--', 'node', '--input-type=module', '-e', `const writer = ${writer}; const expectedUid = ${JSON.stringify(computer.podUid)};\n${connect}`], { stdio: ['pipe', 'pipe', 'ignore'] });
    const stream = Duplex.from({ readable: child.stdout, writable: child.stdin });
    stream.on('error', () => child.kill());
    child.stdin.on('error', () => stream.destroy()); child.stdout.on('error', () => stream.destroy());
    child.once('error', () => stream.destroy(new Error('Desktop transport unavailable')));
    child.once('exit', () => stream.destroy());
    stream.once('close', () => child.kill());
    return stream;
  };
}

/** Runs only inside the UID-bound Pod; the bridge credential never leaves it. */
export function computerControl(kubeconfig: string, namespace: string): NonNullable<LiveViewOptions['control']> {
  return async (computer, action, leaseId, version) => {
    if (!computer.podUid || !/^[a-z0-9-]+$/u.test(computer.computerId)) throw new Error('Unbound computer');
    const script = `import { readFileSync } from 'node:fs';
if (process.env['POD_UID'] !== ${JSON.stringify(computer.podUid)}) process.exit(1);
process.setgroups([]); process.setgid(1000); process.setuid(1000);
const credential = JSON.parse(readFileSync('/run/codex/computer.json', 'utf8'));
const response = await fetch('http://127.0.0.1:8081/${action}', { method: 'POST', headers: { 'x-bridge-token': credential.value }, body: JSON.stringify({ leaseId: ${JSON.stringify(leaseId)}, version: ${version} }), signal: AbortSignal.timeout(15000) });
if (!response.ok || !(await response.json()).quiescent) process.exit(1);`;
    await promisify(execFile)('kubectl', ['--kubeconfig', kubeconfig, '-n', namespace, 'exec', computer.computerId, '-c', 'computer', '--', 'node', '--input-type=module', '-e', script], { timeout: 17000, maxBuffer: 4096 });
  };
}
