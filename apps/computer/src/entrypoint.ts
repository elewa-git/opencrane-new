import { prepareTemporaryDirectory } from './display-lock.ts';
// Prepare protected homes and start the computer's separate user processes.
import {
  mkdirSync, lstatSync, openSync, closeSync, fstatSync, fchmodSync, fchownSync,
  constants, symlinkSync, rmSync, readdirSync, writeFileSync, chownSync,
} from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { privateConfig, privateEnvironments } from './codex-config.ts';
import { privateCodexLaunch } from './private-codex.ts';
import { supervisorStop } from './supervisor-stop.ts';
import { workerExecutor } from './worker-executor.ts';
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
function preparePrivateHome(privateHome: string) {
  const directories = [privateHome, `${privateHome}/codex`,
    `${privateHome}/tmp`, `${privateHome}/work`];
  for (const path of directories) {
    mkdirSync(path, { mode: 0o700 });
  }
  const configPath = `${privateHome}/codex/config.toml`;
  const environmentsPath = `${privateHome}/codex/environments.toml`;
  writeFileSync(configPath, privateConfig(process.env['MODEL'] ?? 'stub-model'));
  writeFileSync(environmentsPath, privateEnvironments());
  const ownedPaths = [...directories, configPath, environmentsPath];
  // Keep the modes set at creation. Root lacks FOWNER after giving files to UID 1003.
  for (const path of ownedPaths) {
    chownSync(path, 1003, 1003);
  }
}

