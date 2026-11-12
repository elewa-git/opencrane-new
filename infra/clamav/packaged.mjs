import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readApprovedRelease, validateManifest } from './release.mjs';
import { scanClamd } from './instream.mjs';

function requireScanner(condition) {
  if (!condition) throw new Error('Packaged scanner refused');
}

async function verifyDatabase(directory, database) {
  const path = join(directory, database.file);
  const status = await lstat(path);
  requireScanner(status.isFile() && status.size >= 512 && status.size <= 512 * 1024 * 1024);
  const hash = createHash('sha256');
  const bytes = createReadStream(path);
  for await (const chunk of bytes) hash.update(chunk);
  requireScanner(hash.digest('hex') === database.sha256);
}

// The chart copies the approved image's files once, then mounts the set read-only
// in both containers. clamd has no reload or updater and listens only on loopback.
export async function packagedScanner(settings) {
  const inputs = { ...settings };
  const started = Date.now();
  const manifest = await readApprovedRelease(inputs, started);
  validateManifest(manifest, Date.now());
  const imageDigest = inputs.image.slice(inputs.image.indexOf('@') + 1);
  const manifestDigest = `sha256:${inputs.approvedSha}`;
  const files = await readdir(inputs.databaseDirectory);
  requireScanner(files.length === manifest.databases.length);
  for (const database of manifest.databases) {
    await verifyDatabase(inputs.databaseDirectory, database);
  }
  const stopped = new AbortController();
  let previousTime = started;
  function fresh() {
    const now = Date.now();
    requireScanner(!stopped.signal.aborted && now >= previousTime);
    validateManifest(manifest, now);
    previousTime = now;
    return now;
  }
  async function scan(input) {
    fresh();
    requireScanner(Buffer.isBuffer(input.bytes) && input.bytes.length <= 20 * 1024 * 1024);
    const bytes = Buffer.from(input.bytes);
    const hash = createHash('sha256');
    hash.update(bytes);
    const sha256 = hash.digest('hex');
    requireScanner(bytes.length === input.byteCount && sha256 === input.sha256);
    const signal = AbortSignal.any([stopped.signal, input.signal, AbortSignal.timeout(60000)]);
    const connection = { host: '127.0.0.1', port: 3310 };
    const verdict = await scanClamd(bytes, connection, signal);
    signal.throwIfAborted();
    const checked = fresh();
    const expires = Math.min(checked + 120000, Date.parse(manifest.databaseUpdatedAt) + 86400000);
    return { verdict, sha256, byteCount: bytes.length,
      imageDigest, manifestDigest,
      databaseUpdatedAt: manifest.databaseUpdatedAt,
      databases: structuredClone(manifest.databases),
      checkedAt: new Date(checked).toISOString(), expiresAt: new Date(expires).toISOString() };
  }
  function stop() {
    stopped.abort();
  }
  fresh();
  return { scan, stop, signal: stopped.signal, databaseUpdatedAt: manifest.databaseUpdatedAt };
}
