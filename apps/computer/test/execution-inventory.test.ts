import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { hasLiveExecutionTasks } from '../src/execution-inventory.ts';

const processRoot = fs.mkdtempSync(join(tmpdir(), 'execution-inventory-'));
const readFile = fs.readFileSync;

function cleanup() {
  vi.restoreAllMocks();
  fs.rmSync(processRoot, { recursive: true, force: true });
}
afterEach(cleanup);

function stat(pid: string, start: string, state = 'S') {
  // Include spaces and a closing bracket in the name, as Linux permits both.
  return `${pid} (worker ) name) ${state} ${Array(18).fill('0').join(' ')} ${start} 0`;
}

function task(pid: string, tid: string, uid = 1001, state = 'S', start = '123') {
  const directory = join(processRoot, pid, 'task', tid);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(join(directory, 'stat'), stat(tid, start, state));
  fs.writeFileSync(join(directory, 'status'),
    `Name:\tworker\nState:\t${state} (fixture)\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`);
  fs.writeFileSync(join(processRoot, pid, 'stat'), stat(pid, start, state));
  return directory;
}

function findsExecutor(uid: number) {
  task('42', '42', uid);
  expect(hasLiveExecutionTasks(processRoot)).toBe(true);
}
it.each([1001, 1003])('finds live execution tasks owned by UID %s', findsExecutor);

function findsZombieWorker() {
  task('42', '43', 1001);
  task('42', '42', 1001, 'Z');
  expect(hasLiveExecutionTasks(processRoot)).toBe(true);
}
it('checks live workers even when their process leader is a zombie', findsZombieWorker);

function acceptsExitedTasks() {
  task('42', '42', 1001, 'Z');
  task('45', '45', 1003, 'X');
  task('46', '46', 1002);
  expect(hasLiveExecutionTasks(processRoot)).toBe(false);
}
it('excludes exited tasks and leaves the desktop outside executor termination', acceptsExitedTasks);

function rejectsIncompleteIdentity(value: string) {
  const directory = task('42', '42');
  fs.writeFileSync(join(directory, 'status'), value);
  expect(() => hasLiveExecutionTasks(processRoot)).toThrow('Task identity unavailable');
}
it.each([
  'State:\tS\n',
  'State:\tS\nUid:\t1001\n',
  'State:\tS\nUid:\t1000\tunknown\t1000\t1000\n',
])('refuses incomplete task identities: %s', rejectsIncompleteIdentity);

function checksEveryUid() {
  const directory = task('42', '42', 1000);
  fs.writeFileSync(join(directory, 'status'), 'State:\tS\nUid:\t1000\t1001\t1000\t1000\n');
  expect(hasLiveExecutionTasks(processRoot)).toBe(true);
}
it('checks effective, saved and filesystem identities as well as the real user', checksEveryUid);

function rejectsInvalidStat(value: string) {
  task('42', '42', 1002);
  fs.writeFileSync(join(processRoot, '42', 'stat'), value);
  expect(() => hasLiveExecutionTasks(processRoot)).toThrow('Task identity unavailable');
}
it.each(['', '42 (worker) S', stat('43', '123'), stat('42', 'invalid')])(
  'refuses an unreadable process identity: %s', rejectsInvalidStat);

function rejectsReusedIdentity(target: 'process' | 'thread') {
  const directory = task('42', '42', 1002);
  let identityPath = join(processRoot, '42', 'stat');
  if (target === 'thread') identityPath = join(directory, 'stat');
  let reads = 0;
  function inspect(...args: Parameters<typeof fs.readFileSync>) {
    if (args[0] === identityPath) {
      reads++;
      if (reads === 2) return stat('42', '124');
    }
    return Reflect.apply(readFile, fs, args) as ReturnType<typeof fs.readFileSync>;
  }
  vi.spyOn(fs, 'readFileSync').mockImplementation(inspect);
  expect(() => hasLiveExecutionTasks(processRoot)).toThrow('Task identity changed');
}
it.each(['process', 'thread'] as const)(
  'refuses a reused %s number during observation', rejectsReusedIdentity);

function acceptsAnObservedExit() {
  const directory = task('42', '42', 1001);
  function exitBeforeStatus(...args: Parameters<typeof fs.readFileSync>) {
    if (args[0] === join(directory, 'status')) {
      fs.rmSync(join(processRoot, '42'), { recursive: true });
    }
    return Reflect.apply(readFile, fs, args) as ReturnType<typeof fs.readFileSync>;
  }
  vi.spyOn(fs, 'readFileSync').mockImplementation(exitBeforeStatus);
  expect(hasLiveExecutionTasks(processRoot)).toBe(false);
}
it('allows a process to exit during observation', acceptsAnObservedExit);

function refusesAnUnreadableTask() {
  const directory = task('42', '42');
  function refuseStatus(...args: Parameters<typeof fs.readFileSync>) {
    if (args[0] === join(directory, 'status')) {
      const error = Object.assign(new Error('Fixture refusal'), { code: 'EACCES' });
      throw error;
    }
    return Reflect.apply(readFile, fs, args) as ReturnType<typeof fs.readFileSync>;
  }
  vi.spyOn(fs, 'readFileSync').mockImplementation(refuseStatus);
  expect(() => hasLiveExecutionTasks(processRoot)).toThrow('Fixture refusal');
}
it('never treats a permission error as an exited task', refusesAnUnreadableTask);
