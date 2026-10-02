import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { until } from '@opencrane/authz/testing';
import { tcpProxy } from '@opencrane/event-store/testing';
const exec = promisify(execFile);

/** Disposable runtime image with this branch's sources; no shared-stack Pods or credentials. */
export async function uploadComputer() {
  const stub = spawn(process.execPath, ['--experimental-strip-types', 'infra/dev-stack/model-stub.ts'],
    { env: { ...process.env, STUB_PORT: '0' }, stdio: ['ignore', 'pipe', 'ignore'] });
  let output = ''; stub.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  const disk = `upload-disk-${randomUUID()}`;
  let container: string | undefined, relay: Awaited<ReturnType<typeof tcpProxy>> | undefined;
  const docker = async (...args: string[]) => (await exec('docker', args, { timeout: 120_000 })).stdout.trim();
  const close = async () => { if (container) await docker('rm', '-f', container); await docker('volume', 'rm', disk); await relay?.close(); stub.kill(); };
  try {
    await until(() => /Stub ready (\d+)/u.test(output));
    const gateway = await docker('network', 'inspect', 'bridge', '--format', '{{(index .IPAM.Config 0).Gateway}}');
    relay = await tcpProxy(() => ({ host: '127.0.0.1', port: Number(/Stub ready (\d+)/u.exec(output)![1]) }), gateway);
    let url = '';
    const start = async () => {
      container = await docker('run', '-d', '--name', `upload-computer-${randomUUID()}`, '-p', '127.0.0.1::8081',
        '-v', `${disk}:/home/agent`, '-v', `${resolve('apps/computer/src')}:/app/src:ro`, '-e', `GATEWAY=http://${gateway}:${relay!.port}`, 'ocn-computer-runtime');
      const port = Number((await docker('port', container, '8081/tcp')).split(':')[1]);
      url = `http://127.0.0.1:${port}`;
    };
    await start();
    const ready = () => until(async () => { try { return (await fetch(`${url}/health`)).ok; } catch { return false; } }, 30_000);
    const credentials = async () => {
      await ready();
      const response = await fetch(`${url}/credentials`, { method: 'POST', body: JSON.stringify({ value: 'test-computer', id: 'token:test', expiresAt: Date.now()+600_000 }) });
      if (!response.ok) throw new Error('Test credential refused');
    };
    await credentials();
    return { get url() { return url; }, close, async restart() { await docker('rm', '-f', container!); await start(); await credentials(); },
      pause: () => docker('pause', container!), resume: () => docker('unpause', container!),
      read: (path: string) => docker('exec', container!, 'cat', path),
      write: (path: string, text: string) => docker('exec', '-u', '1001', container!, '/opt/python/bin/python', '-c', 'import pathlib,sys; path=pathlib.Path(sys.argv[1]); path.parent.mkdir(parents=True,exist_ok=True); path.write_bytes(sys.argv[2].encode())', path, text),
      mtime: (path: string) => docker('exec', container!, 'stat', '-c', '%Y', path) };
  } catch (error) { await close(); throw error; }
}
