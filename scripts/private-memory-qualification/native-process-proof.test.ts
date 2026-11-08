import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, expect, it } from 'vitest';
import { nativeDumpProtected, proveNativePair } from './native-process-proof.ts';

const directories: string[] = [];

function record(contents: string, mode = 0o600): string {
  const directory = mkdtempSync(join(tmpdir(), 'native-proof-'));
  directories.push(directory);
  const path = join(directory, 'identity');
  writeFileSync(path, contents, { mode });
  return path;
}

afterEach(function removeRecords(): void {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function standInCannotPass(): void {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  try {
    expect(child.pid).toBeDefined();
    const path = record(`${child.pid} 1\n`);
    const result = proveNativePair({ challengeId: '11111111-1111-4111-8111-111111111111',
      wrapperPid: child.pid!, childPid: child.pid!,
      recordPath: path, childBinary: process.execPath });
    expect(result).not.toBe(true);
  } finally {
    child.kill('SIGKILL');
  }
}

it('refuses a stand-in process even with a fixture-reported PID', standInCannotPass);

function missingRecordCannotPass(): void {
  const result = proveNativePair({ challengeId: '11111111-1111-4111-8111-111111111111',
    wrapperPid: process.pid, childPid: process.pid,
    recordPath: '/run/missing-native-proof-record', childBinary: process.execPath });
  expect(result).not.toBe(true);
}

it('refuses a missing launch record', missingRecordCannotPass);

function writableRecordCannotPass(): void {
  const path = record(`${process.pid} 1\n`, 0o666);
  const result = proveNativePair({ challengeId: '11111111-1111-4111-8111-111111111111',
    wrapperPid: process.pid, childPid: process.pid,
    recordPath: path, childBinary: process.execPath });
  expect(result).not.toBe(true);
}

it('refuses a writable launch record', writableRecordCannotPass);

function executedProcessesAreDumpable(): void {
  const first = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  const second = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  try {
    expect(first.pid).toBeDefined();
    expect(second.pid).toBeDefined();
    expect(nativeDumpProtected(first.pid!)).toBe(false);
    expect(nativeDumpProtected(second.pid!)).toBe(false);
  } finally {
    first.kill('SIGKILL');
    second.kill('SIGKILL');
  }
}

it('measures both executed processes as dumpable', executedProcessesAreDumpable);

async function protectedProcessHasRootOwnedStatus(): Promise<void> {
  const code = [
    'import ctypes',
    'import time',
    'assert ctypes.CDLL(None).prctl(4, 0, 0, 0, 0) == 0',
    'time.sleep(10)',
  ].join('\n');
  const child = spawn('python3', ['-c', code], { stdio: 'ignore' });
  try {
    expect(child.pid).toBeDefined();
    let protectedStatus = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const status = statSync(`/proc/${child.pid}/status`);
      if (status.uid === 0) {
        protectedStatus = true;
        break;
      }
      await delay(10);
    }
    expect(protectedStatus).toBe(true);
    expect(nativeDumpProtected(child.pid!)).toBe(true);
  } finally {
    child.kill('SIGKILL');
  }
}

it('accepts proc ownership only after a live process disables dumps',
  protectedProcessHasRootOwnedStatus);
