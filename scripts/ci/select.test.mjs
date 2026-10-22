import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { selectRun, isDocsDecision, jobsPassed } from './select.mjs';

function permitsOnlyDocs() {
  for (const file of ['docs/guide.txt', 'changes/unreleased/example.md', 'README.md',
    'apps/web/README.md', 'docs/picture.png', 'picture.png']) {
    assert.equal(selectRun('pull_request', [file]), 'docs', file);
  }
}

function forcesFullRun() {
  for (const file of ['apps/server/src/index.ts', 'docs/process/evidence/check.md',
    '.github/README.md', '.github/workflows/ci.yml', 'scripts/ci/select.mjs',
    'scripts/ci/sequencer.mjs', 'scripts/ci/test-timings.json', 'picture.png.ts']) {
    assert.equal(selectRun('pull_request', ['README.md', file]), 'full', file);
  }
  assert.equal(selectRun('pull_request', []), 'full');
  assert.equal(selectRun('push', ['README.md']), 'full');
  assert.equal(selectRun('workflow_dispatch', ['README.md']), 'full');
}

function failsClosed() {
  for (const decision of [undefined, null, '', 'full', 'failed', 'DOCS', 'docs\n']) {
    assert.equal(isDocsDecision(decision), false);
    assert.equal(jobsPassed(decision, 'success', 'skipped', 'skipped'), false);
    assert.equal(jobsPassed(decision, 'success', 'success', 'success'), true);
  }
  assert.equal(isDocsDecision('docs'), true);
  assert.equal(jobsPassed('docs', 'success', 'skipped', 'skipped'), true);
  assert.equal(jobsPassed('docs', 'failure', 'skipped', 'skipped'), false);
  assert.equal(jobsPassed('full', 'success', 'failure', 'success'), false);
}

test('allows each documentation rule on pull requests', permitsOnlyDocs);
test('runs everything for protected paths, mixed changes and main pushes', forcesFullRun);
test('skips only for the exact docs decision', failsClosed);

function usesBaseRulesAndIncludesDeletions() {
  const directory = mkdtempSync(join(tmpdir(), 'ci-select-'));
  const options = { cwd: directory, encoding: 'utf8' };
  function git(argumentsList) {
    const result = spawnSync('git', argumentsList, options);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  function commit() {
    git(['add', '.']);
    git(['-c', 'user.name=Test', '-c', 'user.email=test@example.test',
      '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Test files']);
    return git(['rev-parse', 'HEAD']);
  }
  try {
    git(['init', '-q']);
    const directoryOptions = { recursive: true };
    mkdirSync(join(directory, 'scripts/ci'), directoryOptions);
    mkdirSync(join(directory, 'docs'), directoryOptions);
    const source = readFileSync(new URL('./select.mjs', import.meta.url), 'utf8');
    writeFileSync(join(directory, 'scripts/ci/select.mjs'), source);
    writeFileSync(join(directory, 'source.ts'), 'export const value = 1;');
    const base = commit();
    git(['mv', 'source.ts', 'docs/source.md']);
    const head = commit();
    const baseScript = git(['show', `${base}:scripts/ci/select.mjs`]);
    const environment = { ...process.env, GITHUB_OUTPUT: join(directory, 'output') };
    const execution = { ...options, env: environment, input: baseScript };
    const argumentsList = ['--input-type=module', '-', 'pull_request', base, head];
    const result = spawnSync(process.execPath, argumentsList, execution);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'full');
    writeFileSync(join(directory, 'scripts/ci/select.mjs'), "console.log('docs');");
    argumentsList[4] = commit();
    const changedScript = spawnSync(process.execPath, argumentsList, execution);
    assert.equal(changedScript.status, 0, changedScript.stderr);
    assert.equal(changedScript.stdout.trim(), 'full');
    argumentsList[4] = 'missing-commit';
    const failed = spawnSync(process.execPath, argumentsList, execution);
    assert.notEqual(failed.status, 0);
    assert.equal(isDocsDecision(failed.stdout.trim()), false);
  } finally {
    const cleanup = { recursive: true, force: true };
    rmSync(directory, cleanup);
  }
}

test('uses base rules and refuses renamed code or a broken diff', usesBaseRulesAndIncludesDeletions);
