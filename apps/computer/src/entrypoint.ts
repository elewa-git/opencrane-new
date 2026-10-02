// S0.3's disk layout and S0.1b's fixed executor launcher.
import { mkdirSync, chmodSync, chownSync, symlinkSync, rmSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, connect } from 'node:net';
if (process.argv[2] === 'connect') {
  const socket = connect('/run/codex/exec.sock');
  process.stdin.pipe(socket); socket.pipe(process.stdout);
  socket.on('error', () => process.exit(1));
} else {
  process.umask(0o077);
  for (const [name, uid] of [['codex', 1000], ['workspace', 1001], ['profile', 1002]] as const) {
    const path = `/home/agent/${name}`;
    mkdirSync(path, { recursive: true }); chownSync(path, 0, 0);
    chmodSync(path, name === 'workspace' ? 0o755 : 0o700); chownSync(path, uid, uid);
  }
  for (const [path, uid] of [['/home/codex', 1000], ['/run/codex', 1000], ['/home/tool', 1001], ['/home/desktop', 1002]] as const) {
    mkdirSync(path, { recursive: true }); chownSync(path, 0, 0); chmodSync(path, 0o700); chownSync(path, uid, uid);
  }
  for (const [path, target] of [['/workspace', '/home/agent/workspace'], ['/home/codex/.codex', '/home/agent/codex']]) {
    if (!path || !target) throw new Error('Missing path');
    rmSync(path, { recursive: true, force: true }); symlinkSync(target, path);
  }
  const children = new Set<ChildProcess>();
  let stopping = false;
  const stop = (code: number) => {
    if (stopping) return;
    stopping = true;
    for (const child of children) child.kill('SIGTERM');
    setTimeout(() => process.exit(code), 500).unref();
  };
  const watch = (child: ChildProcess, required: boolean) => {
    children.add(child);
    child.on('error', () => stop(1));
    child.on('exit', () => { children.delete(child); if (required) stop(1); });
    return child;
  };
  process.on('SIGTERM', () => stop(0)); process.on('SIGINT', () => stop(0));
  for (const name of ['exec', 'control', 'app']) rmSync(`/run/codex/${name}.sock`, { force: true });
  const server = createServer(socket => {
    const child = watch(spawn('/usr/local/bin/tool-user', [], { stdio: ['pipe', 'pipe', 'inherit'] }), false);
    if (!child.stdin || !child.stdout) throw new Error('Missing executor pipes');
    socket.pipe(child.stdin); child.stdout.pipe(socket);
    child.stdin.on('error', () => socket.destroy());
    socket.on('error', () => child.kill()); socket.on('close', () => child.kill());
  });
  server.listen('/run/codex/exec.sock', () => {
    chmodSync('/run/codex/exec.sock', 0o600); chownSync('/run/codex/exec.sock', 1000, 1000);
    watch(spawn('setpriv', ['--no-new-privs', 'node', '--experimental-strip-types', '/app/src/desktop.ts'], { stdio: 'inherit' }), true);
    watch(spawn('node', ['--experimental-strip-types', '/app/src/bridge.ts'], {
      uid: 1000, gid: 1000, stdio: 'inherit',
      env: { PATH: process.env['PATH'], HOME: '/home/codex', GATEWAY: process.env['GATEWAY'], MODEL: process.env['MODEL'] ?? 'stub-model' },
    }), true);
  });
}
