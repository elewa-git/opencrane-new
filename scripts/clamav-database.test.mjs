import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { verifyDatabases } from '../infra/clamav/refresh.mjs';

const names = ['main', 'daily', 'bytecode'];
let directory;
let evidence;
let output;

async function recordDatabase(name) {
  const file = `${name}.cvd`;
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(join(directory, file))) hash.update(chunk);
  const digest = hash.digest('hex');
  return `\nOPENCRANE_DATABASE ${file}\nFile: ${file}\n` +
    'Build time: 01 Jan 2020 00:00 +0000\nVersion: 42\nVerification OK.\n' +
    `${digest}  ${file}\n${digest}  ${file}\n`;
}

async function recordOutput() {
  output = '';
  for (const name of names) output += await recordDatabase(name);
}

async function prepare() {
  directory = await mkdtemp(join(tmpdir(), 'clamav-database-'));
  evidence = { databases: [] };
  for (const name of names) {
    const file = `${name}.cvd`;
    const header = 'ClamAV-VDB:01 Jan 2020 00-00 +0000:42:1:90:hash:signature:builder:1577836800';
    await writeFile(join(directory, file), header.padEnd(512, ' '));
    evidence.databases.push({ file, version: 42, result: 'up-to-date' });
  }
  await recordOutput();
}

async function cleanup() {
  await rm(directory, { recursive: true, force: true });
}
beforeEach(prepare);
afterEach(cleanup);

function verify() {
  return verifyDatabases(directory, output, Date.now(), evidence);
}

async function acceptsRegularBytes() {
  const databases = await verify();
  expect(databases).toHaveLength(3);
  expect(databases[0]).toMatchObject({ file: 'main.cvd', version: 42,
    builtAt: '2020-01-01T00:00:00.000Z' });
}
test('refresh accepts exact regular database bytes and verified headers', acceptsRegularBytes);

async function refusesSymlink() {
  const file = join(directory, 'daily.cvd');
  const bytes = await readFile(file);
  // Match link and content sizes so only the regular-file rule refuses this input.
  const targetDirectory = join(directory, 'a'.repeat(200), 'b'.repeat(200));
  await mkdir(targetDirectory, { recursive: true });
  const targetNameLength = 512 - Buffer.byteLength(targetDirectory) - 1;
  const target = join(targetDirectory, 'd'.repeat(targetNameLength));
  await writeFile(target, bytes);
  await rm(file);
  await symlink(target, file);
  await expect(verify()).rejects.toThrow();
}
test('refresh refuses a database symlink even with the exact approved bytes', refusesSymlink);

async function refusesSize(size) {
  await truncate(join(directory, 'daily.cvd'), size);
  await recordOutput();
  await expect(verify()).rejects.toThrow();
}
test.each([511, 512 * 1024 * 1024 + 1])('refresh refuses database size %s with matching hashes',
  refusesSize);

async function refusesHash() {
  await writeFile(join(directory, 'daily.cvd'), Buffer.alloc(512));
  await expect(verify()).rejects.toThrow();
}
test('refresh refuses changed bytes against the two verified hashes', refusesHash);
