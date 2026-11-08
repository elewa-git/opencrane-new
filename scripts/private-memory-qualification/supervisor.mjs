import { spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, rmdirSync,
  statfsSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const lock = '/run/opencrane-memory-qualification.lock';
const protectionFailures = JSON.parse(process.argv[1]);
const args = JSON.parse(process.argv[2]);
let child;
let childClosed = Promise.resolve();
let locked = false;
let stopping = false;
let received = '';
let size = 0;
const output = [];
let recordsBefore = new Set();
let snapshotsReady = false;
let journeyChallenge;
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

function isHostRefusal() {
  try {
    const buffer = Buffer.concat(output);
    const result = JSON.parse(buffer.toString('utf8'));
    if (result === null || result.result !== 'FAIL' || result.reason !== 'host_refused') {
      return false;
    }
    const keys = Object.keys(result);
    if (keys.length === 2) {
      return true;
    }
    // Use the collector's fixed allowlist, passed with the command.
    if (keys.length === 3) {
      return typeof result.protectionFailure === 'string' &&
        !result.protectionFailure.startsWith('private_process_') &&
        protectionFailures.includes(result.protectionFailure);
    }
    return keys.length === 4 && result.complete === false &&
      protectionFailures.includes(result.protectionFailure);
  } catch {
    return false;
  }
}

function names(directory) {
  if (!existsSync(directory)) {
    return new Set();
  }
  const information = lstatSync(directory);
  if (!information.isDirectory() || information.uid !== 0 ||
      statfsSync(directory).type !== 0x01021994) {
    throw new Error('transient_directory_untrusted');
  }
  return new Set(readdirSync(directory));
}

function clearTransientFiles() {
  const recordName = /^opencrane-native-[0-9a-f-]{36}\.identity$/u;
  const currentHomes = names('/home/private');
  for (const name of names('/run')) {
    if (!recordName.test(name) || recordsBefore.has(name)) {
      continue;
    }
    const recordPath = join('/run', name);
    const record = lstatSync(recordPath);
    if (!record.isFile() || record.uid !== 0 || record.nlink !== 1 ||
        (record.mode & 0o077) !== 0 || record.size > 128) {
      throw new Error('native_record_untrusted');
    }
    const contents = readFileSync(recordPath, 'utf8');
    if (!journeyChallenge ||
        (contents !== `${journeyChallenge}\n` &&
         !contents.startsWith(`${journeyChallenge} `))) {
      continue;
    }
    const childId = name.slice('opencrane-native-'.length, -'.identity'.length);
    const homeName = `turn-${childId}`;
    if (currentHomes.has(homeName)) {
      rmSync(join('/home/private', homeName), { recursive: true, force: true });
    }
    rmSync(recordPath, { force: true });
  }
}

async function finish(code) {
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
    if (snapshotsReady) {
      clearTransientFiles();
    }
    if (locked) {
      rmdirSync(lock);
    }
    // Forward only the fixed host refusal from a failed runner, after cleanup succeeds.
    const completed = code === 0 || (code === 1 && isHostRefusal());
    if (completed && size <= 65_536) {
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
  void finish(null);
}
function closed(code) {
  void finish(code);
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
    if (input !== '') {
      const request = JSON.parse(input);
      if (typeof request?.challengeId === 'string') {
        journeyChallenge = request.challengeId;
      }
    }
    const lockOptions = { mode: 0o700 };
    mkdirSync(lock, lockOptions);
    locked = true;
    names('/home/private');
    recordsBefore = names('/run');
    snapshotsReady = true;
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
