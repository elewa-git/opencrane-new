import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

const waitForHandoff = `
import pathlib
import sys
import time
parent = pathlib.Path('/proc/' + sys.argv[1] + '/status')
deadline = time.monotonic() + 5
while True:
    try:
        parent.read_text()
        exited = False
    except FileNotFoundError:
        exited = True
    if exited and pathlib.Path('/workspace/handoff-done').exists():
        break
    if time.monotonic() >= deadline:
        raise RuntimeError('Detached process did not hand work to a child')
    time.sleep(0.005)
`;
interface SupervisorModule {
  supervisorStop: () => unknown;
}

function isSupervisorModule(value: unknown): value is SupervisorModule {
  return value !== null && typeof value === 'object' && 'supervisorStop' in value
    && typeof value.supervisorStop === 'function';
}

const stage = process.argv[2];
const originalReadFile = fs.readFileSync;
const originalReadDirectory = fs.readdirSync;
let observedWorker = false;
let injected = false;

function handOff(pid: string) {
  fs.rmSync('/workspace/handoff-done', { force: true });
  fs.writeFileSync('/workspace/handoff-now', 'fork');
  execFileSync('/usr/bin/python3', ['-I', '-c', waitForHandoff, pid]);
  fs.writeFileSync('/workspace/fork-injected', stage ?? 'unknown');
  injected = true;
}

function readDirectoryThenFork(target: typeof fs.readdirSync,
  receiver: unknown, argumentsList: unknown[]): unknown {
  const names: unknown = Reflect.apply(target, receiver, argumentsList);
  if (stage !== 'directory' || injected || argumentsList[0] !== '/proc'
    || !Array.isArray(names)) return names;
  const pid = originalReadFile('/workspace/handoff-pid', 'utf8');
  if (!names.includes(pid)) throw new Error('Handoff parent missing from inventory');
  // Force a real fork after capturing the process list.
  handOff(pid);
  return names;
}

function readFileThenFork(...args: Parameters<typeof fs.readFileSync>) {
  const pid = originalReadFile('/workspace/handoff-pid', 'utf8');
  if (stage === 'observed-worker' && !injected) {
    if (observedWorker && args[0] === `/proc/${pid}/stat`) {
      // Wait for the observed worker to fork and be reaped before its final identity check.
      handOff(pid);
    }
    if (args[0] === `/proc/${pid}/task/${pid}/status`) observedWorker = true;
  }
  return originalReadFile(...args);
}

const directoryObserver = { apply: readDirectoryThenFork };
fs.readdirSync = new Proxy(originalReadDirectory, directoryObserver);
fs.readFileSync = readFileThenFork;
syncBuiltinESMExports();
const supervisorModule = new URL('file:///app/src/supervisor-stop.ts');
const stopModule: unknown = await import(supervisorModule.href);
if (!isSupervisorModule(stopModule)) throw new Error('Supervisor module unavailable');
fs.rmSync('/run/executor/supervisor/control.sock');
stopModule.supervisorStop();

function ready() {
  fs.writeFileSync('/workspace/fork-observer-ready', 'ready');
}
setImmediate(ready);
