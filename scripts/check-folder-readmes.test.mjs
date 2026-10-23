import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, test } from 'vitest';

const checker = fileURLToPath(new URL('./check-folder-readmes.mjs', import.meta.url));
let repository;

function createRepository() {
  repository = mkdtempSync(join(tmpdir(), 'folder-readmes-'));
  const options = { cwd: repository, encoding: 'utf8' };
  execFileSync('git', ['init', '--quiet'], options);
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

function runCheck() {
  const options = { cwd: repository, encoding: 'utf8' };
  return spawnSync(process.execPath, [checker], options);
}

beforeEach(createRepository);
afterEach(removeRepository);

function reportsEveryMissingFolder() {
  const files = {
    'apps/example/README.md': '# Example\n',
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
    'libs/example/README.md': '# Example\n',
    [`libs/example/${folder}/nested/file.ts`]: '',
    [`libs/example/src/${folder}/nested/file.ts`]: '',
  };
  trackFiles(files);

  const result = runCheck();

  expect(result.status, result.stderr).toBe(0);
}

test.each(excludedFolders)('allows %s folders and everything inside them', skipsExcludedFolder);

function allowsTopLevelSource() {
  const files = {
    'libs/example/README.md': '# Example\n',
    'libs/example/src/index.ts': '',
  };
  trackFiles(files);

  const result = runCheck();

  expect(result.status, result.stderr).toBe(0);
}

test('allows the top-level src folder without a README', allowsTopLevelSource);

function requiresNestedSourceReadme() {
  const files = {
    'libs/example/README.md': '# Example\n',
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
    'infra/example/README.md': '# Example\n',
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
    'apps/example/README.md': '# Example\n',
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
