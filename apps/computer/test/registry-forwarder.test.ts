import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, cp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createServer, connect, type AddressInfo, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;
  server.close();
  await once(server, 'close');
  return port;
}

async function hasExited(child: ChildProcess, deadline = 3000) {
  const start = Date.now();
  while (child.exitCode === null && child.signalCode === null) {
    if (Date.now() - start >= deadline) return false;
    await delay(20);
  }
  return true;
}

async function stopsWithOpenConnection() {
  const sockets = new Set<Socket>();
  function accepted(socket: Socket) { sockets.add(socket); }
  const registry = createServer(accepted);
  registry.listen(0, '127.0.0.1');
  await once(registry, 'listening');
  const upstream = (registry.address() as AddressInfo).port;
  const port = await freePort();
  const child = spawn(process.execPath, ['apps/computer/test/registry-forwarder.mjs',
    '127.0.0.1', String(upstream), String(port)]);
  let client: Socket | undefined;
  try {
    await once(child.stdout!, 'data');
    client = connect(port, '127.0.0.1');
    await once(client, 'connect');
    client.write('keep this connection open');
    await delay(50);
    child.kill('SIGTERM');
    expect(await hasExited(child)).toBe(true);
    expect(child.exitCode).toBe(0);
  } finally {
    client?.destroy();
    for (const socket of sockets) socket.destroy();
    registry.close();
    child.kill('SIGKILL');
  }
}

async function interruptsBuild(signal: 'SIGTERM' | 'SIGINT') {
  const directory = await mkdtemp(join(tmpdir(), 'computer-build-stop-'));
  const bin = join(directory, 'bin');
  const port = await freePort();
  await mkdir(bin);
  await cp('apps/computer/build.sh', join(directory, 'build.sh'));
  await cp('apps/computer/test', join(directory, 'test'), { recursive: true });
  await writeFile(join(bin, 'docker'), '#!/bin/sh\necho 127.0.0.1\n', { mode: 0o755 });
  await writeFile(join(bin, 'curl'), '#!/bin/sh\ncase "$*" in\n *v2*) exit 0;;\nesac\necho waiting\nsleep 60\n', { mode: 0o755 });
  const nodeScript = `#!/bin/sh\nexec '${process.execPath}' "$1" "$2" "$3" ${port}\n`;
  await writeFile(join(bin, 'node'), nodeScript, { mode: 0o755 });
  const child = spawn('sh', [join(directory, 'build.sh')], {
    detached: true, env: { ...process.env, PATH: `${bin}:${process.env['PATH']}` },
  });
  let output = '';
  function collect(chunk: Buffer) { output += chunk.toString(); }
  child.stdout!.on('data', collect);
  let socket: Socket | undefined;
  try {
    const deadline = Date.now() + 5000;
    while (!output.includes('waiting') || !output.includes('Forwarding')) {
      if (Date.now() > deadline) throw new Error('Build fixture did not start');
      await delay(20);
    }
    child.kill(signal);
    expect(await hasExited(child)).toBe(true);
    await delay(100);
    socket = connect(port, '127.0.0.1');
    await expect(once(socket, 'connect')).rejects.toThrow('ECONNREFUSED');
    expect(child.exitCode).toBe(signal === 'SIGTERM' ? 143 : 130);
  } finally {
    socket?.destroy();
    if (child.pid) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* The group has already exited. */ }
    }
    await rm(directory, { recursive: true, force: true });
  }
}

async function terminatesBuild() { await interruptsBuild('SIGTERM'); }
async function interruptsBuildWithInt() { await interruptsBuild('SIGINT'); }
it('closes open registry sockets before exiting', stopsWithOpenConnection);
it('removes the listener when only the build shell receives TERM', terminatesBuild);
it('removes the listener when only the build shell receives INT', interruptsBuildWithInt);
