import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  assert.ok(fixtures.includes('--maxWorkers=1'));
  assert.ok(fixtures.includes('apps/web/test/chat-browser.test.ts'));
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
    const helper = resolve(directory, 'apps/server/test/helper.mjs');
    const childScript = resolve(directory, 'scripts/browser.mjs');
    mkdirSync(dirname(childScript), directoryOptions);
    writeFileSync(helper, "import './new-browser.test.ts';\nexport * from './browser.mjs';");
    writeFileSync(resolve(directory, 'apps/server/test/browser.mjs'),
      "import { chromium } from 'playwright';");
    writeFileSync(childScript, "require('playwright');");
    const sources = [
      "import { chromium } from 'playwright';",
      "import './helper.mjs';",
      "execFile(process.execPath, ['scripts/browser.mjs']);",
      "await import('./browser.mjs');",
    ];
    for (const source of sources) {
      writeFileSync(resolve(directory, newTest), source);
      const refused = verify();
      assert.notEqual(refused.status, 0, source);
      assert.match(refused.stderr, /Add this test to fixtureFiles/, source);
    }
    writeFileSync(resolve(directory, 'apps/server/test/browser.mjs'),
      "const image = 'ocn-upload-computer:test';");
    writeFileSync(resolve(directory, newTest), "import './helper.mjs';");
    const imageRefused = verify();
    assert.notEqual(imageRefused.status, 0);
    assert.match(imageRefused.stderr, /Add this test to fixtureFiles/);
    writeFileSync(childScript, "const browser = 'ordinary data';");
    writeFileSync(resolve(directory, newTest), "spawn('node', ['scripts/browser.mjs']);");
    assert.equal(verify().status, 0);
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

function detectsRealChatBrowserScripts() {
  const file = 'apps/web/test/chat-browser.test.ts';
  const source = readFileSync(file, 'utf8');
  assert.equal(needsFixtures(source, file), true);
  const scripts = [
    'scripts/check-chat-browser.mjs',
    'scripts/check-chat-production.mjs',
    'scripts/check-fold-loader.mjs',
  ];
  for (const script of scripts) {
    const launch = `execFile(process.execPath, ['${script}']);`;
    assert.equal(needsFixtures(launch, file), true, script);
  }
  assert.ok(fixtureFiles.includes(file));
}

function verifiesRealChatBrowserAssignment() {
  const directory = mkdtempSync(join(tmpdir(), 'ci-chat-files-'));
  const script = resolve('scripts/ci/test-files.mjs');
  const chatTest = 'apps/web/test/chat-browser.test.ts';
  const files = [...new Set([...fixtureFiles, chatTest])];
  const directoryOptions = { recursive: true };
  const executionOptions = { cwd: directory, encoding: 'utf8' };
  function listedFile(file) {
    return { file: resolve(directory, file) };
  }
  try {
    for (const file of files) {
      const target = resolve(directory, file);
      mkdirSync(dirname(target), directoryOptions);
      writeFileSync(target, '');
    }
    const chatScripts = [
      chatTest,
      'scripts/check-chat-browser.mjs',
      'scripts/check-chat-production.mjs',
      'scripts/check-fold-loader.mjs',
    ];
    for (const file of chatScripts) {
      const target = resolve(directory, file);
      mkdirSync(dirname(target), directoryOptions);
      writeFileSync(target, readFileSync(file, 'utf8'));
    }
    const reports = join(directory, '.tools/ci');
    mkdirSync(join(reports, 'groups'), directoryOptions);
    const listed = files.map(listedFile);
    writeFileSync(join(reports, 'expected.json'), JSON.stringify(listed));
    writeFileSync(join(reports, 'groups/files.json'), JSON.stringify(files));
    const result = spawnSync('node', [script, 'verify'], executionOptions);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    const cleanupOptions = { recursive: true, force: true };
    rmSync(directory, cleanupOptions);
  }
}

test('detects Chromium through the real chat browser scripts', detectsRealChatBrowserScripts);
test('accepts the real chat browser suite in the fixture list', verifiesRealChatBrowserAssignment);
