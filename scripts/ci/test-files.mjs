import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fixtureFiles, needsFixtures } from './fixture-tests.mjs';

export function verifyFiles(expected, groups) {
  const remaining = new Set(expected);
  const seen = new Set();
  for (const files of groups) {
    for (const file of files) {
      if (seen.has(file)) {
        throw new Error(`Duplicate test file: ${file}`);
      }
      if (!remaining.delete(file)) {
        throw new Error(`Unexpected test file: ${file}`);
      }
      seen.add(file);
    }
  }
  if (remaining.size > 0) {
    throw new Error(`Missing test files: ${[...remaining].join(', ')}`);
  }
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function reportFile(result) {
  return relative(process.cwd(), result.name);
}

function listedFile(result) {
  return relative(process.cwd(), result.file);
}

function readGroup(file) {
  return readJson(`.tools/ci/groups/${file}`);
}

function checkFixtureUse(files) {
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    if (needsFixtures(source, file) && !fixtureFiles.includes(file)) {
      throw new Error(`Add this test to fixtureFiles: ${file}`);
    }
  }
  for (const file of fixtureFiles) {
    if (!files.includes(file)) {
      throw new Error(`Fixture test no longer exists: ${file}`);
    }
  }
}

function main() {
  const operation = process.argv[2];
  if (operation === 'record') {
    const report = readJson('.tools/ci/report.json');
    const files = report.testResults.map(reportFile);
    writeFileSync(`.tools/ci/files-${process.argv[3]}.json`, JSON.stringify(files));
  } else if (operation === 'verify') {
    const listed = readJson('.tools/ci/expected.json');
    const expected = listed.map(listedFile);
    checkFixtureUse(expected);
    const groupNames = readdirSync('.tools/ci/groups');
    const groups = groupNames.map(readGroup);
    verifyFiles(expected, groups);
    console.log(`Verified ${expected.length} test files, each in exactly one job.`);
  } else {
    throw new Error('Unknown test file operation');
  }
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