function supervisePrivateChild(child: ChildProcess, socket: Socket, privateHome: string,
  children: Set<ChildProcess>) {
  let exited = false;
  let timer: NodeJS.Timeout | undefined;
  let killAttempts = 0;
  function childExited() {
    exited = true;
    if (timer) clearTimeout(timer);
    children.delete(child);
    socket.destroy();
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
  child.on('error', childExited);
  child.on('exit', childExited);
  child.stdin?.on('error', socketFailed);
  socket.on('error', socketFailed);
  socket.on('close', socketClosed);
}

if (process.argv[2] === 'connect' || process.argv[2] === 'connect-host') {
  const socket = connect(process.argv[2] === 'connect-host' ? '/run/executor/host.sock' : '/run/executor/exec.sock');
  process.stdin.pipe(socket); socket.pipe(process.stdout);
  socket.on('error', () => process.exit(1));
} else {
  process.umask(0o077);
  prepareTemporaryDirectory();
  const home = trustedParent('/home'), run = trustedParent('/run');
  const agent = directory(home, 'agent', 0, 0o755);
  for (const [name, uid] of [['codex', 1000], ['workspace', 1001], ['profile', 1002]] as const) {
    closeSync(directory(agent, name, uid, name === 'workspace' ? 0o755 : 0o700));
  }
  for (const [name, uid] of [['codex', 1000], ['tool', 1001], ['desktop', 1002]] as const) {
    closeSync(directory(home, name, uid, 0o700));
  }
  closeSync(directory(agent, 'supervisor', 0, 0o700));
  const executorDirectory = directory(run, 'executor', 0, 0o750, 1000);
  closeSync(directory(executorDirectory, 'supervisor', 0, 0o700));
  closeSync(directory(executorDirectory, 'credentials', 0, 0o750, 1000));
  closeSync(executorDirectory);
  rmSync('/run/executor/supervisor/control.sock', { force: true });
  const supervisor = supervisorStop();
  closeSync(directory(home, 'private', 0, 0o711));
  for (const name of readdirSync('/home/private')) {
    if (name.startsWith('turn-')) rmSync(`/home/private/${name}`, { recursive: true, force: true });
  }
  closeSync(directory(run, 'codex', 1000, 0o700));
  closeSync(agent); closeSync(home); closeSync(run);
  rmSync('/home/codex/.codex', { recursive: true, force: true });
  symlinkSync('/home/agent/codex', '/home/codex/.codex');
  const caller = randomBytes(32).toString('hex');
  const privateChildren = new Set<ChildProcess>();
  let privateCounter = 0;

  function startPrivateCodex(socket: Socket, caller: string) {
    const privateHome = `/home/private/turn-${++privateCounter}`;
    let child: ChildProcess | undefined;
    try {
      preparePrivateHome(privateHome);
      // Keep stderr out of Pod logs. Private turns share UID 1003.
      // Treat /tmp, /dev/shm and world-writable workspace folders as writable limits.
      // Treat workspace reads and loopback ports 8080, 8081 and 6901 as limits too.
      // Check directory protections under gVisor before claiming live isolation.
      // Allow UID 1000 processes to reach private.sock, including memory-free Codex.
      const launch = privateCodexLaunch(privateHome, caller);
      child = spawn(launch.command, launch.args, launch.options);
      privateChildren.add(child);
      supervisePrivateChild(child, socket, privateHome, privateChildren);
      if (!child.stdin || !child.stdout) throw new Error('Missing private pipes');
      socket.pipe(child.stdin);
      child.stdout.pipe(socket);
    } catch {
      socket.destroy();
      if (child) {
        child.stdin?.destroy();
      } else {
        rmSync(privateHome, { recursive: true, force: true });
      }
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
  for (const name of ['exec', 'host', 'private']) {
    rmSync(`/run/executor/${name}.sock`, { force: true });
  }
  for (const name of ['control', 'app']) rmSync(`/run/codex/${name}.sock`, { force: true });
  const executor = (args: string[]) => createServer(socket => {
    if (!supervisor.admit(socket)) return;
    const child = watch(spawn('/usr/local/bin/tool-user', args, { stdio: ['pipe', 'pipe', 'inherit'] }), false);
    if (!child.stdin || !child.stdout) throw new Error('Missing executor pipes');
    if (args.length === 0) {
      function reply(value: unknown) {
        const frame = `${JSON.stringify(value)}\n`;
        if (socket.writableLength + Buffer.byteLength(frame) > 65_536) {
          socket.destroy();
          return;
        }
        socket.write(frame);
      }
      function refuseFrame() { socket.destroy(); }
      const input = workerExecutor(reply);
      input.on('error', refuseFrame);
      function closeInput() { input.destroy(); }
      socket.on('close', closeInput);
      socket.pipe(input);
      input.pipe(child.stdin);
    } else {
      socket.pipe(child.stdin);
    }
    child.stdout.pipe(socket);
    child.stdin.on('error', () => socket.destroy());
    // EOF shuts down the executor without signalling across UIDs (CAP_KILL is dropped).
    socket.on('error', () => child.stdin?.destroy()); socket.on('close', () => child.stdin?.destroy());
  });
  // Only UID 1000 can traverse this root-owned directory. No path-based socket chmod/chown.
  process.umask(0o111);
  function privateConnection(socket: Socket) {
    if (!supervisor.admit(socket)) return;
    startPrivateCodex(socket, caller);
  }
  createServer(privateConnection).listen('/run/executor/private.sock');
  executor(['host']).listen('/run/executor/host.sock', () => {
    executor([]).listen('/run/executor/exec.sock', () => {
      process.umask(0o077);
      // Prevent same-user processes from opening a debugger and changing trusted checks.
      const desktopArgs = ['--no-new-privs', '/usr/local/bin/node', '--disable-sigusr1',
        '--experimental-strip-types', '/app/src/desktop.ts'];
      const desktopEnvironment = { ...process.env, NODE_OPTIONS: '' };
      const desktopOptions = { stdio: 'inherit' as const, env: desktopEnvironment };
      const desktop = spawn('/usr/bin/setpriv', desktopArgs, desktopOptions);
      supervisor.desktopStarted(desktop.pid);
      watch(desktop, true);
      const bridgeArgs = ['--disable-sigusr1', '--experimental-strip-types', '/app/src/bridge.ts'];
      const bridgeEnvironment = {
        PATH: process.env['PATH'], HOME: '/home/codex', GATEWAY: process.env['GATEWAY'],
        MODEL: process.env['MODEL'] ?? 'stub-model', PROXY_CALLER_TOKEN: caller,
      };
      const bridgeOptions = {
        uid: 1000, gid: 1000, stdio: 'inherit' as const, env: bridgeEnvironment,
      };
      const bridge = spawn('/usr/local/bin/node', bridgeArgs, bridgeOptions);
      watch(bridge, true);
    });
  });
}
