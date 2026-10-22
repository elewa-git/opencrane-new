import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixtureFiles, needsFixtures, testArguments } from './fixture-tests.mjs';
import { verifyFiles } from './test-files.mjs';

function partitionsTests() {
  const shard = testArguments('2');
  const fixtures = testArguments('fixtures');
  assert.ok(shard.includes('--shard=2/4'));
  for (const file of fixtureFiles) {
    assert.ok(shard.includes(`--exclude=${file}`));
    assert.ok(fixtures.includes(file));
  }
  assert.ok(!fixtures.some(isShardArgument));
}

function isShardArgument(argument) {
  return argument.startsWith('--shard=');
}

function detectsFixtureUse() {
  assert.equal(needsFixtures("import { chromium } from 'playwright';"), true);
  assert.equal(needsFixtures("await import('playwright');"), true);
  assert.equal(needsFixtures('await uploadComputer();'), true);
  assert.equal(needsFixtures('await screenshotDesktop();'), true);
  assert.equal(needsFixtures("'ocn-upload-computer:test'"), true);
  assert.equal(needsFixtures("inventory: ['git', 'playwright']"), false);
}

function rejectsUnknownGroup() {
  assert.throws(() => testArguments('5'), /Unknown test group/);
  assert.throws(() => testArguments(''), /Unknown test group/);
}

function acceptsCompleteRun() {
  assert.doesNotThrow(() => verifyFiles(['one', 'two'], [['two'], ['one']]));
}

function rejectsMissingFile() {
  assert.throws(() => verifyFiles(['one', 'two'], [['one']]), /Missing.*two/);
}

function rejectsDuplicateFile() {
  assert.throws(() => verifyFiles(['one'], [['one'], ['one']]), /Duplicate.*one/);
}

function rejectsUnexpectedFile() {
  assert.throws(() => verifyFiles(['one'], [['one', 'other']]), /Unexpected.*other/);
}

test('keeps fixture files out of all four shards', partitionsTests);
test('detects browser and image use without matching ordinary data', detectsFixtureUse);
test('refuses an unknown test group', rejectsUnknownGroup);
test('accepts every file exactly once', acceptsCompleteRun);
test('refuses missing files', rejectsMissingFile);
test('refuses duplicate files', rejectsDuplicateFile);
test('refuses unexpected files', rejectsUnexpectedFile);
