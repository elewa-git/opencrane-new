import { randomBytes } from 'node:crypto';
import {
  chmodSync, linkSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
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
  expect(scan.scan('live', installation)).toMatchObject({
    result: 'FAIL', complete: false, category,
  });
}
it.each(categories)('detects bytes in the writable %s fixture without returning them', persisted);

async function delayedWrite() {
  expect(scan.scan('live', installation).result).toBe('PARTIAL');
  await Promise.resolve();
  writeFileSync(join(directory, 'outbox', 'late'), canary);
  expect(scan.scan('stopped', installation)).toMatchObject({
    result: 'FAIL', complete: false, category: 'outbox',
  });
}
it('finds a delayed write in the second scan after a simulated Stop', delayedWrite);

function missing(category: typeof categories[number]) {
  rmSync(join(directory, category), { recursive: true });
  expect(scan.scan('live', installation)).toMatchObject({ result: 'FAIL', category });
}
it.each(categories)('refuses a missing required %s directory', missing);

function omitted(category: typeof categories[number]) {
  function keep(entry: typeof inventory[number]) {
    return entry.category !== category;
  }
  const incomplete = inventory.filter(keep);
  const attempt = persistenceScan(incomplete, canary, installation);
  expect(attempt.scan('live', installation)).toMatchObject({ result: 'FAIL' });
  attempt.close();
}
it.each(categories)('refuses an inventory that skips %s', omitted);

function unreadable(category: typeof categories[number]) {
  chmodSync(join(directory, category), 0);
  expect(scan.scan('live', installation)).toMatchObject({ result: 'FAIL', category });
  chmodSync(join(directory, category), 0o700);
}
it.each(categories)('refuses unreadable %s even when run as root', unreadable);

function redirected() {
  symlinkSync(directory, join(directory, 'logs', 'redirect'));
  expect(scan.scan('live', installation)).toMatchObject({ result: 'FAIL', category: 'logs' });
}
it('refuses symlinks without reading their targets', redirected);

function replaced() {
  expect(scan.scan('live', installation).result).toBe('PARTIAL');
  renameSync(join(directory, 'pvc'), join(directory, 'old'));
  mkdirSync(join(directory, 'pvc'));
  expect(scan.scan('stopped', installation)).toMatchObject({ result: 'FAIL', category: 'pvc' });
}
it('refuses a replaced directory even when its name stays the same', replaced);

function changedInstallation() {
  expect(scan.scan('live', installation).result).toBe('PARTIAL');
  const replacement = `sha256:${'b'.repeat(64)}`;
  expect(scan.scan('stopped', replacement)).toMatchObject({ result: 'FAIL', category: 'inventory' });
}
it('invalidates old scans after installation replacement', changedInstallation);

function wrongOrder() {
  expect(scan.scan('stopped', installation)).toMatchObject({ result: 'FAIL' });
  expect(scan.scan('live', installation)).toMatchObject({ result: 'FAIL' });
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
  expect(scan.scan('live', installation)).toMatchObject({ result: 'FAIL', category: 'cache' });
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
  expect(scan.scan('live', installation)).toMatchObject({ result: 'FAIL' });
}
it('refuses reuse after clearing its private buffers', closed);

function unreadableFile() {
  const file = join(directory, 'logs', 'private');
  writeFileSync(file, canary);
  chmodSync(file, 0);
  expect(scan.scan('live', installation)).toMatchObject({ result: 'FAIL', category: 'logs' });
  chmodSync(file, 0o600);
}
it('refuses an unreadable file rather than treating it as empty', unreadableFile);

function linkedFile() {
  const outside = join(directory, 'outside');
  writeFileSync(outside, 'unrelated');
  linkSync(outside, join(directory, 'pvc', 'linked'));
  expect(scan.scan('live', installation)).toMatchObject({ result: 'FAIL', category: 'pvc' });
}
it('refuses a hard link that could reach unrelated stored data', linkedFile);

function redirectedParent() {
  renameSync(join(directory, 'pvc'), join(directory, 'original'));
  symlinkSync(join(directory, 'original'), join(directory, 'pvc'));
  expect(scan.scan('live', installation)).toMatchObject({ result: 'FAIL', category: 'pvc' });
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
