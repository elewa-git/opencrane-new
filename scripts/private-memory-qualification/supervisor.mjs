import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmdirSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

const lock = '/run/opencrane-memory-qualification.lock';
const args = JSON.parse(process.argv[1]);
let child;
let childClosed = Promise.resolve();
let locked = false;
let stopping = false;
let received = '';
let size = 0;
const output = [];
const deadline = setTimeout(cancel, 120_000);

function killGroup() {
  if (!child?.pid) {
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch (error) {
    if (error.code !== 'ESRCH') {
      throw error;
    }
  }
}

function groupIsRunning() {
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/u.test(entry)) {
      continue;
    }
    let stat;
    try {
      stat = readFileSync(`/proc/${entry}/stat`, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ESRCH') {
        continue;
      }
      throw error;
    }
    const processFields = stat.slice(stat.lastIndexOf(')') + 2);
    const fields = processFields.split(' ');
    // Wait for every group member to stop before allowing a retry. Zombies hold no memory.
    if (Number(fields[2]) === child.pid && fields[0] !== 'Z') {
      return true;
    }
  }
  return false;
}

async function finish(success) {
  if (stopping) {
    return;
  }
  stopping = true;
  clearTimeout(deadline);
  try {
    killGroup();
    await childClosed;
    while (child?.pid && groupIsRunning()) {
      await delay(10);
    }
    if (locked) {
      rmdirSync(lock);
    }
    if (success && size <= 65_536) {
      process.stdout.end(Buffer.concat(output), exitSuccessfully);
      return;
    }
  } catch {
    // Keep the lock when cleanup cannot be confirmed, so a retry cannot overlap.
  }
  process.exit(1);
}
function exitSuccessfully() {
  process.exit(0);
}
function cancel() {
  void finish(false);
}
function closed(code) {
  void finish(code === 0);
}
function collect(buffer, keep) {
  size += buffer.length;
  if (size > 65_536) {
    cancel();
    return;
  }
  if (keep) {
    output.push(buffer);
  }
}
function stdout(buffer) {
  collect(buffer, true);
}
function stderr(buffer) {
  collect(buffer, false);
}
function receive(buffer) {
  if (child || stopping) {
    cancel();
    return;
  }
  received += buffer.toString('utf8');
  if (received.length > 65_536) {
    cancel();
    return;
  }
  if (!received.endsWith('\n')) {
    return;
  }
  try {
    const input = JSON.parse(received);
    const lockOptions = { mode: 0o700 };
    mkdirSync(lock, lockOptions);
    locked = true;
    // Put the journey and its children in one process group, outside this supervisor.
    const childOptions = { detached: true, stdio: 'pipe' };
    child = spawn(args[0], args.slice(1), childOptions);
    function waitForClose(resolve) {
      child.on('close', resolve);
    }
    childClosed = new Promise(waitForClose);
    child.on('error', cancel);
    child.on('exit', closed);
    child.stdin.on('error', cancel);
    child.stdout.on('data', stdout);
    child.stderr.on('data', stderr);
    child.stdin.end(input);
  } catch {
    cancel();
  }
}

// Treat the collector's open stdin pipe as permission to keep the journey alive.
process.stdin.on('data', receive);
process.stdin.on('end', cancel);
process.stdin.on('error', cancel);
process.stdout.on('error', cancel);
process.on('SIGTERM', cancel);
process.on('SIGINT', cancel);
process.on('SIGHUP', cancel);
