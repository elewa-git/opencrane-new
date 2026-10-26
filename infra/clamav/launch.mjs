import { mkdir, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { docker, dockerBeforeDeadline, inspectContainer, readApprovedManifest, readBoundedBytes,
  removeContainers, reserveContainer, validateManifest } from './release.mjs';
import { createScanOperation, stateFormat } from './scan.mjs';

const refusal = 'Scanner launch refused';
const maximumAge = 86_400_000;
const maximumStartup = 15 * 60_000;

function requireEvidence(condition) {
  if (!condition) {
    throw new Error(refusal);
  }
}

function startScript(manifest) {
  const lines = ['set -eu', 'set -- ./* ./.[!.]* ./..?*', 'count=0',
    'for file do', '  if [ ! -e "$file" ] && [ ! -L "$file" ]; then',
    '    continue', '  fi',
    '  test -f "$file" && test ! -L "$file"', '  count=$((count + 1))', 'done',
    'test "$count" -eq 3'];
  // Check again inside the running read-only filesystem, before clamd can load a file.
  for (const database of manifest.databases) {
    lines.push(`test ! -L ${database.file}`);
    lines.push(`printf '%s\n' '${database.sha256}  ${database.file}' | sha256sum -c - >/dev/null`);
  }
  lines.push("exec /usr/sbin/clamd --config-file=/dev/stdin <<'CONFIG'",
    'Foreground yes', 'TCPSocket 3310', 'TCPAddr 127.0.0.1',
    'DatabaseDirectory /var/lib/clamav', 'TemporaryDirectory /tmp',
    'SelfCheck 0', 'ConcurrentDatabaseReload no',
    'StreamMaxLength 21M', 'MaxFileSize 21M', 'MaxScanSize 80M', 'MaxRecursion 16',
    'MaxFiles 2000', 'AlertExceedsMax yes', 'AlertEncrypted yes', 'ReadTimeout 60',
    'CommandReadTimeout 10', 'CONFIG');
  return lines.join('\n');
}

async function approvedInputs(options, now) {
  const { image, manifestPath, approvedSha, releasePath } = options;
  const pattern = /^(?:[a-z0-9.-]+(?::[0-9]+)?\/)?[a-z0-9]+(?:[._/-][a-z0-9]+)*@sha256:[a-f0-9]{64}$/;
  requireEvidence(pattern.test(image));
  const manifest = await readApprovedManifest(manifestPath, approvedSha);
  validateManifest(manifest, now);
  const bytes = await readBoundedBytes(releasePath, 1024);
  const record = JSON.parse(bytes.toString('utf8'));
  const inspectedAt = Date.parse(record.inspectedAt);
  requireEvidence(record.formatVersion === 1 &&
    record.imageDigest === image.slice(image.indexOf('@') + 1) &&
    record.manifestDigest === `sha256:${approvedSha}` &&
    record.databaseUpdatedAt === manifest.databaseUpdatedAt &&
    inspectedAt >= Date.parse(manifest.databaseUpdatedAt) && inspectedAt <= now);
  return manifest;
}

function createScanner(image, scanner, manifest, runDocker) {
  const output = runDocker(['image', 'inspect', '--format', '{{.Id}}', image]);
  const imageId = output.trim();
  requireEvidence(/^sha256:[a-f0-9]{64}$/.test(imageId));
  const created = runDocker(['create', '--pull', 'never', '--name', scanner, '--network', 'none',
    '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m,mode=1777',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--user', 'clamav', '--log-driver', 'none', '--memory', '2g',
    '--cpus', '1', '--pids-limit', '64', '--entrypoint', 'sh', '--workdir', '/var/lib/clamav',
    image, '-c', startScript(manifest)]);
  const containerId = created.trim();
  requireEvidence(/^[a-f0-9]{64}$/.test(containerId));
  const inspected = runDocker(['inspect', '--format', '{{.Image}}', containerId]);
  requireEvidence(inspected.trim() === imageId);
  // Reject image-declared volumes too: they would hide files behind writable storage.
  const inspectedMounts = runDocker(['inspect', '--format', '{{json .Mounts}}', containerId]);
  const mounts = JSON.parse(inspectedMounts);
  requireEvidence(Array.isArray(mounts) && mounts.length === 0);
  return { imageId, containerId };
}

function ping(scanner, attempts, runDocker) {
  const command = "printf 'TCPSocket 3310\nTCPAddr 127.0.0.1\n' | " +
    `clamdscan --ping=${attempts}:1 --config-file=/dev/stdin`;
  runDocker(['exec', scanner, 'sh', '-c', command], (attempts + 5) * 1000);
}

function reportFailure() {
  process.stderr.write(`${refusal}\n`);
  process.exitCode = 1;
}

export async function launchScanner(options) {
  const { ownership, clock = Date.now } = options;
  const containers = [];
  const directoryOptions = { mode: 0o700 };
  const removeOptions = { recursive: true, force: true };
  let owned = false;
  let starting = true;
  let stopped = false;
  let timer;
  let cleanup;
  let previousTime = clock();
  const startedAt = previousTime;
  const runDocker = dockerBeforeDeadline(startedAt, clock);
  let manifest;
  let scanner;
  const shutdown = new AbortController();

  function fresh() {
    const currentTime = clock();
    requireEvidence(!stopped && currentTime >= previousTime);
    validateManifest(manifest, currentTime);
    previousTime = currentTime;
    if (starting) {
      requireEvidence(currentTime - startedAt < maximumStartup);
    }
    return currentTime;
  }

  async function removeOwned() {
    requireEvidence(removeContainers(containers));
    await rm(ownership, removeOptions);
    owned = false;
  }

  async function stop() {
    stopped = true;
    shutdown.abort();
    clearTimeout(timer);
    process.removeListener('SIGTERM', terminate);
    process.removeListener('SIGINT', terminate);
    if (owned && !cleanup) {
      cleanup = removeOwned();
    }
    try {
      await cleanup;
    } catch {
      cleanup = undefined;
      throw new Error(refusal);
    }
  }

  function terminate() {
    stopped = true;
    if (!starting) {
      void stop().catch(reportFailure);
    }
  }

  async function ready() {
    try {
      fresh();
      ping(scanner, 1, docker);
      fresh();
      return true;
    } catch {
      await stop();
      return false;
    }
  }

  try {
    requireEvidence(typeof ownership === 'string' && isAbsolute(ownership) &&
      !/[,\r\n]/.test(ownership));
    await mkdir(ownership, directoryOptions);
    owned = true;
    process.on('SIGTERM', terminate);
    process.on('SIGINT', terminate);
    manifest = await approvedInputs(options, startedAt);
    fresh();
    scanner = await reserveContainer(ownership, containers);
    const imageDigest = options.image.slice(options.image.indexOf('@') + 1);
    const manifestDigest = `sha256:${options.approvedSha}`;
    const { imageId, containerId } = createScanner(options.image, scanner, manifest, runDocker);
    // Keep using the immutable ID if another process replaces the reserved name.
    containers[containers.indexOf(scanner)] = containerId;
    scanner = containerId;
    const recordOptions = { mode: 0o600 };
    await writeFile(join(ownership, 'containers.json'), JSON.stringify(containers), recordOptions);
    fresh();
    await mkdir(join(ownership, 'databases'));
    await inspectContainer(scanner, ownership, containers, manifest, clock, runDocker);
    fresh();
    runDocker(['start', scanner]);
    ping(scanner, 60, runDocker);
    fresh();
    const inspected = runDocker(['inspect', '--format', stateFormat, scanner]);
    const state = inspected.trim();
    const [observedId, loadedImage, started, running, restarts] = state.split(' ');
    requireEvidence(observedId === containerId && loadedImage === imageId &&
      Number.isFinite(Date.parse(started)) && running === 'true' && restarts === '0');
    fresh();
    const context = { state, manifest, imageDigest, manifestDigest, clock, fresh, stop,
      signal: shutdown.signal };
    const scan = createScanOperation(context);
    starting = false;
    const expiresIn = Date.parse(manifest.databaseUpdatedAt) + maximumAge - clock();
    timer = setTimeout(terminate, Math.max(0, expiresIn));
    return { databaseUpdatedAt: manifest.databaseUpdatedAt, ready, stop, scan,
      signal: shutdown.signal };
  } catch {
    if (owned) {
      await stop();
    }
    throw new Error(refusal);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    requireEvidence(process.argv.length === 7);
    const [manifestPath, approvedSha, image, releasePath, ownership] = process.argv.slice(2);
    const options = { manifestPath, approvedSha, image, releasePath, ownership };
    await launchScanner(options);
    process.stdout.write('Scanner started.\n');
  } catch {
    reportFailure();
  }
}
