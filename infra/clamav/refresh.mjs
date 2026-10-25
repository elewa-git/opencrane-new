import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

const toolImage = 'clamav/clamav-debian:1.5.2@' +
  'sha256:14e2e0805c6a5ff6728ea591c05565e0f0954d93e8701919012c3a8c44e20674';
const databaseNames = ['main', 'daily', 'bytecode'];
const deadlineMs = 15 * 60 * 1000;
const refusal = 'Candidate refresh refused';

// Stop on any failure, including one after earlier databases were checked successfully.
const containerScript = `set -eu
export LC_ALL=C TZ=UTC
for name in main daily bytecode; do
  if [ ! -e "$name.cvd" ] && [ ! -e "$name.cld" ]; then
    cp "/var/lib/clamav/$name.cvd" .
  fi
done
cat > .refresh-lock/freshclam.conf <<'CONFIG'
DatabaseMirror database.clamav.net
DatabaseOwner root
ScriptedUpdates yes
Bytecode yes
TestDatabases yes
MaxAttempts 1
ConnectTimeout 30
ReceiveTimeout 60
CONFIG
freshclam --config-file=.refresh-lock/freshclam.conf --datadir=/signatures --stdout
for name in main daily bytecode; do
  set -- "$name".cvd "$name".cld
  if [ -e "$1" ] && [ -e "$2" ]; then
    exit 1
  fi
  if [ -e "$1" ]; then
    file="$1"
  else
    file="$2"
  fi
  test -f "$file" && test ! -L "$file"
  printf '\\nOPENCRANE_DATABASE %s\\n' "$file"
  sha256sum "$file"
  sigtool --info "$file"
  sha256sum "$file"
done`;

function requireEvidence(condition) {
  if (!condition) {
    throw new Error(refusal);
  }
}

function runUpdater(candidate) {
  const containerName = `clamav-refresh-${randomUUID()}`;
  const args = [
    'run', '--rm', '--name', containerName, '--entrypoint', 'sh',
    '--mount', `type=bind,src=${candidate},dst=/signatures`, '--workdir', '/signatures',
    toolImage, '-c', containerScript,
  ];
  const options = {
    encoding: 'utf8', timeout: deadlineMs, maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  };
  try {
    return execFileSync('docker', args, options);
  } catch {
    // Remove the container too: stopping a timed-out Docker client alone leaves it running.
    const cleanupOptions = { timeout: 30_000, stdio: 'ignore' };
    try {
      execFileSync('docker', ['rm', '-f', '-v', containerName], cleanupOptions);
    } catch {
      // Keep the same refusal if Docker is unavailable; never publish partial evidence.
      throw new Error(refusal);
    }
    throw new Error(refusal);
  }
}

function onlyMatch(value, pattern) {
  const matches = [...value.matchAll(pattern)];
  requireEvidence(matches.length === 1);
  return matches[0];
}

