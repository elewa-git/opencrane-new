import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

function fixtureRun(buildExit) {
  const directory = mkdtempSync(join(tmpdir(), 'ci-runner-'));
  const binaryDirectory = join(directory, 'bin');
  mkdirSync(binaryDirectory);
  const log = join(directory, 'calls.jsonl');
  const fakeNpm = `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(process.env.CI_CALLS, JSON.stringify(process.argv.slice(2)) + '\\n');
if (process.argv[2] === 'run') {
  process.exit(Number(process.env.CI_BUILD_EXIT));
}
`;
  const fileOptions = { mode: 0o755 };
  writeFileSync(join(binaryDirectory, 'npm'), fakeNpm, fileOptions);
  const environment = { ...process.env, PATH: `${binaryDirectory}:${process.env.PATH}`,
    CI_CALLS: log, CI_BUILD_EXIT: String(buildExit) };
  const options = { cwd: directory, env: environment, encoding: 'utf8' };
  function parseCall(line) {
    return JSON.parse(line);
  }
  try {
    const script = resolve('scripts/ci/run-tests.mjs');
    const result = spawnSync(process.execPath, [script, 'fixtures'], options);
    const lines = readFileSync(log, 'utf8').trim().split('\n');
    return { status: result.status, calls: lines.map(parseCall) };
  } finally {
    const cleanup = { recursive: true, force: true };
    rmSync(directory, cleanup);
  }
}

function preparesBeforeTesting() {
  const result = fixtureRun(0);
  assert.equal(result.status, 0);
  assert.deepEqual(result.calls[0], ['run', 'build', '-w', 'apps/web', '--',
    '--configuration=development']);
  assert.equal(result.calls[1][0], 'test');
  assert.equal(result.calls.length, 2);
}

function refusesFailedPreparation() {
  const result = fixtureRun(7);
  assert.equal(result.status, 7);
  assert.equal(result.calls.length, 1);
}

test('prepares Angular before starting fixture tests', preparesBeforeTesting);
test('fails without running tests when preparation fails', refusesFailedPreparation);
