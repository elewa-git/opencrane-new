import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

function writeFakeCommands(directory) {
  const fakeNpx = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CI_CALLS, JSON.stringify(args) + '\\n');
if (args.includes('--dry-run')) {
  const config = fs.readFileSync(process.env.APT_CONFIG, 'utf8');
  if (!config.includes('APT::Get::Upgrade "false";')) {
    process.exit(99);
  }
  if (fs.existsSync(process.env.CI_PACKAGES_INSTALLED)) {
    process.exit(0);
  }
  process.exit(Number(process.env.CI_DEPENDENCY_STATUS));
}
if (args.includes('install-deps')) {
  const config = fs.readFileSync(process.env.APT_CONFIG, 'utf8');
  const archives = 'Dir::Cache::archives "' + process.env.CHROMIUM_DEB_CACHE + '";';
  if (!config.includes(archives) || !config.includes('APT::Keep-Downloaded-Packages "true";')) {
    process.exit(98);
  }
  if (Number(process.env.CI_INSTALL_STATUS) === 0) {
    fs.writeFileSync(process.env.CHROMIUM_DEB_CACHE + '/fonts-test.deb', 'downloaded package');
  }
}
process.exit(Number(process.env.CI_INSTALL_STATUS));
`;
  const fakeApt = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CI_CALLS, JSON.stringify(['apt-get', ...args]) + '\\n');
if (process.env.CI_CACHED_INSTALL_STATUS === '0' && process.env.CI_INCOMPLETE_CACHE !== 'true') {
  fs.writeFileSync(process.env.CI_PACKAGES_INSTALLED, 'installed');
}
process.exit(Number(process.env.CI_CACHED_INSTALL_STATUS));
`;
  const fakeTimeout = `#!/usr/bin/env node
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CI_CALLS, JSON.stringify(['timeout', ...args]) + '\\n');
const commandArguments = args.slice(3);
const options = { stdio: 'inherit' };
const result = spawnSync(args[2], commandArguments, options);
process.exit(result.status);
`;
  const fileOptions = { mode: 0o755 };
  writeFileSync(join(directory, 'npx'), fakeNpx, fileOptions);
  writeFileSync(join(directory, 'apt-get'), fakeApt, fileOptions);
  writeFileSync(join(directory, 'timeout'), fakeTimeout, fileOptions);
  writeFileSync(join(directory, 'sudo'), '#!/usr/bin/env bash\nexec "$@"\n', fileOptions);
}

function installChromium(dependencyStatus, installStatus = 0, cacheOptions = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'ci-chromium-'));
  const log = join(directory, 'calls.jsonl');
  const cacheDirectory = join(directory, 'archives');
  mkdirSync(cacheDirectory);
  if (cacheOptions.present) {
    writeFileSync(join(cacheDirectory, 'fonts-test.deb'), 'cached package');
  }
  writeFakeCommands(directory);
  const environment = { ...process.env, PATH: `${directory}:${process.env.PATH}`,
    CI_CALLS: log, CI_DEPENDENCY_STATUS: String(dependencyStatus),
    CI_INSTALL_STATUS: String(installStatus), CHROMIUM_DEB_CACHE: cacheDirectory,
    CI_PACKAGES_INSTALLED: join(directory, 'installed'),
    CI_CACHED_INSTALL_STATUS: String(cacheOptions.installStatus ?? 0),
    CI_INCOMPLETE_CACHE: String(cacheOptions.incomplete ?? false) };
  const options = { env: environment, encoding: 'utf8' };
  function parseCall(line) {
    return JSON.parse(line);
  }
  try {
    const script = resolve('scripts/ci/install-chromium.sh');
    const result = spawnSync('bash', [script], options);
    const callLog = readFileSync(log, 'utf8');
    const trimmedLog = callLog.trim();
    const lines = trimmedLog.split('\n');
    const calls = lines.map(parseCall);
    const archives = readdirSync(cacheDirectory);
    return { ...result, calls, archives, cacheDirectory };
  } finally {
    const cleanup = { recursive: true, force: true };
    rmSync(directory, cleanup);
  }
}

