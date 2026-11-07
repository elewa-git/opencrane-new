import { rmSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import type { Socket } from 'node:net';

export function supervisePrivateChild(child: ChildProcess, socket: Socket, privateHome: string,
  children: Set<ChildProcess>) {
  let exited = false;
  let timer: NodeJS.Timeout | undefined;
  let killAttempts = 0;
  function childExited(code: number | null, signal: NodeJS.Signals | null) {
    // Require the process exit result before treating socket EOF as proof of exit.
    if (code === null && signal === null) {
      socket.destroy();
      return;
    }
    if (exited) return;
    exited = true;
    if (timer) clearTimeout(timer);
    children.delete(child);
    rmSync(privateHome, { recursive: true, force: true });
    // End the supervisor side only after the child and its private home are gone.
    socket.end();
  }
  function childFailed() {
    socket.destroy();
    // Keep a running child and its home until the real exit event arrives.
    if (child.pid) return;
    if (exited) return;
    exited = true;
    if (timer) clearTimeout(timer);
    children.delete(child);
    rmSync(privateHome, { recursive: true, force: true });
  }
  function killFailed() {
    if (exited) return;
    // Log fixed text only. Child output and private paths can contain member content.
    process.stderr.write('Private process cleanup failed\n');
    if (killAttempts < 3) {
      timer = setTimeout(killAsPrivateUser, 1000);
    }
  }
  function killAsPrivateUser() {
    if (exited || !child.pid) return;
    killAttempts++;
    const args = ['--reuid=1003', '--regid=1003', '--clear-groups', '--',
      '/bin/kill', '-KILL', String(child.pid)];
    const killer = spawn('/usr/bin/setpriv', args, { stdio: 'ignore' });
    let failed = false;
    function retryKill() {
      if (failed) return;
      failed = true;
      killFailed();
    }
    function killerExited(code: number | null) {
      if (code !== 0) retryKill();
    }
    killer.on('error', retryKill);
    killer.on('exit', killerExited);
  }
  function socketClosed() {
    child.stdin?.destroy();
    if (!exited && !timer) timer = setTimeout(killAsPrivateUser, 5000);
  }
  function socketFailed() {
    socket.destroy();
    socketClosed();
  }
  child.once('error', childFailed);
  child.once('exit', childExited);
  child.stdin?.on('error', socketFailed);
  socket.on('error', socketFailed);
  socket.on('end', socketClosed);
  socket.on('close', socketClosed);
  // Keep this side open when stdout closes. Only the child exit event may end it.
  child.stdout?.pipe(socket, { end: false });
}
