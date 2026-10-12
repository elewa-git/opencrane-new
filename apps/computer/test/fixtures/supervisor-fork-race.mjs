import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

const originalReadDirectory = fs.readdirSync;
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

function parentIsLive(pid) {
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    return !/State:\s+[ZX]/u.test(status);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return false;
  }
}

function readDirectoryThenFork(path, options) {
  const names = originalReadDirectory(path, options);
  if (path !== '/proc') return names;
  const pid = fs.readFileSync('/workspace/handoff-pid', 'utf8');
  if (!names.includes(pid) || !parentIsLive(pid)) return names;
  // Force a real fork after the PID list was captured and before status is read.
  fs.rmSync('/workspace/handoff-done', { force: true });
  fs.writeFileSync('/workspace/handoff-now', 'fork');
  execFileSync('/usr/bin/python3', ['-I', '-c', waitForHandoff, pid]);
  return names;
}

fs.readdirSync = readDirectoryThenFork;
syncBuiltinESMExports();
const { supervisorStop } = await import('/app/src/supervisor-stop.ts');
fs.rmSync('/run/executor/supervisor/control.sock');
supervisorStop();

function ready() {
  fs.writeFileSync('/workspace/fork-observer-ready', 'ready');
}
setImmediate(ready);
