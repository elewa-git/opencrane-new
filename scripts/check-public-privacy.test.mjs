import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, test } from 'vitest';

const checkerUrl = new URL('./check-public-privacy.mjs', import.meta.url);
const checker = fileURLToPath(checkerUrl);
const hostHome = '/' + 'home/';
const privateEmail = 'person@' + 'elewa.ke';
let repository;

function createRepository() {
  repository = mkdtempSync(join(tmpdir(), 'public-privacy-'));
  const options = { cwd: repository };
  execFileSync('git', ['init', '--quiet'], options);
}

function removeRepository() {
  const options = { recursive: true, force: true };
  rmSync(repository, options);
}

function trackFile(name, content) {
  writeFileSync(join(repository, name), content);
  const options = { cwd: repository };
  execFileSync('git', ['add', '--', name], options);
}

function runCheck() {
  const options = { cwd: repository, encoding: 'utf8' };
  return spawnSync(process.execPath, [checker], options);
}

beforeEach(createRepository);
afterEach(removeRepository);

function rejectsPrivateDetails() {
  trackFile('spec.md', privateEmail);
  trackFile('receipt.log', `${hostHome}operator/stack`);
  trackFile('design.html', privateEmail.toUpperCase());
  trackFile('unicode.log', 'δοκιμή@' + 'elewa.ke');
  const receipt = { email: 'person@sub.' + 'elewa.ke' };
  trackFile('run.json', JSON.stringify(receipt));
  trackFile('fixture.ts', `const path = '${hostHome}operator/worktree';`);
  const result = runCheck();
  expect(result.status).toBe(1);
  const names = ['spec.md', 'receipt.log', 'design.html', 'unicode.log', 'run.json', 'fixture.ts'];
  for (const name of names) {
    expect(result.stderr).toContain(`${name}:1:`);
  }
  expect(result.stderr).not.toContain(privateEmail);
  expect(result.stderr).not.toContain(`${hostHome}operator`);
}

function checksWorkingFiles() {
  trackFile('receipt.log', '<worktree>/apps/server');
  writeFileSync(join(repository, 'receipt.log'), `${hostHome}operator/stack`);
  const result = runCheck();
  expect(result.status).toBe(1);
}

function acceptsPublicFiles() {
  const placeholders = '<owner-email> <home> <stack-dir> <worktree> .tools/home/<id>';
  trackFile('guide.md', placeholders);
  for (const account of ['agent', 'codex', 'desktop', 'private', 'tool']) {
    trackFile(`${account}.ts`, `${hostHome}${account}/workspace`);
  }
  const binaryContent = Buffer.from(`\0${privateEmail} ${hostHome}operator`);
  trackFile('image.png', binaryContent);
  writeFileSync(join(repository, 'private.env'), privateEmail);
  const result = runCheck();
  expect(result.status).toBe(0);
}

function refusesAccountPrefixes() {
  trackFile('receipt.log', `${hostHome}codex-person/worktree`);
  const result = runCheck();
  expect(result.status).toBe(1);
}

test('rejects private details across tracked text formats without printing them', rejectsPrivateDetails);

test('checks working files rather than only staged contents', checksWorkingFiles);

test('accepts public placeholders and fixtures; skips binary and untracked files',
  acceptsPublicFiles);

test('refuses names that merely start with an allowed container account', refusesAccountPrefixes);
