import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import { inspectionScript, toolImage, verifyDatabases } from './refresh.mjs';

const refusal = 'Scanner release refused';
const deadlineMs = 15 * 60 * 1000;
const maxAgeMs = 24 * 60 * 60 * 1000;
const names = ['main', 'daily', 'bytecode'];

function requireEvidence(condition) {
  if (!condition) {
    throw new Error(refusal);
  }
}

function timestamp(value) {
  requireEvidence(typeof value === 'string');
  const milliseconds = Date.parse(value);
  requireEvidence(Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value);
  return milliseconds;
}

export function validateManifest(manifest, now) {
  requireEvidence(manifest.formatVersion === 1 && manifest.toolImage === toolImage);
  const updatedAt = timestamp(manifest.databaseUpdatedAt);
  requireEvidence(updatedAt <= now && now - updatedAt < maxAgeMs);
  const evidence = manifest.updaterEvidence;
  requireEvidence(evidence.tool === 'FreshClam' && evidence.exitCode === 0 &&
    Array.isArray(evidence.databases) && Array.isArray(manifest.databases) &&
    evidence.databases.length === 3 && manifest.databases.length === 3);
  for (let index = 0; index < names.length; index++) {
    const database = manifest.databases[index];
    const check = evidence.databases[index];
    requireEvidence(database.file === `${names[index]}.cvd` ||
      database.file === `${names[index]}.cld`);
    requireEvidence(/^[a-f0-9]{64}$/.test(database.sha256) &&
      Number.isSafeInteger(database.version) && database.version > 0);
    requireEvidence(timestamp(database.builtAt) <= updatedAt);
    requireEvidence(check.file === database.file && check.version === database.version &&
      (check.result === 'updated' || check.result === 'up-to-date'));
  }
}

export async function readBoundedBytes(path, maximum = 8192) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const status = await handle.stat();
    requireEvidence(status.isFile() && status.size > 0 && status.size <= maximum);
    const buffer = Buffer.alloc(maximum + 1);
    const { bytesRead } = await handle.read(buffer);
    requireEvidence(bytesRead === status.size);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

export async function readApprovedManifest(path, approvedSha) {
  requireEvidence(/^[a-f0-9]{64}$/.test(approvedSha));
  const bytes = await readBoundedBytes(path);
  const hash = createHash('sha256');
  hash.update(bytes);
  requireEvidence(hash.digest('hex') === approvedSha);
  return JSON.parse(bytes.toString('utf8'));
}

