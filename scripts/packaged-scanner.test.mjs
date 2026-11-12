import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { toolImage } from '../infra/clamav/refresh.mjs';
import { packagedScanner } from '../infra/clamav/packaged.mjs';
import { scanClamd } from '../infra/clamav/instream.mjs';

function transport() {
  return { scanClamd: vi.fn() };
}
vi.mock('../infra/clamav/instream.mjs', transport);

const checked = Date.parse('2026-11-12T20:00:00.000Z');
const image = `example.invalid/scanner@sha256:${'a'.repeat(64)}`;
let directory;
let settings;
let manifest;

function hash(bytes) {
  const digest = createHash('sha256');
  digest.update(bytes);
  return digest.digest('hex');
}

async function approve() {
  const bytes = JSON.stringify(manifest);
  settings.approvedSha = hash(bytes);
  await writeFile(settings.manifestPath, bytes);
  const record = { formatVersion: 1, imageDigest: image.split('@')[1],
    manifestDigest: `sha256:${settings.approvedSha}`,
    databaseUpdatedAt: manifest.databaseUpdatedAt, inspectedAt: new Date(checked).toISOString() };
  await writeFile(settings.releasePath, JSON.stringify(record));
}

async function prepare() {
  vi.spyOn(Date, 'now').mockReturnValue(checked);
  vi.mocked(scanClamd).mockResolvedValue('clean');
  directory = await mkdtemp(join(tmpdir(), 'packaged-scanner-'));
  const databaseDirectory = join(directory, 'databases');
  await mkdir(databaseDirectory);
  settings = { manifestPath: join(directory, 'signatures.json'),
    releasePath: join(directory, 'release.json'), image, databaseDirectory };
  manifest = { formatVersion: 1, toolImage, databaseUpdatedAt: new Date(checked).toISOString(),
    databases: [], updaterEvidence: { tool: 'FreshClam', exitCode: 0, databases: [] } };
  for (const name of ['main', 'daily', 'bytecode']) {
    const file = `${name}.cvd`;
    const bytes = Buffer.alloc(512, name);
    await writeFile(join(databaseDirectory, file), bytes);
    const database = { file, sha256: hash(bytes), version: 1,
      builtAt: '2020-01-01T00:00:00.000Z' };
    manifest.databases.push(database);
    manifest.updaterEvidence.databases.push({ file, version: 1, result: 'up-to-date' });
  }
  await approve();
}
beforeEach(prepare);

async function cleanup() {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  await rm(directory, { recursive: true, force: true });
}
afterEach(cleanup);

function input() {
  const bytes = Buffer.from('A small file');
  return { bytes, sha256: hash(bytes), byteCount: bytes.length,
    signal: new AbortController().signal };
}

test('reports the loaded approved database and exact bytes from the private transport', async () => {
  const approvedSha = settings.approvedSha;
  const scanner = await packagedScanner(settings);
  settings.approvedSha = 'b'.repeat(64);
  const request = input();
  const result = await scanner.scan(request);
  expect(result.verdict).toBe('clean');
  expect(result.imageDigest).toBe(image.split('@')[1]);
  expect(result.manifestDigest).toBe(`sha256:${approvedSha}`);
  expect(result.databases).toEqual(manifest.databases);
  expect(result.sha256).toBe(request.sha256);
  expect(scanClamd).toHaveBeenCalledWith(request.bytes, { host: '127.0.0.1', port: 3310 },
    expect.any(AbortSignal));
  result.databases[0].version = 99;
  const next = await scanner.scan(input());
  expect(next.databases[0].version).toBe(1);
  scanner.stop();
  await expect(scanner.scan(input())).rejects.toThrow('Packaged scanner refused');
});

test.each(['altered', 'missing', 'extra', 'symlink'])('refuses %s database bytes', async (mode) => {
  const file = join(settings.databaseDirectory, 'daily.cvd');
  if (mode === 'altered') await writeFile(file, Buffer.alloc(512, 'changed'));
  if (mode === 'missing' || mode === 'symlink') await rm(file);
  if (mode === 'extra') await writeFile(join(settings.databaseDirectory, 'extra'), 'unknown');
  if (mode === 'symlink') await symlink(join(settings.databaseDirectory, 'main.cvd'), file);
  await expect(packagedScanner(settings)).rejects.toThrow();
  expect(scanClamd).not.toHaveBeenCalled();
});

test('refuses a release for another engine or an unapproved manifest', async () => {
  settings.image = `example.invalid/scanner@sha256:${'b'.repeat(64)}`;
  await expect(packagedScanner(settings)).rejects.toThrow();
  settings.image = image;
  settings.approvedSha = 'b'.repeat(64);
  await expect(packagedScanner(settings)).rejects.toThrow();
});

test('refuses stale and future upstream checks at startup', async () => {
  for (const offset of [-86400000, 1]) {
    manifest.databaseUpdatedAt = new Date(checked + offset).toISOString();
    await approve();
    await expect(packagedScanner(settings)).rejects.toThrow();
  }
});

test('refuses expired database evidence and changed bytes before transfer', async () => {
  const scanner = await packagedScanner(settings);
  const request = input();
  request.bytes[0] = 0;
  await expect(scanner.scan(request)).rejects.toThrow();
  vi.mocked(Date.now).mockReturnValue(checked + 86400000);
  await expect(scanner.scan(input())).rejects.toThrow();
  expect(scanClamd).not.toHaveBeenCalled();
});

test('refuses a result if the database expires during transfer', async () => {
  const scanner = await packagedScanner(settings);
  function expire() {
    vi.mocked(Date.now).mockReturnValue(checked + 86400000);
    return Promise.resolve('clean');
  }
  vi.mocked(scanClamd).mockImplementation(expire);
  await expect(scanner.scan(input())).rejects.toThrow();
});
