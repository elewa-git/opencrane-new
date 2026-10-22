import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

function installChromium(dependencyStatus, installStatus = 0) {
  const directory = mkdtempSync(join(tmpdir(), 'ci-chromium-'));
  const log = join(directory, 'calls.jsonl');
  const fakeNpx = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CI_CALLS, JSON.stringify(args) + '\\n');
if (args.includes('--dry-run')) {
  const config = fs.readFileSync(process.env.APT_CONFIG, 'utf8');
  if (!config.includes('APT::Get::Upgrade "false";')) process.exit(99);
  process.exit(Number(process.env.CI_DEPENDENCY_STATUS));
}
process.exit(Number(process.env.CI_INSTALL_STATUS));
`;
  const fileOptions = { mode: 0o755 };
  writeFileSync(join(directory, 'npx'), fakeNpx, fileOptions);
  const environment = { ...process.env, PATH: `${directory}:${process.env.PATH}`,
    CI_CALLS: log, CI_DEPENDENCY_STATUS: String(dependencyStatus),
    CI_INSTALL_STATUS: String(installStatus) };
  const options = { env: environment, encoding: 'utf8' };
  function parseCall(line) {
    return JSON.parse(line);
  }
  try {
    const script = resolve('scripts/ci/install-chromium.sh');
    const result = spawnSync('bash', [script], options);
    const lines = readFileSync(log, 'utf8').trim().split('\n');
    return { ...result, calls: lines.map(parseCall) };
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
  assert.deepEqual(result.calls[1], ['playwright', 'install', '--with-deps', 'chromium']);
  assert.equal(result.calls.length, 2);
}

function refusesFailedInstall() {
  for (const dependencyStatus of [0, 1]) {
    const result = installChromium(dependencyStatus, 7);
    assert.equal(result.status, 7);
    assert.equal(result.calls.length, 2);
  }
}

test('installs only Chromium when system packages are present', avoidsAptWhenPackagesArePresent);
test('installs system packages when the dependency check fails', installsMissingPackages);
test('fails when Chromium or its dependencies cannot be installed', refusesFailedInstall);
