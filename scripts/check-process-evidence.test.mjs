import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, test } from 'vitest';

const checker = fileURLToPath(new URL('./check-process-evidence.mjs', import.meta.url));
let repository;

function createRepository() {
  repository = mkdtempSync(join(tmpdir(), 'process-evidence-'));
  const options = { cwd: repository, encoding: 'utf8' };
  execFileSync('git', ['init', '--quiet'], options);
}

function removeRepository() {
  rmSync(repository, { recursive: true, force: true });
}

function writeFile(path, content, tracked = true) {
  const target = join(repository, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
  if (tracked) {
    const options = { cwd: repository, encoding: 'utf8' };
    execFileSync('git', ['add', '--', path], options);
  }
}

function runCheck() {
  const options = { cwd: repository, encoding: 'utf8' };
  return spawnSync(process.execPath, [checker], options);
}

beforeEach(createRepository);
afterEach(removeRepository);

const operatorWorkChat = '/home' + '/operator/work/chat';
const operatorProject = '/home' + '/operator/project';

const privateValues = [
  [operatorWorkChat, 'home-directory path'],
  ['/Users/operator/work/chat', 'home-directory path'],
  ['/root/.config/settings', 'home-directory path'],
  ['/root', 'home-directory path'],
  ['file:///root/.config/settings', 'home-directory path'],
  ['C:\\Users\\operator\\work', 'home-directory path'],
  ['C:/Users/operator/work', 'home-directory path'],
  [JSON.stringify({ path: 'C:\\Users\\operator\\work' }), 'home-directory path'],
  ['/srv/private/dev-stack-2/evidence', 'private stack path'],
  ['~/.config/opencrane/dev-stack-1', 'private stack path'],
  ['$HOME/.config/opencrane/dev-stack-1', 'private stack path'],
  ['${HOME}/.config/opencrane/dev-stack-1', 'private stack path'],
  ['person+run@example.invalid', 'email address'],
];

function rejectsPrivateValue(value, description) {
  writeFile('docs/process/older attempt/output.jsonl', `PASS\n${value}\n`);

  const result = runCheck();

  expect(result.status).toBe(1);
  expect(result.stderr).toContain('docs/process/older attempt/output.jsonl:2:');
  expect(result.stderr).toContain(description);
  expect(result.stderr).not.toContain(value);
}

test.each(privateValues)('refuses %s in tracked evidence', rejectsPrivateValue);

function reportsEveryFile() {
  writeFile('docs/process/first.log', `PASS\n${operatorProject}\n`);
  writeFile('docs/process/nested/receipt.md', 'person@example.invalid\n');

  const result = runCheck();

  expect(result.status).toBe(1);
  expect(result.stderr).toContain('first.log:2:');
  expect(result.stderr).toContain('nested/receipt.md:1:');
}

test('reports all affected files and line numbers', reportsEveryFile);

function allowsPublicEvidence() {
  writeFile('docs/process/receipt.md', '<home>/.fleet/log\n<stack-dir>/output\n<email>\n');
  writeFile('docs/process/run.json', '{"directory":"<worktree>/apps/server"}\n');
  writeFile('docs/process/local.log', `${operatorProject}\n`, false);
  writeFile('docs/other.md', `${operatorProject}\n`);
  writeFile('docs/process/image.png', Buffer.from([137, 80, 78, 71, 0, 10]));

  const result = runCheck();

  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('PASS');
}

test('allows placeholders and checks tracked process text only', allowsPublicEvidence);

function checksWorkingCopy() {
  writeFile('docs/process/receipt.md', 'PASS\n');
  writeFile('docs/process/receipt.md', `${operatorProject}\n`, false);

  const result = runCheck();

  expect(result.status).toBe(1);
}

test('also catches an unstaged leak in an already tracked file', checksWorkingCopy);

function allowsRootFileNames() {
  const content = [
    '[Load](i77-live-view/diag/root-load.txt)',
    '[Tests](i77-live-view/final5/root-test.log)',
    '/proc/123/root/var/crash',
    'Integration/root PG_TEST_URL is supplied.',
  ];
  writeFile('docs/process/receipt.md', content.join('\n'));

  const result = runCheck();

  expect(result.status, result.stderr).toBe(0);
}

test('allows relative root filenames and process root paths', allowsRootFileNames);
