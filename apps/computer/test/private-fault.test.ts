import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

function rejectsDumpWithoutCanary() {
  const directory = mkdtempSync(join(tmpdir(), 'private-dump-'));
  try {
    const source = `import {newDumpFiles} from './apps/computer/test/private-fault-evidence.mjs';
      console.log(JSON.stringify(newDumpFiles([], JSON.parse(process.argv[1]))));`;
    const plainDump = [{ path: '/tmp/core.42', dump: true, sha256: 'empty-dump', size: 0 }];
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', source,
      JSON.stringify(plainDump)], { encoding: 'utf8' });
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual(['/tmp/core.42']);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function inventoriesUnnamedCoreAndMinidump() {
  const directory = mkdtempSync(join(tmpdir(), 'private-core-'));
  try {
    const elf = Buffer.alloc(32);
    elf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
    elf.writeUInt16LE(4, 16);
    writeFileSync(join(directory, 'unnamed'), elf);
    writeFileSync(join(directory, 'other'), 'MDMPwithout any canary');
    writeFileSync(join(directory, 'core.empty'), '');
    const args = ['apps/computer/test/private-inventory.py'];
    const input = JSON.stringify({ paths: [directory] });
    const child = spawnSync('python3', args, { input, encoding: 'utf8' });
    expect(child.status, child.stderr).toBe(0);
    const result: unknown = JSON.parse(child.stdout);
    expect(result).toMatchObject({ files: [
      { dump: true }, { dump: true }, { dump: true },
    ] });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function helperDiesFromRealFault() {
  const directory = mkdtempSync(join(tmpdir(), 'private-fault-'));
  try {
    const binary = join(directory, 'fault');
    execFileSync('gcc', ['-O2', '-Wall', '-Wextra', '-Werror',
      'apps/computer/test/private-fault.c', '-o', binary]);
    const child = spawnSync('prlimit', ['--core=0:0', '--', binary], {
      input: 'test-memory-canary\nfault\n', encoding: 'utf8', timeout: 3000,
    });
    expect(child.stdout).toBe('ready\n');
    expect(child.signal).toBe('SIGSEGV');
    expect(child.status).toBeNull();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

it('rejects a new dump without any private canary', rejectsDumpWithoutCanary);
it('recognises empty named dumps and unnamed ELF cores and minidumps', inventoriesUnnamedCoreAndMinidump);
it('faults through a real inaccessible memory access with core limits zero', helperDiesFromRealFault);

function refusesUnreadableCanaryScan() {
  const directory = mkdtempSync(join(tmpdir(), 'private-unreadable-'));
  try {
    writeFileSync(join(directory, 'private'), 'canary');
    chmodSync(directory, 0);
    const input = JSON.stringify({ paths: [directory], patterns: { canary: ['Y2FuYXJ5'] } });
    const child = spawnSync(process.execPath, ['apps/computer/test/private-scanner.mjs'], {
      input, encoding: 'utf8',
    });
    expect(child.status).toBe(1);
    expect(child.stderr).toContain('EACCES');
  } finally {
    chmodSync(directory, 0o700);
    rmSync(directory, { recursive: true, force: true });
  }
}
it('refuses to qualify an unreadable canary scan', refusesUnreadableCanaryScan);