function avoidsAptWhenPackagesArePresent() {
  const result = installChromium(0);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls, [
    ['playwright', 'install-deps', '--dry-run', 'chromium'],
    ['playwright', 'install', 'chromium'],
  ]);
  assert.match(result.stdout, /Chromium setup: \d+ seconds/);
}

function installsMissingPackages() {
  const result = installChromium(1);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls[1], ['timeout', '--kill-after=10s', '180s',
    'npx', 'playwright', 'install-deps', 'chromium']);
  assert.deepEqual(result.calls[2], ['playwright', 'install-deps', 'chromium']);
  assert.deepEqual(result.calls[3], ['playwright', 'install', 'chromium']);
  assert.equal(result.calls.length, 4);
  assert.deepEqual(result.archives, ['fonts-test.deb']);
}

function refusesFailedInstall() {
  for (const dependencyStatus of [0, 1]) {
    const result = installChromium(dependencyStatus, 7);
    assert.equal(result.status, 7);
    if (dependencyStatus === 0) {
      assert.equal(result.calls.length, 2);
    } else {
      assert.equal(result.calls.length, 3);
      assert.deepEqual(result.calls[2], ['playwright', 'install-deps', 'chromium']);
    }
  }
}

function installsCachedPackagesWithoutDownloads() {
  const cacheOptions = { present: true };
  const result = installChromium(1, 0, cacheOptions);
  assert.equal(result.status, 0, result.stderr);
  const archive = join(result.cacheDirectory, 'fonts-test.deb');
  const archiveOption = `Dir::Cache::archives=${result.cacheDirectory}`;
  assert.deepEqual(result.calls, [
    ['playwright', 'install-deps', '--dry-run', 'chromium'],
    ['timeout', '--kill-after=10s', '180s', 'apt-get', '--option', archiveOption,
      'install', '--yes', '--no-install-recommends', '--no-download', archive],
    ['apt-get', '--option', archiveOption, 'install', '--yes',
      '--no-install-recommends', '--no-download', archive],
    ['playwright', 'install-deps', '--dry-run', 'chromium'],
    ['playwright', 'install', 'chromium'],
  ]);
}

function downloadsWhenCacheCannotSupplyDependencies() {
  const unusableCaches = [
    { present: true, installStatus: 9 },
    { present: true, incomplete: true },
  ];
  for (const cacheOptions of unusableCaches) {
    const result = installChromium(1, 0, cacheOptions);
    assert.equal(result.status, 0, result.stderr);
    const calls = result.calls.slice(-3);
    assert.deepEqual(calls, [
      ['timeout', '--kill-after=10s', '180s', 'npx', 'playwright', 'install-deps', 'chromium'],
      ['playwright', 'install-deps', 'chromium'],
      ['playwright', 'install', 'chromium'],
    ]);
  }
}

function refusesFailedFallbackAfterCacheFailure() {
  const cacheOptions = { present: true, installStatus: 9 };
  const result = installChromium(1, 7, cacheOptions);
  assert.equal(result.status, 7);
  assert.deepEqual(result.calls.at(-1), ['playwright', 'install-deps', 'chromium']);
}

function refusesTimedOutDependencyInstall() {
  const result = installChromium(1, 124);
  assert.equal(result.status, 124);
  assert.deepEqual(result.calls.at(-1), ['playwright', 'install-deps', 'chromium']);
}

test('installs only Chromium when system packages are present', avoidsAptWhenPackagesArePresent);
test('installs system packages when the dependency check fails', installsMissingPackages);
test('fails when Chromium or its dependencies cannot be installed', refusesFailedInstall);
test('installs cached system packages without apt updates or downloads',
  installsCachedPackagesWithoutDownloads);
test('downloads missing packages when cached packages fail or are incomplete',
  downloadsWhenCacheCannotSupplyDependencies);
test('fails when the cache and the dependency download both fail',
  refusesFailedFallbackAfterCacheFailure);
test('fails when dependency installation reaches its time limit', refusesTimedOutDependencyInstall);
