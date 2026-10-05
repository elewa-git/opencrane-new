// Prepare protected homes and start the computer's separate user processes.
import { mkdirSync, lstatSync, openSync, closeSync, fstatSync, fchmodSync, fchownSync, constants, symlinkSync, rmSync, readdirSync, writeFileSync, chownSync, chmodSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { privateConfig, privateEnvironments } from './codex-config.ts';
import { privateCodexLaunch } from './private-codex.ts';
import { createServer, connect, type Socket } from 'node:net';
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
  closeSync(directory(home, 'private', 0, 0o711));
  for (const name of readdirSync('/home/private')) {
    if (name.startsWith('turn-')) rmSync(`/home/private/${name}`, { recursive: true, force: true });
  }
  closeSync(directory(run, 'codex', 1000, 0o700));
  closeSync(directory(run, 'executor', 0, 0o750, 1000));
  closeSync(agent); closeSync(home); closeSync(run);
  rmSync('/home/codex/.codex', { recursive: true, force: true });
  symlinkSync('/home/agent/codex', '/home/codex/.codex');
  const caller = randomBytes(32).toString('hex');
  const privateChildren = new Set<ChildProcess>();
  let privateCounter = 0;

  function startPrivateCodex(socket: Socket, caller: string) {
    const privateHome = `/home/private/turn-${++privateCounter}`;
    let child: ChildProcess | undefined;
    let exited = false;
    let timer: NodeJS.Timeout | undefined;
    function removeHome() {
      rmSync(privateHome, { recursive: true, force: true });
    }
    function childExited() {
      exited = true;
      if (timer) clearTimeout(timer);
      if (child) privateChildren.delete(child);
      socket.destroy();
      removeHome();
    }
    function killAsPrivateUser() {
      if (exited || !child?.pid) return;
      const killer = spawn('/usr/bin/setpriv', ['--reuid=1003', '--regid=1003',
        '--clear-groups', '--', '/bin/kill', '-KILL', String(child.pid)], { stdio: 'ignore' });
      killer.on('error', socketClosed);
    }
    function socketClosed() {
      child?.stdin?.destroy();
      if (!exited && !timer) timer = setTimeout(killAsPrivateUser, 5000);
    }
    function socketFailed() { socket.destroy(); socketClosed(); }
    try {
      mkdirSync(privateHome, { mode: 0o700 });
      for (const name of ['codex', 'tmp', 'work']) mkdirSync(`${privateHome}/${name}`, { mode: 0o700 });
      writeFileSync(`${privateHome}/codex/config.toml`, privateConfig(process.env['MODEL'] ?? 'stub-model'));
      writeFileSync(`${privateHome}/codex/environments.toml`, privateEnvironments());
      for (const path of [privateHome, `${privateHome}/codex`, `${privateHome}/tmp`, `${privateHome}/work`,
        `${privateHome}/codex/config.toml`, `${privateHome}/codex/environments.toml`]) {
        chownSync(path, 1003, 1003);
      }
      for (const path of [privateHome, `${privateHome}/codex`, `${privateHome}/tmp`, `${privateHome}/work`]) {
        chmodSync(path, 0o700);
      }
      // Keep stderr out of Pod logs and files in a RAM home owned by UID 1003.
      // Share this UID between private turns; tools being absent keeps members apart.
      // Allow writes to /tmp, /dev/shm and world-writable workspace directories.
      // Allow workspace reads and loopback ports 8080, 8081 and 6901.
      // Deny access to executor, control, persistent Codex and tool homes by directory modes.
      // Allow every UID 1000 process, including persistent Codex, to reach private.sock.
      const launch = privateCodexLaunch(privateHome, caller);
      child = spawn(launch.command, launch.args, launch.options);
      privateChildren.add(child);
      child.on('error', childExited);
      child.on('exit', childExited);
      if (!child.stdin || !child.stdout) throw new Error('Missing private pipes');
      child.stdin.on('error', socketFailed);
      socket.on('error', socketFailed);
      socket.on('close', socketClosed);
      socket.pipe(child.stdin);
      child.stdout.pipe(socket);
    } catch {
      socket.destroy();
      if (child) socketClosed();
      else removeHome();
    }
  }

  const children = new Set<ChildProcess>();
  let stopping = false;
  const stop = (code: number) => {
    if (stopping) return;
    stopping = true;
    for (const child of children) child.kill('SIGTERM');
    for (const child of privateChildren) child.stdin?.destroy();
    setTimeout(() => process.exit(code), 500).unref();
  };
  const watch = (child: ChildProcess, required: boolean) => {
    children.add(child);
    child.on('error', () => stop(1));
    child.on('exit', () => { children.delete(child); if (required) stop(1); });
    return child;
  };
  process.on('SIGTERM', () => stop(0)); process.on('SIGINT', () => stop(0));
  for (const name of ['exec', 'host', 'private']) rmSync(`/run/executor/${name}.sock`, { force: true });
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
  function privateConnection(socket: Socket) { startPrivateCodex(socket, caller); }
  createServer(privateConnection).listen('/run/executor/private.sock');
  executor(['host']).listen('/run/executor/host.sock', () => {
    executor([]).listen('/run/executor/exec.sock', () => {
      process.umask(0o077);
      watch(spawn('/usr/bin/setpriv', ['--no-new-privs', '/usr/local/bin/node', '--experimental-strip-types', '/app/src/desktop.ts'], { stdio: 'inherit' }), true);
      watch(spawn('/usr/local/bin/node', ['--experimental-strip-types', '/app/src/bridge.ts'], {
        uid: 1000, gid: 1000, stdio: 'inherit',
        env: { PATH: process.env['PATH'], HOME: '/home/codex', GATEWAY: process.env['GATEWAY'], MODEL: process.env['MODEL'] ?? 'stub-model', PROXY_CALLER_TOKEN: caller },
      }), true);
    });
  });
}
