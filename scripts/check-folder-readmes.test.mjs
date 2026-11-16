import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { commitBase } from './test/support/git-repository.mjs';
import { afterEach, beforeEach, expect, test } from 'vitest';

const checker = fileURLToPath(new URL('./check-folder-readmes.mjs', import.meta.url));
let repository;
const headings = [
  'What this is', 'Where it fits', 'What it is responsible for',
  'Processes it handles', 'How to run or test it', 'Where to read more',
];

function packageReadme() {
  const lines = ['# Example', ''];
  for (const heading of headings) {
    lines.push(`## ${heading}`, '', 'Example package.', '');
  }
  return lines.join('\n');
}
const validReadme = packageReadme();

function createRepository() {
  repository = mkdtempSync(join(tmpdir(), 'folder-readmes-'));
  const options = { cwd: repository, encoding: 'utf8' };
  execFileSync('git', ['init', '--quiet'], options);
  writeFile('scripts/readme-baseline.json', '[]');
}

function removeRepository() {
  const options = { recursive: true, force: true };
  rmSync(repository, options);
}

function writeFile(path, content) {
  const target = join(repository, path);
  const options = { recursive: true };
  mkdirSync(dirname(target), options);
  writeFileSync(target, content);
}

function trackFiles(files) {
  for (const [path, content] of Object.entries(files)) {
    writeFile(path, content);
  }
  const options = { cwd: repository, encoding: 'utf8' };
  execFileSync('git', ['add', '--all'], options);
}

function runCheck(base = '') {
  const env = { ...process.env, BASE_SHA: base };
  const options = { cwd: repository, encoding: 'utf8', env };
  return spawnSync(process.execPath, [checker], options);
}

beforeEach(createRepository);
afterEach(removeRepository);

function reportsEveryMissingFolder() {
  const files = {
    'apps/example/README.md': validReadme,
    'apps/example/src/chat/history/messages.ts': '',
    'apps/example/assets/icons/logo.svg': '',
  };
  trackFiles(files);

  const result = runCheck();

  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Missing README.md in folder: apps/example/src/chat\n');
  expect(result.stderr).toContain('Missing README.md in folder: apps/example/src/chat/history\n');
  expect(result.stderr).toContain('Missing README.md in folder: apps/example/assets\n');
  expect(result.stderr).toContain('Missing README.md in folder: apps/example/assets/icons\n');
}

test('names every folder missing its README, including parent folders', reportsEveryMissingFolder);

const packageGroups = ['apps', 'libs', 'infra', 'tools'];

function requiresPackageReadme(group) {
  const files = { [`${group}/example/code.ts`]: '' };
  trackFiles(files);

  const result = runCheck();

  expect(result.status).toBe(1);
  expect(result.stderr).toContain(`Missing README.md in folder: ${group}/example\n`);
}

test.each(packageGroups)('requires the package or tool README under %s', requiresPackageReadme);

const excludedFolders = [
  'test', 'tests', '__tests__', 'fixtures', '__snapshots__', 'dist', 'coverage', 'node_modules',
];

function skipsExcludedFolder(folder) {
  const files = {
    'libs/example/README.md': validReadme,
    [`libs/example/${folder}/nested/file.ts`]: '',
    [`libs/example/src/${folder}/nested/file.ts`]: '',
  };
  trackFiles(files);

  const result = runCheck();

  expect(result.status, result.stderr).toBe(0);
}

test.each(excludedFolders)('allows %s folders and everything inside them', skipsExcludedFolder);

function requiresReadmeForExcludedPackageName(folder) {
  const files = { [`libs/${folder}/index.ts`]: '' };
  trackFiles(files);

  const result = runCheck();

  expect(result.status).toBe(1);
  expect(result.stderr).toContain(`Missing README.md in folder: libs/${folder}\n`);
}

test.each(excludedFolders)(
  'requires a package README even when the package is called %s',
  requiresReadmeForExcludedPackageName,
);

function requiresTrackedReadmeOnDisk() {
  const files = {
    'libs/example/README.md': validReadme,
    'libs/example/index.ts': '',
  };
  trackFiles(files);
  rmSync(join(repository, 'libs/example/README.md'));

  const result = runCheck();

  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Missing README.md in folder: libs/example\n');
}

test('reports a tracked README removed from disk as missing', requiresTrackedReadmeOnDisk);

