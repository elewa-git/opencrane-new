import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
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
    assert.equal(jobsPassed(decision, 'success', 'skipped', 'skipped', 'skipped'), false);
    assert.equal(jobsPassed(decision, 'success', 'success', 'success', 'success'), true);
  }
  assert.equal(isDocsDecision('docs'), true);
  assert.equal(jobsPassed('docs', 'success', 'skipped', 'skipped', 'skipped'), true);
  assert.equal(jobsPassed('docs', 'failure', 'skipped', 'skipped', 'skipped'), false);
  assert.equal(jobsPassed('full', 'success', 'failure', 'success', 'success'), false);
  for (const result of ['failure', 'cancelled', 'skipped', undefined]) {
    assert.equal(jobsPassed('full', 'success', 'success', result, 'success'), false);
    assert.equal(jobsPassed('full', 'success', 'success', 'success', result), false);
  }
  assert.equal(jobsPassed('docs', 'success', 'skipped', 'skipped', 'success'), false);
  assert.equal(jobsPassed('docs', 'success', 'skipped', 'success', 'skipped'), false);
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

function documentationCommands() {
  const path = new URL('../../.github/workflows/ci.yml', import.meta.url);
  const workflow = readFileSync(path, 'utf8');
  const docsStep = /- name: Check documentation\n +if: needs\.select\.outputs\.mode == 'docs'\n +run: \|\n((?:          .*\n)+)/u;
  const match = workflow.match(docsStep);
  assert.ok(match, 'The documentation checks must run when CI selects docs.');
  return match[1];
}

function documentationChecksRejectTicketReference() {
  const directory = mkdtempSync(join(tmpdir(), 'ci-docs-'));
  const options = { cwd: directory, encoding: 'utf8' };
  const npmFixture = `#!${process.execPath}
const { spawnSync } = require('node:child_process');
const [command, script] = process.argv.slice(2);
if (command !== 'run') throw new Error('Documentation checks must not install packages.');
if (script === 'lint:readmes') {
  const result = spawnSync(process.execPath, [process.env.README_CHECKER], { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}
const otherChecks = ['lint:docs', 'lint:links', 'lint:changelog'];
if (!otherChecks.includes(script)) throw new Error('Unexpected documentation check: ' + script);
`;
  try {
    mkdirSync(join(directory, 'bin'));
    mkdirSync(join(directory, 'libs/example'), { recursive: true });
    writeFileSync(join(directory, 'bin/npm'), npmFixture, { mode: 0o755 });
    writeFileSync(join(directory, 'libs/example/README.md'), '# Example\n\nAdded in #123.\n');
    execFileSync('git', ['init', '--quiet'], options);
    execFileSync('git', ['add', 'libs'], options);
    const checker = new URL('../check-folder-readmes.mjs', import.meta.url);
    const environment = {
      ...process.env,
      PATH: `${directory}/bin:${process.env.PATH}`,
      README_CHECKER: checker.pathname,
    };
    const execution = { ...options, env: environment };

    const result = spawnSync('bash', ['-e', '-c', documentationCommands()], execution);

    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /Remove ticket or phase references from libs\/example\/README.md:3/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('documentation CI rejects ticket references in folder guides without installs',
  documentationChecksRejectTicketReference);
