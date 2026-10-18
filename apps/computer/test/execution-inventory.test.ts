import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
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
  const fields = Array<string>(18);
  fields.fill('0');
  const statistics = fields.join(' ');
  return `${pid} (worker ) name) ${state} ${statistics} ${start} 0`;
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

function inspectInventory() {
  return hasLiveExecutionTasks(processRoot);
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
  expect(inspectInventory).toThrow('Task identity unavailable');
}
it.each([
  'State:\tS\n',
  'State:\tS\nUid:\t1001\n',
  'State:\tS\nUid:\t1000\t1000\n',
  'State:\tS\nUid:\t1000\t1000\t1000\n',
  'State:\tS\nUid:\t1000\t1000\t1000\t1000\t1000\n',
  'State:\tS\nUid:\t1000\tunknown\t1000\t1000\n',
])('refuses incomplete task identities: %s', rejectsIncompleteIdentity);

function checksEveryUid(uid: number, slot: number) {
  const directory = task('42', '42', 1000);
  const identities = [1000, 1000, 1000, 1000];
  identities[slot] = uid;
  const columns = identities.join('\t');
  fs.writeFileSync(join(directory, 'status'), `State:\tS\nUid:\t${columns}\n`);
  expect(hasLiveExecutionTasks(processRoot)).toBe(true);
}
it.each([
  [1001, 0], [1001, 1], [1001, 2], [1001, 3],
  [1003, 0], [1003, 1], [1003, 2], [1003, 3],
])('finds executor UID %s when only UID column %s matches', checksEveryUid);

function rejectsInvalidState(state: string) {
  const directory = task('42', '42', 1000);
  fs.writeFileSync(join(directory, 'status'), `${state}Uid:\t1000\t1000\t1000\t1000\n`);
  expect(inspectInventory).toThrow('Task state unavailable');
}
it.each(['', 'State:\t\n', 'State:\t?\n', 'State:\tSleeping\n'])(
  'refuses missing or malformed task state: %s', rejectsInvalidState);

function rejectsInvalidStat(value: string) {
  task('42', '42', 1002);
  fs.writeFileSync(join(processRoot, '42', 'stat'), value);
  expect(inspectInventory).toThrow('Task identity unavailable');
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
    return readFile(...args);
  }
  vi.spyOn(fs, 'readFileSync').mockImplementation(inspect);
  expect(inspectInventory).toThrow('Task identity changed');
}
it.each(['process', 'thread'] as const)(
  'refuses a reused %s number during observation', rejectsReusedIdentity);

function refusesAnObservedExit() {
  const directory = task('42', '42', 1001);
  function exitBeforeStatus(...args: Parameters<typeof fs.readFileSync>) {
    if (args[0] === join(directory, 'status')) {
      fs.rmSync(join(processRoot, '42'), { recursive: true });
    }
    return readFile(...args);
  }
  vi.spyOn(fs, 'readFileSync').mockImplementation(exitBeforeStatus);
  expect(inspectInventory).toThrow();
}
it('refuses a process disappearing during observation', refusesAnObservedExit);

function refusesAnUnreadableTask() {
  const directory = task('42', '42');
  function refuseStatus(...args: Parameters<typeof fs.readFileSync>) {
    if (args[0] === join(directory, 'status')) {
      const details = { code: 'EACCES' };
      const error = Object.assign(new Error('Fixture refusal'), details);
      throw error;
    }
    return readFile(...args);
  }
  vi.spyOn(fs, 'readFileSync').mockImplementation(refuseStatus);
  expect(inspectInventory).toThrow('Fixture refusal');
}
it('never treats a permission error as an exited task', refusesAnUnreadableTask);

function refusesLateChild() {
  const directory = task('42', '42');
  let observed = false;
  let injected = false;
  function handOffAfterObservation(...args: Parameters<typeof fs.readFileSync>) {
    if (args[0] === join(directory, 'status')) observed = true;
    if (observed && args[0] === join(processRoot, '42', 'stat')) {
      task('99', '99');
      fs.rmSync(join(processRoot, '42'), { recursive: true });
      injected = true;
    }
    return readFile(...args);
  }
  vi.spyOn(fs, 'readFileSync').mockImplementation(handOffAfterObservation);
  expect(inspectInventory).toThrow();
  expect(injected).toBe(true);
  vi.restoreAllMocks();
  expect(hasLiveExecutionTasks(processRoot)).toBe(true);
}
it('refuses a vanished observed worker that handed work to a late child', refusesLateChild);

function refusesChangedMembership(scope: string, change: string) {
  task('42', '42', 1000);
  const directory = task('45', '44', 1000);
  const other = task('45', '45', 1000);
  let injected = false;
  function changeAfterStatus(...args: Parameters<typeof fs.readFileSync>) {
    const contents = readFile(...args);
    if (args[0] === join(other, 'status') && !injected) {
      if (scope === 'process') {
        if (change === 'appears') task('99', '99');
        else fs.rmSync(join(processRoot, '42'), { recursive: true });
      } else {
        if (change === 'appears') task('45', '46');
        else fs.rmSync(directory, { recursive: true });
      }
      injected = true;
    }
    return contents;
  }
  vi.spyOn(fs, 'readFileSync').mockImplementation(changeAfterStatus);
  expect(inspectInventory).toThrow();
  expect(injected).toBe(true);
}
it.each([
  ['process', 'appears'], ['process', 'vanishes'],
  ['thread', 'appears'], ['thread', 'vanishes'],
])('refuses changed membership when a %s %s', refusesChangedMembership);