function allowsTopLevelSource() {
  const files = {
    'libs/example/README.md': validReadme,
    'libs/example/src/index.ts': '',
  };
  trackFiles(files);

  const result = runCheck();

  expect(result.status, result.stderr).toBe(0);
}

test('allows the top-level src folder without a README', allowsTopLevelSource);

function requiresNestedSourceReadme() {
  const files = {
    'libs/example/README.md': validReadme,
    'libs/example/model/README.md': '# Model\n',
    'libs/example/model/src/index.ts': '',
  };
  trackFiles(files);

  const result = runCheck();

  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Missing README.md in folder: libs/example/model/src\n');
}

test('requires a README for src folders below another folder', requiresNestedSourceReadme);

const ticketReferences = ['#123', 'P3-5', 'phase 3', 'PR 12', 'Phase 3', 'pr 12'];

function rejectsTicketReference(reference) {
  const files = {
    'infra/example/README.md': validReadme,
    'infra/example/settings/README.md': `# Settings\n\nAdded in ${reference}.\n`,
  };
  trackFiles(files);

  const result = runCheck();

  expect(result.status).toBe(1);
  expect(result.stderr).toContain('infra/example/settings/README.md:3');
  expect(result.stderr).toContain('Remove ticket or phase references');
}

test.each(ticketReferences)('refuses %s in a folder README', rejectsTicketReference);

function checksExistingPackageAndSourceReadmes() {
  const files = {
    'tools/example/README.md': '# Example\n\nSee #123.\n',
    'tools/example/src/README.md': '# Source\n\nAdded in PR 12.\n',
  };
  trackFiles(files);

  const result = runCheck();

  expect(result.status).toBe(1);
  expect(result.stderr).toContain('tools/example/README.md:3');
  expect(result.stderr).toContain('tools/example/src/README.md:3');
}

test('also checks existing package and top-level src READMEs', checksExistingPackageAndSourceReadmes);

function usesOnlyTrackedFiles() {
  const files = {
    'apps/example/README.md': validReadme,
    'apps/example/folder with spaces/README.md': '# Settings\n',
    'apps/example/folder with spaces/config.ts': '',
    'docs/notes/history.txt': '',
    'scripts/helpers/helper.mjs': '',
  };
  trackFiles(files);
  writeFile('apps/example/local-only/file.ts', '');

  const result = runCheck();

  expect(result.status, result.stderr).toBe(0);
}

test('checks tracked folders only and supports spaces in paths', usesOnlyTrackedFiles);

function rejectsWrongHeadingOrder() {
  const content = validReadme.replace('## Where it fits', '## Folders');
  trackFiles({ 'libs/example/README.md': content });
  const result = runCheck();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('libs/example/README.md: headings');
}

test('refuses a wrong package heading order', rejectsWrongHeadingOrder);

function rejectsDifferentOpening() {
  const files = {
    'libs/example/README.md': validReadme,
    'libs/example/package.json': JSON.stringify({ description: 'Another package.' }),
  };
  trackFiles(files);
  const result = runCheck();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('libs/example/README.md: opening');
}

test('refuses an opening different from the package description', rejectsDifferentOpening);

function readmeWithLines(count) {
  const lines = validReadme.trimEnd().split('\n');
  while (lines.length < count) lines.push('More detail.');
  return `${lines.join('\n')}\n`;
}

function rejectsLongReadme() {
  trackFiles({ 'libs/example/README.md': readmeWithLines(151) });
  const result = runCheck();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('libs/example/README.md: length: 151');
}

test('refuses a package README with 151 lines', rejectsLongReadme);

function summaryWithLines(count) {
  const extra = 'Change note.\n'.repeat(count - 1);
  return validReadme.replace('Example package.\n', `Example package.\n${extra}`);
}

function rejectsChangeNotes() {
  trackFiles({ 'libs/example/README.md': summaryWithLines(11) });
  const result = runCheck();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('libs/example/README.md: summary: 11');
}

test('refuses 11 non-blank lines under What this is', rejectsChangeNotes);

function rejectsLongRobotReadme() {
  const files = {
    'libs/example/README.md': validReadme,
    'libs/example/README.robot.md': 'Detail.\n'.repeat(1501),
  };
  trackFiles(files);
  const result = runCheck();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('libs/example/README.robot.md: robot-length: 1501');
}

test('refuses a robot README with 1501 lines', rejectsLongRobotReadme);

function writeBaseline(entries) {
  writeFile('scripts/readme-baseline.json', JSON.stringify(entries));
}