export function docker(args, timeout = deadlineMs) {
  const options = { encoding: 'utf8', timeout, maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'] };
  return execFileSync('docker', args, options);
}

export function dockerBeforeDeadline(startedAt, clock = Date.now) {
  let previousTime = startedAt;

  function runDocker(args, timeout = deadlineMs) {
    const currentTime = clock();
    const remaining = startedAt + deadlineMs - currentTime;
    requireEvidence(currentTime >= previousTime && remaining > 0);
    previousTime = currentTime;
    // Share one allowance across Docker calls; keep shorter operation limits too.
    return docker(args, Math.min(timeout, remaining));
  }

  return runDocker;
}

export function removeContainers(containers) {
  let stopped = true;
  for (const name of [...containers]) {
    try {
      const options = { timeout: 30_000, stdio: 'ignore' };
      execFileSync('docker', ['rm', '-f', '-v', name], options);
      containers.splice(containers.indexOf(name), 1);
    } catch {
      // Keep the private attempt directory if Docker cannot confirm removal.
      stopped = false;
    }
  }
  return stopped;
}

export async function reserveContainer(lock, containers) {
  const name = `clamav-release-${randomUUID()}`;
  containers.push(name);
  const options = { mode: 0o600 };
  await writeFile(join(lock, 'containers.json'), JSON.stringify(containers), options);
  return name;
}

async function inspectImage(image, lock, containers, manifest, runDocker) {
  const output = runDocker(['image', 'inspect', '--format', '{{.Id}}', image]);
  const imageId = output.trim();
  requireEvidence(/^sha256:[a-f0-9]{64}$/.test(imageId));
  const scanner = await reserveContainer(lock, containers);
  runDocker(['create', '--pull', 'never', '--name', scanner, '--network', 'none', '--read-only',
    '--entrypoint', '/bin/false', image]);
  const inspected = runDocker(['inspect', '--format', '{{.Image}}', scanner]);
  const actualId = inspected.trim();
  requireEvidence(actualId === imageId);
  await inspectContainer(scanner, lock, containers, manifest, Date.now, runDocker);
}

export async function inspectContainer(scanner, lock, containers, manifest, now, runDocker) {
  const directory = join(lock, 'databases');
  // Copy only from the created image container, never a caller's database directory.
  runDocker(['cp', `${scanner}:/var/lib/clamav/.`, directory]);
  const files = await readdir(directory);
  requireEvidence(files.length === 3);
  for (const database of manifest.databases) {
    const status = await lstat(join(directory, database.file));
    requireEvidence(status.isFile() && status.size >= 512 && status.size <= 512 * 1024 * 1024);
  }
  const inspector = await reserveContainer(lock, containers);
  const output = runDocker(['run', '--pull', 'never', '--name', inspector,
    '--network', 'none', '--read-only', '--log-driver', 'none',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--entrypoint', 'sh',
    '--mount', `type=bind,src=${directory},dst=/signatures,readonly`,
    '--workdir', '/signatures', toolImage, '-c', inspectionScript]);
  const databases = await verifyDatabases(directory, output, now(), manifest.updaterEvidence);
  requireEvidence(isDeepStrictEqual(databases, manifest.databases));
}

async function release(manifestPath, approvedSha, image, destination) {
  const imagePattern = /^(?:[a-z0-9.-]+(?::[0-9]+)?\/)?[a-z0-9]+(?:[._/-][a-z0-9]+)*@sha256:[a-f0-9]{64}$/;
  requireEvidence(imagePattern.test(image));
  requireEvidence(typeof destination === 'string' && isAbsolute(destination) &&
    !/[,\r\n]/.test(destination));
  const manifest = await readApprovedManifest(manifestPath, approvedSha);
  const startedAt = Date.now();
  const runDocker = dockerBeforeDeadline(startedAt);
  validateManifest(manifest, startedAt);
  const lock = `${destination}.lock`;
  const directoryOptions = { mode: 0o700 };
  await mkdir(lock, directoryOptions);
  let reusable = true;
  let published = false;
  const containers = [];
  const removeOptions = { recursive: true, force: true };
  try {
    const directory = join(lock, 'databases');
    await mkdir(directory);
    try {
      await inspectImage(image, lock, containers, manifest, runDocker);
    } finally {
      reusable = removeContainers(containers);
      requireEvidence(reusable);
    }
    await rm(directory, removeOptions);
    await rm(join(lock, 'containers.json'));
    const inspectedAt = Date.now();
    requireEvidence(inspectedAt >= startedAt && inspectedAt - startedAt < deadlineMs);
    validateManifest(manifest, inspectedAt);
    const imageDigest = image.slice(image.indexOf('@') + 1);
    const record = { formatVersion: 1, imageDigest, manifestDigest: `sha256:${approvedSha}`,
      databaseUpdatedAt: manifest.databaseUpdatedAt, inspectedAt: new Date(inspectedAt).toISOString() };
    const encoded = JSON.stringify(record, null, 2) + '\n';
    requireEvidence(Buffer.byteLength(encoded) <= 1024);
    const recordOptions = { flag: 'wx', mode: 0o600 };
    await writeFile(join(lock, 'release.json'), encoded, recordOptions);
    // Publish the whole directory at once, after every check and cleanup has succeeded.
    await rename(lock, destination);
    published = true;
  } finally {
    if (reusable && !published) {
      await rm(lock, removeOptions);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    requireEvidence(process.argv.length === 6);
    await release(...process.argv.slice(2));
    process.stdout.write('Scanner release evidence recorded.\n');
  } catch {
    // Discard tool output and underlying errors, which may contain private paths or identities.
    process.stderr.write(`${refusal}\n`);
    process.exitCode = 1;
  }
}
