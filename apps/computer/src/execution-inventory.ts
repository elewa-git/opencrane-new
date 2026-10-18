import fs from 'node:fs';

export const EXECUTION_UIDS: readonly number[] = [1001, 1003];

function startTime(path: string, pid: string) {
  const contents = fs.readFileSync(`${path}/stat`, 'utf8');
  const nameStart = contents.indexOf('(');
  const nameEnd = contents.lastIndexOf(')');
  // Read past the full process name: Linux permits spaces and brackets in it.
  const numberPrefix = contents.slice(0, nameStart);
  const observedPid = numberPrefix.trim();
  if (nameStart < 1 || nameEnd <= nameStart || observedPid !== pid) {
    throw new Error('Task identity unavailable');
  }
  const afterName = contents.slice(nameEnd + 1);
  const statistics = afterName.trim();
  const fields = statistics.split(/\s+/u);
  const started = fields[19];
  if (!started || !/^\d+$/u.test(started)) throw new Error('Task identity unavailable');
  return started;
}

function requireSameTask(path: string, pid: string, started: string) {
  if (startTime(path, pid) !== started) throw new Error('Task identity changed');
}

function isLiveExecutionTask(status: string) {
  const identities = /^Uid:[ \t]+(\d+)[ \t]+(\d+)[ \t]+(\d+)[ \t]+(\d+)[ \t]*$/mu.exec(status);
  if (!identities) throw new Error('Task identity unavailable');
  const state = /^State:[ \t]+([A-Zt])(?:[ \t]|$)/mu.exec(status)?.[1];
  if (!state) throw new Error('Task state unavailable');
  if (state === 'Z' || state === 'X') return false;
  for (const identity of identities.slice(1)) {
    if (EXECUTION_UIDS.includes(Number(identity))) return true;
  }
  return false;
}

function isTaskNumber(name: string) {
  return /^\d+$/u.test(name);
}

function taskNumbers(directory: string) {
  const names = fs.readdirSync(directory);
  return names.filter(isTaskNumber);
}

function requireSameMembers(directory: string, before: readonly string[]) {
  const after = taskNumbers(directory);
  const members = new Set(after);
  if (before.length !== after.length) throw new Error('Task membership changed');
  for (const name of before) {
    if (!members.has(name)) throw new Error('Task membership changed');
  }
}

function hasLiveExecutionThread(directory: string, pid: string) {
  const processStarted = startTime(directory, pid);
  const taskDirectory = `${directory}/task`;
  const threads = taskNumbers(taskDirectory);
  let liveTask = false;
  for (const thread of threads) {
    const path = `${taskDirectory}/${thread}`;
    const threadStarted = startTime(path, thread);
    const status = fs.readFileSync(`${path}/status`, 'utf8');
    const executing = isLiveExecutionTask(status);
    // Bind the status to one task even if its number is reused while we read it.
    requireSameTask(path, thread, threadStarted);
    if (executing) liveTask = true;
  }
  // Refuse a vanished leader too: it may have handed work to a child outside this scan.
  requireSameTask(directory, pid, processStarted);
  requireSameMembers(taskDirectory, threads);
  return liveTask;
}

export function hasLiveExecutionTasks(processRoot = '/proc') {
  const processes = taskNumbers(processRoot);
  for (const pid of processes) {
    // Let every observation error refuse proof, including exits after seeing live work.
    if (hasLiveExecutionThread(`${processRoot}/${pid}`, pid)) return true;
  }
  requireSameMembers(processRoot, processes);
  return false;
}
