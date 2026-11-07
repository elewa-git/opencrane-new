import { randomBytes } from 'node:crypto';
import {
  chmodSync, linkSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { persistenceScan } from './persistence.ts';

const categories = ['pvc', 'rollout', 'cache', 'outbox', 'logs', 'dumps'] as const;
const installation = `sha256:${'a'.repeat(64)}`;
let directory: string;
let canary: Buffer;
let inventory: { category: typeof categories[number]; path: string }[];
let scan: ReturnType<typeof persistenceScan>;

function freshCanary(): Buffer {
  const bytes = randomBytes(32);
  const text = bytes.toString('hex');
  bytes.fill(0);
  return Buffer.from(text);
}

function prepare() {
  directory = mkdtempSync(join(tmpdir(), 'persistence-'));
  canary = freshCanary();
  inventory = [];
  for (const category of categories) {
    const path = join(directory, category);
    mkdirSync(path);
    const entry = { category, path };
    inventory.push(entry);
  }
  scan = persistenceScan(inventory, canary, installation);
}
function cleanup() {
  scan.close();
  canary.fill(0);
  rmSync(directory, { recursive: true, force: true });
}
beforeEach(prepare);
afterEach(cleanup);

function expectNotRun(
  result: ReturnType<typeof scan.scan>, category: typeof categories[number] | 'inventory',
  files = 0, bytes = 0,
) {
  expect(result).toEqual({
    result: 'NOT RUN', complete: false, category, files, bytes,
    reason: 'Storage inspection could not be completed.',
  });
}

function cleanPair() {
  writeFileSync(join(directory, 'pvc', 'status'), 'ended');
  expect(scan.scan('live', installation)).toEqual({
    result: 'PARTIAL', complete: false, files: 1, bytes: 5,
  });
  expect(scan.scan('stopped', installation)).toEqual({
    result: 'PARTIAL', complete: false, files: 1, bytes: 5,
  });
}
it('reads all required directories twice without claiming qualification', cleanPair);

function persisted(category: typeof categories[number]) {
  writeFileSync(join(directory, category, '.hidden'), canary);
  expect(scan.scan('live', installation)).toEqual({
    result: 'FAIL', complete: false, category, files: 0, bytes: 64,
  });
}
it.each(categories)('detects bytes in the writable %s fixture without returning them', persisted);

async function delayedWrite() {
  expect(scan.scan('live', installation).result).toBe('PARTIAL');
  await Promise.resolve();
  writeFileSync(join(directory, 'outbox', 'late'), canary);
  expect(scan.scan('stopped', installation)).toEqual({
    result: 'FAIL', complete: false, category: 'outbox', files: 0, bytes: 64,
  });
}
it('finds a delayed write in the second scan after a simulated Stop', delayedWrite);

function missing(category: typeof categories[number]) {
  rmSync(join(directory, category), { recursive: true });
  expectNotRun(scan.scan('live', installation), category);
}
it.each(categories)('refuses a missing required %s directory', missing);

function omitted(category: typeof categories[number]) {
  function keep(entry: typeof inventory[number]) {
    return entry.category !== category;
  }
  const incomplete = inventory.filter(keep);
  const attempt = persistenceScan(incomplete, canary, installation);
  expectNotRun(attempt.scan('live', installation), 'inventory');
  attempt.close();
}
it.each(categories)('refuses an inventory that skips %s', omitted);

function unreadable(category: typeof categories[number]) {
  chmodSync(join(directory, category), 0);
  expectNotRun(scan.scan('live', installation), category);
  chmodSync(join(directory, category), 0o700);
}
it.each(categories)('refuses unreadable %s even when run as root', unreadable);

function redirected() {
  const target = join(directory, 'target');
  writeFileSync(target, canary);
  symlinkSync(target, join(directory, 'logs', 'redirect'));
  expectNotRun(scan.scan('live', installation), 'logs');
}
it('refuses symlinks without reading their targets', redirected);

function replaced() {
  expect(scan.scan('live', installation).result).toBe('PARTIAL');
  renameSync(join(directory, 'pvc'), join(directory, 'old'));
  mkdirSync(join(directory, 'pvc'));
  expectNotRun(scan.scan('stopped', installation), 'pvc');
}
it('refuses a replaced directory even when its name stays the same', replaced);

function changedInstallation() {
  expect(scan.scan('live', installation).result).toBe('PARTIAL');
  const replacement = `sha256:${'b'.repeat(64)}`;
  expectNotRun(scan.scan('stopped', replacement), 'inventory');
}
it('invalidates old scans after installation replacement', changedInstallation);

function wrongOrder() {
  expectNotRun(scan.scan('stopped', installation), 'inventory');
  expectNotRun(scan.scan('live', installation), 'inventory');
}
it('refuses skipped phases and keeps the failure', wrongOrder);

function encoded(encoding: BufferEncoding) {
  const text = canary.toString();
  let stored = Buffer.from(text, encoding);
  if (encoding === 'hex' || encoding === 'base64') {
    const encoded = canary.toString(encoding);
    stored = Buffer.from(encoded);
  }
  const prefix = Buffer.alloc(65_530, 32);
  const bytes = Buffer.concat([prefix, stored]);
  writeFileSync(join(directory, 'cache', 'data'), bytes);
  expect(scan.scan('live', installation)).toEqual({
    result: 'FAIL', complete: false, category: 'cache', files: 0, bytes: bytes.length,
  });
  bytes.fill(0);
  stored.fill(0);
}
it.each<BufferEncoding>(['utf8', 'utf16le', 'hex', 'base64'])(
  'finds %s bytes across a read boundary', encoded);

function unrelated() {
  const unrelatedDirectory = join(directory, 'unrelated');
  mkdirSync(unrelatedDirectory);
  writeFileSync(join(unrelatedDirectory, 'private'), canary);
  expect(scan.scan('live', installation).result).toBe('PARTIAL');
  expect(scan.scan('stopped', installation).result).toBe('PARTIAL');
}
it('does not read unrelated directories', unrelated);

function closed() {
  scan.close();
  expectNotRun(scan.scan('live', installation), 'inventory');
}
it('refuses reuse after clearing its private buffers', closed);

function unreadableFile() {
  const file = join(directory, 'logs', 'private');
  writeFileSync(file, canary);
  chmodSync(file, 0);
  expectNotRun(scan.scan('live', installation), 'logs');
  chmodSync(file, 0o600);
}
it('refuses an unreadable file rather than treating it as empty', unreadableFile);

function linkedFile() {
  const outside = join(directory, 'outside');
  writeFileSync(outside, 'unrelated');
  linkSync(outside, join(directory, 'pvc', 'linked'));
  expectNotRun(scan.scan('live', installation), 'pvc');
}
it('refuses a hard link that could reach unrelated stored data', linkedFile);

function redirectedParent() {
  writeFileSync(join(directory, 'pvc', 'private'), canary);
  renameSync(join(directory, 'pvc'), join(directory, 'original'));
  symlinkSync(join(directory, 'original'), join(directory, 'pvc'));
  expectNotRun(scan.scan('live', installation), 'pvc');
}
it('refuses a redirected required directory', redirectedParent);

function parallelScans() {
  const secondCanary = freshCanary();
  const second = persistenceScan(inventory, secondCanary, installation);
  try {
    expect(scan.scan('live', installation).result).toBe('PARTIAL');
    expect(second.scan('live', installation).result).toBe('PARTIAL');
    writeFileSync(join(directory, 'cache', 'late'), canary);
    expect(scan.scan('stopped', installation).result).toBe('FAIL');
    expect(second.scan('stopped', installation).result).toBe('PARTIAL');
  } finally {
    second.close();
    secondCanary.fill(0);
  }
}
it('keeps two scan sessions and their private byte comparisons separate', parallelScans);

function redirectedAncestor() {
  const target = join(directory, 'target');
  const child = join(target, 'child');
  mkdirSync(child, { recursive: true });
  writeFileSync(join(child, 'private'), canary);
  const redirect = join(directory, 'redirect');
  symlinkSync(target, redirect);
  inventory[0] = { category: 'pvc', path: join(redirect, 'child') };
  const attempt = persistenceScan(inventory, canary, installation);
  try {
    expectNotRun(attempt.scan('live', installation), 'pvc');
  } finally {
    attempt.close();
  }
}
it('refuses an intermediate symlink without reading the target file', redirectedAncestor);

function unavailableAfterRead() {
  writeFileSync(join(directory, 'pvc', 'status'), 'ended');
  rmSync(join(directory, 'logs'), { recursive: true });
  expectNotRun(scan.scan('live', installation), 'logs', 1, 5);
  mkdirSync(join(directory, 'logs'));
  expectNotRun(scan.scan('live', installation), 'logs');
}
it('keeps an incomplete inspection after earlier files were read and storage returns',
  unavailableAfterRead);

function retainedDetection() {
  const path = join(directory, 'logs', 'private');
  writeFileSync(path, canary);
  expect(scan.scan('live', installation)).toEqual({
    result: 'FAIL', complete: false, category: 'logs', files: 0, bytes: 64,
  });
  rmSync(path);
  expect(scan.scan('live', installation)).toEqual({
    result: 'FAIL', complete: false, category: 'logs', files: 0, bytes: 0,
  });
}
it('keeps the detected persistence and original category after the file is removed',
  retainedDetection);

function failureOutput() {
  const stdout = vi.spyOn(process.stdout, 'write');
  const stderr = vi.spyOn(process.stderr, 'write');
  let result: ReturnType<typeof scan.scan>;
  try {
    const path = join(directory, 'logs', canary.toString());
    mkdirSync(path);
    symlinkSync(join(directory, 'missing-private-target'), join(path, 'redirect'));
    result = scan.scan('live', installation);
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
  }
  expect(result).toEqual({
    result: 'FAIL', complete: false, category: 'logs', files: 0, bytes: 0,
  });
}
it('detects private text in a stored name without returning that name or raw errors',
  failureOutput);

function unavailableOutput() {
  const stdout = vi.spyOn(process.stdout, 'write');
  const stderr = vi.spyOn(process.stderr, 'write');
  try {
    const path = join(directory, 'logs', canary.toString());
    inventory[4] = { category: 'logs', path };
    const attempt = persistenceScan(inventory, canary, installation);
    try {
      expectNotRun(attempt.scan('live', installation), 'logs');
      expect(stdout).not.toHaveBeenCalled();
      expect(stderr).not.toHaveBeenCalled();
    } finally {
      attempt.close();
    }
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
  }
}
it('keeps unreadable storage paths and system errors out of results and output', unavailableOutput);

function unsearchable() {
  const path = join(directory, 'pvc');
  chmodSync(path, 0o600);
  try {
    expectNotRun(scan.scan('live', installation), 'pvc');
  } finally {
    chmodSync(path, 0o700);
  }
}
it('requires directory execute permission even for an empty folder', unsearchable);

function base64Offset(offset: number) {
  const padding = Buffer.alloc(offset, 32);
  const padded = Buffer.concat([padding, canary]);
  const encoded = padded.toString('base64');
  const stored = Buffer.from(encoded);
  try {
    writeFileSync(join(directory, 'cache', 'data'), stored);
    expect(scan.scan('live', installation)).toEqual({
      result: 'FAIL', complete: false, category: 'cache', files: 0, bytes: 88,
    });
  } finally {
    padded.fill(0);
    stored.fill(0);
  }
}
it.each([1, 2])('finds base64 private text with %s preceding bytes', base64Offset);

function completedScan() {
  cleanPair();
  expectNotRun(scan.scan('stopped', installation), 'inventory');
}
it('closes after two successful scans without allowing another read', completedScan);
