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

function isLiveTask(status: string, uids: readonly number[]) {
  const identities = /^Uid:[ \t]+(\d+)[ \t]+(\d+)[ \t]+(\d+)[ \t]+(\d+)[ \t]*$/mu.exec(status);
  if (!identities) throw new Error('Task identity unavailable');
  const state = /^State:[ \t]+([A-Zt])(?:[ \t]|$)/mu.exec(status)?.[1];
  if (!state) throw new Error('Task state unavailable');
  if (state === 'Z' || state === 'X') return false;
  for (const identity of identities.slice(1)) {
    if (uids.includes(Number(identity))) return true;
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

type AllowedTask = (path: string, pid: string, started: string, status: string) => boolean;

function hasLiveThread(directory: string, pid: string, uids: readonly number[],
  allowed?: AllowedTask) {
  const processStarted = startTime(directory, pid);
  const taskDirectory = `${directory}/task`;
  const threads = taskNumbers(taskDirectory);
  let liveTask = false;
  for (const thread of threads) {
    const path = `${taskDirectory}/${thread}`;
    const threadStarted = startTime(path, thread);
    const status = fs.readFileSync(`${path}/status`, 'utf8');
    const live = isLiveTask(status, uids);
    const executing = live && !allowed?.(path, pid, processStarted, status);
    // Bind the status to one task even if its number is reused while we read it.
    requireSameTask(path, thread, threadStarted);
    if (executing) liveTask = true;
  }
  // Refuse a vanished leader too: it may have handed work to a child outside this scan.
  requireSameTask(directory, pid, processStarted);
  requireSameMembers(taskDirectory, threads);
  return liveTask;
}

function hasLiveTasks(processRoot: string, uids: readonly number[], allowed?: AllowedTask) {
  const processes = taskNumbers(processRoot);
  for (const pid of processes) {
    // Let every observation error refuse proof, including exits after seeing live work.
    if (hasLiveThread(`${processRoot}/${pid}`, pid, uids, allowed)) return true;
  }
  requireSameMembers(processRoot, processes);
  return false;
}

export function hasLiveExecutionTasks(processRoot = '/proc') {
  return hasLiveTasks(processRoot, EXECUTION_UIDS);
}

export function desktopInventory(launcherPid: number) {
  const launcher = String(launcherPid);
  const launcherPath = `/proc/${launcher}`;
  const launcherStarted = startTime(launcherPath, launcher);

  function allowed(path: string, pid: string, started: string, status: string) {
    const processName = fs.readFileSync(`/proc/${pid}/comm`, 'utf8');
    const name = processName.trim();
    const parent = /^PPid:[ \t]+(\d+)[ \t]*$/mu.exec(status)?.[1];
    if (!parent) throw new Error('Task parent unavailable');
    if (pid === launcher) {
      return started === launcherStarted && name === 'node';
    }
    if (parent === launcher && name === 'Xvnc') return true;
    // Recognise only childless Node relays started outside the Pod's PID namespace.
    const children = fs.readFileSync(`${path}/children`, 'utf8');
    return parent === '0' && name === 'node' && children.trim() === '';
  }

  function quiet() {
    requireSameTask(launcherPath, launcher, launcherStarted);
    const unexpected = hasLiveTasks('/proc', [1002], allowed);
    requireSameTask(launcherPath, launcher, launcherStarted);
    return !unexpected;
  }
  return quiet;
}
