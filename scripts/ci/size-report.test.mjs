import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { classify, parseNumstat, ratio, weeklyChanges } from './size-report.mjs';

function classifiesTrackedPaths() {
  assert.equal(classify('apps/web/src/app/chat/workspace.spec.ts'), 'tests');
  assert.equal(classify('apps/server/src/main.ts'), 'source');
  assert.equal(classify('libs/models/src/model.test.ts'), 'tests');
  assert.equal(classify('libs/auth/test/fixtures/token.json'), 'tests');
  assert.equal(classify('apps/web/src/styles.css'), 'source');
  assert.equal(classify('apps/web/src/index.html'), 'source');
  assert.equal(classify('docs/process/journey.png'), 'evidence');
  assert.equal(classify('scripts/ci/size-report.test.mjs'), 'other');
  assert.equal(classify('apps/server/src/config.json'), 'other');
  assert.equal(classify('apps/server/testing/example.ts'), 'other');
}
test('classify applies the shared counting rule', classifiesTrackedPaths);

function parsesTextChanges() {
  const text = '12\t3\tapps/server/src/main.ts\n-\t-\tdocs/process/chat.png\n'
    + '0\t8\tlibs/auth/test/file with spaces.ts\n';
  const expected = [
    { path: 'apps/server/src/main.ts', added: 12, deleted: 3 },
    { path: 'libs/auth/test/file with spaces.ts', added: 0, deleted: 8 },
  ];
  assert.deepEqual(parseNumstat(text), expected);
}
test('parseNumstat reads text changes and skips binary files', parsesTextChanges);

function formatsRatios() {
  assert.equal(ratio({ source: 3, tests: 10 }), '3.3');
  assert.equal(ratio({ source: 1, tests: 10 }), '10.0');
  assert.equal(ratio({ source: 0, tests: 10 }), 'n/a');
  assert.equal(ratio({ source: 0, tests: 0 }), 'n/a');
}
test('ratio uses one decimal place and handles absent source', formatsRatios);

function assignsWeekBoundary() {
  const now = 1_800_000_000;
  const week = 7 * 24 * 60 * 60;
  const history = `@${now - week}\n2\t1\tapps/server/src/name@host.ts\n`
    + `@${now - week - 1}\n4\t3\tlibs/auth/test/token.json\n`
    + `@${now - 2 * week}\n1\t5\tdocs/process/receipt.md\n`
    + `@${now - 2 * week - 1}\n99\t99\tREADME.md\n`;
  const weeks = weeklyChanges(history, now);
  assert.deepEqual(weeks[0].source, { added: 2, deleted: 1 });
  assert.deepEqual(weeks[1].tests, { added: 4, deleted: 3 });
  assert.deepEqual(weeks[1].evidence, { added: 1, deleted: 5 });
  assert.deepEqual(weeks[1].other, { added: 0, deleted: 0 });
}
test('a commit exactly seven days old belongs to the last seven days', assignsWeekBoundary);

const script = resolve('scripts/ci/size-report.mjs');

function git(repository, ...args) {
  return execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim();
}

function reportsWithoutGate() {
  const repository = mkdtempSync(join(tmpdir(), 'size-report-'));
  try {
    git(repository, 'init', '--quiet');
    mkdirSync(join(repository, 'apps/server/src'), { recursive: true });
    mkdirSync(join(repository, 'apps/server/test'), { recursive: true });
    writeFileSync(join(repository, 'apps/server/package.json'), '{}\n');
    writeFileSync(join(repository, 'apps/server/src/main.ts'), 'source\n');
    writeFileSync(join(repository, 'apps/server/test/main.test.ts'), 'test\n'.repeat(10));
    git(repository, 'add', '.');
    git(repository, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
      'commit', '--quiet', '-m', 'Fixture');
    const base = git(repository, 'rev-parse', 'HEAD');
    git(repository, 'update-ref', 'refs/remotes/origin/main', base);
    writeFileSync(join(repository, 'apps/server/src/main.ts'), 'changed\nsource\n');
    git(repository, 'add', '.');
    git(repository, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
      'commit', '--quiet', '-m', 'Change');
    const head = git(repository, 'rev-parse', 'HEAD');
    const summary = join(repository, 'summary.md');
    const env = { ...process.env, BASE_SHA: base, HEAD_SHA: head, GITHUB_STEP_SUMMARY: summary };
    const result = spawnSync(process.execPath, [script], { cwd: repository, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /\| apps\/server \| 2 \| 10 \| 5.0 \|/);
    assert.match(result.stdout, /Pull request changes/);
    assert.equal(readFileSync(summary, 'utf8'), result.stdout);
    const lines = result.stdout.trim().split('\n');
    const report = JSON.parse(lines.at(-1).slice('size-report:'.length));
    assert.deepEqual(report.pullRequest.source, { added: 1, deleted: 0 });
    assert.equal(report.packages.length, 1);
    const localEnv = { ...env, BASE_SHA: '', HEAD_SHA: '' };
    const local = spawnSync(process.execPath, [script], {
      cwd: repository, env: localEnv, encoding: 'utf8',
    });
    assert.match(local.stdout, new RegExp(`Through ${base};`, 'u'));
    env.BASE_SHA = '';
    env.HEAD_SHA = '';
    git(repository, 'checkout', '--quiet', base);
    const main = spawnSync(process.execPath, [script], { cwd: repository, env, encoding: 'utf8' });
    assert.equal(main.status, 0, main.stderr);
    assert.match(main.stdout, /\| Total \| 1 \| 10 \| 10.0 \|/);
    assert.doesNotMatch(main.stdout, /Pull request changes/);
    const failure = spawnSync(process.execPath, [script], {
      cwd: repository, env: { ...env, BASE_SHA: 'missing', HEAD_SHA: head }, encoding: 'utf8',
    });
    assert.equal(failure.status, 0);
    assert.match(failure.stdout, /size-report:.*error/);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
}
test('the CLI reports a ten-to-one tree and Git errors without failing', reportsWithoutGate);
