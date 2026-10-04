// S0.3's disk layout and S0.1b's fixed executor launcher.
import { mkdirSync, lstatSync, openSync, closeSync, fstatSync, fchmodSync, fchownSync, constants, symlinkSync, rmSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, connect } from 'node:net';
// Resolve each child through an open parent; mutate only the checked descriptor.
function directory(parent: number, name: string, uid: number, mode: number, gid = uid) {
  const path = `/proc/self/fd/${parent}/${name}`;
  const before = lstatSync(path, { throwIfNoEntry: false });
  if (before && !before.isDirectory()) throw new Error(`Unsafe directory: ${name}`);
  if (!before) mkdirSync(path, { mode: 0o700 });
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (!opened.isDirectory() || (before && (before.dev !== opened.dev || before.ino !== opened.ino))) {
      throw new Error(`Changed directory: ${name}`);
    }
    if (opened.uid !== uid || opened.gid !== gid || (opened.mode & 0o777) !== mode) {
      fchownSync(fd, 0, 0); fchmodSync(fd, mode); fchownSync(fd, uid, gid);
    }
    return fd;
  } catch (error) { closeSync(fd); throw error; }
}
function trustedParent(path: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const st = fstatSync(fd);
  if (st.uid !== 0 || (st.mode & 0o022)) { closeSync(fd); throw new Error(`Unsafe parent: ${path}`); }
  return fd;
}
if (process.argv[2] === 'connect' || process.argv[2] === 'connect-host') {
  const socket = connect(process.argv[2] === 'connect-host' ? '/run/executor/host.sock' : '/run/executor/exec.sock');
  process.stdin.pipe(socket); socket.pipe(process.stdout);
  socket.on('error', () => process.exit(1));
} else {
  process.umask(0o077);
  const home = trustedParent('/home'), run = trustedParent('/run');
  const agent = directory(home, 'agent', 0, 0o755);
  for (const [name, uid] of [['codex', 1000], ['workspace', 1001], ['profile', 1002]] as const) {
    closeSync(directory(agent, name, uid, name === 'workspace' ? 0o755 : 0o700));
  }
  for (const [name, uid] of [['codex', 1000], ['tool', 1001], ['desktop', 1002]] as const) {
    closeSync(directory(home, name, uid, 0o700));
  }
  closeSync(directory(run, 'codex', 1000, 0o700));
  closeSync(directory(run, 'executor', 0, 0o750, 1000));
  closeSync(agent); closeSync(home); closeSync(run);
  rmSync('/home/codex/.codex', { recursive: true, force: true });
  symlinkSync('/home/agent/codex', '/home/codex/.codex');
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
  for (const name of ['exec', 'host']) rmSync(`/run/executor/${name}.sock`, { force: true });
  for (const name of ['control', 'app']) rmSync(`/run/codex/${name}.sock`, { force: true });
  const executor = (args: string[]) => createServer(socket => {
    const child = watch(spawn('/usr/local/bin/tool-user', args, { stdio: ['pipe', 'pipe', 'inherit'] }), false);
    if (!child.stdin || !child.stdout) throw new Error('Missing executor pipes');
    socket.pipe(child.stdin); child.stdout.pipe(socket);
    child.stdin.on('error', () => socket.destroy());
    // EOF shuts down the executor without signalling across UIDs (CAP_KILL is dropped).
    socket.on('error', () => child.stdin?.destroy()); socket.on('close', () => child.stdin?.destroy());
  });
  // Only UID 1000 can traverse this root-owned directory. No path-based socket chmod/chown.
  process.umask(0o111);
  executor(['host']).listen('/run/executor/host.sock', () => {
    executor([]).listen('/run/executor/exec.sock', () => {
      process.umask(0o077);
      watch(spawn('/usr/bin/setpriv', ['--no-new-privs', '/usr/local/bin/node', '--experimental-strip-types', '/app/src/desktop.ts'], { stdio: 'inherit' }), true);
      watch(spawn('/usr/local/bin/node', ['--experimental-strip-types', '/app/src/bridge.ts'], {
        uid: 1000, gid: 1000, stdio: 'inherit',
        env: { PATH: process.env['PATH'], HOME: '/home/codex', GATEWAY: process.env['GATEWAY'], MODEL: process.env['MODEL'] ?? 'stub-model' },
      }), true);
    });
  });
}
