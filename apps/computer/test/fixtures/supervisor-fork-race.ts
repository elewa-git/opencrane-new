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
        exited = 'State:\\tZ' in parent.read_text()
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

function parentIsLive(pid: string) {
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    return !/State:\s+[ZX]/u.test(status);
  } catch (error) {
    if (!error || typeof error !== 'object' || !('code' in error)
      || error.code !== 'ENOENT') throw error;
    return false;
  }
}

function readDirectoryThenFork(target: typeof fs.readdirSync,
  receiver: unknown, argumentsList: unknown[]): unknown {
  const names: unknown = Reflect.apply(target, receiver, argumentsList);
  if (argumentsList[0] !== '/proc' || !Array.isArray(names)) return names;
  const processNames: unknown[] = names;
  const pid = fs.readFileSync('/workspace/handoff-pid', 'utf8');
  if (!processNames.includes(pid) || !parentIsLive(pid)) return processNames;
  // Force a real fork after the PID list was captured and before status is read.
  fs.rmSync('/workspace/handoff-done', { force: true });
  fs.writeFileSync('/workspace/handoff-now', 'fork');
  execFileSync('/usr/bin/python3', ['-I', '-c', waitForHandoff, pid]);
  return processNames;
}

const directoryObserver = { apply: readDirectoryThenFork };
fs.readdirSync = new Proxy(fs.readdirSync, directoryObserver);
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
