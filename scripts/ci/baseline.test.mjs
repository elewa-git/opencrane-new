import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { baseCommit, readAtBase, mustNotRise } from './baseline.mjs';

const originalDirectory = process.cwd();
const originalBase = process.env.BASE_SHA;
let repository;

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function setup() {
  repository = mkdtempSync(join(tmpdir(), 'baseline-'));
  process.chdir(repository);
  delete process.env.BASE_SHA;
  git('init', '--quiet');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
}

function cleanup() {
  process.chdir(originalDirectory);
  if (originalBase === undefined) delete process.env.BASE_SHA;
  else process.env.BASE_SHA = originalBase;
  rmSync(repository, { recursive: true, force: true });
}

beforeEach(setup);
afterEach(cleanup);

function usesExplicitBase() {
  process.env.BASE_SHA = 'explicit-base';
  assert.equal(baseCommit(), 'explicit-base');
}
test('uses BASE_SHA before consulting Git', usesExplicitBase);

function usesMergeBase() {
  writeFileSync('example.txt', 'base text\n');
  git('add', '.');
  git('commit', '--quiet', '-m', 'Fixture');
  const expected = git('rev-parse', 'HEAD');
  git('update-ref', 'refs/remotes/origin/main', expected);
  assert.equal(baseCommit(), expected);
  assert.equal(readAtBase('example.txt'), 'base text\n');
  assert.equal(readAtBase('missing.txt'), undefined);
  writeFileSync('example.txt', 'changed text\n');
  assert.equal(readAtBase('example.txt'), 'base text\n');
}
test('reads the merge base rather than working files', usesMergeBase);

function handlesMissingBase() {
  assert.equal(baseCommit(), undefined);
  assert.equal(readAtBase('example.txt'), undefined);
}
test('returns nothing when no base commit is available', handlesMissingBase);

function comparesCounts() {
  assert.equal(mustNotRise('lines', 4, 5), 'lines rose from 4 to 5');
  assert.equal(mustNotRise('lines', 4, 4), undefined);
  assert.equal(mustNotRise('lines', 4, 3), undefined);
}
test('reports only increases', comparesCounts);