function parseBuildTime(value, checkedAt) {
  const pattern = /^(\d{2}) ([A-Z][a-z]{2}) (\d{4}) (\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/;
  const parts = pattern.exec(value);
  requireEvidence(parts !== null);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const month = months.indexOf(parts[2]);
  const day = Number(parts[1]);
  const year = Number(parts[3]);
  const hour = Number(parts[4]);
  const minute = Number(parts[5]);
  const offsetHours = Number(parts[7]);
  const offsetMinutes = Number(parts[8]);
  const date = new Date(Date.UTC(year, month, day, hour, minute));
  requireEvidence(month >= 0 && year >= 2000 && date.getUTCFullYear() === year &&
    date.getUTCMonth() === month && date.getUTCDate() === day &&
    date.getUTCHours() === hour && date.getUTCMinutes() === minute &&
    offsetHours <= 23 && offsetMinutes <= 59);
  let offset = (offsetHours * 60 + offsetMinutes) * 60_000;
  if (parts[6] === '-') {
    offset = -offset;
  }
  const builtAt = new Date(date.getTime() - offset);
  requireEvidence(builtAt.getTime() <= checkedAt);
  return builtAt.toISOString();
}

function parseUpdaterEvidence(output) {
  const pattern = new RegExp(
    '^(main|daily|bytecode)\\.(cvd|cld) (database is up-to-date|updated) ' +
    '\\(version: (\\d+), sigs: \\d+, f-level: \\d+, builder: [^\\r\\n]{1,128}\\)$',
    'gm',
  );
  const matches = [...output.matchAll(pattern)];
  requireEvidence(matches.length === 3);
  const databases = [];
  for (const name of databaseNames) {
    function matchingName(match) {
      return match[1] === name;
    }
    const entries = matches.filter(matchingName);
    requireEvidence(entries.length === 1);
    const entry = entries[0];
    let result = 'up-to-date';
    if (entry[3] === 'updated') {
      result = 'updated';
    }
    const version = Number(entry[4]);
    requireEvidence(Number.isSafeInteger(version) && version > 0);
    const database = { file: `${name}.${entry[2]}`, version, result };
    databases.push(database);
  }
  return { tool: 'FreshClam', exitCode: 0, databases };
}

async function hashDatabase(path) {
  const status = await lstat(path);
  requireEvidence(status.isFile() && status.size >= 512 && status.size <= 512 * 1024 * 1024);
  const hash = createHash('sha256');
  const stream = createReadStream(path);
  let header;
  for await (const chunk of stream) {
    if (header === undefined) {
      requireEvidence(chunk.length >= 512);
      header = chunk.toString('ascii', 0, 512);
    }
    hash.update(chunk);
  }
  return { sha256: hash.digest('hex'), header };
}

function verifiedBuildTime(header, version, displayedTime, checkedAt) {
  const fields = header.split(':');
  const timestamp = fields[8]?.trim();
  requireEvidence(fields[0] === 'ClamAV-VDB' && fields[2] === String(version) &&
    typeof timestamp === 'string' && /^\d{1,12}$/.test(timestamp));
  // Use the numeric timestamp that sigtool checks against the database's internal record.
  const milliseconds = Number(timestamp) * 1000;
  const displayedMilliseconds = Date.parse(displayedTime);
  requireEvidence(milliseconds <= checkedAt &&
    Math.floor(milliseconds / 60_000) * 60_000 === displayedMilliseconds);
  return new Date(milliseconds).toISOString();
}

async function readDatabase(candidate, block, evidence, checkedAt) {
  const file = block.slice(0, block.indexOf('\n'));
  requireEvidence(file === evidence.file);
  const fileField = onlyMatch(block, /^File: (.+)$/gm);
  requireEvidence(fileField[1] === file);
  const versionField = onlyMatch(block, /^Version: (\d+)$/gm);
  const version = Number(versionField[1]);
  requireEvidence(version === evidence.version);
  const dateField = onlyMatch(block, /^Build time: (.+)$/gm);
  const displayedTime = parseBuildTime(dateField[1], checkedAt);
  onlyMatch(block, /^Verification OK\.$/gm);
  const hashes = [...block.matchAll(/^([a-f0-9]{64})  (main|daily|bytecode)\.(cvd|cld)$/gm)];
  requireEvidence(hashes.length === 2);
  const { sha256, header } = await hashDatabase(join(candidate, file));
  const builtAt = verifiedBuildTime(header, version, displayedTime, checkedAt);
  for (const hash of hashes) {
    requireEvidence(hash[1] === sha256 && `${hash[2]}.${hash[3]}` === file);
  }
  return { file, sha256, version, builtAt };
}

async function buildManifest(candidate, output, checkedAt) {
  const sections = output.split('\nOPENCRANE_DATABASE ');
  requireEvidence(sections.length === 4);
  const updaterEvidence = parseUpdaterEvidence(sections[0]);
  const files = await readdir(candidate);
  const databaseFiles = files.filter(isDatabase);
  requireEvidence(databaseFiles.length === 3);
  const databases = [];
  for (let index = 0; index < databaseNames.length; index++) {
    const evidence = updaterEvidence.databases[index];
    const database = await readDatabase(candidate, sections[index + 1], evidence, checkedAt);
    databases.push(database);
  }
  return {
    formatVersion: 1, toolImage, databaseUpdatedAt: new Date(checkedAt).toISOString(),
    updaterEvidence, databases,
  };
}

function isDatabase(file) {
  return /\.(cvd|cld)$/i.test(file);
}

async function refresh(candidate) {
  requireEvidence(typeof candidate === 'string' && isAbsolute(candidate));
  // Reject mount separators before Docker can interpret them as extra options.
  requireEvidence(!/[,\r\n]/.test(candidate));
  const directoryOptions = { recursive: true };
  await mkdir(candidate, directoryOptions);
  const directory = await lstat(candidate);
  requireEvidence(directory.isDirectory());
  const lock = join(candidate, '.refresh-lock');
  await mkdir(lock);
  const removeFileOptions = { force: true };
  const removeDirectoryOptions = { recursive: true, force: true };
  try {
    // Remove previous success before updating any file, even if this attempt fails later.
    await rm(join(candidate, 'signatures.json'), removeFileOptions);
    await rm(join(candidate, 'signatures.sha256'), removeFileOptions);
    const files = await readdir(candidate);
    const databaseFiles = files.filter(isDatabase);
    for (const file of databaseFiles) {
      const status = await lstat(join(candidate, file));
      requireEvidence(status.isFile());
    }
    const startedAt = Date.now();
    const output = runUpdater(candidate);
    const checkedAt = Date.now();
    requireEvidence(checkedAt >= startedAt && checkedAt - startedAt <= deadlineMs);
    const manifest = await buildManifest(candidate, output, checkedAt);
    const completedAt = Date.now();
    requireEvidence(completedAt >= checkedAt && completedAt - startedAt <= deadlineMs);
    const encoded = JSON.stringify(manifest, null, 2) + '\n';
    requireEvidence(Buffer.byteLength(encoded) <= 8192);
    const temporary = join(lock, 'signatures.json');
    const manifestOptions = { flag: 'wx', mode: 0o600 };
    await writeFile(temporary, encoded, manifestOptions);
    await rename(temporary, join(candidate, 'signatures.json'));
  } finally {
    await rm(lock, removeDirectoryOptions);
  }
}

try {
  requireEvidence(process.argv.length === 3);
  await refresh(process.argv[2]);
  process.stdout.write('Candidate verified. Review and package it before deployment.\n');
} catch {
  // Discard tool output and filesystem errors: they can contain paths or private data.
  process.stderr.write(`${refusal}\n`);
  process.exitCode = 1;
}
