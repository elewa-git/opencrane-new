import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fixtureFiles, needsFixtures, testArguments } from './fixture-tests.mjs';
import { verifyFiles } from './test-files.mjs';

function partitionsTests() {
  const fixtures = testArguments('fixtures');
  for (const group of ['1', '2', '3', '4']) {
    const shard = testArguments(group);
    assert.ok(shard.includes(`--shard=${group}/4`));
    for (const file of fixtureFiles) {
      assert.ok(shard.includes(`--exclude=${file}`));
      assert.ok(fixtures.includes(file));
    }
  }
  assert.ok(!fixtures.some(isShardArgument));
}

function isShardArgument(argument) {
  return argument.startsWith('--shard=');
}

function detectsFixtureUse() {
  assert.equal(needsFixtures("import { chromium } from 'playwright';"), true);
  assert.equal(needsFixtures("await import('playwright');"), true);
  assert.equal(needsFixtures("require('playwright');"), true);
  assert.equal(needsFixtures('await uploadComputer();'), true);
  assert.equal(needsFixtures('await screenshotDesktop();'), true);
  assert.equal(needsFixtures("'ocn-upload-computer:test'"), true);
  assert.equal(needsFixtures("inventory: ['git', 'playwright']"), false);
}

function rejectsUnknownGroup() {
  function tooManyShards() {
    testArguments('5');
  }
  function emptyGroup() {
    testArguments('');
  }
  assert.throws(tooManyShards, /Unknown test group/);
  assert.throws(emptyGroup, /Unknown test group/);
}

function acceptsCompleteRun() {
  verifyFiles(['one', 'two'], [['two'], ['one']]);
}

function rejectsMissingFile() {
  function missingFile() {
    verifyFiles(['one', 'two'], [['one']]);
  }
  assert.throws(missingFile, /Missing.*two/);
}

function rejectsDuplicateFile() {
  function duplicateFile() {
    verifyFiles(['one'], [['one'], ['one']]);
  }
  assert.throws(duplicateFile, /Duplicate.*one/);
}

function rejectsUnexpectedFile() {
  function unexpectedFile() {
    verifyFiles(['one'], [['one', 'other']]);
  }
  assert.throws(unexpectedFile, /Unexpected.*other/);
}

function checksFixtureEntriesOnEveryVerification() {
  const directory = mkdtempSync(join(tmpdir(), 'ci-files-'));
  const script = resolve('scripts/ci/test-files.mjs');
  const newTest = 'apps/server/test/new-browser.test.ts';
  const files = [...fixtureFiles, newTest];
  const directoryOptions = { recursive: true };
  const executionOptions = { cwd: directory, encoding: 'utf8' };
  function listedFile(file) {
    return { file: resolve(directory, file) };
  }
  function verify() {
    return spawnSync('node', [script, 'verify'], executionOptions);
  }
  try {
    for (const file of files) {
      const target = resolve(directory, file);
      mkdirSync(dirname(target), directoryOptions);
      writeFileSync(target, '');
    }
    const reports = join(directory, '.tools/ci');
    mkdirSync(join(reports, 'groups'), directoryOptions);
    const listed = files.map(listedFile);
    writeFileSync(join(reports, 'expected.json'), JSON.stringify(listed));
    writeFileSync(join(reports, 'groups/files.json'), JSON.stringify(files));
    assert.equal(verify().status, 0);
    writeFileSync(resolve(directory, newTest), "import { chromium } from 'playwright';");
    const refused = verify();
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /Add this test to fixtureFiles/);
  } finally {
    const cleanupOptions = { recursive: true, force: true };
    rmSync(directory, cleanupOptions);
  }
}

test('keeps fixture files out of all four shards', partitionsTests);
test('detects browser and image use without matching ordinary data', detectsFixtureUse);
test('refuses an unknown test group', rejectsUnknownGroup);
test('accepts every file exactly once', acceptsCompleteRun);
test('refuses missing files', rejectsMissingFile);
test('refuses duplicate files', rejectsDuplicateFile);
test('refuses unexpected files', rejectsUnexpectedFile);
test('checks new fixture use whenever CI verifies file lists', checksFixtureEntriesOnEveryVerification);
