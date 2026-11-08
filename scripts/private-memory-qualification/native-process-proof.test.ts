import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { proveNativePair } from './native-process-proof.ts';

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
