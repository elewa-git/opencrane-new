import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, cp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createServer, connect, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';

function listeningPort(server: Server) {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing TCP address');
  return address.port;
}

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = listeningPort(server);
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
  const upstream = listeningPort(registry);
  const port = await freePort();
  const child = spawn(process.execPath, ['apps/computer/test/registry-forwarder.mjs',
    '127.0.0.1', String(upstream), String(port)]);
  let client: Socket | undefined;
  try {
    await once(child.stdout, 'data');
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

async function interruptsBuild(signal: 'SIGTERM' | 'SIGINT', phase = 'download') {
  // Keep -i in the volume path to distinguish it from Docker's interactive argument.
  const directory = await mkdtemp(join(tmpdir(), 'computer-build-stop-i'));
  const bin = join(directory, 'bin');
  const port = await freePort();
  await mkdir(bin);
  await cp('apps/computer/build.sh', join(directory, 'build.sh'));
  await cp('apps/computer/test', join(directory, 'test'), { recursive: true });
  let dockerScript = '#!/bin/sh\necho 127.0.0.1\n';
  let curlScript = '#!/bin/sh\ncase "$*" in\n *v2*) exit 0;;\nesac\necho waiting\nsleep 60\n';
  if (phase === 'contents') {
    dockerScript = `#!/bin/sh
case "$*" in
 *--rm*-i*)
  cat >/dev/null &
  reader_pid=$!
  echo image-check-ready
  wait "$reader_pid"
  sleep 60
  ;;
 inspect*) echo 127.0.0.1;;
esac
`;
    curlScript = '#!/bin/sh\nexit 0\n';
    for (const name of ['sha256sum', 'tar']) {
      await writeFile(join(bin, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    }
  }
  await writeFile(join(bin, 'docker'), dockerScript, { mode: 0o755 });
  await writeFile(join(bin, 'curl'), curlScript, { mode: 0o755 });
  const nodeScript = `#!/bin/sh\nexec '${process.execPath}' "$1" "$2" "$3" ${port}\n`;
  await writeFile(join(bin, 'node'), nodeScript, { mode: 0o755 });
  const child = spawn('sh', [join(directory, 'build.sh')], {
    detached: true, env: { ...process.env, PATH: `${bin}:${process.env['PATH']}` },
  });
  let output = '';
  function collect(chunk: Buffer) { output += chunk.toString(); }
  child.stdout.on('data', collect);
  let socket: Socket | undefined;
  try {
    let readinessSignal = 'waiting';
    if (phase === 'contents') {
      readinessSignal = 'image-check-ready';
    }
    // Allow a heavily loaded CI worker a full minute to start the shell and both child processes.
    const deadline = Date.now() + 60_000;
    while (!output.includes(readinessSignal) || !output.includes('Forwarding')) {
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
it('removes the listener when only the build shell receives TERM', terminatesBuild, 75_000);
it('removes the listener when only the build shell receives INT', interruptsBuildWithInt, 75_000);

async function terminatesContentsCheck() { await interruptsBuild('SIGTERM', 'contents'); }
it('stops the listener while an image check is reading standard input',
  terminatesContentsCheck, 75_000);