function allowsListedOffenders() {
  const files = {
    'libs/example/README.md': readmeWithLines(151),
    'libs/example/README.robot.md': 'Detail.\n'.repeat(1700),
  };
  trackFiles(files);
  writeBaseline([
    { file: 'libs/example/README.md', rule: 'length', count: 151 },
    { file: 'libs/example/README.robot.md', rule: 'robot-length', count: 1501 },
  ]);
  const result = runCheck();
  expect(result.status, result.stderr).toBe(0);
}

test('allows listed offenders and lets listed robot files grow', allowsListedOffenders);

function refusesListedGrowth() {
  trackFiles({ 'libs/example/README.md': readmeWithLines(152) });
  writeBaseline([{ file: 'libs/example/README.md', rule: 'length', count: 151 }]);
  const result = runCheck();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('length rose from 151 to 152');
}

test('refuses a listed package README growing by one line', refusesListedGrowth);

function refusesPassingEntry() {
  trackFiles({ 'libs/example/README.md': validReadme });
  writeBaseline([{ file: 'libs/example/README.md', rule: 'headings' }]);
  const result = runCheck();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('remove the passing baseline entry');
}

test('requires removal of an entry whose file now passes', refusesPassingEntry);

function refusesNewBaselineEntry() {
  trackFiles({ 'libs/example/README.md': validReadme });
  const base = commitBase(repository);
  writeFile('libs/example/README.md', readmeWithLines(151));
  writeBaseline([{ file: 'libs/example/README.md', rule: 'length', count: 151 }]);
  const result = runCheck(base);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('new baseline entry');
}

test('refuses a new entry against the base commit', refusesNewBaselineEntry);

function refusesRaisedCount() {
  trackFiles({ 'libs/example/README.md': readmeWithLines(151) });
  writeBaseline([{ file: 'libs/example/README.md', rule: 'length', count: 151 }]);
  const base = commitBase(repository);
  writeBaseline([{ file: 'libs/example/README.md', rule: 'length', count: 152 }]);
  const result = runCheck(base);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('length rose from 151 to 152');
}

test('refuses a recorded number rising against the base', refusesRaisedCount);

function skipsMissingBase() {
  trackFiles({ 'libs/example/README.md': readmeWithLines(151) });
  writeBaseline([{ file: 'libs/example/README.md', rule: 'length', count: 151 }]);
  const result = runCheck();
  expect(result.status, result.stderr).toBe(0);
}

test('skips comparison when no base commit exists', skipsMissingBase);

function allowsOptionalFoldersAndFencedHeadings(marker) {
  const folders = validReadme.replace('## Where to read more', '## Folders\n\n## Where to read more');
  const content = folders.replace('## Where it fits', `${marker}md\n## Ignored\n${marker}\n\n## Where it fits`);
  trackFiles({ 'libs/example/README.md': content });
  const result = runCheck();
  expect(result.status, result.stderr).toBe(0);
}

test.each(['```', '~~~~'])(
  'allows Folders before the final heading and ignores headings inside %s fences',
  allowsOptionalFoldersAndFencedHeadings,
);

function allowsWrappedOpening() {
  const content = validReadme.replace('Example package.', '[Example](./README.md)\n`package`');
  const files = {
    'libs/example/README.md': content,
    'libs/example/package.json': JSON.stringify({ description: 'Example package.' }),
  };
  trackFiles(files);
  const result = runCheck();
  expect(result.status, result.stderr).toBe(0);
}

test('joins wrapped opening lines and removes link, code and final full-stop markup',
  allowsWrappedOpening);

function allowsExactLimits() {
  const content = readmeWithLines(120);
  const extra = '\nChange note.\n'.repeat(9);
  const summary = content.replace('Example package.', `Example package.${extra}`);
  const files = {
    'libs/example/README.md': readmeWithLines(150),
    'libs/example/README.robot.md': 'Detail.\n'.repeat(1500),
    'libs/summary/README.md': summary,
  };
  trackFiles(files);
  const result = runCheck();
  expect(result.status, result.stderr).toBe(0);
}

test('allows 150 package lines, 10 non-blank summary lines and 1500 robot lines', allowsExactLimits);

function refusesInvalidBaseline() {
  trackFiles({ 'libs/example/README.md': readmeWithLines(151) });
  writeBaseline([{ file: 'libs/example/README.md', rule: 'length', count: 'unlimited' }]);
  const result = runCheck();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Invalid baseline entry');
}

test('refuses an invalid recorded number instead of bypassing the cap', refusesInvalidBaseline);
